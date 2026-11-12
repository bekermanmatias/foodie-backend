const test = require("node:test");
const assert = require("node:assert/strict");
const { settingsSchema, calculateDeposit } = require("../dist/modules/deposits/deposit-rules");
const { verifyProofContent } = require("../dist/modules/deposits/proof-storage.service");
const { DepositDriveService } = require("../dist/modules/deposits/deposit-drive.service");
const { DepositsService } = require("../dist/modules/deposits/deposits.service");
const { resolveFeatures } = require("../dist/common/restaurant-features");
const settings = { reviewed: true, currency: "ARS", bankAlias: "test.alias", bankCbu: "", bankHolder: "Test", paymentHours: 24, rules: [
  { id: "general", label: "General", minPeople: 15, maxPeople: 20, eventId: null, mode: "fixed", amount: 100 },
  { id: "event", label: "Evento", minPeople: 1, maxPeople: null, eventId: "event1", mode: "per_person", amount: 10 }
] };
test("deposits are disabled by default and independent of inherited modules", () => {
  assert.equal(resolveFeatures({}).deposits, false);
  assert.equal(resolveFeatures({ deposits: true }).deposits, true);
  assert.equal(resolveFeatures({ deposits: true }).giftCards, true);
});
test("reviewed settings, tiers, event overrides and Decimal amounts", () => {
  assert.equal(calculateDeposit({ ...settings, reviewed: false }, 16), null);
  assert.equal(calculateDeposit(settings, 14), null);
  assert.equal(calculateDeposit(settings, 16).requiredAmount.toString(), "100");
  assert.equal(calculateDeposit(settings, 16, "event1").requiredAmount.toString(), "160");
  assert.equal(calculateDeposit(settings, 21), null);
  const result = calculateDeposit(settings, 16);
  settings.bankAlias = "changed.alias";
  assert.equal(result.ruleSnapshot.bankAlias, "test.alias");
});
test("incomplete bank instructions and overlapping rules cannot be reviewed", () => {
  assert.equal(settingsSchema.safeParse({ ...settings, bankAlias: "", bankCbu: "" }).success, false);
  assert.equal(settingsSchema.safeParse({ ...settings, rules: [...settings.rules, { ...settings.rules[0], id: "overlap" }] }).success, false);
  assert.equal(settingsSchema.safeParse({ ...settings, paymentHours: -1 }).success, false);
});
test("proof validation checks actual content and size", () => {
  assert.doesNotThrow(() => verifyProofContent(Buffer.from("%PDF-1.4\nTest"), "application/pdf"));
  assert.throws(() => verifyProofContent(Buffer.from("<script>evil()</script>"), "application/pdf"));
  assert.throws(() => verifyProofContent(Buffer.alloc(11 * 1024 * 1024), "application/pdf"));
  assert.throws(() => verifyProofContent(Buffer.from("GIF89a"), "image/png"));
});

test("Gift Card history filters Drive dates and searches authorized orders before returning proofs", async () => {
  const owner = { scope: "restaurant", role: "restaurant_owner", restaurantId: "restaurant-1" };
  let orderCriteria;
  const prisma = {
    restaurant: { findUnique: async () => ({ featureOverrides: {}, isDemo: false }) },
    restaurantDriveConnection: { findUnique: async () => ({ encryptedRefreshToken: "test" }) },
    giftCardOrder: { findMany: async ({ where }) => {
      orderCriteria = where;
      return [{ id: "matched", restaurantId: owner.restaurantId, restaurant: {}, quantity: 1, giftCards: [] }];
    } }
  };
  const service = new DepositDriveService(prisma);
  const from = "2026-11-12T03:00:00.000Z";
  const before = "2026-11-13T03:00:00.000Z";
  service.api = async (restaurantId, path) => {
    assert.equal(restaurantId, owner.restaurantId);
    const query = new URL(path, "https://drive.googleapis.com").searchParams;
    assert.equal(query.get("pageToken"), "requested");
    assert.ok(query.get("q").includes(`createdTime >= '${from}' and createdTime < '${before}'`));
    const file = (id, orderId, restaurantId) => ({ id, appProperties: { foodieGiftCardOrderId: orderId, restaurantId } });
    return { nextPageToken: "older", files: [
      file("proof-1", "matched", owner.restaurantId),
      file("proof-2", "filtered", owner.restaurantId),
      file("proof-3", "matched", "another-restaurant")
    ] };
  };
  const result = await service.giftCardProofHistory(owner, "requested", { search: "MATIAS", review: "approved", payment: "CONFIRMED", from, before });
  assert.equal(orderCriteria.restaurantId, owner.restaurantId);
  assert.deepEqual(orderCriteria.id.in, ["matched", "filtered"]);
  assert.deepEqual(orderCriteria.AND, [{ paymentStatus: "CONFIRMED" }]);
  assert.equal(orderCriteria.paymentStatus, "CONFIRMED");
  assert.equal(orderCriteria.OR[1].purchaserName.contains, "MATIAS");
  assert.deepEqual(result.items.map(item => item.id), ["proof-1"]);
  assert.equal(result.nextPageToken, "older");
});

test("reservation deposit search stays inside the restaurant and combines payment and overdue criteria", async () => {
  const owner = { scope: "restaurant", role: "restaurant_owner", restaurantId: "restaurant-1" };
  const service = new DepositsService({
    restaurant: { findUnique: async () => ({ featureOverrides: { deposits: true } }) },
    reservationDeposit: { findMany: async ({ where }) => [where] }
  });
  const [where] = await service.list(owner, { search: "MATIAS", branchId: "branch-1", status: "partial", expired: true });
  assert.equal(where.restaurantId, owner.restaurantId);
  assert.equal(where.branchId, "branch-1");
  assert.deepEqual(where.status, { equals: "partial", not: "complete" });
  assert.equal(where.reservation.OR[0].fullName.contains, "MATIAS");
  assert.ok(where.dueAt.lt instanceof Date);
});

test("Drive names a new root after the authenticated restaurant and reuses saved folder IDs", async () => {
  const owner = { scope: "restaurant", role: "restaurant_owner", restaurantId: "restaurant-1" };
  let connection;
  const folders = [];
  const prisma = {
    restaurant: {
      findUnique: async () => ({ featureOverrides: { deposits: true }, isDemo: false }),
      findUniqueOrThrow: async ({ where }) => {
        assert.equal(where.id, owner.restaurantId);
        return { name: " DEMO FOODIE " };
      }
    },
    restaurantDriveConnection: {
      findUnique: async () => connection,
      upsert: async ({ create, update }) => { connection = connection ? { ...connection, ...update } : create; }
    }
  };
  const service = new DepositDriveService(prisma);
  service.api = async (restaurantId, path, init) => {
    assert.equal(restaurantId, owner.restaurantId);
    if (init?.method === "POST") {
      const folder = { id: `folder-${folders.length + 1}`, ...JSON.parse(init.body) };
      folders.push(folder);
      return folder;
    }
    const query = new URL(path, "https://www.googleapis.com").searchParams.get("q");
    return { files: folders.filter(folder => folder.parents && query.includes(`name='${folder.name}'`)) };
  };

  const first = await service.setup(owner);
  assert.deepEqual(folders.map(({ name, parents }) => [name, parents]), [
    ["FOODIE - DEMO FOODIE", undefined],
    ["Comprobantes", [first.rootFolderId]],
    ["Archivos generales", [first.rootFolderId]]
  ]);
  assert.deepEqual(await service.setup(owner), first);
  assert.equal(folders.length, 3);
});
