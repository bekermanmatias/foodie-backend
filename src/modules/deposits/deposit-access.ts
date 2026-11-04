import { ForbiddenException } from "@nestjs/common";
import type { RequestUser } from "../../common/auth/request-user";
import { requireFeature } from "../../common/restaurant-features";
import { PrismaService } from "../prisma/prisma.service";

export async function depositActor(prisma: PrismaService, user: RequestUser, ownerOnly = false) {
  if (user.scope !== "restaurant" || !user.restaurantId || !(ownerOnly ? ["restaurant_owner"] : ["restaurant_owner", "restaurant_manager", "cashier"]).includes(user.role)) {
    throw new ForbiddenException("No tenés permiso para gestionar señas");
  }
  await requireFeature(prisma, user.restaurantId, "deposits");
  return user.restaurantId;
}
