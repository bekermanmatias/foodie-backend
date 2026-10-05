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

test("partial event requires an explicit override", async () => {
  const service = serviceFor("partial");
  await assert.rejects(service.assertRoomIsBookable("restaurant", "room", date, "noche"), { status: 409 });
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
