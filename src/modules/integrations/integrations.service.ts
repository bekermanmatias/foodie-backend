import { Injectable } from "@nestjs/common";
import { BadRequestException, ConflictException, ForbiddenException, HttpException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ReservationsService } from "../reservations/reservations.service";
import { verifyPassword } from "../../common/security/password";
import { RealtimeService } from "../realtime/realtime.service";
import { createRequestHash, normalizeReservationCode } from "../../common/utils/code";
import { AuditService } from "../audit/audit.service";
import { hashOpaqueToken } from "../../common/security/token-hash";
import type { PreferredFeature } from "../reservations/preferred-features";
import { compileAssistantSystemMessage, FOODIE_CORE_PROMPT_VERSION } from "./core-prompt";

type ResolvedIntegrationToken = {
  id: string;
  restaurantId: string;
  isGlobal: boolean;
};

const localDate = (timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}`;
};

const dateAfter = (date: string) => {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
};

@Injectable()
export class IntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservationsService: ReservationsService,
    private readonly realtimeService: RealtimeService,
    private readonly auditService: AuditService
  ) {}

  recentEvents() {
    return this.realtimeService.recent();
  }

  async getExternalRestaurantProfile(apiKey: string) {
    const token = await this.resolveToken(apiKey);
    if (!token) throw new ForbiddenException("Invalid API key");
    await this.consumeRateLimit(token.restaurantId);
    const now = new Date();
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: token.restaurantId },
      include: {
        customization: true,
        onlineBooking: true,
        specials: { where: { isActive: true, startsAt: { lte: now }, endsAt: { gte: now } }, orderBy: [{ startsAt: "asc" }, { title: "asc" }] },
        branches: {
          include: {
              bookingWindows: { where: { isEnabled: true }, orderBy: [{ weekday: "asc" }, { service: "asc" }] },
              bookingExceptions: { where: { serviceDate: { gte: new Date(now.toISOString().slice(0, 10)) } }, orderBy: { serviceDate: "asc" } }
          },
          orderBy: { createdAt: "asc" }
        }
      }
    });
    await this.prisma.integrationToken.update({ where: { id: token.id }, data: { lastUsedAt: now } });
    const booking = restaurant.onlineBooking;
    return {
      restaurant: { name: restaurant.name, slug: restaurant.slug, description: restaurant.customization?.description || null, address: restaurant.customization?.address || null, mapsUrl: restaurant.customization?.mapsUrl || null, menuUrl: restaurant.customization?.menuUrl || null, whatsappPhone: booking?.whatsappPhone || null },
      specials: restaurant.specials.map((special) => ({ title: special.title, description: special.description, price: special.price ? Number(special.price) : null, imageUrl: special.imageUrl, externalUrl: special.externalUrl, startsAt: special.startsAt.toISOString().slice(0, 10), endsAt: special.endsAt.toISOString().slice(0, 10) })),
      reservationPolicy: { isEnabled: booking?.isEnabled || false, minAdvanceMinutes: booking?.minAdvanceMinutes || 60, maxAdvanceDays: booking?.maxAdvanceDays || 60, minPartySize: booking?.minPartySize || 1, maxPartySize: booking?.maxPartySize || 15 },
      branches: restaurant.branches.map((branch) => ({ id: branch.id, name: branch.name, timezone: branch.timezone, durationMinutes: branch.onlineBookingDurationMinutes, bookingWindows: branch.bookingWindows.map((window) => ({ weekday: window.weekday, service: window.service, startTime: window.startTime, endTime: window.endTime, intervalMin: window.intervalMin })), exceptions: branch.bookingExceptions.map((exception) => ({ serviceDate: exception.serviceDate.toISOString().slice(0, 10), type: exception.type, windows: exception.windows })) }))
    };
  }

  async getAssistantContext(apiKey: string) {
    const token = await this.resolveToken(apiKey);
    if (!token) throw new ForbiddenException("Invalid API key");
    await this.consumeRateLimit(token.restaurantId);
    const now = new Date();
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: token.restaurantId },
      include: {
        customization: true, onlineBooking: true,
        specials: { where: { isActive: true, startsAt: { lte: now }, endsAt: { gte: now } }, orderBy: { title: "asc" } },
        giftCardProducts: { where: { isActive: true }, orderBy: { createdAt: "asc" } },
        faqs: { where: { isActive: true }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
        assistantUpdates: { where: { isActive: true }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
        bookingCutoffs: true,
        branches: { where: { isEnabled: true }, include: { bookingWindows: { where: { isEnabled: true }, orderBy: [{ weekday: "asc" }, { service: "asc" }] }, bookingExceptions: { where: { serviceDate: { gte: new Date(now.toISOString().slice(0, 10)) } }, orderBy: { serviceDate: "asc" } }, openingHours: { orderBy: [{ weekday: "asc" }, { startTime: "asc" }] }, rooms: { where: { isActive: true }, select: { id: true, name: true, description: true, isOutdoor: true, bookingPriority: true, zones: { select: { id: true, name: true }, orderBy: { name: "asc" } }, bookingBlocks: { where: { serviceDate: { gte: new Date(now.toISOString().slice(0, 10)) } }, select: { serviceDate: true, turn: true }, orderBy: { serviceDate: "asc" } }, bookingRules: { where: { OR: [{ endsAt: null }, { endsAt: { gte: new Date(now.toISOString().slice(0, 10)) } }] }, select: { weekdays: true, turns: true, startsAt: true, endsAt: true } } }, orderBy: [{ bookingPriority: "asc" }, { createdAt: "asc" }] } }, orderBy: { createdAt: "asc" } }
      }
    });
    const c = restaurant.customization; const b = restaurant.onlineBooking;
    const timeZone = restaurant.branches[0]?.timezone || "America/Argentina/Buenos_Aires";
    const today = localDate(timeZone);
    const assistantUpdates = restaurant.assistantUpdates.filter((update) => update.validityType === "indefinite" || (update.startsAt && update.endsAt && update.startsAt.toISOString().slice(0, 10) <= today && update.endsAt.toISOString().slice(0, 10) >= today));
    const nextChangeDates = restaurant.assistantUpdates.flatMap((update) => {
      if (update.validityType === "indefinite" || !update.startsAt || !update.endsAt) return [];
      const start = update.startsAt.toISOString().slice(0, 10);
      const end = update.endsAt.toISOString().slice(0, 10);
      return start > today ? [start] : end >= today ? [dateAfter(end)] : [];
    }).sort();
    const nextContextChangeAt = nextChangeDates[0] ? new Date(`${nextChangeDates[0]}T00:00:00.000Z`).toISOString() : null;
    const context = {
      restaurant: { name: restaurant.name, slug: restaurant.slug, description: c?.description || null, cuisineType: c?.cuisineType || null, address: c?.address || null, city: c?.city || null, province: c?.province || null, country: c?.country || null, phone: c?.phone || null, whatsapp: c?.humanSupportWhatsapp || b?.whatsappPhone || null, email: c?.email || null, websiteUrl: c?.websiteUrl || null, instagramUrl: c?.instagramUrl || null, googleMapsUrl: c?.mapsUrl || null, menuUrl: c?.menuUrl || null },
      assistant: { enabled: c?.assistantEnabled ?? true, name: c?.assistantName || null, role: c?.assistantRole || "asistente virtual", locale: c?.assistantLocale || "es-AR", tone: c?.assistantTone || "calido_breve_profesional", firstGreeting: c?.assistantFirstGreeting || null, disclosure: c?.assistantDisclosure ?? true, humanSupport: { phone: c?.humanSupportPhone || c?.phone || null, whatsapp: c?.humanSupportWhatsapp || b?.whatsappPhone || null, email: c?.humanSupportEmail || c?.email || null } },
      reservationPolicy: { publicBookingEnabled: b?.isEnabled || false, minimumAdvanceMinutes: b?.minAdvanceMinutes || 60, maximumAdvance: { value: b?.maximumAdvanceValue || b?.maxAdvanceDays || 60, unit: b?.maximumAdvanceUnit || "days" }, onlinePartySize: { min: b?.minPartySize || 1, max: b?.maxPartySize || 15 }, largeParty: { partySizeFrom: b?.largePartyThreshold || null, action: b?.largePartyThreshold ? "whatsapp" : null }, agency: { partySizeFrom: b?.agencyPartyThreshold || null, action: b?.agencyPartyThreshold ? "ask_if_agency" : null }, reminder: { enabled: b?.remindersEnabled ?? false, partySizeFrom: b?.reminderPartySizeFrom || null, hoursBefore: b?.reminderHoursBefore || null, channel: "whatsapp" }, cutoffRules: restaurant.bookingCutoffs.map((rule) => ({ service: rule.service, weekdays: rule.weekdays, minimumAdvanceMinutes: rule.minimumAdvanceMinutes, sameDayOnly: rule.sameDayOnly, fallbackAction: rule.fallbackAction })) },
      branches: restaurant.branches.map((branch) => ({ id: branch.id, name: branch.publicName || branch.name, enabled: branch.isEnabled, timezone: branch.timezone, publicBookingEnabled: branch.publicBookingEnabled, address: branch.address || c?.address || null, contact: { phone: branch.phone || c?.phone || null, whatsapp: branch.whatsappPhone || c?.humanSupportWhatsapp || b?.whatsappPhone || null }, durationMinutes: branch.onlineBookingDurationMinutes, openingHours: branch.openingHours.map((hour) => ({ weekday: hour.weekday, startTime: hour.startTime, endTime: hour.endTime, endsNextDay: hour.endsNextDay })), bookingWindows: branch.bookingWindows.map((window) => ({ weekday: window.weekday, service: window.service, startTime: window.startTime, endTime: window.endTime, intervalMinutes: window.intervalMin })), exceptions: branch.bookingExceptions.map((exception) => ({ date: exception.serviceDate.toISOString().slice(0, 10), type: exception.type, windows: exception.windows })), rooms: branch.rooms.map((room) => ({ id: room.id, name: room.name, description: room.description, isOutdoor: room.isOutdoor, bookingPriority: room.bookingPriority, zones: room.zones, bookingBlocks: room.bookingBlocks.map((block) => ({ date: block.serviceDate.toISOString().slice(0, 10), turn: block.turn })), bookingRules: room.bookingRules.map((rule) => ({ weekdays: rule.weekdays, turns: rule.turns, startsAt: rule.startsAt.toISOString().slice(0, 10), endsAt: rule.endsAt?.toISOString().slice(0, 10) || null })) })) })),
      specials: restaurant.specials.map((special) => ({ name: special.title, description: special.description, price: special.price ? Number(special.price) : null, validFrom: special.startsAt.toISOString().slice(0, 10), validUntil: special.endsAt.toISOString().slice(0, 10) })),
      faqs: restaurant.faqs.map((faq) => ({ topic: faq.topic, question: faq.question, answer: faq.answer })),
      assistantUpdates: assistantUpdates.map((update) => ({ title: update.title, category: update.category, content: update.content, validityType: update.validityType, startsAt: update.startsAt?.toISOString().slice(0, 10) || null, endsAt: update.endsAt?.toISOString().slice(0, 10) || null })),
      giftCards: { products: restaurant.giftCardProducts.map((product) => ({ id: product.id, name: product.name, type: product.type, description: product.description, price: product.price ? Number(product.price) : null, minAmount: product.minAmount ? Number(product.minAmount) : null, maxAmount: product.maxAmount ? Number(product.maxAmount) : null, partySize: product.partySize, currency: product.currency, validityDays: product.validityDays, excludedDates: product.excludedDates, restrictions: product.restrictions })) }
    };
    await this.prisma.integrationToken.update({ where: { id: token.id }, data: { lastUsedAt: now } });
    return { configVersion: c?.configVersion || 1, updatedAt: c?.updatedAt || restaurant.updatedAt, nextContextChangeAt, corePromptVersion: FOODIE_CORE_PROMPT_VERSION, context, systemMessage: compileAssistantSystemMessage(context) };
  }

  async listExternalRooms(apiKey: string, input: { restaurantId?: string; branchId?: string; serviceDate?: string; turn?: "mediodia" | "noche" }) {
    const token = await this.resolveToken(apiKey, input.restaurantId);
    if (!token) {
      throw new ForbiddenException("Invalid API key");
    }

    await this.consumeRateLimit(token.restaurantId);

    const branches = await this.prisma.branch.findMany({
      where: {
        restaurantId: token.restaurantId,
        ...(input.branchId ? { id: input.branchId } : {})
      },
      select: {
        id: true,
        name: true,
        timezone: true,
        rooms: {
          where: { isActive: true },
          select: {
            id: true,
            name: true,
            description: true,
            isOutdoor: true,
            bookingPriority: true,
            zones: {
              select: { id: true, name: true },
              orderBy: { name: "asc" }
            },
            bookingBlocks: input.serviceDate && input.turn ? { where: { serviceDate: new Date(input.serviceDate), turn: input.turn }, select: { id: true } } : false,
            bookingRules: input.serviceDate && input.turn ? { where: { weekdays: { has: new Date(input.serviceDate).getUTCDay() }, turns: { has: input.turn }, startsAt: { lte: new Date(input.serviceDate) }, OR: [{ endsAt: null }, { endsAt: { gte: new Date(input.serviceDate) } }] }, select: { id: true } } : false,
            _count: {
              select: {
                tables: { where: { isActive: true } }
              }
            }
          },
          orderBy: [{ bookingPriority: "asc" }, { createdAt: "asc" }]
        }
      },
      orderBy: { createdAt: "asc" }
    });

    await this.prisma.integrationToken.update({
      where: { id: token.id },
      data: { lastUsedAt: new Date() }
    });

    return {
      restaurantId: token.restaurantId,
      branches: branches.map((branch) => ({ ...branch, rooms: branch.rooms.map((room) => ({ ...room, isBlocked: (Array.isArray(room.bookingBlocks) && room.bookingBlocks.length > 0) || (Array.isArray(room.bookingRules) && room.bookingRules.length > 0), bookingBlocks: undefined, bookingRules: undefined })) }))
    };
  }

  async quoteExternalReservation(
    apiKey: string,
    input: {
      restaurantId?: string;
      branchId: string;
      roomId: string;
      partySize: number;
      serviceDate: string;
      serviceTime?: string;
      turn?: "mediodia" | "noche";
      preferredZone?: string;
      preferredFeatures: PreferredFeature[];
    }
  ) {
    const token = await this.resolveToken(apiKey, input.restaurantId);
    if (!token) {
      throw new ForbiddenException("Invalid API key");
    }

    await this.consumeRateLimit(token.restaurantId);

    const quote = await this.reservationsService.quoteReservationForRestaurant({
      restaurantId: token.restaurantId,
      branchId: input.branchId,
      roomId: input.roomId,
      partySize: input.partySize,
      serviceDate: input.serviceDate,
      serviceTime: input.serviceTime,
      turn: input.turn,
      preferredZone: input.preferredZone,
      preferredFeatures: input.preferredFeatures
    });

    await this.prisma.integrationToken.update({
      where: { id: token.id },
      data: { lastUsedAt: new Date() }
    });

    return quote;
  }

  async createExternalReservation(
    apiKey: string,
    input: {
      restaurantId?: string;
      branchId: string;
      roomId: string;
      fullName: string;
      phone: string;
      email?: string | null;
      partySize: number;
      serviceDate: string;
      serviceTime?: string;
      turn?: "mediodia" | "noche";
      preferredZone?: string;
      preferredFeatures: PreferredFeature[];
      preferredTags?: string[];
      birthday?: string;
      notes?: string;
    },
    idempotencyKey?: string
  ) {
    const token = await this.resolveToken(apiKey, input.restaurantId);
    if (!token) {
      throw new ForbiddenException("Invalid API key");
    }

    await this.consumeRateLimit(token.restaurantId);
    const requestHash = createRequestHash(input);

    let existingRequest: {
      id: string;
      requestHash: string;
      status: "success" | "error";
      responseData: unknown;
    } | null = null;

    if (idempotencyKey) {
      existingRequest = await this.prisma.externalApiRequest.findFirst({
        where: {
          restaurantId: token.restaurantId,
          action: "create_reservation",
          idempotencyKey
        },
        select: {
          id: true,
          requestHash: true,
          status: true,
          responseData: true
        }
      });

      if (existingRequest && existingRequest.requestHash !== requestHash) {
        throw new ConflictException("Idempotency key already used with a different payload");
      }

      if (existingRequest?.status === "success" && existingRequest.responseData) {
        return existingRequest.responseData;
      }
    }

    const requestLog = existingRequest
      ? await this.prisma.externalApiRequest.update({
          where: { id: existingRequest.id },
          data: {
            integrationTokenId: token.id,
            requestHash,
            status: "error",
            responseData: Prisma.DbNull,
            errorMessage: null,
            processedAt: null
          }
        })
      : await this.prisma.externalApiRequest.create({
          data: {
            restaurantId: token.restaurantId,
            integrationTokenId: token.id,
            action: "create_reservation",
            idempotencyKey,
            requestHash,
            status: "error"
          }
        });

    try {
      const { restaurantId: _restaurantId, ...reservationInput } = input;
      const created = await this.reservationsService.createReservationForRestaurant(
        token.restaurantId,
        reservationInput,
        { idempotencyKey, source: "integration" }
      );
      const metadata = created.metadata && typeof created.metadata === "object" && !Array.isArray(created.metadata)
        ? created.metadata as {
            seatingPreference?: {
              requestedFeatures?: PreferredFeature[];
              matched?: boolean;
              assignedFeatures?: Record<PreferredFeature, boolean>;
              assignedTableLabels?: string[];
            };
          }
        : null;
      const seatingPreference = metadata?.seatingPreference;
      const response = {
        ...created,
        preference: {
          requested: seatingPreference?.requestedFeatures || input.preferredFeatures,
          matched: seatingPreference?.matched === true
        },
        assignment: seatingPreference
          ? {
              tableLabels: seatingPreference.assignedTableLabels || [],
              features: seatingPreference.assignedFeatures || null
            }
          : null
      };

      await this.prisma.$transaction([
        this.prisma.externalApiRequest.update({
          where: { id: requestLog.id },
          data: {
            status: "success",
            responseData: response,
            processedAt: new Date()
          }
        }),
        this.prisma.integrationToken.update({
          where: { id: token.id },
          data: { lastUsedAt: new Date() }
        })
      ]);

      await this.auditService.log({
        action: "external_reservation.created",
        targetType: "integration_token",
        targetId: token.id,
        restaurantId: token.restaurantId,
        metadata: { idempotencyKey: idempotencyKey || null }
      });

      return response;
    } catch (error) {
      await this.prisma.externalApiRequest.update({
        where: { id: requestLog.id },
        data: {
          status: "error",
          errorMessage: error instanceof Error ? error.message : "Unknown external reservation error",
          processedAt: new Date()
        }
      });
      throw error;
    }
  }

  async updateExternalReservation(
    apiKey: string,
    input: {
      restaurantId?: string;
      code: string;
      branchId?: string;
      roomId?: string;
      fullName?: string;
      phone?: string;
      email?: string;
      partySize?: number;
      serviceDate?: string;
      serviceTime?: string;
      turn?: "mediodia" | "noche";
      preferredZone?: string | null;
      preferredTags?: string[];
      birthday?: string | null;
      notes?: string | null;
    },
    idempotencyKey?: string
  ) {
    const token = await this.resolveToken(apiKey, input.restaurantId);
    if (!token) {
      throw new ForbiddenException("Invalid API key");
    }

    await this.consumeRateLimit(token.restaurantId);
    const requestHash = createRequestHash(input);

    let existingRequest: {
      id: string;
      requestHash: string;
      status: "success" | "error";
      responseData: unknown;
    } | null = null;

    if (idempotencyKey) {
      existingRequest = await this.prisma.externalApiRequest.findFirst({
        where: {
          restaurantId: token.restaurantId,
          action: "update_reservation",
          idempotencyKey
        },
        select: {
          id: true,
          requestHash: true,
          status: true,
          responseData: true
        }
      });

      if (existingRequest && existingRequest.requestHash !== requestHash) {
        throw new ConflictException("Idempotency key already used with a different payload");
      }

      if (existingRequest?.status === "success" && existingRequest.responseData) {
        return existingRequest.responseData;
      }
    }

    const requestLog = existingRequest
      ? await this.prisma.externalApiRequest.update({
          where: { id: existingRequest.id },
          data: {
            integrationTokenId: token.id,
            requestHash,
            status: "error",
            responseData: Prisma.DbNull,
            errorMessage: null,
            processedAt: null
          }
        })
      : await this.prisma.externalApiRequest.create({
          data: {
            restaurantId: token.restaurantId,
            integrationTokenId: token.id,
            action: "update_reservation",
            idempotencyKey,
            requestHash,
            status: "error"
          }
        });

    try {
      const { restaurantId: _restaurantId, ...reservationInput } = input;
      const updated = await this.reservationsService.updateReservationForRestaurant(
        token.restaurantId,
        reservationInput,
        { idempotencyKey }
      );

      await this.prisma.$transaction([
        this.prisma.externalApiRequest.update({
          where: { id: requestLog.id },
          data: {
            status: "success",
            responseData: updated,
            processedAt: new Date()
          }
        }),
        this.prisma.integrationToken.update({
          where: { id: token.id },
          data: { lastUsedAt: new Date() }
        })
      ]);

      await this.auditService.log({
        action: "external_reservation.updated",
        targetType: "reservation",
        targetId: updated.id,
        restaurantId: token.restaurantId,
        metadata: { code: input.code, idempotencyKey: idempotencyKey || null }
      });

      return updated;
    } catch (error) {
      await this.prisma.externalApiRequest.update({
        where: { id: requestLog.id },
        data: {
          status: "error",
          errorMessage: error instanceof Error ? error.message : "Unknown external reservation update error",
          processedAt: new Date()
        }
      });
      throw error;
    }
  }

  async cancelExternalReservation(apiKey: string, input: { restaurantId?: string; code: string }, idempotencyKey?: string) {
    const token = await this.resolveToken(apiKey, input.restaurantId);
    if (!token) {
      throw new ForbiddenException("Invalid API key");
    }

    await this.consumeRateLimit(token.restaurantId);

    let existingRequest:
      | {
          status: "success" | "error";
          responseData: unknown;
        }
      | null = null;

    if (idempotencyKey) {
      existingRequest = await this.prisma.externalApiRequest.findFirst({
        where: {
          restaurantId: token.restaurantId,
          action: "cancel_reservation",
          idempotencyKey
        },
        select: {
          status: true,
          responseData: true
        }
      });

      if (existingRequest?.status === "success" && existingRequest.responseData) {
        return existingRequest.responseData;
      }
    }

    const requestLog = await this.prisma.externalApiRequest.create({
      data: {
        restaurantId: token.restaurantId,
        integrationTokenId: token.id,
        action: "cancel_reservation",
        idempotencyKey,
        requestHash: createRequestHash(input),
        status: "error"
      }
    });

    const reservation = await this.prisma.reservation.findFirst({
      where: { restaurantId: token.restaurantId, codeNormalized: normalizeReservationCode(input.code) }
    });
    if (!reservation) {
      throw new ForbiddenException("Reservation not found for this token");
    }

    await this.prisma.reservation.update({
      where: { id: reservation.id },
      data: { status: "cancelled" }
    });

    await this.prisma.serviceState.updateMany({
      where: {
        restaurantId: token.restaurantId,
        reservationId: reservation.id
      },
      data: {
        status: "free",
        reservationId: null
      }
    });

    this.realtimeService.publish("reservation.cancelled", {
      restaurantId: token.restaurantId,
      reservationId: reservation.id
    });

    await this.prisma.integrationToken.update({
      where: { id: token.id },
      data: { lastUsedAt: new Date() }
    });

    await this.auditService.log({
      action: "external_reservation.cancelled",
      targetType: "reservation",
      targetId: reservation.id,
      restaurantId: token.restaurantId,
      metadata: { code: input.code }
    });

    const result = { ok: true, code: input.code };

    await this.prisma.externalApiRequest.update({
      where: { id: requestLog.id },
      data: {
        status: "success",
        responseData: result,
        processedAt: new Date()
      }
    });

    return result;
  }

  async checkInExternalReservation(apiKey: string, input: { restaurantId?: string; code: string }, idempotencyKey?: string) {
    return this.transitionExternalReservation(apiKey, input, "check_in_reservation", "seated", idempotencyKey);
  }

  async releaseExternalReservation(apiKey: string, input: { restaurantId?: string; code: string }, idempotencyKey?: string) {
    return this.transitionExternalReservation(apiKey, input, "release_reservation", "completed", idempotencyKey);
  }

  private async transitionExternalReservation(
    apiKey: string,
    input: { restaurantId?: string; code: string },
    action: "check_in_reservation" | "release_reservation",
    nextStatus: "seated" | "completed",
    idempotencyKey?: string
  ) {
    const token = await this.resolveToken(apiKey, input.restaurantId);
    if (!token) {
      throw new ForbiddenException("Invalid API key");
    }

    await this.consumeRateLimit(token.restaurantId);
    const requestHash = createRequestHash(input);

    let existingRequest:
      | {
          id: string;
          requestHash: string;
          status: "success" | "error";
          responseData: unknown;
        }
      | null = null;

    if (idempotencyKey) {
      existingRequest = await this.prisma.externalApiRequest.findFirst({
        where: {
          restaurantId: token.restaurantId,
          action,
          idempotencyKey
        },
        select: {
          id: true,
          requestHash: true,
          status: true,
          responseData: true
        }
      });

      if (existingRequest && existingRequest.requestHash !== requestHash) {
        throw new ConflictException("Idempotency key already used with a different payload");
      }

      if (existingRequest?.status === "success" && existingRequest.responseData) {
        return existingRequest.responseData;
      }
    }

    const requestLog = existingRequest
      ? await this.prisma.externalApiRequest.update({
          where: { id: existingRequest.id },
          data: {
            integrationTokenId: token.id,
            requestHash,
            status: "error",
            responseData: Prisma.DbNull,
            errorMessage: null,
            processedAt: null
          }
        })
      : await this.prisma.externalApiRequest.create({
          data: {
            restaurantId: token.restaurantId,
            integrationTokenId: token.id,
            action,
            idempotencyKey,
            requestHash,
            status: "error"
          }
        });

    try {
      const updated = await this.reservationsService.moveReservationToStateForRestaurant(
        token.restaurantId,
        { code: input.code },
        nextStatus,
        { idempotencyKey: idempotencyKey || null }
      );

      await this.prisma.$transaction([
        this.prisma.externalApiRequest.update({
          where: { id: requestLog.id },
          data: {
            status: "success",
            responseData: updated,
            processedAt: new Date()
          }
        }),
        this.prisma.integrationToken.update({
          where: { id: token.id },
          data: { lastUsedAt: new Date() }
        })
      ]);

      await this.auditService.log({
        action: nextStatus === "seated" ? "external_reservation.checked_in" : "external_reservation.completed",
        targetType: "reservation",
        targetId: updated.id,
        restaurantId: token.restaurantId,
        metadata: { code: input.code, idempotencyKey: idempotencyKey || null }
      });

      return updated;
    } catch (error) {
      await this.prisma.externalApiRequest.update({
        where: { id: requestLog.id },
        data: {
          status: "error",
          errorMessage: error instanceof Error ? error.message : "Unknown external reservation transition error",
          processedAt: new Date()
        }
      });
      throw error;
    }
  }

  async findExternalCustomer(apiKey: string, input: { restaurantId?: string; email?: string; phone?: string }) {
    const token = await this.resolveToken(apiKey, input.restaurantId);
    if (!token) {
      throw new ForbiddenException("Invalid API key");
    }

    await this.consumeRateLimit(token.restaurantId);

    const customer = await this.reservationsService.findCustomerForRestaurant(token.restaurantId, {
      email: input.email,
      phone: input.phone
    });

    await this.prisma.integrationToken.update({
      where: { id: token.id },
      data: { lastUsedAt: new Date() }
    });

    return customer;
  }

  async findExternalReservation(apiKey: string, input: { restaurantId?: string; code?: string; phone?: string; serviceDate?: string }) {
    const token = await this.resolveToken(apiKey, input.restaurantId);
    if (!token) {
      throw new ForbiddenException("Invalid API key");
    }

    await this.consumeRateLimit(token.restaurantId);

    const reservation = await this.reservationsService.findReservationForRestaurant(token.restaurantId, {
      code: input.code,
      phone: input.phone,
      serviceDate: input.serviceDate
    });

    await this.prisma.integrationToken.update({
      where: { id: token.id },
      data: { lastUsedAt: new Date() }
    });

    return reservation;
  }

  async searchExternalReservations(
    apiKey: string,
    input: { restaurantId?: string; fullName: string; serviceDate?: string; phone?: string }
  ) {
    const token = await this.resolveToken(apiKey, input.restaurantId);
    if (!token) {
      throw new ForbiddenException("Invalid API key");
    }

    const fullName = input.fullName.trim();
    const phone = input.phone?.trim();
    const serviceDate = input.serviceDate ? new Date(`${input.serviceDate}T00:00:00.000Z`) : undefined;
    if (serviceDate && Number.isNaN(serviceDate.getTime())) {
      throw new BadRequestException("Invalid service date");
    }

    await this.consumeRateLimit(token.restaurantId);

    const where = {
      restaurantId: token.restaurantId,
      fullName: { equals: fullName, mode: "insensitive" as const },
      ...(phone ? { phone } : {}),
      ...(serviceDate ? { serviceDate } : {})
    };
    const [total, reservations] = await this.prisma.$transaction([
      this.prisma.reservation.count({ where }),
      this.prisma.reservation.findMany({
        where,
        select: {
          code: true,
          fullName: true,
          phone: true,
          partySize: true,
          serviceDate: true,
          serviceTime: true,
          status: true,
          branch: { select: { name: true } },
          room: { select: { name: true } }
        },
        orderBy: [{ serviceDate: "asc" }, { serviceTime: "asc" }],
        take: 50
      })
    ]);

    await this.prisma.integrationToken.update({
      where: { id: token.id },
      data: { lastUsedAt: new Date() }
    });

    const results = reservations.map((reservation) => ({
        code: reservation.code,
        fullName: reservation.fullName,
        phone: this.maskPhone(reservation.phone),
        partySize: reservation.partySize,
        serviceDate: reservation.serviceDate.toISOString().slice(0, 10),
        serviceTime: reservation.serviceTime,
        status: reservation.status,
        branch: reservation.branch.name,
        room: reservation.room.name
      }))
      .sort((left, right) => {
        const leftDistance = Math.abs(new Date(`${left.serviceDate}T${left.serviceTime}:00`).getTime() - Date.now());
        const rightDistance = Math.abs(new Date(`${right.serviceDate}T${right.serviceTime}:00`).getTime() - Date.now());
        return leftDistance - rightDistance;
      })
      .slice(0, 10);

    return {
      total,
      results
    };
  }

  private maskPhone(phone: string) {
    const value = phone.trim();
    return value.length <= 4 ? value : `••••${value.slice(-4)}`;
  }

  private async resolveToken(apiKey: string, restaurantId?: string): Promise<ResolvedIntegrationToken | null> {
    if (!apiKey) return null;

    const globalApiKey = process.env.FOODIE_EXTERNAL_API_KEY || process.env.FOODIE_GLOBAL_API_KEY;
    if (globalApiKey && apiKey === globalApiKey) {
      if (!restaurantId) {
        throw new ForbiddenException("restaurantId is required when using global API key");
      }

      const restaurant = await this.prisma.restaurant.findFirst({
        where: { id: restaurantId, isActive: true },
        select: { id: true }
      });
      if (!restaurant) {
        throw new ForbiddenException("Restaurant not found for global API key");
      }

      const tokenHash = hashOpaqueToken(apiKey);
      const token = await this.prisma.integrationToken.upsert({
        where: {
          id: `global_${restaurantId}`
        },
        update: {
          tokenHash,
          isActive: true,
          label: "Global external API key"
        },
        create: {
          id: `global_${restaurantId}`,
          restaurantId,
          label: "Global external API key",
          tokenHash,
          isActive: true
        },
        select: { id: true, restaurantId: true }
      });

      return { ...token, isGlobal: true };
    }

    const hashedApiKey = hashOpaqueToken(apiKey);
    const directMatch = await this.prisma.integrationToken.findFirst({
      where: {
        tokenHash: hashedApiKey,
        isActive: true
      },
      include: { restaurant: true }
    });
    if (directMatch) {
      if (restaurantId && directMatch.restaurantId !== restaurantId) {
        throw new ForbiddenException("API key does not belong to requested restaurant");
      }
      return { id: directMatch.id, restaurantId: directMatch.restaurantId, isGlobal: false };
    }

    const legacyTokens = await this.prisma.integrationToken.findMany({
      where: { isActive: true },
      include: { restaurant: true }
    });

    const legacyToken = legacyTokens.find((candidate) => verifyPassword(apiKey, candidate.tokenHash));
    if (!legacyToken) return null;
    if (restaurantId && legacyToken.restaurantId !== restaurantId) {
      throw new ForbiddenException("API key does not belong to requested restaurant");
    }
    return { id: legacyToken.id, restaurantId: legacyToken.restaurantId, isGlobal: false };
  }

  private async consumeRateLimit(restaurantId: string) {
    const lastMinute = new Date(Date.now() - 60_000);
    const count = await this.prisma.externalApiRequest.count({
      where: {
        restaurantId,
        createdAt: { gte: lastMinute }
      }
    });

    if (count >= 30) {
      throw new HttpException("Rate limit exceeded", 429);
    }
  }
}
