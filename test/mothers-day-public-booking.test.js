const { test } = require("node:test");
const assert = require("node:assert/strict");
const { OnlineBookingsService } = require("../dist/modules/online-bookings/online-bookings.service.js");

function fixture({ special = true, dinner = true, name = "Estilo Campo", slug = "estilo-campo" } = {}) {
  const branch = { id: "branch", publicSlug: "puerto-madero", name: "Puerto Madero", isEnabled: true, publicBookingEnabled: true, onlineBookingDurationMinutes: 120 };
  const restaurant = { id: "restaurant", name, slug, isActive: true, onlineBooking: { isEnabled: true, minPartySize: 1, maxPartySize: 15, maxAdvanceDays: 180, minAdvanceMinutes: 0 }, branches: [branch] };
  const prisma = {
    restaurant: { findUnique: async () => restaurant }, branch: { findFirst: async () => branch },
    table: { findMany: async () => [] },
    specialService: { findMany: async () => special ? [
      { id: "first", startTime: "12:00", endTime: "14:00", intervalMin: 120, durationMinutes: 120, turnoverMinutes: 0 },
      { id: "second", startTime: "14:30", endTime: "16:00", intervalMin: 90, durationMinutes: 90, turnoverMinutes: 0 }
    ] : [] },
    bookingException: { findFirst: async () => null },
    bookingWindow: { findMany: async () => [
      { isEnabled: true, service: "lunch", startTime: "12:00", endTime: "14:30", intervalMin: 15 },
      { isEnabled: dinner, service: "dinner", startTime: "20:00", endTime: "21:30", intervalMin: 15 }
    ] },
    bookingCutoffRule: { findFirst: async () => null }
  };
  const created = [];
  const service = new OnlineBookingsService(prisma, {
    findAvailableRoomForRestaurant: async () => ({ roomId: "room" }),
    createReservationForRestaurant: async (_, data) => { created.push(data); return { code: "ABC123", serviceTime: data.serviceTime, partySize: data.partySize }; }
  }, {});
  // Keep event policy tests independent of the day on which the suite runs.
  service.validateWindow = () => {};
  service.meetsAdvance = () => true;
  const input = { branch: branch.publicSlug, date: "2026-10-18", partySize: 2, preferredFeatures: [], fullName: "Test Guest", phone: "1234567" };
  return { service, input, created, prisma };
}

test("Mother's Day lunch cannot be listed, validated or created publicly; dinner remains bookable", async () => {
  const { service, input, created } = fixture();
  const availability = await service.availability("estilo-campo", input, "mothers-day");
  assert.deepEqual(availability.slots.map((slot) => slot.time), ["20:00", "20:15", "20:30", "20:45", "21:00", "21:15", "21:30"]);
  for (const time of ["12:00", "14:30"]) {
    await assert.rejects(service.validateSlot("estilo-campo", { ...input, time }, `validate-${time}`), { status: 409 });
    await assert.rejects(service.createPublicReservation("estilo-campo", { ...input, time }, `create-${time}`), { status: 409 });
  }
  assert.equal(created.length, 0);
  assert.equal((await service.createPublicReservation("estilo-campo", { ...input, time: "20:00" }, "dinner")).code, "ABC123");
  assert.equal(created.length, 1);
});

test("the lunch restriction also covers regular windows and is limited to this restaurant and date", async () => {
  const { service, input } = fixture({ special: false });
  assert.ok((await service.availability("estilo-campo", input, "regular-event")).slots.every((slot) => slot.time >= "17:00"));
  const otherDay = await service.availability("estilo-campo", { ...input, date: "2026-10-19" }, "other-day");
  assert.ok(otherDay.slots.some((slot) => slot.time === "12:00"));
  const otherRestaurant = fixture({ name: "Otro restaurante", slug: "otro" });
  assert.ok((await otherRestaurant.service.availability("otro", input, "other-restaurant")).slots.some((slot) => slot.time === "12:00"));
  assert.equal((await otherRestaurant.service.getPublicProfile("otro")).specialLunchNotice, null);
});

test("calendar keeps the date accessible for WhatsApp even when dinner has no availability", async () => {
  const { service, input } = fixture({ dinner: false });
  const calendar = await service.calendar("estilo-campo", { branch: input.branch, month: "2026-10", partySize: 2 }, "calendar-event");
  assert.ok(!calendar.availableDates.includes(input.date));
  assert.deepEqual(calendar.contactDates, [input.date]);
  assert.deepEqual((await service.availability("estilo-campo", input, "no-dinner")).slots, []);
  const profile = await service.getPublicProfile("estilo-campo");
  assert.equal(profile.specialLunchNotice.date, input.date);
  assert.equal(profile.specialLunchNotice.introduction, "El servicio es a la carta.");
});
