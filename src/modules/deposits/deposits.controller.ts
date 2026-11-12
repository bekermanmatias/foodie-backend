import type { Response } from "express";
import { DepositDriveService } from "./deposit-drive.service";
import { depositActor } from "./deposit-access";
import { requireFeature, requireExternalAccess } from "../../common/restaurant-features";
import { Body, Controller, Get, Headers, Param, Post, Put, Query, Res, Delete } from "@nestjs/common";
import { z } from "zod";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { Public } from "../../common/auth/public.decorator";
import type { RequestUser } from "../../common/auth/request-user";
import { DepositsService } from "./deposits.service";
import { PrismaService } from "../prisma/prisma.service";
import { hashOpaqueToken } from "../../common/security/token-hash";
import { ForbiddenException } from "@nestjs/common";

const depositSchema = z.object({ requiredAmount: z.number().positive().multipleOf(0.01).max(99999999).optional(), useRules: z.boolean().optional(), dueAt: z.string().datetime().optional(), notes: z.string().max(2000).optional(), currency: z.literal("ARS").optional() });
const entrySchema = z.object({ type: z.enum(["payment", "refund", "adjustment"]), amount: z.number().positive().multipleOf(0.01).max(99999999), paidAt: z.string().min(10), paymentMethod: z.string().min(1).max(80), reference: z.string().max(160).optional(), notes: z.string().max(2000).optional(), proofIds: z.array(z.string()).max(20).optional(), idempotencyKey: z.string().min(8).max(120) });
const uploadSchema = z.object({ fileName: z.string().min(1).max(255), mimeType: z.enum(["application/pdf", "image/jpeg", "image/png", "image/webp"]), size: z.number().int().positive().max(10 * 1024 * 1024) });
const confirmSchema = uploadSchema.extend({ objectKey: z.string().min(1), messageId: z.string().max(255).optional(), caption: z.string().max(2000).optional() });
const proofReview = z.enum(["pending", "approved", "rejected"]);
const pageNumber = z.coerce.number().int().min(1).max(100000).optional();

@Controller()
export class DepositsController {
  constructor(private readonly service: DepositsService, private readonly prisma: PrismaService, private readonly drive: DepositDriveService) {}
  @Get("restaurant/deposits") list(@CurrentUser() user: RequestUser, @Query() query: Record<string, string>) {
    const parsed = z.object({ branchId: z.string().optional(), status: z.enum(["pending", "partial", "complete"]).optional(), phone: z.string().optional(), reservationId: z.string().optional(), from: z.string().date().optional(), to: z.string().date().optional(), review: proofReview.optional(), search: z.string().trim().max(120).optional(), expired: z.enum(["true", "false"]).optional().transform((value) => value === "true"), page: pageNumber }).parse(query);
    return this.service.list(user, parsed);
  }
  @Get("restaurant/deposits/events") async events(@CurrentUser() user: RequestUser) { const restaurantId = await depositActor(this.prisma, user); return this.prisma.specialService.findMany({ where: { restaurantId }, select: { id: true, label: true, serviceDate: true }, orderBy: { serviceDate: "desc" }, take: 200 }); }
  @Get("restaurant/deposits/reservation-options") options(@CurrentUser() user: RequestUser, @Query("search") search: string, @Query("page") page?: string) { return this.service.reservationOptions(user, search, pageNumber.parse(page)); }
  @Post("restaurant/deposits/:depositId/resolve-delivery") resolveDelivery(@CurrentUser() user: RequestUser, @Param("depositId") id: string, @Body() body: unknown) { const input = z.object({ outcome: z.enum(["sent", "not_sent"]), reference: z.string().trim().min(1).max(500) }).parse(body); return this.service.resolveDelivery(user, id, input.outcome, input.reference); }
  @Get("restaurant/deposits/contact-reservations") contact(@CurrentUser() user: RequestUser, @Query("phone") phone: string, @Query("page") page?: string) { return this.service.contactReservations(user, phone, pageNumber.parse(page)); }
  @Get("restaurant/deposits/settings") settings(@CurrentUser() user: RequestUser) { return this.service.settings(user); }
  @Put("restaurant/deposits/settings") configure(@CurrentUser() user: RequestUser, @Body() body: unknown) { return this.service.saveSettings(user, body); }
  @Post("restaurant/deposits/:depositId/confirm-reservation") async confirmReservation(@CurrentUser() user: RequestUser, @Param("depositId") id: string) {
    const result = await this.service.confirmReservation(user, id);
    try { return { ...result, delivery: await this.service.deliver(user, id) }; }
    catch (error) { return { ...result, delivery: { pending: true, error: error instanceof Error ? error.message : "Envío pendiente" } }; }
  }
  @Post("restaurant/deposits/:depositId/send-confirmation") deliver(@CurrentUser() user: RequestUser, @Param("depositId") id: string) { return this.service.deliver(user, id); }
  @Get("restaurant/deposits/:depositId/delivery") delivery(@CurrentUser() user: RequestUser, @Param("depositId") id: string) { return this.service.deliveryState(user, id); }
  @Get("restaurant/deposits/:depositId/proofs") proofs(@CurrentUser() user: RequestUser, @Param("depositId") id: string, @Query("page") page?: string, @Query("review") review?: string) {
    return this.service.proofs(user, id, pageNumber.parse(page) ?? 1, proofReview.optional().parse(review));
  }
  @Get("restaurant/deposits/:depositId/movements") movements(@CurrentUser() user: RequestUser, @Param("depositId") id: string, @Query("page") page?: string) {
    return this.service.movements(user, id, pageNumber.parse(page) ?? 1);
  }
  @Post("restaurant/deposits/proofs/:proofId/reject") reject(@CurrentUser() user: RequestUser, @Param("proofId") id: string, @Body() body: unknown) { return this.service.rejectProof(user, id, z.object({ reason: z.string().trim().min(1).max(2000) }).parse(body).reason); }
  @Post("restaurant/deposits/:depositId/upload") internalUpload(@CurrentUser() user: RequestUser, @Param("depositId") id: string, @Body() body: unknown) { return this.service.internalUpload(user, id, uploadSchema.extend({ content: z.string().max(15 * 1024 * 1024) }).parse(body)); }
  @Get("restaurant/deposits/drive/status") driveStatus(@CurrentUser() user: RequestUser) { return this.drive.status(user); }
  @Post("restaurant/deposits/drive/connect") connect(@CurrentUser() user: RequestUser) { return this.drive.connect(user); }
  @Get("restaurant/deposits/drive/folders") folders(@CurrentUser() user: RequestUser, @Query("pageToken") pageToken?: string) { return this.drive.folders(user, pageToken); }
  @Post("restaurant/deposits/drive/folders") setupFolders(@CurrentUser() user: RequestUser, @Body() body: unknown) { return this.drive.setup(user, z.object({ rootFolderId: z.string().min(1).max(200).optional() }).parse(body).rootFolderId); }
  @Get("restaurant/deposits/drive/files") files(@CurrentUser() user: RequestUser, @Query() query: Record<string, string>) {
    const { category, pageToken, page, search } = z.object({
      category: z.enum(["proofs", "general"]).optional(), pageToken: z.string().min(1).max(2048).optional(),
      page: pageNumber, search: z.string().trim().max(120).optional()
    }).parse(query);
    return this.drive.files(user, category, pageToken, page, search);
  }
  @Post("restaurant/deposits/proofs/:proofId/sync-drive") sync(@CurrentUser() user: RequestUser, @Param("proofId") id: string) { return this.drive.sync(user, id); }
  @Public()
  @Get("external/deposits/drive/callback")
  async callback(
    @Query("state") state: string,
    @Query("code") code: string | undefined,
    @Query("error") oauthError: string | undefined,
    @Res() response: Response
  ) {
    const query = new URLSearchParams({ tab: "drive" });
    try {
      await this.drive.callback(state, oauthError ? undefined : code);
    } catch {
      query.set("connection", oauthError === "access_denied" ? "cancelled" : "failed");
    }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.redirect(303, `/senas?${query}`);
  }
  @Get("restaurant/deposits/proofs/pending") pending(@CurrentUser() user: RequestUser) { return this.service.pendingProofs(user); }
  @Put("restaurant/reservations/:reservationId/deposit") upsert(@CurrentUser() user: RequestUser, @Param("reservationId") reservationId: string, @Body() body: unknown) { return this.service.upsert(user, reservationId, depositSchema.parse(body)); }
  @Post("restaurant/deposits/:depositId/entries") entry(@CurrentUser() user: RequestUser, @Param("depositId") depositId: string, @Body() body: unknown) { return this.service.addEntry(user, depositId, entrySchema.parse(body)); }
  @Post("restaurant/deposits/:depositId/proof-requests") request(@CurrentUser() user: RequestUser, @Param("depositId") depositId: string, @Body() body: { expiresHours?: number }) { return this.service.requestProof(user, depositId, body.expiresHours); }
  @Get("restaurant/deposits/proofs/:proofId/download") async download(@CurrentUser() user: RequestUser, @Param("proofId") proofId: string, @Res() response: Response) {
    const file = await this.service.proofFile(user, proofId);
    response.setHeader("Content-Type", file.mimeType); response.setHeader("X-Content-Type-Options", "nosniff"); response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Disposition", `inline; filename="${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}"`); response.send(file.data);
  }

  @Public() @Get("external/reservations/:reservationCode/deposit-payment-instructions") async instructions(@Headers("x-api-key") apiKey: string, @Param("reservationCode") code: string) { return this.service.externalInstructions(await this.resolveRestaurant(apiKey), code); }
  @Public() @Get("external/deposits/config") async externalConfig(@Headers("x-api-key") apiKey: string) { return this.service.externalConfig(await this.resolveRestaurant(apiKey)); }
  @Public() @Post("external/deposits/delivery/claim") async claim(@Headers("x-api-key") apiKey: string, @Body() body: unknown) { const input = z.object({ eventId: z.string().min(1) }).parse(body); return this.service.claimDelivery(await this.resolveRestaurant(apiKey), input.eventId); }
  @Public() @Post("external/deposits/delivery/finish") async finish(@Headers("x-api-key") apiKey: string, @Body() body: unknown) { const input = z.object({ eventId: z.string().min(1), messageId: z.string().min(1) }).parse(body); return this.service.finishDelivery(await this.resolveRestaurant(apiKey), input.eventId, input.messageId); }
  @Public() @Post("external/deposits/request") async externalRequest(@Headers("x-api-key") apiKey: string, @Body() body: unknown) { const input = z.object({ reservationCode: z.string().trim().min(1), phone: z.string().min(7) }).parse(body); return this.service.externalRequest(await this.resolveRestaurant(apiKey), input.reservationCode, input.phone); }
  @Public() @Get("external/deposits/proof-request") async open(@Headers("x-api-key") apiKey: string, @Query("phone") phone: string, @Query("reservationCode") code?: string) { return this.service.externalOpenRequest(await this.resolveRestaurant(apiKey), phone, code); }
  @Public() @Post("external/deposits/proof-requests/:requestId/upload-url") async upload(@Headers("x-api-key") apiKey: string, @Param("requestId") requestId: string, @Body() body: unknown) { return this.service.externalUploadUrl(await this.resolveRestaurant(apiKey), requestId, uploadSchema.parse(body)); }
  @Public() @Post("external/deposits/proof-requests/:requestId/confirm-upload") async confirm(@Headers("x-api-key") apiKey: string, @Param("requestId") requestId: string, @Body() body: unknown) { return this.service.externalConfirmUpload(await this.resolveRestaurant(apiKey), requestId, confirmSchema.parse(body)); }
  @Public() @Get("external/reservations/reminder-eligibility") async reminder(@Headers("x-api-key") apiKey: string, @Query("reservationCode") reservationCode: string) { return this.service.reminderEligibility(await this.resolveRestaurant(apiKey, false), reservationCode); }
  @Public()
  @Post("external/gift-cards/orders/:orderId/proof")
  async saveGiftCardProof(@Headers("x-api-key") apiKey: string, @Param("orderId") orderId: string, @Body() body: unknown) {
    const token = await this.resolveIntegrationToken(apiKey);
    const input = uploadSchema.omit({ size: true }).extend({
      phone: z.string().trim().min(7).max(40).regex(/^\+?[\d ()-]+$/),
      messageId: z.string().trim().min(1).max(255),
      content: z.string().min(1).max(14 * 1024 * 1024).base64()
    }).parse(body);
    return this.drive.saveGiftCardProof(token, { ...input, orderId });
  }
  @Get("restaurant/gift-cards/proofs")
  listGiftCardProofs(@CurrentUser() user: RequestUser, @Query("phone") phone?: string, @Query("orderIds") orderIds?: string) {
    const input = z.object({
      phone: z.string().max(40).refine(value => value.replace(/\D/g, "").length >= 7).optional(),
      orderIds: z.array(z.string().min(1).max(100)).max(50).optional()
    }).parse({ phone, orderIds: orderIds === undefined ? undefined : orderIds.split(",") });
    return this.drive.listGiftCardProofs(user, input.phone, input.orderIds);
  }
  @Get("restaurant/gift-cards/proofs/history")
  giftCardProofHistory(@CurrentUser() user: RequestUser, @Query() query: Record<string, string>) {
    const { pageToken, ...filters } = z.object({
      pageToken: z.string().min(1).max(2048).optional(),
      search: z.string().trim().max(120).optional(),
      review: proofReview.optional(),
      payment: z.enum(["PENDING", "CONFIRMED"]).optional(),
      phone: z.string().max(40).refine(value => value.replace(/\D/g, "").length >= 7).optional(),
      orderIds: z.string().max(1010).transform(value => value.split(",")).pipe(z.array(z.string().min(1).max(100)).max(10)).optional(),
      from: z.string().datetime().optional(),
      before: z.string().datetime().optional()
    }).parse(query);
    return this.drive.giftCardProofHistory(user, pageToken, filters);
  }
  @Get("restaurant/gift-cards/orders/:orderId/proofs/:fileId")
  async giftCardProofFile(@CurrentUser() user: RequestUser, @Param("orderId") orderId: string, @Param("fileId") fileId: string, @Res() response: Response) {
    const file = await this.drive.giftCardProofFile(user, orderId, fileId);
    response.setHeader("Content-Type", file.mimeType);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.send(file.data);
  }
  private async resolveIntegrationToken(apiKey: string) {
    const token = await this.prisma.integrationToken.findFirst({
      where: { tokenHash: hashOpaqueToken(apiKey), isActive: true }, select: { id: true, restaurantId: true }
    });
    if (!token) throw new ForbiddenException("Invalid API key");
    return token;
  }
  private async resolveRestaurant(apiKey: string, depositsRequired = true) {
    const token = await this.resolveIntegrationToken(apiKey);
    if (depositsRequired) await requireFeature(this.prisma, token.restaurantId, "deposits");
    await requireExternalAccess(this.prisma, token.restaurantId);
    return token.restaurantId;
  }
}
