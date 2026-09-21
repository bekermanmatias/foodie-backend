import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { ReservationsService } from "./reservations.service";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { Roles } from "../../common/auth/roles.decorator";
import type { RequestUser } from "../../common/auth/request-user";
import { z } from "zod";

const reservationSchema = z.object({
  branchId: z.string().min(1),
  roomId: z.string().min(1),
  fullName: z.string().min(2),
  phone: z.string().min(2),
  email: z.preprocess(
    (value) => (typeof value === "string" && !value.trim() ? undefined : value),
    z.string().email().optional().nullable()
  ),
  partySize: z.number().int().min(1),
  serviceDate: z.string().min(1),
  serviceTime: z.string().regex(/^\d{2}:\d{2}$/),
  turn: z.enum(["mediodia", "noche"]).optional(),
  preferredZone: z.string().optional(),
  preferredTags: z.array(z.string()).optional(),
  birthday: z.string().optional(),
  notes: z.string().optional(),
  tableIds: z.array(z.string().min(1)).min(1).optional(),
  manualTableSelection: z.boolean().optional()
});

const eventRoomSchema = z.object({
  roomId: z.string().min(1),
  allocatedCovers: z.number().int().min(1),
  usage: z.enum(["partial", "full"])
});

const eventReservationSchema = z.object({
  branchId: z.string().min(1),
  fullName: z.string().min(2),
  phone: z.string().min(2),
  email: z.preprocess((value) => (typeof value === "string" && !value.trim() ? undefined : value), z.string().email().optional().nullable()),
  partySize: z.number().int().min(1),
  serviceDate: z.string().min(1),
  serviceTime: z.string().regex(/^\d{2}:\d{2}$/),
  notes: z.string().optional(),
  rooms: z.array(eventRoomSchema).min(1)
});

const eventRoomUpdateSchema = z.object({
  rooms: z.array(eventRoomSchema).min(1)
});

const availableTableOptionsSchema = z.object({
  branchId: z.string().min(1),
  roomId: z.string().min(1),
  partySize: z.coerce.number().int().min(1),
  serviceDate: z.string().min(1),
  serviceTime: z.string().regex(/^\d{2}:\d{2}$/),
  preferredZone: z.string().optional()
});

const availableManualTablesSchema = z.object({
  branchId: z.string().min(1),
  roomId: z.string().min(1),
  serviceDate: z.string().min(1),
  serviceTime: z.string().regex(/^\d{2}:\d{2}$/),
  preferredZone: z.string().optional()
});

const reassignTablesSchema = z.object({
  roomId: z.string().min(1),
  tableIds: z.array(z.string().min(1)).min(1)
});
const rescheduleSchema = z.object({
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
});

const cancellationSchema = z.object({
  reason: z.preprocess(
    (value) => (typeof value === "string" && !value.trim() ? undefined : value),
    z.string().max(500).optional()
  )
});

const offlineBackupSchema = z.object({
  branchId: z.string().min(1),
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  turn: z.enum(["mediodia", "noche"]),
  specialServiceId: z.string().min(1).optional()
});

@Controller()
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Get("restaurant/reservations")
  list(
    @CurrentUser() user: RequestUser,
    @Query("branchId") branchId: string,
    @Query("serviceDate") serviceDate: string,
    @Query("turn") turn: "mediodia" | "noche",
    @Query("specialServiceId") specialServiceId?: string
  ) {
    return this.reservationsService.list(user, { branchId, serviceDate, turn, specialServiceId });
  }

  @Get("restaurant/reservations/offline-backup")
  offlineBackup(@CurrentUser() user: RequestUser, @Query() query: Record<string, unknown>) {
    return this.reservationsService.offlineBackup(user, offlineBackupSchema.parse(query));
  }

  @Get("restaurant/reservations/history")
  history(
    @CurrentUser() user: RequestUser,
    @Query("branchId") branchId?: string,
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
    @Query("turn") turn?: "mediodia" | "noche" | "all",
    @Query("status") status?: string,
    @Query("search") search?: string
  ) {
    return this.reservationsService.history(user, { branchId, dateFrom, dateTo, turn, status, search });
  }

  @Post("restaurant/reservations")
  create(@CurrentUser() user: RequestUser, @Body() body: unknown) {
    return this.reservationsService.create(user, reservationSchema.parse(body));
  }

  @Post("restaurant/reservations/events")
  @Roles("restaurant_owner", "restaurant_manager", "events")
  createEvent(@CurrentUser() user: RequestUser, @Body() body: unknown) {
    return this.reservationsService.createEvent(user, eventReservationSchema.parse(body));
  }

  @Post("restaurant/reservations/:reservationId/event-rooms")
  @Roles("restaurant_owner", "restaurant_manager", "events")
  updateEventRooms(@CurrentUser() user: RequestUser, @Param("reservationId") reservationId: string, @Body() body: unknown) {
    return this.reservationsService.updateEventRooms(user, reservationId, eventRoomUpdateSchema.parse(body));
  }

  @Get("restaurant/reservations/available-table-options")
  availableTableOptions(@CurrentUser() user: RequestUser, @Query() query: Record<string, unknown>) {
    return this.reservationsService.listManualTableOptions(user, availableTableOptionsSchema.parse(query));
  }

  @Get("restaurant/reservations/available-manual-tables")
  availableManualTables(@CurrentUser() user: RequestUser, @Query() query: Record<string, unknown>) {
    return this.reservationsService.listAvailableManualTables(user, availableManualTablesSchema.parse(query));
  }

  @Post("restaurant/reservations/:reservationId/check-in")
  checkIn(@CurrentUser() user: RequestUser, @Param("reservationId") reservationId: string) {
    return this.reservationsService.moveToState(user, reservationId, "seated");
  }

  @Post("restaurant/reservations/:reservationId/release")
  release(@CurrentUser() user: RequestUser, @Param("reservationId") reservationId: string) {
    return this.reservationsService.moveToState(user, reservationId, "completed");
  }

  @Post("restaurant/reservations/:reservationId/cancel")
  @Roles("restaurant_owner", "restaurant_manager", "host", "events")
  cancel(@CurrentUser() user: RequestUser, @Param("reservationId") reservationId: string, @Body() body: unknown) {
    return this.reservationsService.cancelManual(user, reservationId, cancellationSchema.parse(body || {}));
  }

  @Post("restaurant/reservations/:reservationId/reschedule")
  @Roles("restaurant_owner", "restaurant_manager", "events")
  reschedule(@CurrentUser() user: RequestUser, @Param("reservationId") reservationId: string, @Body() body: unknown) {
    return this.reservationsService.reschedule(user, reservationId, rescheduleSchema.parse(body));
  }

  @Delete("restaurant/reservations/:reservationId")
  @Roles("restaurant_owner", "restaurant_manager")
  remove(@CurrentUser() user: RequestUser, @Param("reservationId") reservationId: string) {
    return this.reservationsService.deleteCancelled(user, reservationId);
  }

  @Get("restaurant/reservations/:reservationId/table-options")
  tableOptions(@CurrentUser() user: RequestUser, @Param("reservationId") reservationId: string) {
    return this.reservationsService.listTableOptions(user, reservationId);
  }

  @Get("restaurant/reservations/:reservationId/table-availability")
  tableAvailability(@CurrentUser() user: RequestUser, @Param("reservationId") reservationId: string, @Query() query: Record<string, unknown>) {
    const input = z.object({ roomId: z.string().min(1), excludeTableIds: z.string().optional() }).parse(query);
    return this.reservationsService.listTableAvailabilityForReassignment(user, reservationId, input.roomId, input.excludeTableIds?.split(",").filter(Boolean) || []);
  }

  @Post("restaurant/reservations/:reservationId/reassign-tables")
  reassignTables(@CurrentUser() user: RequestUser, @Param("reservationId") reservationId: string, @Body() body: unknown) {
    const input = reassignTablesSchema.parse(body);
    return this.reservationsService.reassignTables(user, reservationId, input);
  }
}
