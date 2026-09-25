import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { RequestUser } from "../../common/auth/request-user";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import type { PreferredFeature } from "../reservations/preferred-features";
import { ReservationsService } from "../reservations/reservations.service";

type Schedule = { isEnabled: boolean; startTime: string; endTime: string; intervalMin: number; service?: "lunch" | "dinner"; durationMinutes?: number; turnoverMinutes?: number; label?: string; specialServiceId?: string };
const requests = new Map<string, number[]>();
const ARGENTINA_TIMEZONE = "America/Argentina/Buenos_Aires";

function serviceDate(date: string) { return new Date(`${date}T00:00:00.000Z`); }
function weekday(date: string, timezone: string) {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(new Date(`${date}T12:00:00Z`));
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(day);
}
function timeToMinutes(value: string) { const [hours, minutes] = value.split(":").map(Number); return hours * 60 + minutes; }
function minutesToTime(value: number) { return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`; }

@Injectable()
export class OnlineBookingsService {
  constructor(private readonly prisma: PrismaService, private readonly reservations: ReservationsService, private readonly audit: AuditService) {}

  private assertOwner(user: RequestUser) {
    if (user.scope !== "restaurant" || !user.restaurantId || user.role !== "restaurant_owner") throw new ForbiddenException("Only the restaurant owner can manage online bookings");
    return user.restaurantId;
  }
  private restaurantScope(user: RequestUser) {
    if (user.scope !== "restaurant" || !user.restaurantId) throw new ForbiddenException("Restaurant context required");
    return user.restaurantId;
  }
  async listSpecialServices(user: RequestUser, input: { branchId: string; serviceDate?: string }) {
    const restaurantId = this.restaurantScope(user);
    return this.prisma.specialService.findMany({ where: { restaurantId, branchId: input.branchId, ...(input.serviceDate ? { serviceDate: serviceDate(input.serviceDate) } : {}) }, orderBy: [{ serviceDate: "asc" }, { position: "asc" }] });
  }
  async saveSpecialServices(user: RequestUser, input: { branchId: string; serviceDate: string; services: Array<{ id?: string; label: string; startTime: string; endTime: string }> }) {
    const restaurantId = this.assertOwner(user);
    const date = serviceDate(input.serviceDate);
    const branch = await this.prisma.branch.findFirst({ where: { id: input.branchId, restaurantId }, select: { id: true } });
    if (!branch) throw new ForbiddenException("Invalid branch");
    const labels = new Set(input.services.map((item) => item.label.trim().toLocaleLowerCase()));
    if (labels.size !== input.services.length || input.services.some((item) => !item.label.trim() || timeToMinutes(item.endTime) <= timeToMinutes(item.startTime))) throw new BadRequestException("Invalid special service");
    const ordered = [...input.services].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
    if (ordered.some((item, index) => index > 0 && timeToMinutes(item.startTime) < timeToMinutes(ordered[index - 1].endTime))) throw new BadRequestException("Special services cannot overlap");
    const existing = await this.prisma.specialService.findMany({ where: { restaurantId, branchId: input.branchId, serviceDate: date }, include: { reservations: { select: { id: true } } } });
    const incomingIds = new Set(input.services.flatMap((item) => item.id ? [item.id] : []));
    for (const current of existing) {
      const next = input.services.find((item) => item.id === current.id);
      if (current.reservations.length && (!next || current.startTime !== next.startTime || current.endTime !== next.endTime)) throw new ConflictException("No se puede modificar o eliminar una franja con reservas asociadas.");
      if (current.reservations.length && !incomingIds.has(current.id)) throw new ConflictException("No se puede eliminar una franja con reservas asociadas.");
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.specialService.deleteMany({ where: { restaurantId, branchId: input.branchId, serviceDate: date, id: { notIn: [...incomingIds] } } });
      for (const [position, item] of input.services.entries()) {
        const serviceMinutes = timeToMinutes(item.endTime) - timeToMinutes(item.startTime);
        const data = { label: item.label.trim(), startTime: item.startTime, endTime: item.endTime, intervalMin: serviceMinutes, durationMinutes: serviceMinutes, turnoverMinutes: 0, position };
        if (item.id) await tx.specialService.update({ where: { id: item.id }, data });
        else await tx.specialService.create({ data: { restaurantId, branchId: input.branchId, serviceDate: date, ...data } });
      }
    });
    await this.audit.log({ action: "special_services.updated", targetType: "branch", targetId: input.branchId, restaurantId, restaurantUserId: user.sub, metadata: { serviceDate: input.serviceDate, count: input.services.length } });
    return this.listSpecialServices(user, input);
  }
  private limit(key: string) {
    const now = Date.now(); const active = (requests.get(key) || []).filter((at) => at > now - 60_000);
    if (active.length >= 30) throw new HttpException("Too many requests. Please try again shortly.", HttpStatus.TOO_MANY_REQUESTS);
    active.push(now); requests.set(key, active);
  }
  private async restaurantBySlug(slug: string) {
    const restaurant = await this.prisma.restaurant.findUnique({ where: { slug }, include: { customization: true, onlineBooking: true, branches: { orderBy: { createdAt: "asc" } } } });
    if (!restaurant || !restaurant.isActive) throw new NotFoundException("Restaurant not found");
    if (!restaurant.onlineBooking?.isEnabled) throw new ConflictException("Online bookings are currently unavailable");
    return restaurant;
  }
  private async schedulesFor(restaurantId: string, branchId: string, date: string, timezone: string): Promise<Schedule[]> {
    const specialServices = await this.prisma.specialService.findMany({ where: { restaurantId, branchId, serviceDate: serviceDate(date) }, orderBy: { position: "asc" } });
    if (specialServices.length) return specialServices.map((item) => ({ isEnabled: true, startTime: item.startTime, endTime: item.endTime, intervalMin: item.intervalMin, durationMinutes: item.durationMinutes, turnoverMinutes: item.turnoverMinutes, label: item.label, specialServiceId: item.id }));
    const exception = await this.prisma.bookingException.findFirst({ where: { restaurantId, branchId, serviceDate: serviceDate(date) } });
    if (exception) {
      if (exception.type !== "custom_hours") return [];
      const windows = Array.isArray(exception.windows) ? exception.windows : [];
      return windows.filter((item): item is { startTime: string; endTime: string; intervalMin?: number; service?: "lunch" | "dinner" } => Boolean(item && typeof item === "object" && "startTime" in item && "endTime" in item)).map((item) => ({ isEnabled: true, startTime: item.startTime, endTime: item.endTime, intervalMin: item.intervalMin || 15, service: item.service }));
    }
    const windows = await this.prisma.bookingWindow.findMany({ where: { restaurantId, branchId, weekday: weekday(date, timezone) }, orderBy: [{ service: "asc" }, { startTime: "asc" }] });
    if (windows.length) return windows.filter((window) => window.isEnabled);
    const legacy = await this.prisma.onlineBookingException.findFirst({ where: { restaurantId, branchId, serviceDate: serviceDate(date) } });
    if (legacy) return legacy.isClosed || !legacy.startTime || !legacy.endTime || !legacy.intervalMin ? [] : [{ isEnabled: true, startTime: legacy.startTime, endTime: legacy.endTime, intervalMin: legacy.intervalMin }];
    const legacySchedule = await this.prisma.onlineBookingSchedule.findFirst({ where: { restaurantId, branchId, weekday: weekday(date, timezone), isEnabled: true } });
    return legacySchedule ? [legacySchedule] : [];
  }
  private async resolveBranch(restaurantId: string, publicSlug: string) {
    const branch = await this.prisma.branch.findFirst({ where: { restaurantId, publicSlug } });
    if (!branch) throw new NotFoundException("Branch not found");
    return branch;
  }
  private validateWindow(date: string, settings: { minAdvanceMinutes: number; maxAdvanceDays: number; maximumAdvanceValue?: number; maximumAdvanceUnit?: "days" | "weeks" | "months" }, timezone: string) {
    const now = new Date();
    const max = new Date(now);
    const amount = settings.maximumAdvanceValue || settings.maxAdvanceDays;
    if (settings.maximumAdvanceUnit === "months") max.setMonth(max.getMonth() + amount); else max.setDate(max.getDate() + amount * (settings.maximumAdvanceUnit === "weeks" ? 7 : 1));
    const selected = new Date(`${date}T12:00:00Z`);
    if (selected > max || Number.isNaN(selected.getTime())) throw new BadRequestException("Selected date is outside the booking window");
    const localToday = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now);
    if (date < localToday) throw new BadRequestException("Selected date is no longer available");
  }
  private async minimumAdvance(restaurantId: string, date: string, time: string, timezone: string, fallback: number) {
    const service = timeToMinutes(time) < 17 * 60 ? "lunch" : "dinner";
    const rule = await this.prisma.bookingCutoffRule.findFirst({ where: { restaurantId, service, weekdays: { has: weekday(date, timezone) } } });
    if (!rule) return fallback;
    const localToday = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
    return rule.sameDayOnly && date !== localToday ? fallback : rule.minimumAdvanceMinutes;
  }
  private meetsAdvance(date: string, time: string, minAdvanceMinutes: number, timezone: string) {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const get = (type: string) => parts.find((part) => part.type === type)?.value || "00";
    const today = `${get("year")}-${get("month")}-${get("day")}`;
    return date !== today || timeToMinutes(time) >= timeToMinutes(`${get("hour")}:${get("minute")}`) + minAdvanceMinutes;
  }

  async getOwnerConfig(user: RequestUser) {
    const restaurantId = this.assertOwner(user);
    const [restaurant, settings, bookingWindows, legacySchedules, exceptions, legacyExceptions] = await Promise.all([
      this.prisma.restaurant.findUniqueOrThrow({ where: { id: restaurantId }, select: { name: true, slug: true, profileImageUrl: true, branches: { select: { id: true, name: true, publicSlug: true, timezone: true, onlineBookingDurationMinutes: true }, orderBy: { createdAt: "asc" } } } }),
      this.prisma.onlineBookingSettings.findUnique({ where: { restaurantId } }),
      this.prisma.bookingWindow.findMany({ where: { restaurantId }, orderBy: [{ branchId: "asc" }, { weekday: "asc" }, { service: "asc" }] }),
      this.prisma.onlineBookingSchedule.findMany({ where: { restaurantId }, orderBy: [{ branchId: "asc" }, { weekday: "asc" }] }),
      this.prisma.bookingException.findMany({ where: { restaurantId }, orderBy: { serviceDate: "asc" } }),
      this.prisma.onlineBookingException.findMany({ where: { restaurantId }, orderBy: { serviceDate: "asc" } })
    ]);
    const windows = bookingWindows.length ? bookingWindows : legacySchedules.map((schedule) => ({ ...schedule, service: timeToMinutes(schedule.startTime) < 17 * 60 ? "lunch" as const : "dinner" as const }));
    const normalizedExceptions = exceptions.length ? exceptions : legacyExceptions.map((item) => ({ branchId: item.branchId, serviceDate: item.serviceDate, type: item.isClosed ? "closed" as const : "custom_hours" as const, windows: item.isClosed || !item.startTime || !item.endTime ? [] : [{ service: item.startTime < "17:00" ? "lunch" as const : "dinner" as const, startTime: item.startTime, endTime: item.endTime, intervalMin: item.intervalMin || 15 }] }));
    return { restaurant, settings: settings || { isEnabled: false, coverImageUrl: null, whatsappPhone: null, accentColor: "#FF5A00", publicTheme: "classic", minAdvanceMinutes: 60, maxAdvanceDays: 60, minPartySize: 1, maxPartySize: 15, largePartyThreshold: null, agencyPartyThreshold: null, remindersEnabled: false, reminderPartySizeFrom: null, reminderHoursBefore: null }, bookingWindows: windows, exceptions: normalizedExceptions.map((item) => ({ ...item, serviceDate: item.serviceDate.toISOString().slice(0, 10) })) };
  }

  async saveOwnerConfig(user: RequestUser, input: { isEnabled: boolean; coverImageUrl?: string | null; whatsappPhone?: string | null; accentColor: string; publicTheme?: "classic" | "campo" | "bistro"; minAdvanceMinutes: number; maxAdvanceDays: number; minPartySize: number; maxPartySize: number; largePartyThreshold?: number | null; agencyPartyThreshold?: number | null; remindersEnabled?: boolean; reminderPartySizeFrom?: number | null; reminderHoursBefore?: number | null; branchDurations?: Array<{ branchId: string; durationMinutes: number }>; bookingWindows: Array<{ branchId: string; weekday: number; service: "lunch" | "dinner"; isEnabled: boolean; startTime: string; endTime: string; intervalMin: number }>; exceptions: Array<{ branchId: string; serviceDate: string; type: "closed" | "custom_hours" | "fully_booked" | "booking_disabled"; windows?: Array<{ service: "lunch" | "dinner"; startTime: string; endTime: string; intervalMin: number }> }> }) {
    const restaurantId = this.assertOwner(user);
    const branchIds = new Set((await this.prisma.branch.findMany({ where: { restaurantId }, select: { id: true } })).map((item) => item.id));
    if ([...input.bookingWindows, ...input.exceptions, ...(input.branchDurations || [])].some((item) => !branchIds.has(item.branchId))) throw new ForbiddenException("Invalid branch");
    if (input.bookingWindows.some((item) => timeToMinutes(item.endTime) <= timeToMinutes(item.startTime))) throw new BadRequestException("End time must be after start time");
    if (input.exceptions.some((item) => item.type === "custom_hours" && (!item.windows?.length || item.windows.some((window) => timeToMinutes(window.endTime) <= timeToMinutes(window.startTime))))) throw new BadRequestException("Invalid date exception");
    await this.prisma.$transaction(async (tx) => {
      const settingsData = { isEnabled: input.isEnabled, coverImageUrl: input.coverImageUrl || null, ...(input.whatsappPhone === undefined ? {} : { whatsappPhone: input.whatsappPhone || null }), accentColor: input.accentColor, publicTheme: input.publicTheme || "classic", minAdvanceMinutes: input.minAdvanceMinutes, maxAdvanceDays: input.maxAdvanceDays, minPartySize: input.minPartySize, maxPartySize: input.maxPartySize, largePartyThreshold: input.largePartyThreshold || null, agencyPartyThreshold: input.agencyPartyThreshold || null, remindersEnabled: input.remindersEnabled || false, reminderPartySizeFrom: input.remindersEnabled ? input.reminderPartySizeFrom || null : null, reminderHoursBefore: input.remindersEnabled ? input.reminderHoursBefore || null : null };
      await tx.onlineBookingSettings.upsert({ where: { restaurantId }, create: { restaurantId, ...settingsData }, update: settingsData });
      await tx.restaurantCustomization.upsert({ where: { restaurantId }, create: { restaurantId }, update: { configVersion: { increment: 1 } } });
      await Promise.all((input.branchDurations || []).map((item) => tx.branch.update({ where: { id: item.branchId }, data: { onlineBookingDurationMinutes: item.durationMinutes } })));
      await tx.onlineBookingSchedule.deleteMany({ where: { restaurantId } });
      await tx.bookingWindow.deleteMany({ where: { restaurantId } });
      if (input.bookingWindows.length) await tx.bookingWindow.createMany({ data: input.bookingWindows.map((item) => ({ ...item, restaurantId })) });
      await tx.bookingException.deleteMany({ where: { restaurantId } });
      if (input.exceptions.length) await tx.bookingException.createMany({ data: input.exceptions.map((item) => ({ restaurantId, branchId: item.branchId, serviceDate: serviceDate(item.serviceDate), type: item.type, windows: item.windows || undefined })) });
    });
    await this.audit.log({ action: "online_booking.updated", targetType: "restaurant", targetId: restaurantId, restaurantId, restaurantUserId: user.sub });
    return this.getOwnerConfig(user);
  }

  async getPublicProfile(slug: string) {
    const restaurant = await this.restaurantBySlug(slug);
    const tables = await this.prisma.table.findMany({ where: { restaurantId: restaurant.id, isActive: true, isReservable: true }, select: { metadata: true } });
    const supportedFeatures = (["nearWindow", "nearColumn", "nearWall", "nearCorridor", "hasWindowView"] as PreferredFeature[]).filter((feature) => tables.some((table) => {
      const metadata = table.metadata as { derivedFeatures?: Record<string, boolean>; manualFeatures?: { hasTvView?: boolean } } | null;
      return feature === "hasWindowView" ? metadata?.manualFeatures?.hasTvView === true : metadata?.derivedFeatures?.[feature] === true;
    }));
    const settings = restaurant.onlineBooking;
    const customization = restaurant.customization;
    return { name: restaurant.name, slug: restaurant.slug, logoUrl: restaurant.profileImageUrl, coverImageUrl: settings?.coverImageUrl || null, whatsappPhone: customization?.humanSupportWhatsapp || settings?.whatsappPhone || null, accentColor: settings?.accentColor || "#FF5A00", publicTheme: settings?.publicTheme || "classic", minPartySize: settings?.minPartySize || 1, maxPartySize: settings?.maxPartySize || 15, largePartyThreshold: settings?.largePartyThreshold || null, commentsEnabled: settings?.commentsEnabled ?? true, publicInfo: { address: settings?.showAddress ? customization?.address || null : null, phone: settings?.showPhone ? customization?.phone || null : null, menuUrl: settings?.showMenu ? customization?.menuUrl || null : null, instagramUrl: settings?.showInstagram ? customization?.instagramUrl || null : null, mapsUrl: settings?.showGoogleMaps ? customization?.mapsUrl || null : null }, supportedFeatures, branches: restaurant.branches.filter((branch) => branch.isEnabled && branch.publicBookingEnabled).map((branch) => ({ slug: branch.publicSlug, name: branch.publicName || branch.name })) };
  }

  async availability(slug: string, input: { branch: string; date: string; partySize: number; preferredFeatures: PreferredFeature[] }, ip: string, skipLimit = false) {
    if (!skipLimit) this.limit(`${ip}:${slug}:availability`);
    const restaurant = await this.restaurantBySlug(slug); const settings = restaurant.onlineBooking!;
    const branch = await this.resolveBranch(restaurant.id, input.branch);
    if (!branch.isEnabled || !branch.publicBookingEnabled) throw new NotFoundException("Branch not found");
    if (input.partySize < settings.minPartySize || input.partySize > settings.maxPartySize) throw new BadRequestException("Party size is outside the allowed range");
    this.validateWindow(input.date, settings, ARGENTINA_TIMEZONE);
    if (settings.largePartyThreshold && input.partySize > settings.largePartyThreshold) return { date: input.date, partySize: input.partySize, slots: [], fallbackAction: "whatsapp" };
    const schedules = await this.schedulesFor(restaurant.id, branch.id, input.date, ARGENTINA_TIMEZONE);
    if (!schedules.length) return { date: input.date, partySize: input.partySize, slots: [] };
    const slots: Array<{ time: string; available: boolean }> = [];
    for (const schedule of schedules) for (let minute = timeToMinutes(schedule.startTime); minute + (schedule.durationMinutes || branch.onlineBookingDurationMinutes) + (schedule.turnoverMinutes || 0) <= timeToMinutes(schedule.endTime); minute += schedule.intervalMin) {
      const time = minutesToTime(minute);
      if (!this.meetsAdvance(input.date, time, await this.minimumAdvance(restaurant.id, input.date, time, ARGENTINA_TIMEZONE, settings.minAdvanceMinutes), ARGENTINA_TIMEZONE)) continue;
      const available = await this.reservations.findAvailableRoomForRestaurant({ restaurantId: restaurant.id, branchId: branch.id, partySize: input.partySize, serviceDate: input.date, serviceTime: time, preferredFeatures: input.preferredFeatures, durationMinutes: schedule.durationMinutes || branch.onlineBookingDurationMinutes, turnoverMinutes: schedule.turnoverMinutes || 0 });
      if (available) slots.push({ time, available: true });
    }
    return { date: input.date, partySize: input.partySize, slots };
  }

  async validateSlot(slug: string, input: { branch: string; date: string; partySize: number; time: string; preferredFeatures: PreferredFeature[] }, ip: string) {
    const result = await this.availability(slug, input, ip);
    if (!result.slots.some((slot) => slot.time === input.time)) throw new ConflictException({ code: "SLOT_UNAVAILABLE", message: "This time is no longer available" });
    return { available: true };
  }

  async calendar(slug: string, input: { branch: string; month: string; partySize: number; preferredFeatures: PreferredFeature[] }, ip: string) {
    this.limit(`${ip}:${slug}:calendar`);
    const [year, month] = input.month.split("-").map(Number); const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const dates = Array.from({ length: last }, (_, index) => `${input.month}-${String(index + 1).padStart(2, "0")}`);
    const restaurant = await this.restaurantBySlug(slug); const settings = restaurant.onlineBooking!;
    const branch = await this.resolveBranch(restaurant.id, input.branch);
    if (input.partySize < settings.minPartySize || input.partySize > settings.maxPartySize) throw new BadRequestException("Party size is outside the allowed range");
    if (settings.largePartyThreshold && input.partySize > settings.largePartyThreshold) return { month: input.month, availableDates: [] };
    const availableDates: string[] = [];
    for (const date of dates) {
      try {
        this.validateWindow(date, settings, ARGENTINA_TIMEZONE);
        const schedules = await this.schedulesFor(restaurant.id, branch.id, date, ARGENTINA_TIMEZONE);
        const bookable = await this.branchHasBookableSlot({ restaurantId: restaurant.id, branchId: branch.id, fallbackDurationMinutes: branch.onlineBookingDurationMinutes, date, partySize: input.partySize, schedules, settings });
        if (bookable) availableDates.push(date);
      } catch { /* Closed and out-of-window dates remain unavailable. */ }
    }
    return { month: input.month, availableDates };
  }

  // A date is only offered when at least one slot can actually seat the party,
  // using the same single-table/combination resolution as the availability endpoint.
  private async branchHasBookableSlot(input: { restaurantId: string; branchId: string; fallbackDurationMinutes: number; date: string; partySize: number; schedules: Schedule[]; settings: { minAdvanceMinutes: number } }) {
    for (const schedule of input.schedules) {
      const durationMinutes = schedule.durationMinutes || input.fallbackDurationMinutes;
      const turnoverMinutes = schedule.turnoverMinutes || 0;
      for (let minute = timeToMinutes(schedule.startTime); minute + durationMinutes + turnoverMinutes <= timeToMinutes(schedule.endTime); minute += schedule.intervalMin) {
        const time = minutesToTime(minute);
        if (!this.meetsAdvance(input.date, time, await this.minimumAdvance(input.restaurantId, input.date, time, ARGENTINA_TIMEZONE, input.settings.minAdvanceMinutes), ARGENTINA_TIMEZONE)) continue;
        const available = await this.reservations.findAvailableRoomForRestaurant({ restaurantId: input.restaurantId, branchId: input.branchId, partySize: input.partySize, serviceDate: input.date, serviceTime: time, durationMinutes, turnoverMinutes });
        if (available) return true;
      }
    }
    return false;
  }

  async createPublicReservation(slug: string, input: { branch: string; date: string; partySize: number; time: string; fullName: string; phone: string; notes?: string; preferredFeatures: PreferredFeature[]; website?: string }, ip: string) {
    this.limit(`${ip}:${slug}:create`);
    if (input.website) throw new BadRequestException("Unable to submit reservation");
    const restaurant = await this.restaurantBySlug(slug); const settings = restaurant.onlineBooking!;
    const branch = await this.resolveBranch(restaurant.id, input.branch);
    if (input.partySize < settings.minPartySize || input.partySize > settings.maxPartySize) throw new BadRequestException("Party size is outside the allowed range");
    this.validateWindow(input.date, settings, ARGENTINA_TIMEZONE);
    const schedules = await this.schedulesFor(restaurant.id, branch.id, input.date, ARGENTINA_TIMEZONE);
    const schedule = schedules.find((item) => timeToMinutes(input.time) >= timeToMinutes(item.startTime) && timeToMinutes(input.time) + (item.durationMinutes || branch.onlineBookingDurationMinutes) + (item.turnoverMinutes || 0) <= timeToMinutes(item.endTime) && (timeToMinutes(input.time) - timeToMinutes(item.startTime)) % item.intervalMin === 0);
    if (!schedule) throw new ConflictException({ code: "SLOT_UNAVAILABLE", message: "This time is no longer available" });
    if (!this.meetsAdvance(input.date, input.time, await this.minimumAdvance(restaurant.id, input.date, input.time, ARGENTINA_TIMEZONE, settings.minAdvanceMinutes), ARGENTINA_TIMEZONE)) throw new ConflictException({ code: "SLOT_UNAVAILABLE", message: "This time is no longer available" });
    const available = await this.reservations.findAvailableRoomForRestaurant({ restaurantId: restaurant.id, branchId: branch.id, partySize: input.partySize, serviceDate: input.date, serviceTime: input.time, preferredFeatures: input.preferredFeatures, durationMinutes: schedule.durationMinutes || branch.onlineBookingDurationMinutes, turnoverMinutes: schedule.turnoverMinutes || 0 });
    if (!available) throw new ConflictException({ code: "SLOT_UNAVAILABLE", message: "This time is no longer available" });
    try {
      const reservation = await this.reservations.createReservationForRestaurant(restaurant.id, { branchId: branch.id, roomId: available.roomId, fullName: input.fullName, phone: input.phone, partySize: input.partySize, serviceDate: input.date, serviceTime: input.time, preferredFeatures: input.preferredFeatures, notes: input.notes, durationMinutes: schedule.durationMinutes || branch.onlineBookingDurationMinutes, turnoverMinutes: schedule.turnoverMinutes || 0 }, { source: "public_web" });
      return { code: reservation.code, date: input.date, time: reservation.serviceTime, partySize: reservation.partySize, branch: branch.name, restaurant: restaurant.name };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new ConflictException({ code: "SLOT_UNAVAILABLE", message: "This time is no longer available" });
      throw error;
    }
  }
}
