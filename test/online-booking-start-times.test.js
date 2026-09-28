const { test } = require("node:test");
const assert = require("node:assert/strict");
const { bookingStartTimes, OnlineBookingsService } = require("../dist/modules/online-bookings/online-bookings.service.js");

test("weekly lunch and dinner windows contain arrival slots even when a reservation lasts longer", () => {
  const lunch = bookingStartTimes({ isEnabled: true, startTime: "12:00", endTime: "14:30", intervalMin: 10 }, 180);
  const dinner = bookingStartTimes({ isEnabled: true, startTime: "20:00", endTime: "21:30", intervalMin: 10 }, 180);
  assert.equal(lunch[0], "12:00");
  assert.equal(lunch.at(-1), "14:20");
  assert.equal(lunch.length, 15);
  assert.equal(dinner[0], "20:00");
  assert.equal(dinner.at(-1), "21:20");
  assert.equal(dinner.length, 9);
});

test("special services keep their full reserved duration within each turn", () => {
  const first = bookingStartTimes({ isEnabled: true, startTime: "12:00", endTime: "14:00", intervalMin: 120, durationMinutes: 120, specialServiceId: "first" }, 180);
  const second = bookingStartTimes({ isEnabled: true, startTime: "14:30", endTime: "16:00", intervalMin: 90, durationMinutes: 90, specialServiceId: "second" }, 180);
  const tooShort = bookingStartTimes({ isEnabled: true, startTime: "12:00", endTime: "13:30", intervalMin: 90, durationMinutes: 120, specialServiceId: "short" }, 180);
  assert.deepEqual(first, ["12:00"]);
  assert.deepEqual(second, ["14:30"]);
  assert.deepEqual(tooShort, []);
});

test("calendar, availability and creation agree on weekly and special-service starts", async () => {
  const futureMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 2, 1));
  const month = futureMonth.toISOString().slice(0, 7);
  const specialDate = `${month}-18`;
  const regularDate = `${month}-19`;
  const branch = { id: "branch", publicSlug: "puerto-madero", isEnabled: true, publicBookingEnabled: true, onlineBookingDurationMinutes: 180, name: "Puerto Madero" };
  const restaurant = { id: "restaurant", name: "Estilo Campo", isActive: true, onlineBooking: { isEnabled: true, minPartySize: 1, maxPartySize: 15, maxAdvanceDays: 180, minAdvanceMinutes: 0 }, branches: [branch] };
  const prisma = {
    restaurant: { findUnique: async () => restaurant },
    branch: { findFirst: async () => branch },
    specialService: { findMany: async ({ where }) => where.serviceDate.toISOString().slice(0, 10) === specialDate ? [
      { id: "first", startTime: "12:00", endTime: "14:00", intervalMin: 120, durationMinutes: 120, turnoverMinutes: 0, label: "Primer turno" },
      { id: "second", startTime: "14:30", endTime: "16:00", intervalMin: 90, durationMinutes: 90, turnoverMinutes: 0, label: "Segundo turno" }
    ] : [] },
    bookingException: { findFirst: async () => null },
    bookingWindow: { findMany: async () => [
      { isEnabled: true, startTime: "12:00", endTime: "14:30", intervalMin: 10 },
      { isEnabled: true, startTime: "20:00", endTime: "21:30", intervalMin: 10 }
    ] },
    bookingCutoffRule: { findFirst: async () => null }
  };
  const assignment = { roomId: "room" };
  const reservations = { findAvailableRoomForRestaurant: async () => assignment, createReservationForRestaurant: async () => ({ code: "ABC123", serviceTime: "14:20", partySize: 2 }) };
  const service = new OnlineBookingsService(prisma, reservations, {});
  const calendar = await service.calendar("estilo-campo", { branch: branch.publicSlug, month, partySize: 2 }, "test-calendar");
  assert.ok(calendar.availableDates.includes(specialDate));
  assert.ok(calendar.availableDates.includes(regularDate));
  const regular = await service.availability("estilo-campo", { branch: branch.publicSlug, date: regularDate, partySize: 2, preferredFeatures: [] }, "test-regular");
  assert.equal(regular.slots.length, 24);
  assert.ok(regular.slots.some((slot) => slot.time === "14:20"));
  const special = await service.availability("estilo-campo", { branch: branch.publicSlug, date: specialDate, partySize: 2, preferredFeatures: [] }, "test-special");
  assert.deepEqual(special.slots.map((slot) => slot.time), ["12:00", "14:30"]);
  const created = await service.createPublicReservation("estilo-campo", { branch: branch.publicSlug, date: regularDate, partySize: 2, time: "14:20", fullName: "Test Guest", phone: "1234567", preferredFeatures: [] }, "test-create");
  assert.equal(created.code, "ABC123");
});
