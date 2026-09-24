import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { z } from "zod";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { RequestUser } from "../../common/auth/request-user";
import { Roles } from "../../common/auth/roles.decorator";
import { RestaurantsService } from "./restaurants.service";

const branchSchema = z.object({
  name: z.string().min(2),
  timezone: z.string().min(2)
});

const restaurantUserSchema = z.object({
  fullName: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(4),
  role: z.enum(["restaurant_owner", "restaurant_manager", "host", "waiter", "cashier", "kitchen", "events"])
});

const updateRestaurantUserSchema = z
  .object({
    fullName: z.string().min(2).optional(),
    email: z.string().email().optional(),
    password: z.string().min(4).optional(),
    role: z.enum(["restaurant_owner", "restaurant_manager", "host", "waiter", "cashier", "kitchen", "events"]).optional(),
    isActive: z.boolean().optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required"
  });

const rotateTokenSchema = z.object({
  label: z.string().min(2)
});
const chatAuthSchema = z.object({
  email: z.string().email(),
  password: z.string().min(4)
});
const updateRestaurantSchema = z
  .object({
    name: z.string().min(2).optional(),
    slug: z.string().min(2).optional(),
    profileImageUrl: z.string().max(1000).nullable().optional(),
    isActive: z.boolean().optional(),
    chatPhoneNumberId: z.string().max(64).nullable().optional()
  })
  .refine((value) => Object.keys(value).length > 0, { message: "At least one field is required" });
const updateBranchSchema = z.object({ name: z.string().min(2) });

@Controller("platform/restaurants/:restaurantId")
@Roles("platform_admin")
export class PlatformTenantsController {
  constructor(private readonly restaurantsService: RestaurantsService) {}

  @Get()
  detail(@Param("restaurantId") restaurantId: string) {
    return this.restaurantsService.detail(restaurantId);
  }

  @Patch()
  update(@Param("restaurantId") restaurantId: string, @Body() body: unknown, @CurrentUser() user: RequestUser) {
    return this.restaurantsService.updateRestaurant(restaurantId, updateRestaurantSchema.parse(body), user);
  }

  @Patch("branches/:branchId")
  updateBranch(
    @Param("restaurantId") restaurantId: string,
    @Param("branchId") branchId: string,
    @Body() body: unknown,
    @CurrentUser() user: RequestUser
  ) {
    return this.restaurantsService.updateBranch(restaurantId, branchId, updateBranchSchema.parse(body), user);
  }

  @Post("branches")
  createBranch(
    @Param("restaurantId") restaurantId: string,
    @Body() body: unknown,
    @CurrentUser() user: RequestUser
  ) {
    return this.restaurantsService.createBranch(restaurantId, branchSchema.parse(body), user);
  }

  @Post("users")
  createUser(
    @Param("restaurantId") restaurantId: string,
    @Body() body: unknown,
    @CurrentUser() user: RequestUser
  ) {
    return this.restaurantsService.createRestaurantUser(restaurantId, restaurantUserSchema.parse(body), user);
  }

  @Patch("users/:userId")
  updateUser(
    @Param("restaurantId") restaurantId: string,
    @Param("userId") userId: string,
    @Body() body: unknown,
    @CurrentUser() user: RequestUser
  ) {
    return this.restaurantsService.updateRestaurantUser(
      restaurantId,
      userId,
      updateRestaurantUserSchema.parse(body),
      user
    );
  }

  @Delete("users/:userId")
  removeUser(
    @Param("restaurantId") restaurantId: string,
    @Param("userId") userId: string,
    @CurrentUser() user: RequestUser
  ) {
    return this.restaurantsService.removeRestaurantUser(restaurantId, userId, user);
  }

  @Patch("chat-auth")
  configureChatAuth(
    @Param("restaurantId") restaurantId: string,
    @Body() body: unknown,
    @CurrentUser() user: RequestUser
  ) {
    return this.restaurantsService.configureChatAuth(restaurantId, chatAuthSchema.parse(body), user);
  }
  @Post("integration-tokens/rotate")
  rotateToken(
    @Param("restaurantId") restaurantId: string,
    @Body() body: unknown,
    @CurrentUser() user: RequestUser
  ) {
    return this.restaurantsService.rotateIntegrationToken(restaurantId, rotateTokenSchema.parse(body), user);
  }
}
