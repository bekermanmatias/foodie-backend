import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, Patch } from "@nestjs/common";
import { z } from "zod";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { RequestUser } from "../../common/auth/request-user";
import { Roles } from "../../common/auth/roles.decorator";
import { FEATURE_CATALOG, restaurantFeatures, resolveFeatures } from "../../common/restaurant-features";
import { PrismaService } from "../prisma/prisma.service";

const overridesSchema = z.record(z.boolean()).superRefine((values, context) => {
  for (const key of Object.keys(values)) if (!FEATURE_CATALOG.some((feature) => feature.key === key)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Función desconocida", path: [key] });
  }
});
export const featurePatchSchema = z.object({ isDemo: z.boolean().optional(), overrides: overridesSchema.optional() }).strict()
  .refine((value) => value.isDemo !== undefined || value.overrides !== undefined, "Indicá los cambios a guardar");

@Controller("platform/restaurants/:restaurantId/features")
@Roles("platform_admin")
export class RestaurantFeaturesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async get(@Param("restaurantId") restaurantId: string) {
    return { ...await restaurantFeatures(this.prisma, restaurantId), catalog: FEATURE_CATALOG };
  }

  @Patch()
  async patch(@Param("restaurantId") restaurantId: string, @Body() body: unknown, @CurrentUser() actor: RequestUser) {
    const result = featurePatchSchema.safeParse(body);
    if (!result.success) throw new BadRequestException({ message: "Configuración de módulos inválida", issues: result.error.issues });
    const input = result.data;
    return this.prisma.$transaction(async (tx) => {
      // Serialize partial updates so administrators cannot silently overwrite one another's options.
      await tx.$queryRaw`SELECT id FROM "Restaurant" WHERE id = ${restaurantId} FOR UPDATE`;
      const before = await tx.restaurant.findUnique({ where: { id: restaurantId }, select: { isDemo: true, featureOverrides: true } });
      if (!before) throw new NotFoundException("Restaurante no encontrado");
      if (input.isDemo === true && !before.isDemo) {
        const connections = await tx.restaurant.findUniqueOrThrow({ where: { id: restaurantId }, select: {
          chatClientId: true, chatWabaId: true, chatAccessToken: true, chatWorkflowId: true,
          chatPhoneNumberId: true, chatAuthEmail: true, chatAuthSecret: true
        } });
        if (Object.values(connections).some(Boolean)) throw new ConflictException({ code: "DEMO_HAS_CONNECTIONS",
          message: "Elegí un restaurante separado sin conexiones de chat configuradas para usarlo como demo" });
      }
      const overrides = { ...(before.featureOverrides as Record<string, boolean>), ...input.overrides };
      const after = { isDemo: input.isDemo ?? before.isDemo, featureOverrides: overrides };
      await tx.restaurant.update({ where: { id: restaurantId }, data: after });
      await tx.restaurantCustomization.upsert({ where: { restaurantId }, create: { restaurantId, configVersion: 2 }, update: { configVersion: { increment: 1 } } });
      await tx.auditLog.create({ data: { action: "restaurant.features.updated", targetType: "restaurant", targetId: restaurantId,
        restaurantId, platformUserId: actor.sub, metadata: { before, after } } });
      return { isDemo: after.isDemo, overrides, enabled: resolveFeatures(overrides), catalog: FEATURE_CATALOG };
    });
  }
}
