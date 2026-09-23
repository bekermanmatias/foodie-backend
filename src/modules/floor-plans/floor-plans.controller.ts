import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { FloorPlansService } from "./floor-plans.service";
import { Roles } from "../../common/auth/roles.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { RequestUser } from "../../common/auth/request-user";
import { z } from "zod";

const roomSchema = z.object({
  branchId: z.string().min(1),
  name: z.string().min(2),
  description: z.string().optional(),
  isOutdoor: z.boolean().optional()
});

const updateRoomSchema = z.object({
  name: z.string().min(2),
  description: z.string().optional(),
  isOutdoor: z.boolean().optional()
});

const reorderRoomsSchema = z.object({
  branchId: z.string().min(1),
  roomIds: z.array(z.string().min(1)).min(1)
}).refine((value) => new Set(value.roomIds).size === value.roomIds.length, "Room ids must be unique");

const roomBlockSchema = z.object({
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  turn: z.enum(["mediodia", "noche"]),
  reason: z.string().trim().max(500).optional()
});

const roomBlockQuerySchema = z.object({
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  turn: z.enum(["mediodia", "noche"])
});

const roomBookingRuleSchema = z.object({
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).refine((value) => new Set(value).size === value.length, "Weekdays must be unique"),
  turns: z.array(z.enum(["mediodia", "noche"])).min(1).refine((value) => new Set(value).size === value.length, "Turns must be unique"),
  startsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  reason: z.string().trim().max(500).nullable().optional()
}).refine((value) => !value.endsAt || value.endsAt >= value.startsAt, "La fecha de fin debe ser posterior a la fecha de inicio");

const layoutSchema = z.object({
  zones: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      slug: z.string().min(1)
    })
  ),
  items: z.array(
    z.object({
      id: z.string().min(1),
      kind: z.string().min(1),
      label: z.string().optional(),
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
      rotation: z.number().optional(),
      metadata: z.record(z.any()).optional()
    })
  ),
  tables: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      shape: z.string().min(1),
      seats: z.number().int().min(1),
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
      rotation: z.number().optional(),
      isReservable: z.boolean(),
      metadata: z.record(z.any()).optional(),
      zoneId: z.string().nullable().optional()
    })
  ),
  combinations: z.array(
    z.object({
      id: z.string().min(1),
      parentTableId: z.string().min(1),
      childTableId: z.string().min(1),
      combinedSeats: z.number().int().min(1)
    })
  )
});

const layoutImpactSchema = layoutSchema.extend({
  focusTableId: z.string().min(1).optional()
});

function parseLayout<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException("El plano contiene datos incompletos o inválidos. Revisá las mesas y volvé a intentar.");
  }
  return result.data;
}

@Controller("restaurant/rooms")
export class FloorPlansController {
  constructor(private readonly floorPlansService: FloorPlansService) {}

  @Get()
  list(@CurrentUser() user: RequestUser, @Query("branchId") branchId?: string) {
    return this.floorPlansService.list(user, branchId);
  }

  @Get("blocks")
  blocks(@CurrentUser() user: RequestUser, @Query("branchId") branchId: string, @Query("serviceDate") serviceDate: string, @Query("turn") turn: string) {
    return this.floorPlansService.blocks(user, z.object({ branchId: z.string().min(1), ...roomBlockQuerySchema.shape }).parse({ branchId, serviceDate, turn }));
  }

  @Post()
  @Roles("restaurant_owner", "restaurant_manager")
  create(@Body() body: unknown, @CurrentUser() user: RequestUser) {
    return this.floorPlansService.create(user, roomSchema.parse(body));
  }

  @Patch(":roomId")
  @Roles("restaurant_owner", "restaurant_manager")
  update(
    @Param("roomId") roomId: string,
    @Body() body: unknown,
    @CurrentUser() user: RequestUser
  ) {
    return this.floorPlansService.update(user, roomId, updateRoomSchema.parse(body));
  }

  @Put("reorder")
  @Roles("restaurant_owner", "restaurant_manager")
  reorder(@Body() body: unknown, @CurrentUser() user: RequestUser) {
    return this.floorPlansService.reorder(user, reorderRoomsSchema.parse(body));
  }

  @Post(":roomId/blocks")
  @Roles("restaurant_owner", "restaurant_manager")
  block(@Param("roomId") roomId: string, @Body() body: unknown, @CurrentUser() user: RequestUser) {
    return this.floorPlansService.block(user, roomId, roomBlockSchema.parse(body));
  }

  @Delete(":roomId/blocks")
  @Roles("restaurant_owner", "restaurant_manager")
  unblock(@Param("roomId") roomId: string, @Query("serviceDate") serviceDate: string, @Query("turn") turn: string, @CurrentUser() user: RequestUser) {
    return this.floorPlansService.unblock(user, roomId, roomBlockQuerySchema.parse({ serviceDate, turn }));
  }

  @Get(":roomId/booking-rules")
  rules(@Param("roomId") roomId: string, @CurrentUser() user: RequestUser) {
    return this.floorPlansService.rules(user, roomId);
  }

  @Post(":roomId/booking-rules")
  @Roles("restaurant_owner", "restaurant_manager")
  createRule(@Param("roomId") roomId: string, @Body() body: unknown, @CurrentUser() user: RequestUser) {
    return this.floorPlansService.createRule(user, roomId, roomBookingRuleSchema.parse(body));
  }

  @Patch(":roomId/booking-rules/:ruleId")
  @Roles("restaurant_owner", "restaurant_manager")
  updateRule(@Param("roomId") roomId: string, @Param("ruleId") ruleId: string, @Body() body: unknown, @CurrentUser() user: RequestUser) {
    return this.floorPlansService.updateRule(user, roomId, ruleId, roomBookingRuleSchema.parse(body));
  }

  @Delete(":roomId/booking-rules/:ruleId")
  @Roles("restaurant_owner", "restaurant_manager")
  removeRule(@Param("roomId") roomId: string, @Param("ruleId") ruleId: string, @CurrentUser() user: RequestUser) {
    return this.floorPlansService.removeRule(user, roomId, ruleId);
  }

  @Delete(":roomId")
  @Roles("restaurant_owner", "restaurant_manager")
  remove(@Param("roomId") roomId: string, @CurrentUser() user: RequestUser) {
    return this.floorPlansService.remove(user, roomId);
  }

  @Get(":roomId/layout")
  detail(@Param("roomId") roomId: string, @CurrentUser() user: RequestUser) {
    return this.floorPlansService.detail(user, roomId);
  }

  @Post(":roomId/layout-impact")
  @Roles("restaurant_owner", "restaurant_manager")
  layoutImpact(
    @Param("roomId") roomId: string,
    @Body() body: unknown,
    @CurrentUser() user: RequestUser
  ) {
    const { focusTableId, ...layout } = parseLayout(layoutImpactSchema, body);
    return this.floorPlansService.layoutImpact(user, roomId, layout, focusTableId);
  }

  @Put(":roomId/layout")
  @Roles("restaurant_owner", "restaurant_manager")
  replaceLayout(
    @Param("roomId") roomId: string,
    @Body() body: unknown,
    @CurrentUser() user: RequestUser
  ) {
    return this.floorPlansService.replaceLayout(user, roomId, parseLayout(layoutSchema, body));
  }
}
