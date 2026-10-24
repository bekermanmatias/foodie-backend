import { BadRequestException, Body, Controller, Get, Headers, Post, Query } from "@nestjs/common";
import { IntegrationsService } from "./integrations.service";
import { Public } from "../../common/auth/public.decorator";
import { chatOrderSchema } from "../notifications/order-input";
import { z } from "zod";
import { preferredFeaturesSchema } from "../reservations/preferred-features";

const emptyToUndefined = (value: unknown) => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  return value;
};

const emptyToNull = (value: unknown) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return value;
};

const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const requiredString = z.preprocess(emptyToUndefined, z.string().min(1));
const optionalEmail = z.preprocess(emptyToUndefined, z.string().email().optional());
const optionalNullableString = z.preprocess(emptyToNull, z.string().nullable().optional());

const optionalTurn = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["mediodia", "medio dia", "almuerzo", "dia", "d\u00EDa"].includes(normalized)) return "mediodia";
  if (["noche", "cena"].includes(normalized)) return "noche";
  return normalized;
}, z.enum(["mediodia", "noche"]).optional());

const preferredTagsSchema = z.preprocess((value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const tags = value.split(",").map((tag) => tag.trim()).filter(Boolean);
    return tags.length ? tags : undefined;
  }
  return value;
}, z.array(z.string()).optional());

const quoteSchema = z.object({
  restaurantId: optionalString,
  branchId: requiredString,
  roomId: requiredString,
  partySize: z.coerce.number().int().min(1),
  serviceDate: requiredString,
  serviceTime: z.preprocess(emptyToUndefined, z.string().regex(/^\d{2}:\d{2}$/).optional()),
  turn: optionalTurn,
  preferredZone: optionalString,
  preferredFeatures: preferredFeaturesSchema
}).refine((value) => value.serviceTime || value.turn, {
  message: "serviceTime or turn is required"
});

const externalReservationSchema = z.object({
  restaurantId: optionalString,
  branchId: requiredString,
  roomId: requiredString,
  fullName: z.preprocess(emptyToUndefined, z.string().min(2)),
  phone: z.preprocess(emptyToUndefined, z.string().min(2)),
  email: optionalEmail,
  partySize: z.coerce.number().int().min(1),
  serviceDate: requiredString,
  serviceTime: z.preprocess(emptyToUndefined, z.string().regex(/^\d{2}:\d{2}$/).optional()),
  turn: optionalTurn,
  preferredZone: optionalString,
  preferredFeatures: preferredFeaturesSchema,
  preferredTags: preferredTagsSchema,
  birthday: optionalString,
  notes: optionalString
}).refine((value) => value.serviceTime || value.turn, {
  message: "serviceTime or turn is required"
});

const externalRoomsSchema = z.object({
  restaurantId: optionalString,
  branchId: optionalString,
  serviceDate: z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
  turn: optionalTurn
});

const cancellationSchema = z.object({
  restaurantId: optionalString,
  code: z.preprocess(emptyToUndefined, z.string().min(3))
});

const reservationCodeSchema = z.object({
  restaurantId: optionalString,
  code: z.preprocess(emptyToUndefined, z.string().min(3))
});

const reservationNameSearchSchema = z.object({
  restaurantId: optionalString,
  fullName: z.preprocess(emptyToUndefined, z.string().min(2)),
  serviceDate: z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
  phone: optionalString
});

const updateReservationSchema = z.object({
  restaurantId: optionalString,
  code: z.preprocess(emptyToUndefined, z.string().min(3)),
  branchId: optionalString,
  roomId: optionalString,
  fullName: z.preprocess(emptyToUndefined, z.string().min(2).optional()),
  phone: z.preprocess(emptyToUndefined, z.string().min(2).optional()),
  email: optionalEmail,
  partySize: z.coerce.number().int().min(1).optional(),
  serviceDate: optionalString,
  serviceTime: z.preprocess(emptyToUndefined, z.string().regex(/^\d{2}:\d{2}$/).optional()),
  turn: optionalTurn,
  preferredZone: optionalNullableString,
  preferredTags: preferredTagsSchema,
  birthday: optionalNullableString,
  notes: optionalNullableString
});

@Controller()
export class IntegrationsController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  @Public()
  @Post("external/notifications/chat-orders")
  chatOrder(@Headers("x-api-key") apiKey: string, @Body() body: unknown) {
    const result = chatOrderSchema.safeParse(body);
    if (!result.success) throw new BadRequestException("Datos del pedido inválidos");
    return this.integrationsService.receiveChatOrder(apiKey, result.data);
  }

  @Get("integrations/events")
  health() {
    return this.integrationsService.recentEvents();
  }

  @Public()
  @Get("external/restaurant-profile")
  restaurantProfile(@Headers("x-api-key") apiKey: string) {
    return this.integrationsService.getExternalRestaurantProfile(apiKey);
  }

  @Public()
  @Get("external/assistant/context")
  assistantContext(@Headers("x-api-key") apiKey: string) {
    return this.integrationsService.getAssistantContext(apiKey);
  }

  @Public()
  @Get("external/rooms")
  listExternalRooms(
    @Headers("x-api-key") apiKey: string,
    @Query("restaurantId") restaurantId?: string,
    @Query("branchId") branchId?: string,
    @Query("serviceDate") serviceDate?: string,
    @Query("turn") turn?: string
  ) {
    return this.integrationsService.listExternalRooms(apiKey, externalRoomsSchema.parse({ restaurantId, branchId, serviceDate, turn }));
  }

  @Public()
  @Post("external/reservations/quote")
  quoteExternalReservation(@Headers("x-api-key") apiKey: string, @Body() body: unknown) {
    return this.integrationsService.quoteExternalReservation(apiKey, quoteSchema.parse(body));
  }

  @Public()
  @Post("external/reservations")
  externalReservation(
    @Headers("x-api-key") apiKey: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown
  ) {
    return this.integrationsService.createExternalReservation(
      apiKey,
      externalReservationSchema.parse(body),
      idempotencyKey
    );
  }

  @Public()
  @Post("external/reservations/update")
  updateExternalReservation(
    @Headers("x-api-key") apiKey: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown
  ) {
    return this.integrationsService.updateExternalReservation(apiKey, updateReservationSchema.parse(body), idempotencyKey);
  }

  @Public()
  @Post("external/reservations/cancel")
  cancelExternalReservation(
    @Headers("x-api-key") apiKey: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown
  ) {
    return this.integrationsService.cancelExternalReservation(apiKey, cancellationSchema.parse(body), idempotencyKey);
  }

  @Public()
  @Post("external/reservations/check-in")
  checkInExternalReservation(
    @Headers("x-api-key") apiKey: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown
  ) {
    return this.integrationsService.checkInExternalReservation(apiKey, reservationCodeSchema.parse(body), idempotencyKey);
  }

  @Public()
  @Post("external/reservations/release")
  releaseExternalReservation(
    @Headers("x-api-key") apiKey: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown
  ) {
    return this.integrationsService.releaseExternalReservation(apiKey, reservationCodeSchema.parse(body), idempotencyKey);
  }

  @Public()
  @Get("external/customers/find")
  findExternalCustomer(
    @Headers("x-api-key") apiKey: string,
    @Query("restaurantId") restaurantId?: string,
    @Query("email") email?: string,
    @Query("phone") phone?: string
  ) {
    return this.integrationsService.findExternalCustomer(apiKey, { restaurantId, email, phone });
  }

  @Public()
  @Get("external/reservations/find")
  findExternalReservation(
    @Headers("x-api-key") apiKey: string,
    @Query("restaurantId") restaurantId?: string,
    @Query("code") code?: string,
    @Query("phone") phone?: string,
    @Query("serviceDate") serviceDate?: string
  ) {
    return this.integrationsService.findExternalReservation(apiKey, { restaurantId, code, phone, serviceDate });
  }

  @Public()
  @Get("external/reservations/search")
  searchExternalReservations(
    @Headers("x-api-key") apiKey: string,
    @Query("restaurantId") restaurantId?: string,
    @Query("fullName") fullName?: string,
    @Query("serviceDate") serviceDate?: string,
    @Query("phone") phone?: string
  ) {
    return this.integrationsService.searchExternalReservations(
      apiKey,
      reservationNameSearchSchema.parse({ restaurantId, fullName, serviceDate, phone })
    );
  }
}
