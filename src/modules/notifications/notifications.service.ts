import { requireFeature } from "../../common/restaurant-features";
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { RequestUser } from "../../common/auth/request-user";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";

export type ChatOrderInput = {
  channelId: string;
  chatId: string;
  sourceMessageId: string;
  contactName?: string;
  contactPhone: string;
  occurredAt: string;
  orderMode: "delivery" | "takeaway" | "unknown";
  summary: string;
};

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private async restaurantId(user: RequestUser) {
    if (user.scope !== "restaurant" || !user.restaurantId || !["restaurant_owner", "restaurant_manager", "host"].includes(user.role)) {
      throw new ForbiddenException("No tenés permiso para acceder a las notificaciones");
    }
    await requireFeature(this.prisma, user.restaurantId, "notifications");
    return user.restaurantId;
  }

  async receiveOrder(restaurantId: string, input: ChatOrderInput) {
    await requireFeature(this.prisma, restaurantId, "notifications");
    const eventKey = JSON.stringify([input.channelId, input.chatId, input.sourceMessageId]);
    return this.prisma.$transaction(async (tx) => {
      // Serialize incoming events and attention changes for the same conversation.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${restaurantId}), hashtext(${input.chatId}))`;
      const previous = await tx.notificationEvent.findUnique({ where: { restaurantId_eventKey: { restaurantId, eventKey } } });
      if (previous) return { notificationId: previous.notificationId, duplicate: true, created: false };

      const activeKey = JSON.stringify([input.channelId, input.chatId]);
      const pending = await tx.notification.findUnique({ where: { restaurantId_activeKey: { restaurantId, activeKey } } });
      const occurredAt = new Date(input.occurredAt);
      const data = {
        channelId: input.channelId, chatId: input.chatId,
        contactName: input.contactName || null, contactPhone: input.contactPhone,
        orderMode: input.orderMode, summary: input.summary, occurredAt
      };
      // Older events delivered late cannot overwrite more recent information.
      const notification = pending
        ? occurredAt >= pending.occurredAt
          ? await tx.notification.update({ where: { id: pending.id }, data })
          : pending
        : await tx.notification.create({ data: { ...data, restaurantId, activeKey } });
      await tx.notificationEvent.create({ data: { restaurantId, eventKey, sourceMessageId: input.sourceMessageId, notificationId: notification.id } });
      return { notificationId: notification.id, duplicate: false, created: !pending };
    });
  }

  async list(user: RequestUser, input: { status?: "pending" | "attended"; unread?: boolean; page: number; pageSize: number }) {
    const restaurantId = await this.restaurantId(user);
    const where = {
      restaurantId,
      deletedAt: null,
      ...(input.status ? { status: input.status } : {}),
      ...(input.unread ? { reads: { none: { userId: user.sub } } } : {})
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({ where, skip: (input.page - 1) * input.pageSize, take: input.pageSize,
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        include: { reads: { where: { userId: user.sub }, select: { readAt: true } }, attendedBy: { select: { fullName: true } } } }),
      this.prisma.notification.count({ where })
    ]);
    return { items: items.map(({ reads, ...item }) => ({ ...item, readAt: reads[0]?.readAt || null })), total, page: input.page, pageSize: input.pageSize };
  }

  async counts(user: RequestUser) {
    const restaurantId = await this.restaurantId(user);
    const [unread, pending] = await this.prisma.$transaction([
      this.prisma.notification.count({ where: { restaurantId, deletedAt: null, status: "pending", reads: { none: { userId: user.sub } } } }),
      this.prisma.notification.count({ where: { restaurantId, deletedAt: null, status: "pending" } })
    ]);
    return { unread, pending };
  }

  private async find(user: RequestUser, id: string) {
    const notification = await this.prisma.notification.findFirst({ where: { id, restaurantId: await this.restaurantId(user), deletedAt: null } });
    if (!notification) throw new NotFoundException("Notificación no encontrada");
    return notification;
  }

  async read(user: RequestUser, id: string) {
    await this.find(user, id);
    // Empty-update upserts can become a read/create race in Prisma. ON CONFLICT
    // DO NOTHING preserves the first read timestamp even with concurrent tabs.
    await this.prisma.notificationRead.createMany({ data: [{ notificationId: id, userId: user.sub }], skipDuplicates: true });
    return this.prisma.notificationRead.findUniqueOrThrow({ where: { notificationId_userId: { notificationId: id, userId: user.sub } } });
  }

  async attend(user: RequestUser, id: string) {
    const notification = await this.find(user, id);
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${notification.restaurantId}), hashtext(${notification.chatId}))`;
      return tx.notification.updateMany({ where: { id, restaurantId: notification.restaurantId, status: "pending" },
        data: { status: "attended", activeKey: null, attendedAt: new Date(), attendedByUserId: user.sub } });
    });
    if (result.count) await this.audit.log({ action: "notification.attended", targetType: "notification", targetId: id,
      restaurantId: notification.restaurantId, restaurantUserId: user.sub });
    return { attended: true };
  }

  async remove(user: RequestUser, id: string) {
    const restaurantId = await this.restaurantId(user);
    const notification = await this.prisma.notification.findFirst({ where: { id, restaurantId } });
    if (!notification) throw new NotFoundException("Notificación no encontrada");
    if (notification.status !== "attended") throw new ConflictException("Primero marcá la notificación como atendida para eliminarla");
    // Keep source events so late retries cannot recreate an alert that was deleted.
    const result = await this.prisma.notification.updateMany({
      where: { id, restaurantId, status: "attended", deletedAt: null },
      data: { deletedAt: new Date() }
    });
    if (result.count) await this.audit.log({ action: "notification.deleted", targetType: "notification", targetId: id,
      restaurantId, restaurantUserId: user.sub });
    return { deleted: true };
  }
}
