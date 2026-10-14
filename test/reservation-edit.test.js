const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ReservationsService } = require("../dist/modules/reservations/reservations.service.js");

const user = { scope: "restaurant", restaurantId: "restaurant", sub: "host", role: "host" };
const original = {
  id: "reservation", code: "ABC123", branchId: "branch", roomId: "room",
  fullName: "Original Guest", phone: "123456", email: "old@example.com",
  partySize: 2, serviceDate: new Date("2026-10-31"), serviceTime: "13:00",
  turn: "mediodia", durationMinutes: 180, turnoverMinutes: 0,
  status: "confirmed", notes: "Old note", tables: [{ tableId: "table" }]
};

function fixture({ unavailable = false, event = false, status = "confirmed" } = {}) {
  const writes = [];
  const assignments = [];
  const prisma = {
    reservation: {
      findFirst: async ({ where }) => {
        assert.equal(where.restaurantId, "restaurant");
        return { ...original, status };
      },
      update: async ({ data }) => { writes.push({ kind: "reservation", data }); return { ...original, ...data }; }
    },
    reservationRoomAssignment: { findFirst: async () => event ? { id: "event" } : null },
    room: { findFirst: async () => ({ id: "room", tables: [{ id: "table", label: "1", seats: 6, isReservable: true }] }) },
    reservationTable: { deleteMany: async () => writes.push({ kind: "tables" }) },
    serviceState: {
      updateMany: async () => writes.push({ kind: "release" }),
      upsert: async ({ create, update }) => writes.push({ kind: "state", create, update })
    },
    $queryRaw: async () => [],
    $transaction: async (callback) => callback(prisma)
  };
  const service = new ReservationsService(prisma, { publish() {} }, { log: async () => {} });
  service.resolveSpecialService = async () => null;
  service.validateBookingException = async () => {};
  service.assertRoomIsBookable = async () => {};
  service.upsertCustomer = async () => { writes.push({ kind: "customer" }); return { id: "customer" }; };
  service.findManualRequestedAssignment = async (client, input, ids) => {
    assert.equal(client, prisma);
    assignments.push({ input, ids });
    return unavailable ? null : { tableIds: ids };
  };
  service.assignTables = async (client, input) => {
    assignments.push({ input, automatic: true });
    return unavailable ? null : { tableIds: ["automatic-table"] };
  };
  return { service, writes, assignments };
}

test("editing saves customer, schedule, covers, notes and selected tables together", async () => {
  const { service, writes, assignments } = fixture();
  const updated = await service.updateManual(user, original.id, {
    fullName: "Updated Guest", phone: "987654", email: null, notes: null,
    partySize: 6, serviceDate: "2026-11-01", serviceTime: "20:30",
    roomId: "room", tableIds: ["table"]
  });
  assert.equal(updated.fullName, "Updated Guest");
  assert.equal(updated.email, null);
  assert.equal(updated.notes, null);
  assert.equal(updated.partySize, 6);
  assert.equal(updated.turn, "noche");
  assert.deepEqual(updated.tables.createMany.data, [{ tableId: "table" }]);
  assert.equal(assignments[0].input.excludeReservationId, original.id);
  assert.equal(assignments[0].input.serviceTime, "20:30");
  const state = writes.find((item) => item.kind === "state");
  assert.equal(state.update.serviceDate.toISOString().slice(0, 10), "2026-11-01");
  assert.equal(state.update.turn, "noche");
});

test("unavailable or undersized tables reject the whole edit before any writes", async () => {
  const { service, writes } = fixture({ unavailable: true });
  await assert.rejects(service.updateManual(user, original.id, { notes: "New note", partySize: 8, tableIds: ["table"] }), { status: 409 });
  assert.deepEqual(writes, []);
});

test("automatic assignment is available when explicit tables are omitted", async () => {
  const { service, assignments } = fixture();
  const result = await service.updateManual(user, original.id, { partySize: 4 });
  assert.equal(assignments[0].automatic, true);
  assert.deepEqual(result.tables.createMany.data, [{ tableId: "automatic-table" }]);
});

test("edits reject events, inactive reservations, duplicate tables and foreign scopes", async () => {
  await assert.rejects(fixture({ event: true }).service.updateManual(user, original.id, { notes: "edit" }), { status: 409 });
  await assert.rejects(fixture({ status: "seated" }).service.updateManual(user, original.id, { notes: "edit" }), { status: 409 });
  await assert.rejects(fixture().service.updateManual(user, original.id, { tableIds: ["table", "table"] }), { status: 400 });
  await assert.rejects(fixture().service.updateManual({ scope: "platform" }, original.id, {}), { status: 403 });
});

test("availability uses the edited date, time and party size and excludes the current booking", async () => {
  const { service } = fixture();
  let requested;
  service.isRoomBlocked = async () => false;
  service.isRoomAssignedToFullEvent = async () => false;
  service.listAvailableTables = async (_client, input) => { requested = input; return [{ id: "table" }]; };
  const result = await service.listTableAvailabilityForReassignment(user, original.id, "room", [], {
    serviceDate: "2026-11-02", serviceTime: "21:00", partySize: 6
  });
  assert.equal(requested.serviceDate.toISOString().slice(0, 10), "2026-11-02");
  assert.equal(requested.serviceTime, "21:00");
  assert.equal(requested.turn, "noche");
  assert.equal(requested.partySize, 6);
  assert.equal(requested.excludeReservationId, original.id);
  assert.equal(requested.turnoverMinutes, 0);
  assert.equal(result.tables[0].isAvailable, true);
});
