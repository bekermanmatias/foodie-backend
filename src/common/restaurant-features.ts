import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../modules/prisma/prisma.service";

export type FeatureDefinition = { key: string; label: string; description: string; group: "module" | "preview"; defaultEnabled?: boolean; module?: string };
// New definitions default to OFF. Preview implementations must branch using requireFeature/isFeatureEnabled.
export const FEATURE_CATALOG: FeatureDefinition[] = [
  { key: "giftCards", label: "Gift Cards", description: "Productos, emisión y gestión de Gift Cards.", group: "module", defaultEnabled: true },
  { key: "notifications", label: "Notificaciones", description: "Alertas y seguimiento de pedidos por chat.", group: "module", defaultEnabled: true }
];

export function resolveFeatures(overrides: unknown, catalog = FEATURE_CATALOG): Record<string, boolean> {
  const values = (overrides && typeof overrides === "object" && !Array.isArray(overrides) ? overrides : {}) as Record<string, unknown>;
  const byKey = new Map(catalog.map((item) => [item.key, item]));
  const resolve = (key: string, visited = new Set<string>()): boolean => {
    const definition = byKey.get(key);
    if (!definition || visited.has(key)) return false;
    visited.add(key);
    const enabled = typeof values[key] === "boolean" ? values[key] : definition.defaultEnabled === true;
    return Boolean(enabled && (!definition.module || resolve(definition.module, visited)));
  };
  return Object.fromEntries(catalog.map((item) => [item.key, resolve(item.key)]));
}

export async function restaurantFeatures(prisma: PrismaService, restaurantId: string) {
  const row = await prisma.restaurant.findUnique({ where: { id: restaurantId }, select: { isDemo: true, featureOverrides: true } });
  if (!row) throw new NotFoundException("Restaurante no encontrado");
  return { isDemo: row.isDemo, overrides: row.featureOverrides, enabled: resolveFeatures(row.featureOverrides) };
}

export async function requireFeature(prisma: PrismaService, restaurantId: string, key: string) {
  const config = await restaurantFeatures(prisma, restaurantId);
  if (!config.enabled[key]) throw new ForbiddenException({ code: "MODULE_DISABLED", message: "Este módulo no está habilitado para el restaurante", feature: key });
}

export async function requireExternalAccess(prisma: PrismaService, restaurantId: string) {
  if ((await restaurantFeatures(prisma, restaurantId)).isDemo) {
    throw new ForbiddenException({ code: "DEMO_EXTERNAL_BLOCKED", message: "La cuenta demo permite únicamente pruebas internas" });
  }
}
