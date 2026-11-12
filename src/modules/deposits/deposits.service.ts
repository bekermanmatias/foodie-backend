import { restaurantWebhook, n8nWebhookToken } from "../../common/restaurant-webhooks";
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { RequestUser } from "../../common/auth/request-user";
import { requireFeature, requireExternalAccess, restaurantFeatures } from "../../common/restaurant-features";
import { PrismaService } from "../prisma/prisma.service";
import { ReservationsService } from "../reservations/reservations.service";
import { depositActor } from "./deposit-access";
import { EMPTY_SETTINGS, settingsSchema, calculateDeposit, normalizeDepositPhone } from "./deposit-rules";
import { ProofStorageService, MAX_PROOF_BYTES, verifyProofContent } from "./proof-storage.service";
import { DepositDriveService } from "./deposit-drive.service";

const detail = { reservation: { include: { branch: true, tables: { include: { table: true } } } }, entries: { orderBy: { createdAt: "desc" as const } }, proofRequests: { include: { proofs: true }, orderBy: { createdAt: "desc" as const } } };
type Upload = { fileName: string; mimeType: string; size: number };
type Entry = { type: "payment" | "refund" | "adjustment"; amount: number; paidAt: string; paymentMethod: string; reference?: string; notes?: string; proofIds?: string[]; idempotencyKey: string };
@Injectable()
export class DepositsService {
  constructor(private readonly prisma: PrismaService, private readonly storage: ProofStorageService,
    private readonly reservations: ReservationsService, private readonly drive: DepositDriveService) {}

  private audit(tx: Prisma.TransactionClient, restaurantId: string, actor: string | null, action: string, id: string, metadata: Prisma.InputJsonValue) {
    return tx.auditLog.create({ data: { action, targetType: "reservation_deposit", targetId: id, restaurantId, restaurantUserId: actor, metadata } });
  }
  private async locked(tx: Prisma.TransactionClient, restaurantId: string, depositId: string) {
    await tx.$queryRaw`SELECT id FROM "ReservationDeposit" WHERE id=${depositId} AND "restaurantId"=${restaurantId} FOR UPDATE`;
    const deposit = await tx.reservationDeposit.findFirst({ where: { id: depositId, restaurantId }, include: { reservation: true } });
    if (!deposit) throw new NotFoundException("Seña no encontrada");
    return deposit;
  }
  async settings(user: RequestUser) {
    const restaurantId = await depositActor(this.prisma, user);
    return (await this.prisma.restaurantDepositSettings.findUnique({ where: { restaurantId } }))?.config ?? EMPTY_SETTINGS;
  }
  async saveSettings(user: RequestUser, body: unknown) {
    const restaurantId = await depositActor(this.prisma, user, true);
    const parsed = settingsSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ message: "Revisá las reglas y datos de transferencia", issues: parsed.error.issues });
    const config = parsed.data as Prisma.InputJsonValue;
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Restaurant" WHERE id=${restaurantId} FOR UPDATE`;
      const before = await tx.restaurantDepositSettings.findUnique({ where: { restaurantId } });
      await tx.restaurantDepositSettings.upsert({ where: { restaurantId }, create: { restaurantId, config }, update: { config } });
      await tx.restaurantCustomization.upsert({ where: { restaurantId }, create: { restaurantId, configVersion: 2 }, update: { configVersion: { increment: 1 } } });
      await this.audit(tx, restaurantId, user.sub, "deposit.settings.updated", restaurantId, { before: before?.config ?? null, after: config });
      return config;
    });
  }
  async list(user: RequestUser, input: { branchId?: string; status?: string; phone?: string; reservationId?: string; from?: string; to?: string; review?: string; expired?: boolean; search?: string } = {}) {
    const restaurantId = await depositActor(this.prisma, user);
    const phone = input.phone ? normalizeDepositPhone(input.phone) : null;
    if (phone !== null && phone.length < 7) throw new BadRequestException("Teléfono incompleto");
    // Normalize both sides in the database; punctuation never changes contact ownership.
    const contactIds = phone ? await this.prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Reservation" WHERE "restaurantId"=${restaurantId} AND regexp_replace(phone, '[^0-9]', '', 'g')=${phone}` : null;
    return this.prisma.reservationDeposit.findMany({ where: { restaurantId,
      ...(input.branchId ? { branchId: input.branchId } : {}), ...(input.reservationId ? { reservationId: input.reservationId } : {}),
      status: { equals: input.status as "pending" | "partial" | "complete" | undefined, not: input.expired ? "complete" : undefined },
      ...(input.expired ? { dueAt: { lt: new Date() } } : {}),
      ...(input.review ? { proofRequests: { some: { proofs: { some: { reviewStatus: input.review } } } } } : {}),
      reservation: { ...(contactIds ? { id: { in: contactIds.map((row) => row.id) } } : {}),
        ...(input.search ? { OR: [
          { fullName: { contains: input.search, mode: "insensitive" } },
          { code: { contains: input.search, mode: "insensitive" } },
          { phone: { contains: input.search } }
        ] } : {}),
        ...((input.from || input.to) ? { serviceDate: { ...(input.from ? { gte: new Date(`${input.from}T00:00:00Z`) } : {}), ...(input.to ? { lte: new Date(`${input.to}T23:59:59Z`) } : {}) } } : {}) }
    }, include: detail, orderBy: { updatedAt: "desc" }, take: 200 });
  }
  async reservationOptions(user: RequestUser, search: string) {
    const restaurantId = await depositActor(this.prisma, user);
    if (!search || search.trim().length < 2) return [];
    return this.prisma.reservation.findMany({ where: { restaurantId, status: { in: ["pending", "confirmed"] }, OR: [{ code: { contains: search.trim(), mode: "insensitive" } }, { fullName: { contains: search.trim(), mode: "insensitive" } }, { phone: { contains: search.trim() } }] }, select: { id: true, code: true, fullName: true, serviceDate: true, deposit: { select: { id: true } } }, take: 100, orderBy: { serviceDate: "desc" } });
  }
  async contactReservations(user: RequestUser, phone: string) {
    const restaurantId = await depositActor(this.prisma, user); const normalized = normalizeDepositPhone(phone);
    if (normalized.length < 7) throw new BadRequestException("Teléfono incompleto");
    const ids = await this.prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Reservation" WHERE "restaurantId"=${restaurantId} AND regexp_replace(phone, '[^0-9]', '', 'g')=${normalized} AND status IN ('pending','confirmed') ORDER BY "serviceDate" DESC LIMIT 100`;
    return this.prisma.reservation.findMany({ where: { id: { in: ids.map((row) => row.id) }, restaurantId }, include: { deposit: true }, orderBy: { serviceDate: "desc" } });
  }
  async upsert(user: RequestUser, reservationId: string, input: { requiredAmount?: number; notes?: string; currency?: string; dueAt?: string; useRules?: boolean }) {
    const restaurantId = await depositActor(this.prisma, user);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Reservation" WHERE id=${reservationId} AND "restaurantId"=${restaurantId} FOR UPDATE`;
      const reservation = await tx.reservation.findFirst({ where: { id: reservationId, restaurantId }, include: { deposit: true } });
      if (!reservation) throw new NotFoundException("Reserva no encontrada");
      if (!["pending", "confirmed"].includes(reservation.status)) throw new ConflictException("La reserva no permite solicitar una seña");
      const config = await tx.restaurantDepositSettings.findUnique({ where: { restaurantId } });
      const parsed = settingsSchema.safeParse(config?.config);
      if (!parsed.success || !parsed.data.reviewed) throw new ConflictException("El dueño debe revisar y guardar la configuración de señas primero");
      const calculated = input.useRules ? calculateDeposit(config?.config, reservation.partySize, reservation.specialServiceId) : null;
      if (input.useRules && !calculated) throw new ConflictException("No hay una regla aplicable a esta reserva");
      const amount = calculated?.requiredAmount ?? new Prisma.Decimal(input.requiredAmount ?? 0);
      if (amount.lte(0) || amount.decimalPlaces() > 2) throw new BadRequestException("El importe requerido debe ser positivo");
      if (reservation.deposit?.confirmationAt) throw new ConflictException("La reserva ya se confirmó con su seña; registrá pagos o devoluciones sin reemplazar la solicitud");
      const dueAt = input.dueAt ? new Date(input.dueAt) : calculated?.dueAt ?? new Date(Date.now() + parsed.data.paymentHours * 3600000);
      if (!Number.isFinite(dueAt.getTime())) throw new BadRequestException("Vencimiento inválido");
      const paid = reservation.deposit?.paidAmount ?? new Prisma.Decimal(0);
      const data = { requiredAmount: amount, currency: calculated?.currency ?? input.currency ?? parsed.data.currency, notes: input.notes?.trim() || null, dueAt,
        ruleSnapshot: calculated?.ruleSnapshot ?? { manual: true, paymentHours: parsed.data.paymentHours, bankAlias: parsed.data.bankAlias, bankCbu: parsed.data.bankCbu, bankHolder: parsed.data.bankHolder }, status: paid.lte(0) ? "pending" as const : paid.gte(amount) ? "complete" as const : "partial" as const };
      const deposit = await tx.reservationDeposit.upsert({ where: { reservationId }, create: { restaurantId, branchId: reservation.branchId, reservationId, ...data }, update: data });
      await tx.reservation.update({ where: { id: reservationId }, data: { status: "pending" } });
      await this.audit(tx, restaurantId, user.sub, "deposit.requested", deposit.id, { reservationId, requiredAmount: amount.toString(), dueAt: dueAt.toISOString(), snapshot: data.ruleSnapshot });
      return deposit;
    });
  }
  private async entry(tx: Prisma.TransactionClient, user: RequestUser, depositId: string, input: Entry) {
    const deposit = await this.locked(tx, user.restaurantId!, depositId);
    const previous = await tx.depositEntry.findUnique({ where: { depositId_idempotencyKey: { depositId, idempotencyKey: input.idempotencyKey } } });
    if (previous) {
      if (previous.type !== input.type || !previous.amount.equals(input.amount)) throw new ConflictException("La operación ya se utilizó con otros datos");
      return { entry: previous, deposit, duplicate: true };
    }
    const amount = new Prisma.Decimal(input.amount);
    if (!amount.isFinite() || amount.decimalPlaces() > 2 || amount.lte(0) || !Number.isFinite(new Date(input.paidAt).getTime())) throw new BadRequestException("Importe o fecha inválidos");
    if (input.type === "adjustment") throw new BadRequestException("Registrá pagos o devoluciones; no se admiten ajustes sin movimiento");
    if (input.type === "refund" && (!input.notes?.trim() || !input.reference?.trim() || amount.gt(deposit.paidAmount))) throw new BadRequestException("La devolución requiere motivo y referencia, y no puede superar el saldo acreditado");
    const proofIds = [...new Set(input.proofIds ?? [])];
    if (proofIds.length) {
      if (input.type !== "payment") throw new BadRequestException("Un comprobante solo puede acreditar un pago");
      const proofs = await tx.depositProof.findMany({ where: { id: { in: proofIds }, restaurantId: user.restaurantId, request: { depositId }, reviewStatus: "pending", entryId: null } });
      if (proofs.length !== proofIds.length) throw new ConflictException("Uno de los comprobantes ya fue revisado o pertenece a otra seña");
    }
    const entry = await tx.depositEntry.create({ data: { depositId, type: input.type, amount, paidAt: new Date(input.paidAt), paymentMethod: input.paymentMethod, reference: input.reference, notes: input.notes, idempotencyKey: input.idempotencyKey, createdByUserId: user.sub } });
    if (proofIds.length) await tx.depositProof.updateMany({ where: { id: { in: proofIds }, restaurantId: user.restaurantId }, data: { entryId: entry.id, reviewedAt: new Date(), reviewedByUserId: user.sub, reviewStatus: "approved" } });
    const paid = input.type === "refund" ? deposit.paidAmount.sub(amount) : deposit.paidAmount.add(amount);
    const updated = await tx.reservationDeposit.update({ where: { id: depositId }, data: { paidAmount: paid, status: paid.lte(0) ? "pending" : paid.gte(deposit.requiredAmount) ? "complete" : "partial" } });
    await this.audit(tx, user.restaurantId!, user.sub, "deposit.entry_added", depositId, { entryId: entry.id, type: input.type, amount: amount.toString(), proofIds });
    return { entry, deposit: updated, duplicate: false };
  }
  async addEntry(user: RequestUser, depositId: string, input: Entry) {
    await depositActor(this.prisma, user);
    return this.prisma.$transaction((tx) => this.entry(tx, user, depositId, input));
  }
  async rejectProof(user: RequestUser, proofId: string, reason: string) {
    const restaurantId = await depositActor(this.prisma, user);
    if (!reason.trim()) throw new BadRequestException("Indicá el motivo del rechazo");
    return this.prisma.$transaction(async (tx) => {
      const proof = await tx.depositProof.findFirst({ where: { id: proofId, restaurantId }, include: { request: true } });
      if (!proof) throw new NotFoundException("Comprobante no encontrado");
      await this.locked(tx, restaurantId, proof.request.depositId);
      const changed = await tx.depositProof.updateMany({ where: { id: proofId, reviewStatus: "pending", entryId: null }, data: { reviewStatus: "rejected", rejectionReason: reason, reviewedAt: new Date(), reviewedByUserId: user.sub } });
      if (!changed.count) throw new ConflictException("El comprobante ya fue revisado");
      await this.audit(tx, restaurantId, user.sub, "deposit.proof.rejected", proof.request.depositId, { proofId, reason });
      return { rejected: true };
    });
  }
  async requestProof(user: RequestUser, depositId: string, expiresHours?: number) {
    const restaurantId = await depositActor(this.prisma, user);
    if (expiresHours !== undefined && (!Number.isInteger(expiresHours) || expiresHours < 1 || expiresHours > 720)) throw new BadRequestException("Plazo inválido");
    return this.prisma.$transaction(async (tx) => {
      const deposit = await this.locked(tx, restaurantId, depositId);
      const existing = await tx.depositProofRequest.findFirst({ where: { depositId, status: "awaiting_proof", expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } });
      if (existing) return existing;
      await tx.depositProofRequest.updateMany({ where: { depositId, status: "awaiting_proof", expiresAt: { lte: new Date() } }, data: { status: "expired" } });
      const request = await tx.depositProofRequest.create({ data: { depositId, restaurantId, reservationId: deposit.reservationId, phone: normalizeDepositPhone(deposit.reservation.phone), expiresAt: new Date(Date.now() + (expiresHours ?? Number((deposit.ruleSnapshot as Record<string, unknown>)?.paymentHours ?? 48)) * 3600000), createdByUserId: user.sub } });
      await this.audit(tx, restaurantId, user.sub, "deposit.proof.requested", depositId, { requestId: request.id });
      return request;
    });
  }
  async confirmReservation(user: RequestUser, depositId: string) {
    const restaurantId = await depositActor(this.prisma, user);
    return this.prisma.$transaction(async (tx) => {
      const deposit = await this.locked(tx, restaurantId, depositId);
      if (deposit.confirmationAt && deposit.reservation.status === "confirmed") return { confirmed: true, duplicate: true };
      if (deposit.paidAmount.lt(deposit.requiredAmount)) throw new ConflictException("Falta completar la seña");
      await this.reservations.confirmDepositReservation(tx, restaurantId, deposit.reservationId);
      await tx.reservationDeposit.update({ where: { id: deposit.id }, data: { confirmationAt: new Date() } });
      await tx.depositDelivery.upsert({ where: { reservationId_kind: { reservationId: deposit.reservationId, kind: "confirmation" } }, create: { restaurantId, reservationId: deposit.reservationId, kind: "confirmation" }, update: {} });
      await this.audit(tx, restaurantId, user.sub, "deposit.reservation.confirmed", depositId, { reservationId: deposit.reservationId });
      return { confirmed: true, duplicate: false };
    });
  }
  async deliver(user: RequestUser, depositId: string) {
    const restaurantId = await depositActor(this.prisma, user);
    const deposit = await this.prisma.reservationDeposit.findFirst({ where: { id: depositId, restaurantId }, include: { reservation: true } });
    if (!deposit?.confirmationAt || deposit.reservation.status !== "confirmed") throw new ConflictException("Primero confirmá la reserva");
    const delivery = await this.prisma.depositDelivery.findUniqueOrThrow({ where: { reservationId_kind: { reservationId: deposit.reservationId, kind: "confirmation" } } });
    if (delivery.status === "sent" || delivery.status === "simulated") return delivery;
    if ((await restaurantFeatures(this.prisma, restaurantId)).isDemo) return this.prisma.depositDelivery.update({ where: { id: delivery.id }, data: { status: "simulated", sentAt: new Date(), error: null } });
    await requireExternalAccess(this.prisma, restaurantId);
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({ where: { id: restaurantId }, select: { chatPhoneNumberId: true } });
    if (!restaurant.chatPhoneNumberId?.trim()) throw new ConflictException("Configurá el canal de WhatsApp de este restaurante antes de enviar confirmaciones");
    const url = restaurantWebhook("depositConfirmation", restaurantId, restaurant.chatPhoneNumberId);
    const token = n8nWebhookToken();
    if (!url || !token) throw new ConflictException("Falta configurar el envío de confirmaciones para el canal de este restaurante");
    const claimed = await this.prisma.depositDelivery.updateMany({ where: { id: delivery.id, status: { in: ["pending", "failed"] } }, data: { status: "sending", attempts: { increment: 1 }, error: null } });
    if (!claimed.count) throw new ConflictException("El envío está en proceso o requiere verificar el resultado anterior");
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-n8n-token": token, "Idempotency-Key": delivery.id }, body: JSON.stringify({ eventId: delivery.id, restaurantId, reservationId: deposit.reservationId, code: deposit.reservation.code, phone: deposit.reservation.phone }), signal: AbortSignal.timeout(20000) });
      const result = await response.json() as { sent?: boolean; retrySafe?: boolean };
      if (!response.ok || result.sent !== true) {
        await this.prisma.depositDelivery.update({ where: { id: delivery.id }, data: { status: result.retrySafe === true ? "failed" : "unknown", error: "El proveedor no confirmó el envío; revisá antes de reintentar" } });
        throw new ConflictException("El proveedor no confirmó el envío");
      }
      return this.prisma.depositDelivery.update({ where: { id: delivery.id }, data: { status: "sent", sentAt: new Date(), error: null } });
    } catch (error) {
      await this.prisma.depositDelivery.updateMany({ where: { id: delivery.id, status: { in: ["sending", "dispatching"] } }, data: { status: "unknown", error: "Resultado incierto; verificar en n8n antes de reintentar" } });
      throw error;
    }
  }
  async resolveDelivery(user: RequestUser, depositId: string, outcome: "sent" | "not_sent", reference: string) {
    const restaurantId = await depositActor(this.prisma, user);
    if (!reference.trim()) throw new BadRequestException("Indicá dónde verificaste el resultado del envío");
    return this.prisma.$transaction(async (tx) => {
      const deposit = await this.locked(tx, restaurantId, depositId);
      const delivery = await tx.depositDelivery.findUniqueOrThrow({ where: { reservationId_kind: { reservationId: deposit.reservationId, kind: "confirmation" } } });
      if (delivery.status !== "unknown" && !(["sending", "dispatching"].includes(delivery.status) && delivery.updatedAt < new Date(Date.now() - 120000))) throw new ConflictException("El envío no necesita resolución manual");
      const result = await tx.depositDelivery.update({ where: { id: delivery.id }, data: { status: outcome === "sent" ? "sent" : "failed", sentAt: outcome === "sent" ? new Date() : null, error: null } });
      await this.audit(tx, restaurantId, user.sub, "deposit.delivery.resolved", depositId, { outcome, reference, deliveryId: delivery.id });
      return result;
    });
  }
  async deliveryState(user: RequestUser, depositId: string) {
    const restaurantId = await depositActor(this.prisma, user);
    const row = await this.prisma.reservationDeposit.findFirst({ where: { id: depositId, restaurantId } });
    if (!row) throw new NotFoundException("Seña no encontrada");
    return this.prisma.depositDelivery.findUnique({ where: { reservationId_kind: { reservationId: row.reservationId, kind: "confirmation" } } });
  }
  async claimDelivery(restaurantId: string, eventId: string) {
    await requireFeature(this.prisma, restaurantId, "deposits"); await requireExternalAccess(this.prisma, restaurantId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "DepositDelivery" WHERE id=${eventId} AND "restaurantId"=${restaurantId} FOR UPDATE`;
      const delivery = await tx.depositDelivery.findFirst({ where: { id: eventId, restaurantId } });
      if (!delivery) throw new NotFoundException("Envío no encontrado");
      if (delivery.status === "sent") return { alreadySent: true, eventId };
      if (delivery.status !== "sending") throw new ConflictException("El envío ya se tomó o no está listo para despachar");
      const deposit = await tx.reservationDeposit.findFirst({ where: { restaurantId, reservationId: delivery.reservationId }, include: { reservation: true, restaurant: true } });
      if (!deposit?.confirmationAt || deposit.reservation.status !== "confirmed" || deposit.paidAmount.lt(deposit.requiredAmount) || !deposit.restaurant.chatPhoneNumberId) throw new ConflictException("La reserva no permite enviar una confirmación");
      await tx.depositDelivery.update({ where: { id: eventId }, data: { status: "dispatching" } });
      return { alreadySent: false, eventId, phone: deposit.reservation.phone, channelId: deposit.restaurant.chatPhoneNumberId,
        message: `Tu reserva ${deposit.reservation.code} está confirmada para el ${deposit.reservation.serviceDate.toISOString().slice(0, 10)} a las ${deposit.reservation.serviceTime}, para ${deposit.reservation.partySize} personas. ¡Te esperamos!` };
    });
  }
  async finishDelivery(restaurantId: string, eventId: string, messageId: string) {
    await requireFeature(this.prisma, restaurantId, "deposits"); await requireExternalAccess(this.prisma, restaurantId);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.depositDelivery.updateMany({ where: { id: eventId, restaurantId, status: "dispatching" }, data: { status: "sent", sentAt: new Date(), error: null } });
      if (!updated.count) throw new ConflictException("El envío no está en proceso");
      await this.audit(tx, restaurantId, null, "deposit.confirmation.sent", eventId, { messageId });
      return { sent: true };
    });
  }
  async internalUpload(user: RequestUser, depositId: string, input: Upload & { content: string }) {
    const restaurantId = await depositActor(this.prisma, user);
    const request = await this.requestProof(user, depositId);
    const data = Buffer.from(input.content, "base64"); verifyProofContent(data, input.mimeType);
    if (data.length !== input.size) throw new BadRequestException("Tamaño incorrecto");
    const key = `deposits/${restaurantId}/${request.reservationId}/${request.id}/${randomUUID()}`;
    const demo = (await restaurantFeatures(this.prisma, restaurantId)).isDemo;
    await this.storage.put(key, data, input.mimeType, demo);
    const proof = await this.recordProof(restaurantId, request.id, { ...input, objectKey: key }, user.sub);
    await this.drive.sync(user, proof.proofId).catch(() => undefined);
    return proof;
  }
  async proofFile(user: RequestUser, proofId: string) {
    const restaurantId = await depositActor(this.prisma, user);
    const proof = await this.prisma.depositProof.findFirst({ where: { id: proofId, restaurantId } });
    if (!proof) throw new NotFoundException("Comprobante no encontrado");
    return { data: await this.storage.get(proof.objectKey, (await restaurantFeatures(this.prisma, restaurantId)).isDemo), mimeType: proof.mimeType, name: proof.originalName };
  }
  async pendingProofs(user: RequestUser) { const restaurantId = await depositActor(this.prisma, user); return this.prisma.depositProof.findMany({ where: { restaurantId, reviewStatus: "pending" }, include: { request: { include: { deposit: true } } }, orderBy: { receivedAt: "desc" } }); }
  async externalConfig(restaurantId: string) { await requireFeature(this.prisma, restaurantId, "deposits"); return (await this.prisma.restaurantDepositSettings.findUnique({ where: { restaurantId } }))?.config ?? EMPTY_SETTINGS; }
  async externalOpenRequest(restaurantId: string, phone: string, reservationCode?: string) {
    await requireFeature(this.prisma, restaurantId, "deposits");
    const normalized = normalizeDepositPhone(phone || "");
    if (normalized.length < 7) throw new BadRequestException("Teléfono incompleto");
    const requests = await this.prisma.depositProofRequest.findMany({ where: { restaurantId, phone: normalized, status: "awaiting_proof", ...(reservationCode ? { deposit: { reservation: { codeNormalized: reservationCode.toUpperCase() } } } : {}) }, include: { deposit: { include: { reservation: true } } }, orderBy: { createdAt: "desc" } });
    // Keep the latest request per reservation without guessing between different reservations.
    const uniqueRequests = [...new Map(requests.map((request) => [request.depositId, request] as const).reverse()).values()];
    return { active: uniqueRequests.length === 1, requiresReservationSelection: uniqueRequests.length > 1, requestId: uniqueRequests.length === 1 ? uniqueRequests[0].id : null,
      requests: uniqueRequests.map((request) => ({ requestId: request.id, code: request.deposit.reservation.code, requiredAmount: request.deposit.requiredAmount, paidAmount: request.deposit.paidAmount, dueAt: request.deposit.dueAt, instructions: request.deposit.ruleSnapshot })) };
  }
  async externalInstructions(restaurantId: string, code: string) {
    await requireFeature(this.prisma, restaurantId, "deposits");
    const reservation = await this.prisma.reservation.findFirst({ where: { restaurantId, codeNormalized: code.toUpperCase() } });
    if (!reservation) throw new NotFoundException("Reserva no encontrada");
    const request = await this.externalRequest(restaurantId, code, reservation.phone);
    return { ...request, reservation: { code: reservation.code, fullName: reservation.fullName, serviceDate: reservation.serviceDate, partySize: reservation.partySize }, paymentType: "reservation", reservationCode: reservation.code };
  }
  async externalRequest(restaurantId: string, reservationCode: string, phone: string) {
    await requireFeature(this.prisma, restaurantId, "deposits");
    const reservation = await this.prisma.reservation.findFirst({ where: { restaurantId, codeNormalized: reservationCode.toUpperCase() }, include: { deposit: true } });
    if (!reservation || normalizeDepositPhone(reservation.phone) !== normalizeDepositPhone(phone)) throw new NotFoundException("Reserva no encontrada para este contacto");
    if (!reservation.deposit) throw new ConflictException("La reserva no tiene seña requerida");
    if (!["pending", "confirmed"].includes(reservation.status)) throw new ConflictException("La reserva ya no admite solicitudes de seña");
    const deposit = reservation.deposit;
    return this.prisma.$transaction(async (tx) => {
      await this.locked(tx, restaurantId, deposit.id);
      const previous = await tx.depositProofRequest.findFirst({ where: { depositId: deposit.id, status: "awaiting_proof" } });
      const request = previous ?? await tx.depositProofRequest.create({ data: { restaurantId, reservationId: reservation.id, depositId: deposit.id, phone: normalizeDepositPhone(phone), expiresAt: deposit.dueAt ?? new Date(Date.now() + 48 * 3600000) } });
      return { requestId: request.id, dueAt: deposit.dueAt, requiredAmount: deposit.requiredAmount, paidAmount: deposit.paidAmount, instructions: deposit.ruleSnapshot, expired: Boolean(deposit.dueAt && deposit.dueAt < new Date()), reservationStatus: reservation.status };
    });
  }
  async externalUploadUrl(restaurantId: string, requestId: string, input: Upload) {
    await requireFeature(this.prisma, restaurantId, "deposits"); await requireExternalAccess(this.prisma, restaurantId);
    const request = await this.prisma.depositProofRequest.findFirst({ where: { id: requestId, restaurantId, status: "awaiting_proof" } });
    if (!request) throw new NotFoundException("Solicitud de comprobante no encontrada");
    if (input.size > MAX_PROOF_BYTES) throw new BadRequestException("Archivo demasiado grande");
    const key = `deposits/${restaurantId}/${request.reservationId}/${request.id}/${randomUUID()}`;
    await this.prisma.depositUpload.create({ data: { objectKey: key, requestId, restaurantId, ...input, expiresAt: new Date(Date.now() + 3600000) } });
    return { objectKey: key, uploadUrl: await this.storage.uploadUrl(key, input.mimeType) };
  }
  async externalConfirmUpload(restaurantId: string, requestId: string, input: Upload & { objectKey: string; messageId?: string; caption?: string }) {
    await requireFeature(this.prisma, restaurantId, "deposits"); await requireExternalAccess(this.prisma, restaurantId);
    const lease = await this.prisma.depositUpload.findFirst({ where: { objectKey: input.objectKey, restaurantId, requestId } });
    if (!lease || (!lease.confirmedAt && lease.expiresAt < new Date()) || lease.mimeType !== input.mimeType || lease.size !== input.size || lease.fileName !== input.fileName) throw new BadRequestException("Carga no autorizada o vencida");
    await this.storage.verify(input.objectKey, input.mimeType, input.size);
    const result = await this.recordProof(restaurantId, requestId, input, null);
    await this.drive.syncForRestaurant(restaurantId, result.proofId).catch(async (error) => { await this.prisma.depositProof.update({ where: { id: result.proofId }, data: { driveStatus: "failed", driveError: error instanceof Error ? error.message : "Error de sincronización" } }); });
    return result;
  }
  private async recordProof(restaurantId: string, requestId: string, input: Upload & { objectKey: string; messageId?: string; caption?: string }, actor: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.depositProofRequest.findFirst({ where: { id: requestId, restaurantId }, include: { deposit: { include: { reservation: true } } } });
      if (!request || request.status === "cancelled") throw new NotFoundException("Solicitud de comprobante no encontrada");
      await this.locked(tx, restaurantId, request.depositId);
      const previous = await tx.depositProof.findFirst({ where: { restaurantId, OR: [{ objectKey: input.objectKey }, ...(input.messageId ? [{ messageId: input.messageId }] : [])] } });
      if (previous) {
        if (previous.requestId !== requestId) throw new ConflictException("El mensaje ya está asociado a otra reserva");
        return { proofId: previous.id, status: "received_for_review", duplicate: true };
      }
      const proof = await tx.depositProof.create({ data: { restaurantId, requestId, objectKey: input.objectKey, originalName: input.fileName, mimeType: input.mimeType, size: input.size, ingestionKey: input.messageId ? `${restaurantId}:${input.messageId}` : null, messageId: input.messageId, caption: input.caption } });
      await tx.depositProofRequest.update({ where: { id: requestId }, data: { status: "received" } });
      await tx.depositUpload.updateMany({ where: { objectKey: input.objectKey, restaurantId }, data: { confirmedAt: new Date() } });
      await this.audit(tx, restaurantId, actor, "deposit.proof.received", request.depositId, { proofId: proof.id, requestId });
      const features = await tx.restaurant.findUniqueOrThrow({ where: { id: restaurantId }, select: { featureOverrides: true } });
      if ((features.featureOverrides as Record<string, boolean>)?.notifications !== false) {
        await tx.notification.create({ data: { restaurantId, type: "deposit_proof", channelId: "foodie", chatId: request.phone, contactPhone: request.phone, contactName: request.deposit.reservation.fullName, orderMode: "unknown", summary: `Comprobante de seña pendiente · Reserva ${request.deposit.reservation.code}`, occurredAt: new Date() } });
      }
      return { proofId: proof.id, status: "received_for_review", duplicate: false };
    });
  }
  async reminderEligibility(restaurantId: string, reservationCode: string) {
    const reservation = await this.prisma.reservation.findFirst({ where: { codeNormalized: reservationCode.toUpperCase(), restaurantId }, include: { deposit: true } });
    return { eligible: Boolean(reservation && reservation.status === "confirmed" && (!reservation.deposit || reservation.deposit.status === "complete")) };
  }
}
