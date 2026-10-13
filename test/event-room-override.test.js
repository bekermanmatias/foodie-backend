const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ReservationsService } = require("../dist/modules/reservations/reservations.service.js");

const date = new Date("2026-10-31");

function serviceFor(usage, blocked = false) {
  const prisma = {
    roomBookingBlock: { findUnique: async () => blocked ? { id: "block" } : null },
    roomBookingRule: { findFirst: async () => null },
    reservationRoomAssignment: {
      findFirst: async ({ where }) => usage && (!where.usage || where.usage === usage) ? { id: "assignment" } : null
    }
  };
  return new ReservationsService(prisma, {}, {});
}

test("partial event allows reservations without an override", async () => {
  const service = serviceFor("partial");
  await assert.doesNotReject(service.assertRoomIsBookable("restaurant", "room", date, "noche"));
  await assert.doesNotReject(service.assertRoomIsBookable("restaurant", "room", date, "noche", undefined, undefined, undefined, true));
});

test("full event and room closures cannot be overridden", async () => {
  await assert.rejects(serviceFor("full").assertRoomIsBookable("restaurant", "room", date, "noche", undefined, undefined, undefined, true), { status: 409 });
  await assert.rejects(serviceFor("partial", true).assertRoomIsBookable("restaurant", "room", date, "noche", undefined, undefined, undefined, true), { status: 409 });
});

test("other restaurant roles cannot request an override", async () => {
  const service = serviceFor("partial");
  await assert.rejects(service.create({ scope: "restaurant", restaurantId: "restaurant", role: "host" }, { allowEventRoomConflict: true }), { status: 403 });
});

function availabilityService(usage = "partial") {
  const service = serviceFor(usage);
  Object.assign(service.prisma, {
    roomBookingBlock: { findMany: async () => [] },
    roomBookingRule: { findMany: async () => [] },
    room: { findMany: async () => [{ id: "room" }] },
    table: { findMany: async () => [{ id: "six", label: "6", seats: 6 }, { id: "two", label: "2", seats: 2 }] },
    reservation: { findMany: async () => [] },
    serviceState: { findMany: async () => [] },
    tableCombination: { findMany: async () => [] }
  });
  service.prisma.reservationRoomAssignment.findMany = async () => [{ allocatedCovers: 2, reservation: { serviceTime: "13:00", durationMinutes: 180, turnoverMinutes: 0 } }];
  service.resolveSpecialService = async () => null;
  return service;
}

const availabilityInput = { restaurantId: "restaurant", branchId: "branch", roomId: "room", serviceDate: date, turn: "mediodia", serviceTime: "13:00", partySize: 6 };

test("a partial event leaves a six-person table bookable and is considered by bot room search", async () => {
  const service = availabilityService();
  assert.deepEqual((await service.listAvailableTables(service.prisma, availabilityInput)).map((table) => table.id), ["six", "two"]);
  assert.equal((await service.findAvailableRoomForRestaurant({ ...availabilityInput, serviceDate: "2026-10-31" })).roomId, "room");
  assert.equal(await availabilityService("full").findAvailableRoomForRestaurant({ ...availabilityInput, serviceDate: "2026-10-31" }), null);
});

test("partial-event covers and occupied tables reduce the capacity available for new reservations", async () => {
  const service = availabilityService();
  assert.deepEqual(await service.listAvailableTables(service.prisma, { ...availabilityInput, partySize: 7 }), []);
  service.prisma.reservation.findMany = async () => [{ serviceTime: "13:00", durationMinutes: 180, turnoverMinutes: 0, tables: [{ tableId: "two" }] }];
  assert.deepEqual(await service.listAvailableTables(service.prisma, availabilityInput), []);
  assert.deepEqual((await service.listAvailableTables(service.prisma, { ...availabilityInput, partySize: 4 })).map((table) => table.id), ["six"]);
});

test("partial events do not consume capacity outside their time window", async () => {
  const service = availabilityService();
  assert.equal((await service.listAvailableTables(service.prisma, { ...availabilityInput, serviceTime: "16:00", partySize: 8 })).length, 2);
});
