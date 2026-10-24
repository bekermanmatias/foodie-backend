import { z } from "zod";

export const chatOrderSchema = z.object({
  channelId: z.string().trim().min(1).max(200),
  chatId: z.string().trim().min(1).max(200),
  sourceMessageId: z.string().trim().min(1).max(512),
  contactName: z.string().trim().max(200).optional(),
  contactPhone: z.string().trim().regex(/^\+?\d{6,20}$/),
  occurredAt: z.string().datetime({ offset: true }),
  orderMode: z.enum(["delivery", "takeaway", "unknown"]),
  summary: z.string().trim().min(1).max(2000)
});
