const { test } = require("node:test");
const assert = require("node:assert/strict");
const { bookingStartTimes, OnlineBookingsService } = require("../dist/modules/online-bookings/online-bookings.service.js");
const { ReservationsService } = require("../dist/modules/reservations/reservations.service.js");

test("weekly lunch and dinner offer slots every 15 minutes, including the configured end", () => {
  const lunch = bookingStartTimes({ isEnabled: true, startTime: "12:00", endTime: "14:30", intervalMin: 10 }, 180);
  const dinner = bookingStartTimes({ isEnabled: true, startTime: "20:00", endTime: "21:30", intervalMin: 10 }, 180);
  assert.equal(lunch[0], "12:00");
  assert.equal(lunch.at(-1), "14:30");
  assert.equal(lunch.length, 11);
  assert.ok(lunch.every((time, index) => index === 0 || Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) - (Number(lunch[index - 1].slice(0, 2)) * 60 + Number(lunch[index - 1].slice(3))) === 15));
  assert.equal(dinner[0], "20:00");
  assert.equal(dinner.at(-1), "21:30");
  assert.equal(dinner.length, 7);
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
      { isEnabled: true, service: "lunch", startTime: "12:00", endTime: "14:30", intervalMin: 10 },
      { isEnabled: true, service: "dinner", startTime: "20:00", endTime: "21:30", intervalMin: 10 }
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
  assert.equal(regular.slots.length, 18);
  assert.ok(regular.slots.some((slot) => slot.time === "14:30"));
  const special = await service.availability("estilo-campo", { branch: branch.publicSlug, date: specialDate, partySize: 2, preferredFeatures: [] }, "test-special");
  assert.deepEqual(special.slots.map((slot) => slot.time), ["12:00", "14:30", "20:00", "20:15", "20:30", "20:45", "21:00", "21:15", "21:30"]);
  assert.deepEqual(special.slots.slice(0, 2), [
    { time: "12:00", available: true, departureTime: "14:00" },
    { time: "14:30", available: true, departureTime: "16:00" }
  ]);
  assert.equal(special.slots.find((slot) => slot.time === "20:00").departureTime, undefined);
  const dinner = await service.createPublicReservation("estilo-campo", { branch: branch.publicSlug, date: specialDate, partySize: 2, time: "20:00", fullName: "Test Guest", phone: "1234567", preferredFeatures: [] }, "test-special-dinner");
  assert.equal(dinner.code, "ABC123");
  await assert.rejects(service.createPublicReservation("estilo-campo", { branch: branch.publicSlug, date: specialDate, partySize: 2, time: "13:00", fullName: "Test Guest", phone: "1234567", preferredFeatures: [] }, "test-invalid-lunch"), { status: 409 });
  const created = await service.createPublicReservation("estilo-campo", { branch: branch.publicSlug, date: regularDate, partySize: 2, time: "14:30", fullName: "Test Guest", phone: "1234567", preferredFeatures: [] }, "test-create");
  assert.equal(created.code, "ABC123");
});

test("special shifts keep closed dates and disabled or custom dinner windows respected", async () => {
  const date = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 2, 18)).toISOString().slice(0, 10);
  const branch = { id: "branch", publicSlug: "branch", isEnabled: true, publicBookingEnabled: true, onlineBookingDurationMinutes: 120 };
  const restaurant = { id: "restaurant", isActive: true, onlineBooking: { isEnabled: true, minPartySize: 1, maxPartySize: 10, maxAdvanceDays: 180, minAdvanceMinutes: 0 } };
  let exception = null;
  let dinnerEnabled = false;
  const prisma = {
    restaurant: { findUnique: async () => restaurant }, branch: { findFirst: async () => branch },
    specialService: { findMany: async () => [{ id: "lunch", startTime: "12:00", endTime: "14:00", durationMinutes: 120, turnoverMinutes: 0, intervalMin: 120 }] },
    bookingException: { findFirst: async () => exception },
    bookingWindow: { findMany: async () => [{ isEnabled: dinnerEnabled, service: "dinner", startTime: "20:00", endTime: "20:30", intervalMin: 15 }] },
    bookingCutoffRule: { findFirst: async () => null }
  };
  const service = new OnlineBookingsService(prisma, { findAvailableRoomForRestaurant: async () => ({ roomId: "room" }) }, {});
  const query = { branch: "branch", date, partySize: 2, preferredFeatures: [] };
  assert.deepEqual((await service.availability("slug", query, "disabled-dinner")).slots.map((slot) => slot.time), ["12:00"]);
  dinnerEnabled = true;
  assert.deepEqual((await service.availability("slug", query, "regular-dinner")).slots.map((slot) => slot.time), ["12:00", "20:00", "20:15", "20:30"]);
  exception = { type: "custom_hours", windows: [{ service: "dinner", startTime: "21:00", endTime: "21:30" }] };
  assert.deepEqual((await service.availability("slug", query, "custom-dinner")).slots.map((slot) => slot.time), ["12:00", "21:00", "21:15", "21:30"]);
  exception = { type: "closed" };
  assert.deepEqual((await service.availability("slug", query, "closed-date")).slots, []);
});

test("reservation validation allows regular dinner alongside special lunch but rejects extra lunch starts", async () => {
  const date = new Date("2026-10-18T00:00:00.000Z");
  const prisma = { specialService: { findMany: async () => [{ id: "first", startTime: "12:00", endTime: "14:00", durationMinutes: 120, turnoverMinutes: 0 }] } };
  const reservations = new ReservationsService(prisma, {}, {});
  assert.equal((await reservations.resolveSpecialService("restaurant", "branch", date, "12:00")).id, "first");
  await assert.rejects(reservations.resolveSpecialService("restaurant", "branch", date, "13:00"), { status: 409 });
  assert.equal(await reservations.resolveSpecialService("restaurant", "branch", date, "20:00"), null);
});

test("custom dinner windows accept their last advertised arrival time", async () => {
  const prisma = { bookingException: { findUnique: async () => ({ type: "custom_hours", windows: [{ service: "dinner", startTime: "21:00", endTime: "21:30" }] }) } };
  const reservations = new ReservationsService(prisma, {}, {});
  const date = new Date("2026-10-18T00:00:00.000Z");
  await reservations.validateBookingException("restaurant", "branch", date, "21:30");
  await assert.rejects(reservations.validateBookingException("restaurant", "branch", date, "21:45"), { status: 409 });
});
