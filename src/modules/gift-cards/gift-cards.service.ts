import { restaurantWebhook, n8nWebhookToken } from "../../common/restaurant-webhooks";
import { requireFeature, requireExternalAccess } from "../../common/restaurant-features";
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
type OrderInput = { productId?: string; type: GiftCardProductType; purchaserName: string; purchaserPhone: string; recipientName?: string | null; message?: string | null; partySize?: number | null; amount?: number; currency?: string; quantity?: number };
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

  private async owner(user: RequestUser) {
    if (user.scope !== "restaurant" || user.role !== "restaurant_owner" || !user.restaurantId) throw new ForbiddenException("Solo el dueño puede administrar Gift Cards");
    await requireFeature(this.prisma, user.restaurantId, "giftCards");
    return user.restaurantId;
  }

  private async giftCardStaff(user: RequestUser, action: string) {
    if (user.scope !== "restaurant" || !user.restaurantId || !["restaurant_owner", "host", "events"].includes(user.role)) throw new ForbiddenException(`Solo el dueño, recepción o eventos pueden ${action}`);
    await requireFeature(this.prisma, user.restaurantId, "giftCards");
    return user.restaurantId;
  }

  private async externalRestaurant(apiKey: string) {
    if (!apiKey) throw new ForbiddenException("Invalid API key");
    const direct = await this.prisma.integrationToken.findFirst({ where: { tokenHash: hashOpaqueToken(apiKey), isActive: true } });
    if (direct) { await requireExternalAccess(this.prisma, direct.restaurantId); await requireFeature(this.prisma, direct.restaurantId, "giftCards"); return direct.restaurantId; }
    const candidates = await this.prisma.integrationToken.findMany({ where: { isActive: true } });
    const legacy = candidates.find((candidate) => verifyPassword(apiKey, candidate.tokenHash));
    if (!legacy) throw new ForbiddenException("Invalid API key");
    await requireExternalAccess(this.prisma, legacy.restaurantId);
    await requireFeature(this.prisma, legacy.restaurantId, "giftCards");
    return legacy.restaurantId;
  }

  private productView(product: any) {
    return { id: product.id, name: product.name, type: product.type, description: product.description, price: product.price == null ? null : money(product.price), minAmount: product.minAmount == null ? null : money(product.minAmount), maxAmount: product.maxAmount == null ? null : money(product.maxAmount), partySize: product.partySize, currency: product.currency, validityDays: product.validityDays, excludedDates: product.excludedDates, restrictions: product.restrictions, paymentAlias: product.paymentAlias, paymentCbu: product.paymentCbu, paymentHolder: product.paymentHolder, isActive: product.isActive, createdAt: product.createdAt, updatedAt: product.updatedAt };
  }

  async listProducts(user: RequestUser) { const restaurantId = await this.giftCardStaff(user, "ver las Gift Cards"); return (await this.prisma.giftCardProduct.findMany({ where: { restaurantId }, orderBy: [{ isActive: "desc" }, { createdAt: "desc" }] })).map((item) => this.productView(item)); }

  async listExternalProducts(apiKey: string) { const restaurantId = await this.externalRestaurant(apiKey); return { products: (await this.prisma.giftCardProduct.findMany({ where: { restaurantId, isActive: true }, orderBy: { createdAt: "asc" } })).map((item) => this.productView(item)) }; }

  async saveProduct(user: RequestUser, productId: string | undefined, input: ProductInput) {
    const restaurantId = await this.owner(user);
    this.validateProduct(input);
    const data = { name: input.name.trim(), type: input.type, description: input.description.trim(), price: input.price == null ? null : new Prisma.Decimal(input.price), minAmount: input.minAmount == null ? null : new Prisma.Decimal(input.minAmount), maxAmount: input.maxAmount == null ? null : new Prisma.Decimal(input.maxAmount), partySize: input.partySize ?? null, currency: input.currency || "ARS", validityDays: input.validityDays, excludedDates: input.excludedDates || [], restrictions: input.restrictions as Prisma.InputJsonValue | undefined, paymentAlias: input.paymentAlias?.trim() || null, paymentCbu: input.paymentCbu?.trim() || null, paymentHolder: input.paymentHolder?.trim() || null, isActive: input.isActive };
    const product = productId ? await this.prisma.giftCardProduct.update({ where: { id: productId, restaurantId }, data }) : await this.prisma.giftCardProduct.create({ data: { restaurantId, ...data } });
    await this.audit.log({ action: productId ? "gift_card.product.updated" : "gift_card.product.created", targetType: "gift_card_product", targetId: product.id, restaurantId, restaurantUserId: user.sub });
    return this.productView(product);
  }

  async deleteProduct(user: RequestUser, productId: string) {
    const restaurantId = await this.owner(user);
    await this.prisma.giftCardProduct.update({ where: { id: productId, restaurantId }, data: { isActive: false } });
    return { success: true };
  }

  async previewProduct(user: RequestUser, input: ProductInput) {
    await this.owner(user);
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
    const restaurantId = await this.giftCardStaff(user, "ver las Gift Cards");
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
      ...(query.giftCardStatus ? { giftCards: { some: { status: query.giftCardStatus as any } } } : {}),
      ...((from || to) ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
      ...(search ? { OR: [{ id: search }, { purchaserName: { contains: search, mode: "insensitive" } }, { purchaserPhone: { contains: search } }, { recipientName: { contains: search, mode: "insensitive" } }, { product: { is: { name: { contains: search, mode: "insensitive" } } } }, { giftCards: { some: { displayCode: { contains: search, mode: "insensitive" } } } }] } : {}),
    };
    const [total, orders] = await Promise.all([
      this.prisma.giftCardOrder.count({ where }),
      this.prisma.giftCardOrder.findMany({ where, include: { product: true, giftCards: { orderBy: { createdAt: "asc" } } }, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    return { items: orders.map((order) => ({ id: order.id, purchaserName: order.purchaserName, purchaserPhone: order.purchaserPhone, recipientName: order.recipientName, message: order.message, type: order.type, partySize: order.partySize, quantity: order.quantity, unitAmount: money(order.unitAmount), amount: money(order.amount), currency: order.currency, paymentMethod: order.paymentMethod, paymentStatus: order.paymentStatus, status: order.status, paymentReference: order.paymentReference, paymentConfirmedAt: order.paymentConfirmedAt, sentAt: order.sentAt, createdAt: order.createdAt, product: order.product ? this.productView(order.product) : null, giftCards: order.giftCards.map((card) => this.giftCardView(card)), giftCard: order.quantity === 1 && order.giftCards[0] ? this.giftCardView(order.giftCards[0]) : null })), total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  }

  private absoluteAsset(value: string | null | undefined) { if (!value) return null; return value.startsWith("http") ? value : `${process.env.PUBLIC_API_ORIGIN || "http://localhost:4000"}${value}`; }

  private giftCardView(card: any) { return { id: card.id, code: card.displayCode, status: card.status, originalAmount: money(card.originalAmount), currency: card.currency, validFrom: dateOnly(card.validFrom), validUntil: dateOnly(card.validUntil), imageUrl: this.absoluteAsset(card.imageUrl), pdfUrl: this.absoluteAsset(card.pdfUrl), issuedAt: card.issuedAt, redeemedAt: card.redeemedAt, sentAt: card.sentAt }; }

  private async resolveOrder(restaurantId: string, input: OrderInput) {
    const quantity = input.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw new ConflictException("La cantidad debe estar entre 1 y 20");
    const product = input.productId ? await this.prisma.giftCardProduct.findFirst({ where: { id: input.productId, restaurantId, isActive: true } }) : null;
    if (input.type === "FIXED_MENU" && !product) throw new NotFoundException("Gift Card product not found");
    if (product && product.type !== input.type) throw new ConflictException("El tipo de Gift Card no coincide con el producto");
    const unitAmount = input.type === "FIXED_MENU" ? Number(product!.price) : Number(input.amount);
    if (!Number.isFinite(unitAmount) || unitAmount <= 0) throw new ConflictException("Invalid Gift Card amount");
    if (input.type === "OPEN_AMOUNT" && product && ((product.minAmount && unitAmount < Number(product.minAmount)) || (product.maxAmount && unitAmount > Number(product.maxAmount)))) throw new ConflictException("Amount is outside product limits");
    if (input.type === "FIXED_MENU" && input.partySize !== undefined && input.partySize !== product!.partySize) throw new ConflictException("Party size does not match product");
    if (product && input.currency && input.currency !== product.currency) throw new ConflictException("La moneda no coincide con el producto");
    return { product, quantity, unitAmount: new Prisma.Decimal(unitAmount), totalAmount: new Prisma.Decimal(unitAmount).mul(quantity), currency: product?.currency || input.currency || "ARS", partySize: input.partySize ?? product?.partySize ?? null };
  }

  private paymentInstructions(product: { paymentAlias: string | null; paymentCbu: string | null; paymentHolder: string | null } | null) {
    return { alias: product?.paymentAlias || process.env.GIFT_CARD_TRANSFER_ALIAS || "Consultar al restaurante", cbu: product?.paymentCbu || process.env.GIFT_CARD_TRANSFER_CBU || null, holder: product?.paymentHolder || process.env.GIFT_CARD_TRANSFER_HOLDER || null };
  }

  private productFingerprint(product: any) {
    return hashOpaqueToken(JSON.stringify({ name: product.name, type: product.type, description: product.description, price: product.price?.toString() ?? null, minAmount: product.minAmount?.toString() ?? null, maxAmount: product.maxAmount?.toString() ?? null, partySize: product.partySize, currency: product.currency, validityDays: product.validityDays, excludedDates: product.excludedDates, restrictions: product.restrictions, paymentAlias: product.paymentAlias, paymentCbu: product.paymentCbu, paymentHolder: product.paymentHolder, isActive: product.isActive }));
  }

  private orderCreatedView(order: { id: string; status: string; paymentMethod: string; amount: Prisma.Decimal; unitAmount: Prisma.Decimal; quantity: number; currency: string }, product: { paymentAlias: string | null; paymentCbu: string | null; paymentHolder: string | null } | null) {
    return { order: { id: order.id, status: order.status, paymentMethod: order.paymentMethod, amount: money(order.amount), unitAmount: money(order.unitAmount), quantity: order.quantity, currency: order.currency, paymentInstructions: this.paymentInstructions(product) } };
  }

  async createExternal(apiKey: string, input: OrderInput, idempotencyKey?: string) {
    const restaurantId = await this.externalRestaurant(apiKey);
    const requestHash = hashOpaqueToken(JSON.stringify(input));
    if (idempotencyKey) {
      const existing = await this.prisma.externalApiRequest.findFirst({ where: { restaurantId, action: "gift_card.create_order", idempotencyKey } });
      if (existing) {
        if (existing.requestHash !== requestHash) throw new ConflictException("La misma clave se usó para otra compra");
        if (existing.responseData) return existing.responseData;
      }
    }
    const resolved = await this.resolveOrder(restaurantId, input);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const order = await tx.giftCardOrder.create({ data: { restaurantId, productId: resolved.product?.id, type: input.type, purchaserName: input.purchaserName.trim(), purchaserPhone: input.purchaserPhone.trim(), recipientName: input.recipientName?.trim() || null, message: input.message?.trim() || null, partySize: resolved.partySize, unitAmount: resolved.unitAmount, quantity: resolved.quantity, amount: resolved.totalAmount, currency: resolved.currency } });
        const response = this.orderCreatedView(order, resolved.product);
        if (idempotencyKey) {
          const token = await tx.integrationToken.findFirstOrThrow({ where: { restaurantId, isActive: true }, select: { id: true } });
          await tx.externalApiRequest.create({ data: { restaurantId, integrationTokenId: token.id, action: "gift_card.create_order", idempotencyKey, requestHash, status: "success", responseData: response } });
        }
        return response;
      });
    } catch (error) {
      if (idempotencyKey && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await this.prisma.externalApiRequest.findFirst({ where: { restaurantId, action: "gift_card.create_order", idempotencyKey } });
        if (existing?.requestHash === requestHash && existing.responseData) return existing.responseData;
      }
      throw error;
    }
  }

  private checkoutView(checkout: any) {
    return { id: checkout.id, status: checkout.status, productId: checkout.productId, productName: checkout.product?.name || null, productDescription: checkout.product?.description || null, validityDays: checkout.product?.validityDays ?? null, type: checkout.type, quantity: checkout.quantity, unitAmount: money(checkout.unitAmount), amount: money(checkout.totalAmount), currency: checkout.currency, purchaserName: checkout.purchaserName, purchaserPhone: checkout.purchaserPhone, expiresAt: checkout.expiresAt, orderId: checkout.order?.id || null };
  }

  async prepareExternal(apiKey: string, input: OrderInput, prepareKey?: string) {
    const restaurantId = await this.externalRestaurant(apiKey);
    if (!input.productId) throw new ConflictException("Seleccioná un producto real de Gift Card");
    const requestHash = hashOpaqueToken(JSON.stringify(input));
    if (prepareKey) {
      const existing = await this.prisma.giftCardCheckout.findFirst({ where: { restaurantId, prepareKey }, include: { product: true, order: true } });
      if (existing) {
        if (existing.requestHash !== requestHash) throw new ConflictException("La misma clave se usó para otra compra");
        return { checkout: this.checkoutView(existing) };
      }
    }
    const resolved = await this.resolveOrder(restaurantId, input);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    try {
      const checkout = await this.prisma.$transaction(async (tx) => {
        const created = await tx.giftCardCheckout.create({ data: { restaurantId, productId: resolved.product?.id, type: input.type, quantity: resolved.quantity, unitAmount: resolved.unitAmount, totalAmount: resolved.totalAmount, currency: resolved.currency, purchaserName: input.purchaserName.trim(), purchaserPhone: input.purchaserPhone.trim(), recipientName: input.recipientName?.trim() || null, message: input.message?.trim() || null, partySize: resolved.partySize, prepareKey, requestHash, productFingerprint: resolved.product ? this.productFingerprint(resolved.product) : null, expiresAt }, include: { product: true, order: true } });
        await tx.giftCardCheckout.updateMany({ where: { restaurantId, purchaserPhone: input.purchaserPhone.trim(), status: "PENDING", id: { not: created.id } }, data: { status: "CANCELLED" } });
        return created;
      });
      return { checkout: this.checkoutView(checkout) };
    } catch (error) {
      if (prepareKey && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await this.prisma.giftCardCheckout.findFirst({ where: { restaurantId, prepareKey }, include: { product: true, order: true } });
        if (existing?.requestHash === requestHash) return { checkout: this.checkoutView(existing) };
      }
      throw error;
    }
  }

  async pendingExternal(apiKey: string, phone: string) {
    const restaurantId = await this.externalRestaurant(apiKey);
    const checkout = await this.prisma.giftCardCheckout.findFirst({ where: { restaurantId, purchaserPhone: phone.trim(), status: "PENDING", expiresAt: { gt: new Date() } }, include: { product: true, order: true }, orderBy: { createdAt: "desc" } });
    return { checkout: checkout ? this.checkoutView(checkout) : null };
  }

  async confirmExternal(apiKey: string, checkoutId: string, phone: string, idempotencyKey?: string) {
    const restaurantId = await this.externalRestaurant(apiKey);
    const requestHash = hashOpaqueToken(phone.trim());
    if (idempotencyKey) {
      const existing = await this.prisma.externalApiRequest.findFirst({ where: { restaurantId, action: "gift_card.confirm_checkout", idempotencyKey } });
      if (existing) { if (existing.requestHash !== requestHash) throw new ConflictException("La misma clave se usó para otro comprador"); if (existing.responseData) return existing.responseData; }
      const requote = await this.prisma.giftCardCheckout.findFirst({ where: { restaurantId, purchaserPhone: phone.trim(), prepareKey: `reprice-${idempotencyKey}` }, include: { product: true, order: true } });
      if (requote) return { requiresReconfirmation: true, checkout: this.checkoutView(requote) };
    }
    const checkout = await this.prisma.giftCardCheckout.findFirst({ where: { id: checkoutId, restaurantId, purchaserPhone: phone.trim() }, include: { product: true, order: true } });
    if (!checkout) throw new NotFoundException("Compra pendiente no encontrada");
    if (checkout.status === "CONFIRMED" && checkout.order) return this.orderCreatedView(checkout.order, checkout.product);
    if (checkout.status !== "PENDING" || checkout.expiresAt <= new Date()) throw new ConflictException({ code: "GIFT_CARD_CHECKOUT_EXPIRED", message: "La propuesta venció. Volvé a consultar el producto." });
    const product = checkout.product;
    if (!product?.isActive) throw new ConflictException({ code: "GIFT_CARD_PRODUCT_UNAVAILABLE", message: "El producto ya no está disponible." });
    const currentAmount = checkout.type === "FIXED_MENU" ? Number(product.price) : money(checkout.unitAmount);
    if (checkout.type !== product.type || product.currency !== checkout.currency) throw new ConflictException({ code: "GIFT_CARD_PRODUCT_CHANGED", message: "El producto cambió. Volvé a consultar el catálogo." });
    if (checkout.type === "OPEN_AMOUNT" && ((product.minAmount && currentAmount < Number(product.minAmount)) || (product.maxAmount && currentAmount > Number(product.maxAmount)))) throw new ConflictException({ code: "GIFT_CARD_AMOUNT_CHANGED", message: "El importe ya no está disponible. Volvé a consultar el catálogo." });
    if (currentAmount !== money(checkout.unitAmount) || (checkout.productFingerprint && checkout.productFingerprint !== this.productFingerprint(product))) {
      const replacement = await this.prepareExternal(apiKey, { productId: product.id, type: checkout.type, quantity: checkout.quantity, purchaserName: checkout.purchaserName, purchaserPhone: checkout.purchaserPhone, recipientName: checkout.recipientName, message: checkout.message, partySize: checkout.partySize || undefined, amount: checkout.type === "OPEN_AMOUNT" ? money(checkout.unitAmount) : undefined, currency: checkout.currency }, idempotencyKey ? `reprice-${idempotencyKey}` : undefined);
      return { requiresReconfirmation: true, checkout: replacement.checkout };
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.giftCardCheckout.updateMany({ where: { id: checkout.id, status: "PENDING", expiresAt: { gt: new Date() } }, data: { status: "CONFIRMED" } });
        let order;
        if (claimed.count !== 1) {
          order = await tx.giftCardOrder.findUnique({ where: { checkoutId: checkout.id } });
          if (!order) throw new ConflictException("La compra pendiente cambió. Intentá nuevamente.");
        } else {
          order = await tx.giftCardOrder.create({ data: { restaurantId, checkoutId: checkout.id, productId: checkout.productId, type: checkout.type, purchaserName: checkout.purchaserName, purchaserPhone: checkout.purchaserPhone, recipientName: checkout.recipientName, message: checkout.message, partySize: checkout.partySize, unitAmount: checkout.unitAmount, quantity: checkout.quantity, amount: checkout.totalAmount, currency: checkout.currency } });
        }
        const response = this.orderCreatedView(order, product);
        if (idempotencyKey) {
          const token = await tx.integrationToken.findFirstOrThrow({ where: { restaurantId, isActive: true }, select: { id: true } });
          await tx.externalApiRequest.create({ data: { restaurantId, integrationTokenId: token.id, action: "gift_card.confirm_checkout", idempotencyKey, requestHash, status: "success", responseData: response } });
        }
        return response;
      });
    } catch (error) {
      if (idempotencyKey && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await this.prisma.externalApiRequest.findFirst({ where: { restaurantId, action: "gift_card.confirm_checkout", idempotencyKey } });
        if (existing?.requestHash === requestHash && existing.responseData) return existing.responseData;
      }
      throw error;
    }
  }

  async getExternal(apiKey: string, orderId: string) { const restaurantId = await this.externalRestaurant(apiKey); const order = await this.prisma.giftCardOrder.findFirst({ where: { id: orderId, restaurantId }, include: { giftCards: { orderBy: { createdAt: "asc" } } } }); if (!order) throw new NotFoundException("Gift Card order not found"); return { order: { id: order.id, status: order.status, paymentStatus: order.paymentStatus, quantity: order.quantity, unitAmount: money(order.unitAmount), amount: money(order.amount), currency: order.currency, giftCards: order.giftCards.map((card) => this.giftCardView(card)), giftCard: order.quantity === 1 && order.giftCards[0] ? this.giftCardView(order.giftCards[0]) : null } }; }

  async confirmPayment(user: RequestUser, orderId: string, approved: boolean, reference?: string) {
    const restaurantId = await this.owner(user);
    const order = await this.prisma.giftCardOrder.findFirst({ where: { id: orderId, restaurantId }, include: { product: true, giftCards: { orderBy: { createdAt: "asc" } } } });
    if (!order) throw new NotFoundException("Gift Card order not found");
    const issuedView = (cards: typeof order.giftCards) => ({ order: order.id, giftCards: cards.map((card) => this.giftCardView(card)), giftCard: order.quantity === 1 && cards[0] ? this.giftCardView(cards[0]) : null });
    if (order.paymentStatus === "CONFIRMED" && order.giftCards.length === order.quantity) return issuedView(order.giftCards);
    if (order.paymentStatus !== "PENDING") throw new ConflictException("La orden no admite una nueva confirmación de pago");
    if (!approved) { const rejected = await this.prisma.giftCardOrder.updateMany({ where: { id: order.id, paymentStatus: "PENDING" }, data: { paymentStatus: "REJECTED", status: "CANCELLED", paymentReference: reference || null } }); if (rejected.count !== 1) throw new ConflictException("La orden cambió mientras se rechazaba el pago"); await this.audit.log({ action: "gift_card.payment.rejected", targetType: "gift_card_order", targetId: order.id, restaurantId, restaurantUserId: user.sub }); return { order: order.id, status: "CANCELLED" }; }
    const validFrom = new Date(); const validityDays = order.product?.validityDays || 180; const validUntil = new Date(validFrom); validUntil.setUTCDate(validUntil.getUTCDate() + validityDays);
    const generatedCodes: string[] = [];
    let issued: typeof order.giftCards;
    try {
      issued = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.giftCardOrder.updateMany({ where: { id: order.id, paymentStatus: "PENDING", giftCards: { none: {} } }, data: { paymentStatus: "CONFIRMED", status: "PAID", paymentReference: reference || null, paymentConfirmedAt: new Date(), paymentConfirmedBy: user.sub } });
        if (updated.count !== 1) {
          const existing = await tx.giftCard.findMany({ where: { orderId: order.id }, orderBy: { createdAt: "asc" } });
          if (existing.length === order.quantity) return existing;
          throw new ConflictException("Order payment state changed");
        }
        const cards: typeof order.giftCards = [];
        for (let index = 0; index < order.quantity; index += 1) {
          let displayCode = createGiftCardCode();
          while (generatedCodes.includes(displayCode)) displayCode = createGiftCardCode();
          generatedCodes.push(displayCode);
          const assets = await this.generateAssets(order, displayCode, validUntil);
          cards.push(await tx.giftCard.create({ data: { restaurantId, orderId: order.id, displayCode, originalAmount: order.unitAmount, currency: order.currency, validFrom, validUntil, imageUrl: assets.imageUrl, pdfUrl: assets.pdfUrl } }));
        }
        return cards;
      }, { timeout: 180000 });
    } catch (error) {
      const directory = join(process.cwd(), "uploads", "gift-cards", restaurantId, order.id);
      await Promise.all(generatedCodes.flatMap((code) => [rm(join(directory, `gift-card-${code}.png`), { force: true }), rm(join(directory, `gift-card-${code}.pdf`), { force: true })]));
      throw error;
    }
    await this.audit.log({ action: "gift_card.issued", targetType: "gift_card_order", targetId: order.id, restaurantId, restaurantUserId: user.sub, metadata: { quantity: issued.length, cardIds: issued.map((card) => card.id) } });
    return issuedView(issued);
  }

  async sendGiftCard(user: RequestUser, orderId: string, resend = false) {
    const restaurantId = await this.owner(user);
    await requireExternalAccess(this.prisma, restaurantId);
    const order = await this.prisma.giftCardOrder.findFirst({ where: { id: orderId, restaurantId }, include: { giftCards: { orderBy: { createdAt: "asc" } }, restaurant: { select: { chatPhoneNumberId: true } } } });
    if (!order) throw new NotFoundException("Gift Card order not found");
    if (order.giftCards.length !== order.quantity) throw new ConflictException("La compra todavía no tiene todas las Gift Cards emitidas");
    const activeCards = order.giftCards.filter((card) => card.status === GiftCardStatus.ACTIVE);
    if (!activeCards.length || activeCards.some((card) => !card.imageUrl)) throw new ConflictException("No hay Gift Cards activas con imagen para enviar");
    const pending = resend ? activeCards : activeCards.filter((card) => !card.sentAt);
    if (!pending.length) return { sent: true, sentCount: activeCards.length, totalCount: activeCards.length, reason: null };
    const clientId = order.restaurant?.chatPhoneNumberId?.trim();
    if (!clientId) throw new ConflictException("Configurá el canal de WhatsApp de este restaurante antes de enviar Gift Cards");
    const webhookUrl = restaurantWebhook("giftCard", restaurantId, clientId);
    if (!webhookUrl) throw new ConflictException("Falta configurar el envío de Gift Cards para el canal de este restaurante");
    const webhookToken = n8nWebhookToken();
    for (const card of pending) {
      let result: { sent?: boolean; reason?: string | null; lastInboundAt?: string | null } | null = null;
      try {
        const response = await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json", "x-n8n-token": webhookToken }, body: JSON.stringify({ clientId, phoneNumber: order.purchaserPhone, imageUrl: this.absoluteAsset(card.imageUrl), caption: `¡Tu Gift Card está lista! Código: ${card.displayCode}.`, orderId: order.id, restaurantId, code: card.displayCode }) });
        result = (await response.json().catch(() => null)) as { sent?: boolean; reason?: string | null; lastInboundAt?: string | null } | null;
        if (!response.ok) throw new Error(`n8n respondió ${response.status}`);
      } catch (error) {
        await this.audit.log({ action: "gift_card.send.failed", targetType: "gift_card", targetId: card.id, restaurantId, restaurantUserId: user.sub, metadata: { error: error instanceof Error ? error.message : String(error) } });
        return { sent: false, sentCount: await this.prisma.giftCard.count({ where: { orderId: order.id, status: GiftCardStatus.ACTIVE, sentAt: { not: null } } }), totalCount: activeCards.length, reason: "SEND_FAILED" };
      }
      if (!result?.sent) {
        await this.audit.log({ action: "gift_card.send.blocked", targetType: "gift_card", targetId: card.id, restaurantId, restaurantUserId: user.sub, metadata: { reason: result?.reason || "NOT_SENT", lastInboundAt: result?.lastInboundAt || null } });
        return { sent: false, sentCount: await this.prisma.giftCard.count({ where: { orderId: order.id, status: GiftCardStatus.ACTIVE, sentAt: { not: null } } }), totalCount: activeCards.length, reason: result?.reason || "NOT_SENT", lastInboundAt: result?.lastInboundAt || null };
      }
      await this.prisma.giftCard.update({ where: { id: card.id }, data: { sentAt: new Date(), sentBy: user.sub } });
      await this.audit.log({ action: "gift_card.sent", targetType: "gift_card", targetId: card.id, restaurantId, restaurantUserId: user.sub, metadata: { channel: "whatsapp", clientId, orderId: order.id } });
    }
    const sentAt = new Date();
    await this.prisma.giftCardOrder.update({ where: { id: order.id }, data: { sentAt, sentBy: user.sub } });
    return { sent: true, sentAt, sentCount: activeCards.length, totalCount: activeCards.length, reason: null };
  }

  async cancelOrder(user: RequestUser, orderId: string) {
    const restaurantId = await this.owner(user);
    const order = await this.prisma.giftCardOrder.findFirst({ where: { id: orderId, restaurantId }, include: { giftCards: { include: { redemptions: { select: { id: true }, take: 1 } } } } });
    if (!order) throw new NotFoundException("Gift Card order not found");
    if (order.status === "CANCELLED") throw new ConflictException("La orden ya está cancelada");
    if (!["PENDING_PAYMENT", "PAID"].includes(order.status)) throw new ConflictException("La orden no puede cancelarse en su estado actual");
    if (order.giftCards.some((card) => (card.status !== GiftCardStatus.ACTIVE && card.status !== GiftCardStatus.CANCELLED) || card.redemptions.length > 0)) {
      throw new ConflictException("La Gift Card ya fue canjeada o no está activa");
    }

    const cancelled = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.giftCardOrder.updateMany({ where: { id: order.id, restaurantId, status: { in: ["PENDING_PAYMENT", "PAID"] } }, data: { status: "CANCELLED" } });
      if (updated.count !== 1) throw new ConflictException("La orden cambió mientras se cancelaba");
      const activeCount = order.giftCards.filter((card) => card.status === GiftCardStatus.ACTIVE).length;
      if (activeCount) { const cards = await tx.giftCard.updateMany({ where: { orderId: order.id, status: "ACTIVE" }, data: { status: GiftCardStatus.CANCELLED } }); if (cards.count !== activeCount) throw new ConflictException("Una Gift Card cambió mientras se cancelaba"); }
      return tx.giftCardOrder.findUniqueOrThrow({ where: { id: order.id } });
    });
    await this.audit.log({ action: "gift_card.order.cancelled", targetType: "gift_card_order", targetId: order.id, restaurantId, restaurantUserId: user.sub, metadata: { cardCount: order.giftCards.length } });
    return { id: cancelled.id, status: cancelled.status };
  }

  async cancelCard(user: RequestUser, cardId: string) {
    const restaurantId = await this.owner(user);
    const card = await this.prisma.giftCard.findFirst({ where: { id: cardId, restaurantId }, include: { order: true, redemptions: { select: { id: true }, take: 1 } } });
    if (!card) throw new NotFoundException("Gift Card not found");
    if (card.order.status !== "PAID" || card.status !== GiftCardStatus.ACTIVE || card.redemptions.length) throw new ConflictException("La Gift Card no se puede cancelar");
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.giftCard.updateMany({ where: { id: card.id, status: GiftCardStatus.ACTIVE }, data: { status: GiftCardStatus.CANCELLED } });
      if (updated.count !== 1) throw new ConflictException("La Gift Card cambió mientras se cancelaba");
      const active = await tx.giftCard.count({ where: { orderId: card.orderId, status: { not: GiftCardStatus.CANCELLED } } });
      if (active === 0) await tx.giftCardOrder.update({ where: { id: card.orderId }, data: { status: "CANCELLED" } });
    });
    await this.audit.log({ action: "gift_card.cancelled", targetType: "gift_card", targetId: card.id, restaurantId, restaurantUserId: user.sub, metadata: { orderId: card.orderId } });
    return { id: card.id, status: GiftCardStatus.CANCELLED };
  }

  async deleteOrder(user: RequestUser, orderId: string) {
    const restaurantId = await this.owner(user);
    const order = await this.prisma.giftCardOrder.findFirst({ where: { id: orderId, restaurantId }, include: { giftCards: { include: { redemptions: { select: { id: true } } } } } });
    if (!order) throw new NotFoundException("Gift Card order not found");

    await this.prisma.giftCardOrder.delete({ where: { id: order.id } });
    await rm(join(process.cwd(), "uploads", "gift-cards", restaurantId, order.id), { recursive: true, force: true });
    await this.audit.log({ action: "gift_card.order.deleted", targetType: "gift_card_order", targetId: order.id, restaurantId, restaurantUserId: user.sub, metadata: { orderStatus: order.status, cardCount: order.giftCards.length, redemptionCount: order.giftCards.reduce((total, card) => total + card.redemptions.length, 0) } });
    return { id: order.id, deleted: true };
  }

  async redeem(user: RequestUser, input: { code?: string; notes?: string; reservationId?: string }) {
    const restaurantId = await this.giftCardStaff(user, "canjear Gift Cards"); const code = input.code?.trim(); if (!code) throw new ConflictException("Gift Card code is required"); const card = await this.prisma.giftCard.findFirst({ where: { restaurantId, displayCode: code }, include: { order: true } });
    if (!card) throw new NotFoundException("Gift Card not found");
    if (card.status !== "ACTIVE") throw new ConflictException("Gift Card is not active");
    if (card.validUntil < new Date()) { await this.prisma.giftCard.update({ where: { id: card.id }, data: { status: "EXPIRED" } }); throw new ConflictException("Gift Card expired"); }
    const redeemed = await this.prisma.$transaction(async (tx) => { const locked = await tx.giftCard.updateMany({ where: { id: card.id, status: "ACTIVE" }, data: { status: "REDEEMED", redeemedAt: new Date() } }); if (locked.count !== 1) throw new ConflictException("Gift Card already redeemed"); await tx.giftCardRedemption.create({ data: { giftCardId: card.id, restaurantId, redeemedBy: user.sub, reservationId: input.reservationId, notes: input.notes } }); const remaining = await tx.giftCard.count({ where: { orderId: card.orderId, status: { not: "REDEEMED" } } }); if (remaining === 0) await tx.giftCardOrder.update({ where: { id: card.orderId }, data: { status: "REDEEMED" } }); return tx.giftCard.findUniqueOrThrow({ where: { id: card.id } }); });
    await this.audit.log({ action: "gift_card.redeemed", targetType: "gift_card", targetId: card.id, restaurantId, restaurantUserId: user.sub, metadata: { reservationId: input.reservationId || null } });
    return this.giftCardView(redeemed);
  }

  private async renderGiftCard(order: any, code: string, validUntil: Date) {
    const assetsDirectory = join(process.cwd(), "assets"); const templatePath = join(assetsDirectory, "gift-card-template.png");
    process.env.FONTCONFIG_FILE ??= join(assetsDirectory, "fonts", "fonts.conf"); process.env.XDG_CACHE_HOME ??= join(process.cwd(), "uploads", ".cache"); await mkdir(join(process.env.XDG_CACHE_HOME, "fontconfig"), { recursive: true });
    const value = order.type === "FIXED_MENU" ? order.product?.name || "Gift Card" : displayAmount(order.unitAmount ?? order.amount, order.currency);
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
