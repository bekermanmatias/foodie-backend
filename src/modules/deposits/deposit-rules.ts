import { z } from "zod";
import { Prisma } from "@prisma/client";
import { ConflictException } from "@nestjs/common";

export const settingsSchema = z.object({
  reviewed: z.boolean(), currency: z.literal("ARS").default("ARS"),
  bankAlias: z.string().trim().max(120), bankCbu: z.string().trim().max(40).default(""), bankHolder: z.string().trim().max(160),
  paymentHours: z.number().int().min(1).max(720),
  rules: z.array(z.object({ id: z.string().min(1).max(80), label: z.string().min(1).max(120),
    minPeople: z.number().int().min(1), maxPeople: z.number().int().min(1).nullable().default(null),
    eventId: z.string().min(1).nullable().default(null), mode: z.enum(["fixed", "per_person"]), amount: z.number().positive().multipleOf(0.01).max(99999999)
  }).refine((rule) => rule.maxPeople === null || rule.maxPeople >= rule.minPeople, "Tramo inválido")).max(100)
}).strict().superRefine((settings, ctx) => {
  if (settings.reviewed && (!settings.bankHolder || (!settings.bankAlias && !settings.bankCbu))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Completá los datos de transferencia antes de aprobar la configuración" });
  const ids = new Set<string>();
  settings.rules.forEach((rule, index) => {
    if (ids.has(rule.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Identificador de regla repetido", path: ["rules", index] });
    ids.add(rule.id);
    if (settings.rules.slice(0, index).some((other) => other.eventId === rule.eventId && rule.minPeople <= (other.maxPeople ?? Infinity) && other.minPeople <= (rule.maxPeople ?? Infinity))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Las reglas del mismo evento no pueden superponer tramos", path: ["rules", index] });
    }
  });
});
export type DepositSettings = z.infer<typeof settingsSchema>;
export const EMPTY_SETTINGS: DepositSettings = { reviewed: false, currency: "ARS", bankAlias: "", bankCbu: "", bankHolder: "", paymentHours: 48, rules: [] };
export const normalizeDepositPhone = (value: string) => value.replace(/\D/g, "");

export function calculateDeposit(config: unknown, partySize: number, eventId?: string | null) {
  const result = settingsSchema.safeParse(config);
  if (!result.success || !result.data.reviewed) return null;
  const settings = result.data;
  const matches = (event: string | null) => settings.rules.find((rule) => rule.eventId === event && partySize >= rule.minPeople && (rule.maxPeople === null || partySize <= rule.maxPeople));
  const rule = (eventId ? matches(eventId) : undefined) ?? matches(null);
  if (!rule) return null;
  const amount = new Prisma.Decimal(rule.amount).mul(rule.mode === "per_person" ? partySize : 1).toDecimalPlaces(2);
  if (amount.gt("9999999999.99")) throw new ConflictException("El importe calculado supera el máximo admitido");
  return { requiredAmount: amount, currency: settings.currency, dueAt: new Date(Date.now() + settings.paymentHours * 3600000),
    ruleSnapshot: { rule, currency: settings.currency, bankAlias: settings.bankAlias, bankCbu: settings.bankCbu, bankHolder: settings.bankHolder, paymentHours: settings.paymentHours } as Prisma.InputJsonValue };
}

export async function initialReservationDeposit(tx: Prisma.TransactionClient, restaurantId: string, partySize: number, eventId?: string | null) {
  const restaurant = await tx.restaurant.findUniqueOrThrow({ where: { id: restaurantId }, select: { featureOverrides: true, depositSettings: true } });
  const enabled = (restaurant.featureOverrides as Record<string, unknown>)?.deposits === true;
  if (!enabled) return null;
  const parsed = settingsSchema.safeParse(restaurant.depositSettings?.config);
  if (!parsed.success || !parsed.data.reviewed) throw new ConflictException("El restaurante debe revisar la configuración de señas antes de recibir nuevas reservas con este módulo habilitado");
  return calculateDeposit(parsed.data, partySize, eventId);
}
