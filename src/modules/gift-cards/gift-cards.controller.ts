import { BadRequestException, Body, Controller, Delete, Get, Headers, Param, Post, Put, Query } from "@nestjs/common";
import { z } from "zod";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { Public } from "../../common/auth/public.decorator";
import { Roles } from "../../common/auth/roles.decorator";
import type { RequestUser } from "../../common/auth/request-user";
import { GiftCardsService } from "./gift-cards.service";

const productSchema = z.object({ name: z.string().trim().min(2).max(120), type: z.enum(["FIXED_MENU", "OPEN_AMOUNT"]), description: z.string().trim().min(2).max(2000), price: z.number().nonnegative().nullable().optional(), minAmount: z.number().nonnegative().nullable().optional(), maxAmount: z.number().nonnegative().nullable().optional(), partySize: z.number().int().positive().nullable().optional(), currency: z.string().trim().length(3).optional(), validityDays: z.number().int().min(1).max(3650), excludedDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(365).optional(), restrictions: z.record(z.unknown()).nullable().optional(), paymentAlias: z.string().trim().max(120).nullable().optional(), paymentCbu: z.string().trim().max(120).nullable().optional(), paymentHolder: z.string().trim().max(160).nullable().optional(), isActive: z.boolean().default(true) });
const orderSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  return {
    ...input,
    type: input.type || (input.amount !== undefined ? "OPEN_AMOUNT" : undefined),
    purchaserName: input.purchaserName || input.fullName,
    purchaserPhone: input.purchaserPhone || input.phone
  };
}, z.object({ productId: z.string().optional(), type: z.enum(["FIXED_MENU", "OPEN_AMOUNT"]), purchaserName: z.string().trim().min(2).max(160), purchaserPhone: z.string().trim().min(5).max(40), recipientName: z.string().trim().max(160).nullable().optional(), message: z.string().trim().max(1000).nullable().optional(), partySize: z.number().int().positive().nullable().optional(), amount: z.number().positive().optional(), currency: z.string().trim().length(3).optional() }));

function parseOrder(body: unknown) {
  try { return orderSchema.parse(body); }
  catch (error) { if (error instanceof z.ZodError) throw new BadRequestException({ message: "Los datos de la Gift Card no son válidos", issues: error.issues }); throw error; }
}

@Controller()
export class GiftCardsController {
  constructor(private readonly service: GiftCardsService) {}

  @Roles("restaurant_owner", "host", "events")
  @Get("restaurant/gift-cards/products") products(@CurrentUser() user: RequestUser) { return this.service.listProducts(user); }
  @Roles("restaurant_owner")
  @Post("restaurant/gift-cards/products") createProduct(@CurrentUser() user: RequestUser, @Body() body: unknown) { return this.service.saveProduct(user, undefined, productSchema.parse(body)); }
  @Roles("restaurant_owner")
  @Put("restaurant/gift-cards/products/:id") updateProduct(@CurrentUser() user: RequestUser, @Param("id") id: string, @Body() body: unknown) { return this.service.saveProduct(user, id, productSchema.parse(body)); }
  @Roles("restaurant_owner")
  @Delete("restaurant/gift-cards/products/:id") deleteProduct(@CurrentUser() user: RequestUser, @Param("id") id: string) { return this.service.deleteProduct(user, id); }
  @Roles("restaurant_owner")
  @Post("restaurant/gift-cards/products/preview") previewProduct(@CurrentUser() user: RequestUser, @Body() body: unknown) { return this.service.previewProduct(user, productSchema.parse(body)); }
  @Roles("restaurant_owner", "host", "events")
  @Get("restaurant/gift-cards/orders") orders(@CurrentUser() user: RequestUser, @Query("from") from?: string, @Query("to") to?: string, @Query("productId") productId?: string, @Query("status") status?: string, @Query("paymentStatus") paymentStatus?: string, @Query("giftCardStatus") giftCardStatus?: string, @Query("search") search?: string, @Query("page") page?: string, @Query("pageSize") pageSize?: string) { return this.service.listOrders(user, { from, to, productId, status, paymentStatus, giftCardStatus, search, page, pageSize }); }
  @Roles("restaurant_owner")
  @Post("restaurant/gift-cards/orders/:id/payment") payment(@CurrentUser() user: RequestUser, @Param("id") id: string, @Body() body: { approved?: boolean; reference?: string }) { return this.service.confirmPayment(user, id, body.approved === true, body.reference); }
  @Roles("restaurant_owner")
  @Post("restaurant/gift-cards/orders/:id/send") send(@CurrentUser() user: RequestUser, @Param("id") id: string) { return this.service.sendGiftCard(user, id); }
  @Roles("restaurant_owner")
  @Post("restaurant/gift-cards/orders/:id/cancel") cancel(@CurrentUser() user: RequestUser, @Param("id") id: string) { return this.service.cancelOrder(user, id); }
  @Roles("restaurant_owner")
  @Delete("restaurant/gift-cards/orders/:id") delete(@CurrentUser() user: RequestUser, @Param("id") id: string) { return this.service.deleteOrder(user, id); }
  @Roles("restaurant_owner", "host", "events")
  @Post("restaurant/gift-cards/redeem") redeem(@CurrentUser() user: RequestUser, @Body() body: { code?: string; notes?: string; reservationId?: string }) { return this.service.redeem(user, body); }

  @Public()
  @Get("external/gift-cards/products") externalProducts(@Headers("x-api-key") apiKey: string) { return this.service.listExternalProducts(apiKey); }
  @Public()
  @Post("external/gift-cards/orders") externalCreate(@Headers("x-api-key") apiKey: string, @Headers("idempotency-key") idempotencyKey: string | undefined, @Body() body: unknown) { return this.service.createExternal(apiKey, parseOrder(body), idempotencyKey); }
  @Public()
  @Get("external/gift-cards/orders/:id") externalGet(@Headers("x-api-key") apiKey: string, @Param("id") id: string) { return this.service.getExternal(apiKey, id); }
}
