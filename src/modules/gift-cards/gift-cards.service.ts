import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, GiftCardProductType, GiftCardStatus } from "@prisma/client";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import type { RequestUser } from "../../common/auth/request-user";
import { hashOpaqueToken } from "../../common/security/token-hash";
import { verifyPassword } from "../../common/security/password";
import { createGiftCardCode } from "../../common/utils/code";

type ProductInput = { name: string; type: GiftCardProductType; description: string; price?: number | null; minAmount?: number | null; maxAmount?: number | null; partySize?: number | null; currency?: string; validityDays: number; excludedDates?: string[]; restrictions?: Record<string, unknown> | null; paymentAlias?: string | null; paymentCbu?: string | null; paymentHolder?: string | null; isActive: boolean };
type OrderInput = { productId?: string; type: GiftCardProductType; purchaserName: string; purchaserPhone: string; recipientName?: string | null; message?: string | null; partySize?: number | null; amount?: number; currency?: string };
type OrderListQuery = { from?: string; to?: string; productId?: string; status?: string; paymentStatus?: string; giftCardStatus?: string; search?: string; page?: string; pageSize?: string };

const money = (value: Prisma.Decimal | number) => Number(value);
const dateOnly = (date: Date) => date.toISOString().slice(0, 10);
const displayDate = (date: Date) => new Intl.DateTimeFormat("es-AR", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
const displayAmount = (amount: Prisma.Decimal | number, currency: string) => new Intl.NumberFormat("es-AR", { style: "currency", currency: currency || "ARS", maximumFractionDigits: 0 }).format(money(amount));

function dateBoundary(value: string, timezone: string, endExclusive = false) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]) + (endExclusive ? 1 : 0);
  const utcGuess = Date.UTC(year, month - 1, day);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(utcGuess));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value || 0);
  const localAsUtc = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
  return new Date(utcGuess - (localAsUtc - utcGuess));
}
const escapeXml = (value: string) => value.replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&quot;", '"': "&quot;", "'": "&apos;" })[character]!);

const GIFT_CARD_TEXT_ANGLE = -4;
const GIFT_CARD_RIGHT_BLOCK = { centerX: 775, centerY: 875, width: 330, height: 260, topPadding: 14, bottomPadding: 14, codeHeight: 28, sectionGap: 8, codeGap: 12 };
const GIFT_CARD_DATE_BLOCK = { centerX: 380, centerY: 978, width: 240, height: 80, dateBaseline: 978 };

type GiftCardPrintLine = { text: string; fontSize: number; lineHeight: number; marginBefore: number; className: "gift-card-value" | "gift-card-description" };
type GiftCardFlow = { lines: GiftCardPrintLine[]; codeBaseline: number };

function approximateTextWidth(value: string, fontSize: number) {
  return Array.from(value).reduce((width, character) => width + (character === " " ? fontSize * 0.3 : fontSize * 0.65), 0);
}

function splitMenuValue(value: string, maxWidth: number, fontSize: number) {
  const words = value.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && approximateTextWidth(candidate, fontSize) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function giftCardFlow(value: string, type: GiftCardProductType, description?: string): GiftCardFlow {
  const title = value.trim().replace(/\s+/g, " ") || "Gift Card";
  const detail = description?.trim().replace(/\s+/g, " ") || "";
  const titleBaseSize = type === "OPEN_AMOUNT" ? 36 : 30;
  const detailBaseSize = 17;
  const availableHeight = GIFT_CARD_RIGHT_BLOCK.height - GIFT_CARD_RIGHT_BLOCK.topPadding - GIFT_CARD_RIGHT_BLOCK.bottomPadding - GIFT_CARD_RIGHT_BLOCK.codeHeight - GIFT_CARD_RIGHT_BLOCK.codeGap;
  let selected: GiftCardPrintLine[] = [];
  for (let scale = 100; scale >= 25; scale -= 5) {
    const titleSize = Math.max(9, Math.round(titleBaseSize * scale / 100));
    const detailSize = Math.max(8, Math.round(detailBaseSize * scale / 100));
    const titleLineHeight = Math.round(titleSize * 1.16);
    const detailLineHeight = Math.round(detailSize * 1.28);
    const titleLines = splitMenuValue(title, GIFT_CARD_RIGHT_BLOCK.width, titleSize).map((text) => ({ text, fontSize: titleSize, lineHeight: titleLineHeight, marginBefore: 0, className: "gift-card-value" as const }));
    const detailLines = detail ? splitMenuValue(detail, GIFT_CARD_RIGHT_BLOCK.width, detailSize).map((text, index) => ({ text, fontSize: detailSize, lineHeight: detailLineHeight, marginBefore: index === 0 ? GIFT_CARD_RIGHT_BLOCK.sectionGap : 0, className: "gift-card-description" as const })) : [];
    const lines = [...titleLines, ...detailLines];
    const totalHeight = lines.reduce((total, line) => total + line.marginBefore + line.lineHeight, 0);
    selected = lines;
    if (totalHeight <= availableHeight) break;
  }
  const contentHeight = selected.reduce((total, line) => total + line.marginBefore + line.lineHeight, 0);
  const codeBaseline = GIFT_CARD_RIGHT_BLOCK.topPadding + contentHeight + GIFT_CARD_RIGHT_BLOCK.codeGap + GIFT_CARD_RIGHT_BLOCK.codeHeight;
  return { lines: selected, codeBaseline };
}

async function rotateTextBlock(svg: string, width: number, height: number, centerX: number, centerY: number) {
  const horizontal = await sharp(Buffer.from(svg)).png().toBuffer();
  const rotated = await sharp(horizontal).rotate(GIFT_CARD_TEXT_ANGLE, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const metadata = await sharp(rotated).metadata();
  return {
    input: rotated,
    left: Math.round(centerX - (metadata.width ?? width) / 2),
    top: Math.round(centerY - (metadata.height ?? height) / 2),
  };
}

@Injectable()
export class GiftCardsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private owner(user: RequestUser) {
    if (user.scope !== "restaurant" || user.role !== "restaurant_owner" || !user.restaurantId) throw new ForbiddenException("Solo el dueño puede administrar Gift Cards");
    return user.restaurantId;
  }

  private async externalRestaurant(apiKey: string) {
    if (!apiKey) throw new ForbiddenException("Invalid API key");
    const direct = await this.prisma.integrationToken.findFirst({ where: { tokenHash: hashOpaqueToken(apiKey), isActive: true } });
    if (direct) return direct.restaurantId;
    const candidates = await this.prisma.integrationToken.findMany({ where: { isActive: true } });
    const legacy = candidates.find((candidate) => verifyPassword(apiKey, candidate.tokenHash));
    if (!legacy) throw new ForbiddenException("Invalid API key");
    return legacy.restaurantId;
  }

  private productView(product: any) {
    return { id: product.id, name: product.name, type: product.type, description: product.description, price: product.price == null ? null : money(product.price), minAmount: product.minAmount == null ? null : money(product.minAmount), maxAmount: product.maxAmount == null ? null : money(product.maxAmount), partySize: product.partySize, currency: product.currency, validityDays: product.validityDays, excludedDates: product.excludedDates, restrictions: product.restrictions, paymentAlias: product.paymentAlias, paymentCbu: product.paymentCbu, paymentHolder: product.paymentHolder, isActive: product.isActive, createdAt: product.createdAt, updatedAt: product.updatedAt };
  }

  async listProducts(user: RequestUser) { const restaurantId = this.owner(user); return (await this.prisma.giftCardProduct.findMany({ where: { restaurantId }, orderBy: [{ isActive: "desc" }, { createdAt: "desc" }] })).map((item) => this.productView(item)); }

  async listExternalProducts(apiKey: string) { const restaurantId = await this.externalRestaurant(apiKey); return { products: (await this.prisma.giftCardProduct.findMany({ where: { restaurantId, isActive: true }, orderBy: { createdAt: "asc" } })).map((item) => this.productView(item)) }; }

  async saveProduct(user: RequestUser, productId: string | undefined, input: ProductInput) {
    const restaurantId = this.owner(user);
    this.validateProduct(input);
    const data = { name: input.name.trim(), type: input.type, description: input.description.trim(), price: input.price == null ? null : new Prisma.Decimal(input.price), minAmount: input.minAmount == null ? null : new Prisma.Decimal(input.minAmount), maxAmount: input.maxAmount == null ? null : new Prisma.Decimal(input.maxAmount), partySize: input.partySize ?? null, currency: input.currency || "ARS", validityDays: input.validityDays, excludedDates: input.excludedDates || [], restrictions: input.restrictions as Prisma.InputJsonValue | undefined, paymentAlias: input.paymentAlias?.trim() || null, paymentCbu: input.paymentCbu?.trim() || null, paymentHolder: input.paymentHolder?.trim() || null, isActive: input.isActive };
    const product = productId ? await this.prisma.giftCardProduct.update({ where: { id: productId, restaurantId }, data }) : await this.prisma.giftCardProduct.create({ data: { restaurantId, ...data } });
    await this.audit.log({ action: productId ? "gift_card.product.updated" : "gift_card.product.created", targetType: "gift_card_product", targetId: product.id, restaurantId, restaurantUserId: user.sub });
    return this.productView(product);
  }

  async deleteProduct(user: RequestUser, productId: string) {
    const restaurantId = this.owner(user);
    await this.prisma.giftCardProduct.update({ where: { id: productId, restaurantId }, data: { isActive: false } });
    return { success: true };
  }

  async previewProduct(user: RequestUser, input: ProductInput) {
    this.owner(user);
    this.validateProduct(input);
    const validUntil = new Date();
    validUntil.setUTCDate(validUntil.getUTCDate() + input.validityDays);
    const amount = input.type === "FIXED_MENU" ? input.price! : input.minAmount || 10000;
    const image = await this.renderGiftCard({ type: input.type, product: input, amount, currency: input.currency || "ARS" }, "MUESTRA1", validUntil);
    return { image: `data:image/png;base64,${image.toString("base64")}` };
  }

  private validateProduct(input: ProductInput) {
    if (input.name.trim().length < 2 || input.description.trim().length < 2) throw new ConflictException("El producto requiere nombre y descripción");
    if (!Number.isInteger(input.validityDays) || input.validityDays < 1 || input.validityDays > 3650) throw new ConflictException("La vigencia debe estar entre 1 y 3650 días");
    if (input.type === "FIXED_MENU" && (!input.price || input.price <= 0 || !input.partySize || input.partySize < 1)) throw new ConflictException("Un menú requiere precio y cantidad de personas");
    if (input.type === "OPEN_AMOUNT" && ((input.minAmount != null && input.minAmount <= 0) || (input.maxAmount != null && input.maxAmount <= 0) || (input.minAmount != null && input.maxAmount != null && input.maxAmount < input.minAmount))) throw new ConflictException("Los límites del importe libre no son válidos");
    if ([...(input.excludedDates || [])].some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date))) throw new ConflictException("Hay una fecha excluida inválida");
  }

  async listOrders(user: RequestUser, query: OrderListQuery = {}) {
    const restaurantId = this.owner(user);
    const page = Math.max(1, Number.parseInt(query.page || "1", 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(query.pageSize || "10", 10) || 10));
    const search = query.search?.trim();
    const branch = await this.prisma.branch.findFirst({ where: { restaurantId }, orderBy: { createdAt: "asc" }, select: { timezone: true } });
    const timezone = branch?.timezone || "America/Argentina/Buenos_Aires";
    const from = query.from ? dateBoundary(query.from, timezone) : null;
    const to = query.to ? dateBoundary(query.to, timezone, true) : null;
    const where: Prisma.GiftCardOrderWhereInput = {
      restaurantId,
      ...(query.status ? { status: query.status as any } : {}),
      ...(query.paymentStatus ? { paymentStatus: query.paymentStatus as any } : {}),
      ...(query.productId === "__OPEN_AMOUNT__" ? { productId: null } : query.productId ? { productId: query.productId } : {}),
      ...(query.giftCardStatus ? { giftCard: { is: { status: query.giftCardStatus as any } } } : {}),
      ...((from || to) ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
      ...(search ? { OR: [{ id: search }, { purchaserName: { contains: search, mode: "insensitive" } }, { purchaserPhone: { contains: search } }, { recipientName: { contains: search, mode: "insensitive" } }, { product: { is: { name: { contains: search, mode: "insensitive" } } } }, { giftCard: { is: { displayCode: { contains: search, mode: "insensitive" } } } }] } : {}),
    };
    const [total, orders] = await Promise.all([
      this.prisma.giftCardOrder.count({ where }),
      this.prisma.giftCardOrder.findMany({ where, include: { product: true, giftCard: true }, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    return { items: orders.map((order) => ({ id: order.id, purchaserName: order.purchaserName, purchaserPhone: order.purchaserPhone, recipientName: order.recipientName, message: order.message, type: order.type, partySize: order.partySize, amount: money(order.amount), currency: order.currency, paymentMethod: order.paymentMethod, paymentStatus: order.paymentStatus, status: order.status, paymentReference: order.paymentReference, paymentConfirmedAt: order.paymentConfirmedAt, sentAt: order.sentAt, createdAt: order.createdAt, product: order.product ? this.productView(order.product) : null, giftCard: order.giftCard ? this.giftCardView(order.giftCard) : null })), total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  }

  private absoluteAsset(value: string | null | undefined) { if (!value) return null; return value.startsWith("http") ? value : `${process.env.PUBLIC_API_ORIGIN || "http://localhost:4000"}${value}`; }

  private giftCardView(card: any) { return { id: card.id, code: card.displayCode, status: card.status, originalAmount: money(card.originalAmount), currency: card.currency, validFrom: dateOnly(card.validFrom), validUntil: dateOnly(card.validUntil), imageUrl: this.absoluteAsset(card.imageUrl), pdfUrl: this.absoluteAsset(card.pdfUrl), issuedAt: card.issuedAt, redeemedAt: card.redeemedAt }; }

  async createExternal(apiKey: string, input: OrderInput, idempotencyKey?: string) {
    const restaurantId = await this.externalRestaurant(apiKey);
    if (idempotencyKey) { const existing = await this.prisma.externalApiRequest.findFirst({ where: { restaurantId, action: "gift_card.create_order", idempotencyKey } }); if (existing?.responseData) return existing.responseData; }
    const product = input.productId ? await this.prisma.giftCardProduct.findFirst({ where: { id: input.productId, restaurantId, isActive: true } }) : null;
    if (input.type === "FIXED_MENU" && !product) throw new NotFoundException("Gift Card product not found");
    const amount = input.type === "FIXED_MENU" ? Number(product!.price) : Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new ConflictException("Invalid Gift Card amount");
    if (input.type === "OPEN_AMOUNT" && product && ((product.minAmount && amount < Number(product.minAmount)) || (product.maxAmount && amount > Number(product.maxAmount)))) throw new ConflictException("Amount is outside product limits");
    if (input.type === "FIXED_MENU" && input.partySize !== undefined && input.partySize !== product!.partySize) throw new ConflictException("Party size does not match product");
    const order = await this.prisma.giftCardOrder.create({ data: { restaurantId, productId: product?.id, type: input.type, purchaserName: input.purchaserName.trim(), purchaserPhone: input.purchaserPhone.trim(), recipientName: input.recipientName?.trim() || null, message: input.message?.trim() || null, partySize: input.partySize ?? product?.partySize ?? null, amount: new Prisma.Decimal(amount), currency: input.currency || product?.currency || "ARS" } });
    const response = { order: { id: order.id, status: order.status, paymentMethod: order.paymentMethod, amount, currency: order.currency, paymentInstructions: { alias: product?.paymentAlias || process.env.GIFT_CARD_TRANSFER_ALIAS || "Consultar al restaurante", cbu: product?.paymentCbu || process.env.GIFT_CARD_TRANSFER_CBU || null, holder: product?.paymentHolder || process.env.GIFT_CARD_TRANSFER_HOLDER || null } } };
    if (idempotencyKey) await this.prisma.externalApiRequest.create({ data: { restaurantId, integrationTokenId: (await this.prisma.integrationToken.findFirstOrThrow({ where: { restaurantId, isActive: true }, select: { id: true } })).id, action: "gift_card.create_order", idempotencyKey, requestHash: hashOpaqueToken(JSON.stringify(input)), status: "success", responseData: response } });
    return response;
  }

  async getExternal(apiKey: string, orderId: string) { const restaurantId = await this.externalRestaurant(apiKey); const order = await this.prisma.giftCardOrder.findFirst({ where: { id: orderId, restaurantId }, include: { giftCard: true } }); if (!order) throw new NotFoundException("Gift Card order not found"); return { order: { id: order.id, status: order.status, paymentStatus: order.paymentStatus, amount: money(order.amount), currency: order.currency, giftCard: order.giftCard ? this.giftCardView(order.giftCard) : null } }; }

  async confirmPayment(user: RequestUser, orderId: string, approved: boolean, reference?: string) {
    const restaurantId = this.owner(user);
    const order = await this.prisma.giftCardOrder.findFirst({ where: { id: orderId, restaurantId }, include: { product: true, giftCard: true } });
    if (!order) throw new NotFoundException("Gift Card order not found");
    if (order.paymentStatus === "CONFIRMED" && order.giftCard) return { order: order.id, giftCard: this.giftCardView(order.giftCard) };
    if (!approved) { const rejected = await this.prisma.giftCardOrder.update({ where: { id: order.id }, data: { paymentStatus: "REJECTED", status: "CANCELLED", paymentReference: reference || null } }); await this.audit.log({ action: "gift_card.payment.rejected", targetType: "gift_card_order", targetId: order.id, restaurantId, restaurantUserId: user.sub }); return { order: rejected.id, status: rejected.status }; }
    const displayCode = createGiftCardCode();
    const validFrom = new Date(); const validityDays = order.product?.validityDays || 180; const validUntil = new Date(validFrom); validUntil.setUTCDate(validUntil.getUTCDate() + validityDays);
    const assets = await this.generateAssets(order, displayCode, validUntil);
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.giftCardOrder.updateMany({ where: { id: order.id, paymentStatus: "PENDING", giftCard: null }, data: { paymentStatus: "CONFIRMED", status: "PAID", paymentReference: reference || null, paymentConfirmedAt: new Date(), paymentConfirmedBy: user.sub } });
      if (updated.count !== 1) { const existing = await tx.giftCard.findUnique({ where: { orderId: order.id } }); if (existing) return existing; throw new ConflictException("Order payment state changed"); }
      return tx.giftCard.create({ data: { restaurantId, orderId: order.id, displayCode, originalAmount: order.amount, currency: order.currency, validFrom, validUntil, imageUrl: assets.imageUrl, pdfUrl: assets.pdfUrl } });
    });
    await this.audit.log({ action: "gift_card.issued", targetType: "gift_card", targetId: result.id, restaurantId, restaurantUserId: user.sub, metadata: { orderId: order.id } });
    return { order: order.id, giftCard: this.giftCardView(result) };
  }

  async sendGiftCard(user: RequestUser, orderId: string) {
    const restaurantId = this.owner(user);
    const order = await this.prisma.giftCardOrder.findFirst({ where: { id: orderId, restaurantId }, include: { giftCard: true, restaurant: { select: { chatPhoneNumberId: true } } } });
    if (!order) throw new NotFoundException("Gift Card order not found");
    if (!order.giftCard) throw new ConflictException("La Gift Card todavía no está emitida");
    if (order.giftCard.status !== GiftCardStatus.ACTIVE) throw new ConflictException("La Gift Card no está activa");
    const imageUrl = this.absoluteAsset(order.giftCard.imageUrl);
    if (!imageUrl) throw new ConflictException("La Gift Card no tiene imagen generada");
    const clientId = order.restaurant?.chatPhoneNumberId?.trim();
    if (!clientId) throw new ConflictException("El restaurante no tiene configurado el número de WhatsApp");
    const webhookUrl = process.env.N8N_GIFT_CARD_SEND_WEBHOOK_URL;
    const webhookToken = process.env.N8N_WEBHOOK_TOKEN;
    if (!webhookUrl || !webhookToken) throw new ConflictException("El envío por WhatsApp no está configurado");
    const caption = `¡Tu Gift Card está lista! Código: ${order.giftCard.displayCode}.`;
    let result: { sent?: boolean; reason?: string | null; lastInboundAt?: string | null } | null = null;
    try {
      const response = await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json", "x-n8n-token": webhookToken }, body: JSON.stringify({ clientId, phoneNumber: order.purchaserPhone, imageUrl, caption, orderId: order.id, restaurantId, code: order.giftCard.displayCode }) });
      result = (await response.json().catch(() => null)) as { sent?: boolean; reason?: string | null; lastInboundAt?: string | null } | null;
      if (!response.ok) throw new Error(`n8n respondió ${response.status}`);
    } catch (error) {
      await this.audit.log({ action: "gift_card.send.failed", targetType: "gift_card_order", targetId: order.id, restaurantId, restaurantUserId: user.sub, metadata: { error: error instanceof Error ? error.message : String(error) } });
      throw new ConflictException("No se pudo contactar el servicio de envío de WhatsApp");
    }
    if (!result?.sent) {
      await this.audit.log({ action: "gift_card.send.blocked", targetType: "gift_card_order", targetId: order.id, restaurantId, restaurantUserId: user.sub, metadata: { reason: result?.reason || "NOT_SENT", lastInboundAt: result?.lastInboundAt || null } });
      return { sent: false, reason: result?.reason || "NOT_SENT", lastInboundAt: result?.lastInboundAt || null };
    }
    const sentAt = new Date();
    await this.prisma.giftCardOrder.update({ where: { id: order.id }, data: { sentAt, sentBy: user.sub } });
    await this.audit.log({ action: "gift_card.sent", targetType: "gift_card_order", targetId: order.id, restaurantId, restaurantUserId: user.sub, metadata: { channel: "whatsapp", clientId } });
    return { sent: true, sentAt, reason: null };
  }

  async cancelOrder(user: RequestUser, orderId: string) {
    const restaurantId = this.owner(user);
    const order = await this.prisma.giftCardOrder.findFirst({ where: { id: orderId, restaurantId }, include: { giftCard: { include: { redemptions: { select: { id: true }, take: 1 } } } } });
    if (!order) throw new NotFoundException("Gift Card order not found");
    if (order.status === "CANCELLED") throw new ConflictException("La orden ya está cancelada");
    if (!["PENDING_PAYMENT", "PAID"].includes(order.status)) throw new ConflictException("La orden no puede cancelarse en su estado actual");
    if (order.giftCard && (order.giftCard.status !== GiftCardStatus.ACTIVE || order.giftCard.redemptions.length > 0)) {
      throw new ConflictException("La Gift Card ya fue canjeada o no está activa");
    }

    const cancelled = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.giftCardOrder.updateMany({ where: { id: order.id, restaurantId, status: { in: ["PENDING_PAYMENT", "PAID"] } }, data: { status: "CANCELLED" } });
      if (updated.count !== 1) throw new ConflictException("La orden cambió mientras se cancelaba");
      if (order.giftCard) await tx.giftCard.updateMany({ where: { id: order.giftCard.id, status: "ACTIVE" }, data: { status: GiftCardStatus.CANCELLED } });
      return tx.giftCardOrder.findUniqueOrThrow({ where: { id: order.id } });
    });
    await this.audit.log({ action: "gift_card.order.cancelled", targetType: "gift_card_order", targetId: order.id, restaurantId, restaurantUserId: user.sub, metadata: { hadGiftCard: Boolean(order.giftCard) } });
    return { id: cancelled.id, status: cancelled.status };
  }

  async deleteOrder(user: RequestUser, orderId: string) {
    const restaurantId = this.owner(user);
    const order = await this.prisma.giftCardOrder.findFirst({ where: { id: orderId, restaurantId }, include: { giftCard: { include: { redemptions: { select: { id: true } } } } } });
    if (!order) throw new NotFoundException("Gift Card order not found");

    await this.prisma.giftCardOrder.delete({ where: { id: order.id } });
    await rm(join(process.cwd(), "uploads", "gift-cards", restaurantId, order.id), { recursive: true, force: true });
    await this.audit.log({ action: "gift_card.order.deleted", targetType: "gift_card_order", targetId: order.id, restaurantId, restaurantUserId: user.sub, metadata: { orderStatus: order.status, giftCardStatus: order.giftCard?.status || null, redemptionCount: order.giftCard?.redemptions.length || 0 } });
    return { id: order.id, deleted: true };
  }

  async redeem(user: RequestUser, input: { code?: string; notes?: string; reservationId?: string }) {
    const restaurantId = this.owner(user); const code = input.code?.trim(); if (!code) throw new ConflictException("Gift Card code is required"); const card = await this.prisma.giftCard.findFirst({ where: { restaurantId, displayCode: code }, include: { order: true } });
    if (!card) throw new NotFoundException("Gift Card not found");
    if (card.status !== "ACTIVE") throw new ConflictException("Gift Card is not active");
    if (card.validUntil < new Date()) { await this.prisma.giftCard.update({ where: { id: card.id }, data: { status: "EXPIRED" } }); throw new ConflictException("Gift Card expired"); }
    const redeemed = await this.prisma.$transaction(async (tx) => { const locked = await tx.giftCard.updateMany({ where: { id: card.id, status: "ACTIVE" }, data: { status: "REDEEMED", redeemedAt: new Date() } }); if (locked.count !== 1) throw new ConflictException("Gift Card already redeemed"); await tx.giftCardOrder.update({ where: { id: card.orderId }, data: { status: "REDEEMED" } }); await tx.giftCardRedemption.create({ data: { giftCardId: card.id, restaurantId, redeemedBy: user.sub, reservationId: input.reservationId, notes: input.notes } }); return tx.giftCard.findUniqueOrThrow({ where: { id: card.id } }); });
    await this.audit.log({ action: "gift_card.redeemed", targetType: "gift_card", targetId: card.id, restaurantId, restaurantUserId: user.sub, metadata: { reservationId: input.reservationId || null } });
    return this.giftCardView(redeemed);
  }

  private async renderGiftCard(order: any, code: string, validUntil: Date) {
    const assetsDirectory = join(process.cwd(), "assets"); const templatePath = join(assetsDirectory, "gift-card-template.png");
    process.env.FONTCONFIG_FILE ??= join(assetsDirectory, "fonts", "fonts.conf"); process.env.XDG_CACHE_HOME ??= join(process.cwd(), "uploads", ".cache"); await mkdir(join(process.env.XDG_CACHE_HOME, "fontconfig"), { recursive: true });
    const value = order.type === "FIXED_MENU" ? order.product?.name || "Gift Card" : displayAmount(order.amount, order.currency);
    const includeDescriptionInPrint = order.product?.restrictions?.includeDescriptionInPrint === true;
    const description = includeDescriptionInPrint ? order.product?.description?.trim() : undefined;
    const date = displayDate(validUntil); const flow = giftCardFlow(value, order.type, description);
    let contentOffset = GIFT_CARD_RIGHT_BLOCK.topPadding;
    const rightTop = GIFT_CARD_RIGHT_BLOCK.centerY - (GIFT_CARD_RIGHT_BLOCK.height / 2);
    const dateTop = GIFT_CARD_DATE_BLOCK.centerY - (GIFT_CARD_DATE_BLOCK.height / 2);
    const svgPrintLines = flow.lines.map((line) => { contentOffset += line.marginBefore + line.lineHeight; return `<text class="${line.className}" x="${GIFT_CARD_RIGHT_BLOCK.width / 2}" y="${contentOffset - (line.lineHeight * 0.2)}" text-anchor="middle" font-size="${line.fontSize}">${escapeXml(line.text)}</text>`; }).join("");
    const rightBlockSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${GIFT_CARD_RIGHT_BLOCK.width}" height="${GIFT_CARD_RIGHT_BLOCK.height}"><style>text { font-family: Montserrat, sans-serif; fill: #282621; paint-order: stroke; } .gift-card-value { font-family: 'Playfair Display', serif; font-weight: 800; stroke: #282621; stroke-width: 0.45; } .gift-card-description { font-family: Montserrat, sans-serif; font-weight: 600; }</style>${svgPrintLines}<text x="${GIFT_CARD_RIGHT_BLOCK.width / 2}" y="${flow.codeBaseline}" text-anchor="middle" font-size="22" font-weight="700" stroke="#282621" stroke-width="0.3" letter-spacing="1.8">${escapeXml(code.toUpperCase())}</text></svg>`;
    const dateBlockSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${GIFT_CARD_DATE_BLOCK.width}" height="${GIFT_CARD_DATE_BLOCK.height}"><style>text { font-family: Montserrat, sans-serif; fill: #282621; paint-order: stroke; }</style><text x="${GIFT_CARD_DATE_BLOCK.width / 2}" y="${GIFT_CARD_DATE_BLOCK.dateBaseline - dateTop}" text-anchor="middle" font-size="20" font-weight="700" stroke="#282621" stroke-width="0.25">${escapeXml(date)}</text></svg>`;
    const [rightBlock, dateBlock] = await Promise.all([
      rotateTextBlock(rightBlockSvg, GIFT_CARD_RIGHT_BLOCK.width, GIFT_CARD_RIGHT_BLOCK.height, GIFT_CARD_RIGHT_BLOCK.centerX, GIFT_CARD_RIGHT_BLOCK.centerY),
      rotateTextBlock(dateBlockSvg, GIFT_CARD_DATE_BLOCK.width, GIFT_CARD_DATE_BLOCK.height, GIFT_CARD_DATE_BLOCK.centerX, GIFT_CARD_DATE_BLOCK.centerY),
    ]);
    return sharp(templatePath).composite([rightBlock, dateBlock]).png().toBuffer();
  }

  private async generateAssets(order: any, code: string, validUntil: Date) {
    const directory = join(process.cwd(), "uploads", "gift-cards", order.restaurantId, order.id); await mkdir(directory, { recursive: true });
    const renderedImage = await this.renderGiftCard(order, code, validUntil);
    const imageFile = `gift-card-${code}.png`; const imagePath = join(directory, imageFile); await writeFile(imagePath, renderedImage);
    const pdfFile = `gift-card-${code}.pdf`; const pdfPath = join(directory, pdfFile);
    await new Promise<void>((resolve, reject) => { const doc = new PDFDocument({ size: [540, 720], margin: 0 }); const chunks: Buffer[] = []; doc.on("data", (chunk: Buffer) => chunks.push(chunk)); doc.on("end", async () => { try { await writeFile(pdfPath, Buffer.concat(chunks)); resolve(); } catch (error) { reject(error); } }); doc.on("error", reject); doc.image(renderedImage, 0, 0, { width: 540, height: 720 }); doc.end(); });
    const base = `/uploads/gift-cards/${order.restaurantId}/${order.id}`; return { imageUrl: `${base}/${imageFile}`, pdfUrl: `${base}/${pdfFile}` };
  }
}
