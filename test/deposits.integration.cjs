// Requires a fresh isolated PostgreSQL on 127.0.0.1:5438/foodie14_check.
const assert = require("node:assert/strict");
const { PrismaClient } = require("@prisma/client");
const { randomUUID } = require("node:crypto");
const { DepositsService } = require("../dist/modules/deposits/deposits.service");
const { DepositDriveService } = require("../dist/modules/deposits/deposit-drive.service");
const { ReservationsService } = require("../dist/modules/reservations/reservations.service");
const { ProofStorageService } = require("../dist/modules/deposits/proof-storage.service");
const { R2StorageService } = require("../dist/modules/deposits/r2-storage.service");
const { NotificationsService } = require("../dist/modules/notifications/notifications.service");
const { AuditService } = require("../dist/modules/audit/audit.service");
const { initialReservationDeposit } = require("../dist/modules/deposits/deposit-rules");
const url = new URL(process.env.FOODIE14_TEST_DATABASE_URL || "http://invalid");
if (url.hostname !== "127.0.0.1" || url.port !== "5438" || url.pathname !== "/foodie14_check") throw new Error("Only the disposable foodie14_check database is allowed");
const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
const storage = new ProofStorageService(new R2StorageService());
const audit = new AuditService(prisma);
const reservations = new ReservationsService(prisma, { publish() {} }, audit);
const drive = new DepositDriveService(prisma, storage);
const service = new DepositsService(prisma, storage, reservations, drive);
let passed = 0;
async function check(name, action) { await action(); passed++; console.log(`PASS ${name}`); }
const failure = (status) => (error) => error.getStatus?.() === status;
async function main() {
  const restaurant = await prisma.restaurant.create({ data: { name: "Demo FOODIE14", slug: randomUUID(), isDemo: true } });
  const other = await prisma.restaurant.create({ data: { name: "Other", slug: randomUUID(), featureOverrides: { deposits: true } } });
  const branch = await prisma.branch.create({ data: { restaurantId: restaurant.id, name: "Demo", timezone: "America/Argentina/Buenos_Aires" } });
  const room = await prisma.room.create({ data: { restaurantId: restaurant.id, branchId: branch.id, name: "Room" } });
  const table = await prisma.table.create({ data: { restaurantId: restaurant.id, roomId: room.id, label: "T1", seats: 6, x: 0, y: 0, width: 80, height: 80, shape: "square" } });
  const actor = async (role, tenant = restaurant.id) => { const user = await prisma.restaurantUser.create({ data: { restaurantId: tenant, fullName: role, email: `${randomUUID()}@test.local`, passwordHash: "test", role } }); return { sub: user.id, scope: "restaurant", restaurantId: tenant, role, fullName: role, email: user.email }; };
  const owner = await actor("restaurant_owner"); const cashier = await actor("cashier"); const host = await actor("host"); const outsider = await actor("restaurant_owner", other.id);
  const makeReservation = async (phone, tableIds = [], time = "20:00") => {
    const code = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
    return prisma.reservation.create({ data: { restaurantId: restaurant.id, branchId: branch.id, roomId: room.id, code, codeNormalized: code, fullName: "Cliente", phone, partySize: 2, turn: "noche", serviceDate: new Date("2027-03-10T00:00:00Z"), serviceTime: time, status: "pending", tables: { create: tableIds.map((tableId) => ({ tableId })) } } });
  };
  let reservation, deposit, proofId, secondProof;
  await check("default off blocks every financial entry point", async () => {
    await assert.rejects(service.list(owner), failure(403));
    await assert.rejects(service.externalOpenRequest(restaurant.id, "5491112345678"), failure(403));
    assert.equal(await prisma.reservationDeposit.count({ where: { restaurantId: restaurant.id } }), 0);
    await prisma.restaurant.update({ where: { id: restaurant.id }, data: { featureOverrides: { deposits: true } } });
  });
  await check("financial roles and owner-only rules", async () => {
    await assert.rejects(service.list(host), failure(403));
    await assert.rejects(service.saveSettings(cashier, {}), failure(403));
    const config = { reviewed: true, currency: "ARS", bankAlias: "demo.alias", bankCbu: "", bankHolder: "Demo", paymentHours: 24, rules: [{ id: "normal", label: "Test rule", minPeople: 1, maxPeople: null, eventId: null, mode: "per_person", amount: 50 }] };
    await service.saveSettings(owner, config);
    const calculated = await prisma.$transaction((tx) => initialReservationDeposit(tx, restaurant.id, 2));
    assert.equal(calculated.requiredAmount.toString(), "100");
  });
  await check("request retains cupo and snapshots bank instructions", async () => {
    reservation = await makeReservation("+54 (9) 11 1234-5678", [table.id]);
    deposit = await service.upsert(owner, reservation.id, { useRules: true });
    assert.equal(deposit.requiredAmount.toString(), "100");
    assert.equal(deposit.ruleSnapshot.bankAlias, "demo.alias");
    const config = await service.settings(owner); await service.saveSettings(owner, { ...config, bankAlias: "new.alias" });
    assert.equal((await prisma.reservationDeposit.findUnique({ where: { id: deposit.id } })).ruleSnapshot.bankAlias, "demo.alias");
    const row = await prisma.reservation.findUnique({ where: { id: reservation.id }, include: { tables: true } });
    assert.equal(row.status, "pending"); assert.equal(row.tables[0].tableId, table.id);
  });
  await check("normalized phone isolates the contact and restaurant", async () => {
    assert.equal((await service.list(owner, { phone: "5491112345678" })).length, 1);
    assert.equal((await service.list(owner, { phone: "5491199999999" })).length, 0);
    assert.equal((await service.list(outsider, { phone: "5491112345678" })).length, 0);
    await assert.rejects(service.addEntry(outsider, deposit.id, { type: "payment", amount: 1, paidAt: new Date().toISOString(), paymentMethod: "transfer", idempotencyKey: randomUUID() }), failure(404));
  });
  await check("demo upload preserves a private proof without crediting payment", async () => {
    const bytes = Buffer.from("%PDF-1.4\nDemo proof\n%%EOF");
    const result = await service.internalUpload(cashier, deposit.id, { fileName: "proof.pdf", mimeType: "application/pdf", size: bytes.length, content: bytes.toString("base64") }); proofId = result.proofId;
    assert.equal((await prisma.depositProof.findUnique({ where: { id: proofId } })).reviewStatus, "pending");
    assert.equal((await prisma.reservationDeposit.findUnique({ where: { id: deposit.id } })).paidAmount.toString(), "0");
    assert.deepEqual((await service.proofFile(cashier, proofId)).data, bytes);
    await assert.rejects(service.proofFile(outsider, proofId), failure(404));
    assert.equal((await drive.sync(owner, proofId)).driveStatus, "simulated");
  });
  await check("concurrent approval credits a proof once; a partial payment leaves reservation pending", async () => {
    const input = { type: "payment", amount: 40, paidAt: new Date().toISOString(), paymentMethod: "transfer", proofIds: [proofId], idempotencyKey: randomUUID() };
    const outcomes = await Promise.all([service.addEntry(cashier, deposit.id, input), service.addEntry(cashier, deposit.id, input)]);
    assert.equal(outcomes.filter((value) => value.duplicate).length, 1);
    assert.equal((await prisma.reservationDeposit.findUnique({ where: { id: deposit.id } })).paidAmount.toString(), "40");
    assert.equal((await prisma.reservation.findUnique({ where: { id: reservation.id } })).status, "pending");
    await assert.rejects(service.confirmReservation(owner, deposit.id), failure(409));
  });
  await check("rejection does not erase credited payments and resend accepts a new proof", async () => {
    const bytes = Buffer.from("%PDF-1.4\nSecond proof");
    secondProof = (await service.internalUpload(cashier, deposit.id, { fileName: "second.pdf", mimeType: "application/pdf", size: bytes.length, content: bytes.toString("base64") })).proofId;
    await service.rejectProof(cashier, secondProof, "Ilegible");
    await assert.rejects(service.rejectProof(cashier, secondProof, "Otra vez"), failure(409));
    assert.equal((await prisma.reservationDeposit.findUnique({ where: { id: deposit.id } })).paidAmount.toString(), "40");
    await service.requestProof(cashier, deposit.id);
    assert.ok((await service.pendingProofs(cashier)).every((proof) => proof.id !== secondProof));
  });
  await check("expired requests retain tables; multiple reservations require explicit code", async () => {
    await prisma.reservationDeposit.update({ where: { id: deposit.id }, data: { dueAt: new Date("2020-01-01") } });
    const second = await makeReservation("5491112345678", [], "22:00");
    const secondDeposit = await service.upsert(owner, second.id, { requiredAmount: 50 });
    await service.requestProof(owner, secondDeposit.id);
    const open = await service.externalOpenRequest(restaurant.id, "5491112345678");
    assert.equal(open.active, false); assert.equal(open.requiresReservationSelection, true);
    assert.equal((await service.externalOpenRequest(restaurant.id, "5491112345678", reservation.code)).active, true);
    assert.equal((await prisma.reservation.findUnique({ where: { id: reservation.id } })).status, "pending");
  });
  await check("covering the amount requires explicit confirmation; unavailable tables reject it", async () => {
    await service.addEntry(cashier, deposit.id, { type: "payment", amount: 60, paidAt: new Date().toISOString(), paymentMethod: "transfer", idempotencyKey: randomUUID() });
    assert.equal((await prisma.reservation.findUnique({ where: { id: reservation.id } })).status, "pending");
    const conflict = await makeReservation("5491100000000", [table.id]);
    await assert.rejects(service.confirmReservation(owner, deposit.id), failure(409));
    assert.equal((await prisma.reservation.findUnique({ where: { id: reservation.id } })).status, "pending");
    await prisma.reservation.update({ where: { id: conflict.id }, data: { status: "cancelled" } });
    const outcomes = await Promise.all([service.confirmReservation(owner, deposit.id), service.confirmReservation(owner, deposit.id)]);
    assert.equal(outcomes.filter((result) => result.duplicate).length, 1);
    const row = await prisma.reservation.findUnique({ where: { id: reservation.id }, include: { tables: true } });
    assert.equal(row.status, "confirmed"); assert.equal(row.tables[0].tableId, table.id);
    assert.equal(await prisma.depositDelivery.count({ where: { reservationId: reservation.id } }), 1);
  });
  await check("confirmation sends are simulated in demo and deduplicated", async () => {
    assert.equal((await service.deliver(owner, deposit.id)).status, "simulated");
    assert.equal((await service.deliver(owner, deposit.id)).status, "simulated");
  });
  await check("refunds require reference and cannot exceed credited balance", async () => {
    const input = { type: "refund", amount: 101, paidAt: new Date().toISOString(), paymentMethod: "transfer", reference: "bank-1", notes: "Manual refund", idempotencyKey: randomUUID() };
    await assert.rejects(service.addEntry(cashier, deposit.id, input), failure(400));
    await service.addEntry(cashier, deposit.id, { ...input, amount: 10 });
    assert.equal((await prisma.reservationDeposit.findUnique({ where: { id: deposit.id } })).paidAmount.toString(), "90");
    assert.equal((await prisma.reservation.findUnique({ where: { id: reservation.id } })).status, "confirmed");
  });
  await check("finance notifications stay hidden from reception and available to cashier", async () => {
    const notifications = new NotificationsService(prisma, audit);
    assert.equal((await notifications.list(host, { page: 1, pageSize: 100 })).items.some((item) => item.type === "deposit_proof"), false);
    assert.equal((await notifications.list(cashier, { page: 1, pageSize: 100 })).items.every((item) => item.type === "deposit_proof"), true);
  });
  await check("turning the module off preserves records and blocks access", async () => {
    const entries = await prisma.depositEntry.count();
    await prisma.restaurant.update({ where: { id: restaurant.id }, data: { featureOverrides: { deposits: false } } });
    await assert.rejects(service.list(owner), failure(403));
    await assert.rejects(service.proofFile(owner, proofId), failure(403));
    assert.equal(await prisma.depositEntry.count(), entries);
  });
  await check("Drive OAuth state, encrypted refresh, durable upload retries and revocation", async () => {
    await prisma.restaurant.update({ where: { id: restaurant.id }, data: { isDemo: false, featureOverrides: { deposits: true } } });
    process.env.GOOGLE_DRIVE_CLIENT_ID = "test-client"; process.env.GOOGLE_DRIVE_CLIENT_SECRET = "test-secret";
    process.env.GOOGLE_DRIVE_REDIRECT_URI = "http://localhost:4000/v1/external/deposits/drive/callback";
    process.env.CHAT_CREDENTIAL_SECRET = "test-encryption-secret";
    const originalFetch = global.fetch; const files = new Map(); let revoked = false; let uploaded = 0; let failUploadResponse = true;
    const mockDrive = new DepositDriveService(prisma, { get: async () => Buffer.from("%PDF-1.4\nTest") });
    const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    global.fetch = async (input, init) => {
      const target = String(input);
      if (target.includes("oauth2.googleapis.com/token")) return revoked ? json({ error: "invalid_grant" }, 400) : json({ access_token: "test-access", refresh_token: "test-refresh" });
      if (target.includes("generateIds")) return json({ ids: [`drive-${randomUUID()}`] });
      if (target.includes("upload/drive")) {
        uploaded++; const body = Buffer.from(init.body).toString(); const id = JSON.parse(body.split("\r\n\r\n")[1].split("\r\n--")[0]).id;
        const file = { id, webViewLink: `https://drive.google.com/file/d/${id}/view` }; files.set(id, file);
        if (failUploadResponse) { failUploadResponse = false; throw new Error("Network interruption after Google received the file"); }
        return json(file);
      }
      const match = /drive\/v3\/files\/([^?]+)/.exec(target);
      if (match) return files.has(match[1]) ? json(files.get(match[1])) : json({}, 404);
      if (init?.method === "POST") { const metadata = JSON.parse(init.body); const id = randomUUID(); files.set(id, { id, ...metadata }); return json({ id }); }
      return json({ files: [] });
    };
    try {
      const auth = await mockDrive.connect(owner); const state = new URL(auth.url).searchParams.get("state");
      await assert.rejects(mockDrive.callback("wrong-state", "code"), failure(400));
      await mockDrive.callback(state, "code");
      await assert.rejects(mockDrive.callback(state, "code"), failure(400));
      const connection = await prisma.restaurantDriveConnection.findUnique({ where: { restaurantId: restaurant.id } });
      assert.ok(connection.encryptedRefreshToken && !connection.encryptedRefreshToken.includes("test-refresh"));
      await mockDrive.setup(owner);
      await prisma.depositProof.update({ where: { id: proofId }, data: { driveStatus: "pending" } });
      assert.equal((await mockDrive.sync(owner, proofId)).driveStatus, "failed");
      const allocated = (await prisma.depositProof.findUnique({ where: { id: proofId } })).driveFileId;
      assert.ok(allocated);
      assert.equal((await mockDrive.sync(owner, proofId)).driveStatus, "synced");
      assert.equal(uploaded, 1, "An interrupted upload must reuse the durable Google file ID");
      const reconnect = await mockDrive.connect(owner);
      await mockDrive.callback(new URL(reconnect.url).searchParams.get("state"), "new-code");
      assert.equal((await prisma.depositProof.findUnique({ where: { id: proofId } })).driveFileId, allocated);
      revoked = true;
      await assert.rejects(mockDrive.folders(owner), failure(409));
      assert.equal((await mockDrive.status(owner)).status, "reconnect_required");
      assert.ok(await prisma.depositProof.findUnique({ where: { id: proofId } }));
    } finally { global.fetch = originalFetch; }
  });
  await check("confirmation webhook claims once and refuses foreign tenants", async () => {
    await prisma.restaurant.update({ where: { id: restaurant.id }, data: { chatPhoneNumberId: "test-channel" } });
    // Complete the refunded balance so the recorded confirmation is eligible again.
    await service.addEntry(owner, deposit.id, { type: "payment", amount: 10, paidAt: new Date().toISOString(), paymentMethod: "transfer", idempotencyKey: randomUUID() });
    const delivery = await prisma.depositDelivery.update({ where: { reservationId_kind: { reservationId: reservation.id, kind: "confirmation" } }, data: { status: "sending" } });
    await assert.rejects(service.claimDelivery(other.id, delivery.id), failure(404));
    const outcomes = await Promise.allSettled([service.claimDelivery(restaurant.id, delivery.id), service.claimDelivery(restaurant.id, delivery.id)]);
    assert.equal(outcomes.filter((value) => value.status === "fulfilled").length, 1);
    await service.finishDelivery(restaurant.id, delivery.id, "whatsapp-message-1");
    assert.equal((await service.claimDelivery(restaurant.id, delivery.id)).alreadySent, true);
  });
  console.log(`${passed} PostgreSQL integration scenarios passed`);
}
main().finally(() => prisma.$disconnect()).catch((error) => { console.error(error); process.exitCode = 1; });
