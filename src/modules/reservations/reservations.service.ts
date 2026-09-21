import { Injectable } from "@nestjs/common";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { RequestUser } from "../../common/auth/request-user";
import { createReservationCode, normalizeReservationCode } from "../../common/utils/code";
import { RealtimeService } from "../realtime/realtime.service";
import { AuditService } from "../audit/audit.service";
import { Prisma, ReservationSource, ReservationStatus } from "@prisma/client";
import { getSharedTableFeatures, tableMatchesPreferredFeatures, type PreferredFeature } from "./preferred-features";

@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeService: RealtimeService,
    private readonly auditService: AuditService
  ) {}

  private restaurantScope(user: RequestUser) {
    if (user.scope !== "restaurant" || !user.restaurantId) {
      throw new ForbiddenException("Restaurant context required");
    }
    return user.restaurantId;
  }

  private assertEventsCannotCreateStandardReservations(user: RequestUser) {
    if (user.scope === "restaurant" && user.role === "events") {
      throw new ForbiddenException("El rol Eventos debe crear reservas de evento.");
    }
  }

  private normalizeOptionalEmail(email?: string | null) {
    const value = email?.trim();
    return value ? value.toLowerCase() : undefined;
  }

  private normalizeServiceTime(serviceTime?: string, fallbackTurn?: "mediodia" | "noche") {
    if (!serviceTime) {
      return fallbackTurn === "mediodia" ? "13:00" : "20:00";
    }

    const match = /^(\d{2}):(\d{2})$/.exec(serviceTime);
    if (!match) {
      throw new BadRequestException("Invalid service time");
    }

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) {
      throw new BadRequestException("Invalid service time");
    }

    return serviceTime;
  }

  private deriveTurnFromServiceTime(serviceTime: string): "mediodia" | "noche" {
    const hours = Number(serviceTime.slice(0, 2));
    return hours < 17 ? "mediodia" : "noche";
  }

  private async validateBookingException(restaurantId: string, branchId: string, serviceDate: Date, serviceTime: string) {
    const exception = await this.prisma.bookingException.findUnique({ where: { branchId_serviceDate: { branchId, serviceDate } } });
    if (!exception) return;
    if (exception.type !== "custom_hours") throw new ConflictException("El restaurante no toma reservas en esta fecha.");
    const service = this.deriveTurnFromServiceTime(serviceTime) === "mediodia" ? "lunch" : "dinner";
    const windows = Array.isArray(exception.windows) ? exception.windows as Array<{ service?: string; startTime?: string; endTime?: string }> : [];
    const window = windows.find((item) => item.service === service && item.startTime && item.endTime && serviceTime >= item.startTime && serviceTime < item.endTime);
    if (!window) throw new ConflictException("El turno seleccionado no está disponible para esta fecha.");
  }

  private async isRoomBlocked(restaurantId: string, roomId: string, serviceDate: Date, turn: "mediodia" | "noche", client: PrismaService | Prisma.TransactionClient = this.prisma) {
    const pointBlock = await client.roomBookingBlock.findUnique({
      where: { roomId_serviceDate_turn: { roomId, serviceDate, turn } },
      select: { id: true }
    });
    if (pointBlock) return true;
    return Boolean(await client.roomBookingRule.findFirst({
      where: {
        restaurantId,
        roomId,
        weekdays: { has: serviceDate.getUTCDay() },
        turns: { has: turn },
        startsAt: { lte: serviceDate },
        OR: [{ endsAt: null }, { endsAt: { gte: serviceDate } }]
      },
      select: { id: true }
    }));
  }

  private async isRoomAssignedToActiveEvent(
    restaurantId: string,
    roomId: string,
    serviceDate: Date,
    turn: "mediodia" | "noche",
    specialServiceId: string | null | undefined,
    client: PrismaService | Prisma.TransactionClient = this.prisma,
    excludeReservationId?: string
  ) {
    return Boolean(await client.reservationRoomAssignment.findFirst({
      where: {
        roomId,
        reservation: {
          restaurantId,
          serviceDate,
          turn,
          specialServiceId: specialServiceId || null,
          status: { in: ["pending", "confirmed", "seated"] },
          ...(excludeReservationId ? { id: { not: excludeReservationId } } : {})
        }
      },
      select: { id: true }
    }));
  }

  private async assertRoomIsBookable(
    restaurantId: string,
    roomId: string,
    serviceDate: Date,
    turn: "mediodia" | "noche",
    client: PrismaService | Prisma.TransactionClient = this.prisma,
    specialServiceId?: string | null,
    excludeReservationId?: string
  ) {
    if (await this.isRoomBlocked(restaurantId, roomId, serviceDate, turn, client)) {
      throw new ConflictException("El salon esta cerrado para reservas en la fecha y turno seleccionados.");
    }
    if (await this.isRoomAssignedToActiveEvent(restaurantId, roomId, serviceDate, turn, specialServiceId, client, excludeReservationId)) {
      throw new ConflictException("El salon esta asignado a un evento para el servicio seleccionado.");
    }
  }

  list(user: RequestUser, input: { branchId: string; serviceDate: string; turn: "mediodia" | "noche"; specialServiceId?: string }) {
    const restaurantId = this.restaurantScope(user);
    return this.prisma.reservation.findMany({
      where: {
        restaurantId,
        branchId: input.branchId,
        serviceDate: new Date(input.serviceDate),
        turn: input.turn,
        ...(input.specialServiceId ? { specialServiceId: input.specialServiceId } : {})
      },
      include: {
        room: true,
        customer: { include: { tags: true } },
        tables: { include: { table: true } },
        eventRoomAssignments: { include: { room: true } },
        specialService: true,
        deposit: { select: { id: true, requiredAmount: true, paidAmount: true, currency: true, status: true } }
      },
      orderBy: [{ serviceTime: "asc" }, { createdAt: "desc" }]
    });
  }

  async offlineBackup(user: RequestUser, input: { branchId: string; serviceDate: string; turn: "mediodia" | "noche"; specialServiceId?: string }) {
    const restaurantId = this.restaurantScope(user);
    const serviceDate = new Date(input.serviceDate);
    if (Number.isNaN(serviceDate.getTime())) throw new BadRequestException("Invalid service date");

    const branch = await this.prisma.branch.findFirst({
      where: { id: input.branchId, restaurantId },
      select: { id: true, name: true, restaurant: { select: { name: true } } }
    });
    if (!branch) throw new NotFoundException("Branch not found");

    const specialService = input.specialServiceId
      ? await this.prisma.specialService.findFirst({
          where: { id: input.specialServiceId, restaurantId, branchId: input.branchId, serviceDate },
          select: { id: true, label: true, startTime: true, endTime: true }
        })
      : null;
    if (input.specialServiceId && !specialService) throw new NotFoundException("Special service not found");
    if (!input.specialServiceId && await this.prisma.specialService.count({ where: { restaurantId, branchId: input.branchId, serviceDate } })) {
      throw new BadRequestException("Seleccioná un servicio especial para preparar el backup.");
    }

    const reservations = await this.prisma.reservation.findMany({
      where: {
        restaurantId,
        branchId: input.branchId,
        serviceDate,
        turn: input.turn,
        status: { in: ["pending", "confirmed", "seated"] },
        ...(input.specialServiceId ? { specialServiceId: input.specialServiceId } : {})
      },
      select: {
        id: true,
        code: true,
        fullName: true,
        phone: true,
        partySize: true,
        status: true,
        serviceTime: true,
        preferredZone: true,
        notes: true,
        room: { select: { id: true, name: true } },
        tables: { include: { table: { select: { id: true, label: true, seats: true, metadata: true } } } },
        eventRoomAssignments: { include: { room: { select: { id: true, name: true } } } },
        specialService: { select: { id: true, label: true } }
      },
      orderBy: [{ serviceTime: "asc" }, { createdAt: "asc" }]
    });

    return {
      generatedAt: new Date().toISOString(),
      restaurant: { name: branch.restaurant.name },
      branch: { id: branch.id, name: branch.name },
      serviceDate: input.serviceDate,
      turn: input.turn,
      specialService,
      totalReservations: reservations.length,
      totalCovers: reservations.reduce((total, reservation) => total + reservation.partySize, 0),
      reservations
    };
  }

  history(
    user: RequestUser,
    input: {
      branchId?: string;
      dateFrom?: string;
      dateTo?: string;
      turn?: "mediodia" | "noche" | "all";
      status?: string;
      search?: string;
    }
  ) {
    const restaurantId = this.restaurantScope(user);
    const dateFrom = input.dateFrom ? new Date(input.dateFrom) : undefined;
    const dateTo = input.dateTo ? new Date(input.dateTo) : undefined;

    if ((input.dateFrom && (!dateFrom || Number.isNaN(dateFrom.getTime()))) || (input.dateTo && (!dateTo || Number.isNaN(dateTo.getTime())))) {
      throw new BadRequestException("Invalid date range");
    }

    const search = input.search?.trim();
    const normalizedSearch = search ? this.normalizeReservationCode(search) : undefined;

    return this.prisma.reservation.findMany({
      where: {
        restaurantId,
        ...(input.branchId ? { branchId: input.branchId } : {}),
        ...(input.turn && input.turn !== "all" ? { turn: input.turn } : {}),
        ...(input.status && input.status !== "all" ? { status: input.status as ReservationStatus } : {}),
        ...(dateFrom || dateTo
          ? {
              serviceDate: {
                ...(dateFrom ? { gte: dateFrom } : {}),
                ...(dateTo ? { lte: dateTo } : {})
              }
            }
          : {}),
        ...(search
          ? {
              OR: [
                { fullName: { contains: search, mode: "insensitive" } },
                { phone: { contains: search, mode: "insensitive" } },
                { email: { contains: search, mode: "insensitive" } },
                { codeNormalized: { contains: normalizedSearch } }
              ]
            }
          : {})
      },
      include: {
        branch: true,
        room: true,
        customer: { include: { tags: true } },
        tables: { include: { table: true } },
        eventRoomAssignments: { include: { room: true } },
        specialService: true,
        deposit: { select: { id: true, requiredAmount: true, paidAmount: true, currency: true, status: true } }
      },
      orderBy: [{ serviceDate: "desc" }, { serviceTime: "asc" }, { createdAt: "desc" }],
      take: 1000
    });
  }

  async create(
    user: RequestUser,
    input: {
      branchId: string;
      roomId: string;
      fullName: string;
      phone: string;
      email?: string | null;
      partySize: number;
      serviceDate: string;
      serviceTime: string;
      turn?: "mediodia" | "noche";
      preferredZone?: string;
      preferredFeatures?: PreferredFeature[];
      preferredTags?: string[];
      birthday?: string;
      notes?: string;
      durationMinutes?: number;
      turnoverMinutes?: number;
      tableIds?: string[];
      manualTableSelection?: boolean;
    }
  ) {
    const restaurantId = this.restaurantScope(user);
    this.assertEventsCannotCreateStandardReservations(user);
    return this.createReservationForRestaurant(restaurantId, input, { actorUserId: user.sub });
  }

  async createEvent(
    user: RequestUser,
    input: {
      branchId: string;
      fullName: string;
      phone: string;
      email?: string | null;
      partySize: number;
      serviceDate: string;
      serviceTime: string;
      notes?: string;
      rooms: Array<{ roomId: string; allocatedCovers: number; usage: "partial" | "full" }>;
    }
  ) {
    const restaurantId = this.restaurantScope(user);
    if (!new Set(["restaurant_owner", "restaurant_manager", "events"]).has(String(user.role))) {
      throw new ForbiddenException("No tenes permiso para crear reservas de evento.");
    }

    const roomsById = new Map<string, { roomId: string; allocatedCovers: number; usage: "partial" | "full" }>();
    for (const assignment of input.rooms) {
      if (roomsById.has(assignment.roomId)) throw new BadRequestException("Un salon solo puede asignarse una vez al evento.");
      roomsById.set(assignment.roomId, assignment);
    }
    const assignments = [...roomsById.values()];
    if (assignments.reduce((total, assignment) => total + assignment.allocatedCovers, 0) !== input.partySize) {
      throw new BadRequestException("Los cubiertos distribuidos entre salones deben coincidir con el total del evento.");
    }

    const serviceDate = new Date(input.serviceDate);
    if (Number.isNaN(serviceDate.getTime())) throw new BadRequestException("Invalid service date");
    const serviceTime = this.normalizeServiceTime(input.serviceTime);
    const turn = this.deriveTurnFromServiceTime(serviceTime);
    const specialService = await this.resolveSpecialService(restaurantId, input.branchId, serviceDate, serviceTime);
    if (!specialService) await this.validateBookingException(restaurantId, input.branchId, serviceDate, serviceTime);

    const selectedRooms = await this.prisma.room.findMany({
      where: { id: { in: assignments.map((assignment) => assignment.roomId) }, restaurantId, branchId: input.branchId, isActive: true },
      include: { tables: { where: { isActive: true, isReservable: true }, select: { seats: true, metadata: true } } }
    });
    if (selectedRooms.length !== assignments.length) throw new NotFoundException("Uno o mas salones no existen o no pertenecen a la sede seleccionada.");

    const roomById = new Map(selectedRooms.map((room) => [room.id, room]));
    const exceptions = await Promise.all(assignments.map(async (assignment) => {
      const room = roomById.get(assignment.roomId)!;
      const capacity = room.tables.reduce((total, table) => total + this.tableCapacity(table), 0);
      return {
        roomId: room.id,
        roomName: room.name,
        blocked: await this.isRoomBlocked(restaurantId, room.id, serviceDate, turn),
        exceedsCapacity: assignment.allocatedCovers > capacity,
        capacity,
        allocatedCovers: assignment.allocatedCovers
      };
    }));
    const created = await this.prisma.$transaction(async (tx) => {
      const roomIds = assignments.map((assignment) => assignment.roomId);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Room" WHERE "id" IN (${Prisma.join(roomIds)}) FOR UPDATE`);

      const conflict = await tx.reservation.findFirst({
        where: {
          restaurantId,
          roomId: { in: roomIds },
          serviceDate,
          turn,
          specialServiceId: specialService?.id || null,
          status: { in: ["pending", "confirmed", "seated"] }
        },
        select: { id: true, code: true }
      });
      if (conflict) throw new ConflictException(`El salon ya tiene una reserva activa (${conflict.code}) para este servicio.`);

      const eventConflict = await tx.reservationRoomAssignment.findFirst({
        where: {
          roomId: { in: roomIds },
          reservation: {
            restaurantId,
            serviceDate,
            turn,
            specialServiceId: specialService?.id || null,
            status: { in: ["pending", "confirmed", "seated"] }
          }
        },
        select: { id: true }
      });
      if (eventConflict) throw new ConflictException("Uno de los salones ya esta asignado a otro evento para este servicio.");

      const reservationCode = await this.createAvailableReservationCode(tx);
      const customer = await this.upsertCustomer(tx, restaurantId, { ...input, email: this.normalizeOptionalEmail(input.email) }, { incrementReservationCount: true });
      return tx.reservation.create({
        data: {
          restaurantId,
          branchId: input.branchId,
          roomId: assignments[0].roomId,
          customerId: customer.id,
          code: reservationCode,
          codeNormalized: this.normalizeReservationCode(reservationCode),
          fullName: input.fullName,
          phone: input.phone,
          email: this.normalizeOptionalEmail(input.email) ?? null,
          partySize: input.partySize,
          status: "confirmed",
          turn,
          specialServiceId: specialService?.id || null,
          serviceDate,
          serviceTime,
          notes: input.notes,
          source: "admin",
          durationMinutes: specialService?.durationMinutes || 180,
          turnoverMinutes: specialService?.turnoverMinutes || 0,
          metadata: { event: { automaticOverride: exceptions.some((exception) => exception.blocked || exception.exceedsCapacity), exceptions } } as Prisma.InputJsonValue,
          eventRoomAssignments: { createMany: { data: assignments } }
        },
        include: {
          room: true,
          branch: true,
          customer: { include: { tags: true } },
          tables: { include: { table: true } },
          eventRoomAssignments: { include: { room: true } },
          specialService: true
        }
      });
    });

    this.realtimeService.publish("reservation.created", { restaurantId, branchId: input.branchId, roomIds: assignments.map((assignment) => assignment.roomId), reservationId: created.id });
    await this.auditService.log({
      action: "reservation.event_created",
      targetType: "reservation",
      targetId: created.id,
      restaurantId,
      restaurantUserId: user.sub,
      metadata: { code: created.code, automaticOverride: exceptions.some((exception) => exception.blocked || exception.exceedsCapacity), assignments, exceptions }
    });
    return created;
  }

  async updateEventRooms(
    user: RequestUser,
    reservationId: string,
    input: { rooms: Array<{ roomId: string; allocatedCovers: number; usage: "partial" | "full" }> }
  ) {
    const restaurantId = this.restaurantScope(user);
    if (!new Set(["restaurant_owner", "restaurant_manager", "events"]).has(String(user.role))) {
      throw new ForbiddenException("No tenes permiso para editar reservas de evento.");
    }
    const reservation = await this.prisma.reservation.findFirst({
      where: { id: reservationId, restaurantId, status: { in: ["pending", "confirmed"] } },
      include: { eventRoomAssignments: true }
    });
    if (!reservation) throw new NotFoundException("Reserva de evento activa no encontrada.");
    if (!reservation.eventRoomAssignments.length) throw new ConflictException("Esta reserva no es un evento.");

    const uniqueAssignments = new Map<string, { roomId: string; allocatedCovers: number; usage: "partial" | "full" }>();
    for (const assignment of input.rooms) {
      if (uniqueAssignments.has(assignment.roomId)) throw new BadRequestException("Un salon solo puede asignarse una vez al evento.");
      uniqueAssignments.set(assignment.roomId, assignment);
    }
    const assignments = [...uniqueAssignments.values()];
    if (assignments.reduce((total, assignment) => total + assignment.allocatedCovers, 0) !== reservation.partySize) {
      throw new BadRequestException("Los cubiertos distribuidos entre salones deben coincidir con el total del evento.");
    }
    const rooms = await this.prisma.room.findMany({
      where: { id: { in: assignments.map((assignment) => assignment.roomId) }, restaurantId, branchId: reservation.branchId, isActive: true },
      include: { tables: { where: { isActive: true, isReservable: true }, select: { seats: true, metadata: true } } }
    });
    if (rooms.length !== assignments.length) throw new NotFoundException("Uno o mas salones no pertenecen a la sede de la reserva.");
    const roomById = new Map(rooms.map((room) => [room.id, room]));
    const exceptions = await Promise.all(assignments.map(async (assignment) => {
      const room = roomById.get(assignment.roomId)!;
      const capacity = room.tables.reduce((total, table) => total + this.tableCapacity(table), 0);
      return { roomId: room.id, roomName: room.name, blocked: await this.isRoomBlocked(restaurantId, room.id, reservation.serviceDate, reservation.turn), exceedsCapacity: assignment.allocatedCovers > capacity, capacity, allocatedCovers: assignment.allocatedCovers };
    }));
    const updated = await this.prisma.$transaction(async (tx) => {
      const roomIds = assignments.map((assignment) => assignment.roomId);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Room" WHERE "id" IN (${Prisma.join(roomIds)}) FOR UPDATE`);
      const normalConflict = await tx.reservation.findFirst({
        where: { restaurantId, id: { not: reservation.id }, roomId: { in: roomIds }, serviceDate: reservation.serviceDate, turn: reservation.turn, specialServiceId: reservation.specialServiceId, status: { in: ["pending", "confirmed", "seated"] } },
        select: { code: true }
      });
      if (normalConflict) throw new ConflictException(`El salon ya tiene una reserva activa (${normalConflict.code}) para este servicio.`);
      const eventConflict = await tx.reservationRoomAssignment.findFirst({
        where: {
          roomId: { in: roomIds },
          reservation: {
            id: { not: reservation.id },
            restaurantId,
            serviceDate: reservation.serviceDate,
            turn: reservation.turn,
            specialServiceId: reservation.specialServiceId,
            status: { in: ["pending", "confirmed", "seated"] }
          }
        },
        select: { id: true }
      });
      if (eventConflict) throw new ConflictException("Uno de los salones ya esta asignado a otro evento para este servicio.");
      await tx.reservationRoomAssignment.deleteMany({ where: { reservationId: reservation.id } });
      return tx.reservation.update({
        where: { id: reservation.id },
        data: {
          roomId: assignments[0].roomId,
          metadata: { event: { automaticOverride: exceptions.some((exception) => exception.blocked || exception.exceedsCapacity), exceptions } } as Prisma.InputJsonValue,
          eventRoomAssignments: { createMany: { data: assignments } }
        },
        include: { room: true, branch: true, customer: { include: { tags: true } }, tables: { include: { table: true } }, eventRoomAssignments: { include: { room: true } }, specialService: true }
      });
    });
    this.realtimeService.publish("reservation.updated", { restaurantId, reservationId: updated.id, roomIds: assignments.map((assignment) => assignment.roomId) });
    await this.auditService.log({ action: "reservation.event_rooms_updated", targetType: "reservation", targetId: updated.id, restaurantId, restaurantUserId: user.sub, metadata: { assignments, automaticOverride: exceptions.some((exception) => exception.blocked || exception.exceedsCapacity), exceptions } });
    return updated;
  }

  async createReservationForRestaurant(
    restaurantId: string,
    input: {
      branchId: string;
      roomId: string;
      fullName: string;
      phone: string;
      email?: string | null;
      partySize: number;
      serviceDate: string;
      serviceTime?: string;
      turn?: "mediodia" | "noche";
      preferredZone?: string;
      preferredFeatures?: PreferredFeature[];
      preferredTags?: string[];
      birthday?: string;
      notes?: string;
      durationMinutes?: number;
      turnoverMinutes?: number;
      tableIds?: string[];
      manualTableSelection?: boolean;
    },
    options?: { actorUserId?: string; idempotencyKey?: string; source?: ReservationSource }
  ) {
    const room = await this.prisma.room.findFirst({
      where: { id: input.roomId, restaurantId, branchId: input.branchId, isActive: true },
      include: { tables: { where: { isActive: true } } }
    });
    if (!room) {
      throw new NotFoundException("Room not found");
    }

    const serviceDate = new Date(input.serviceDate);
    if (Number.isNaN(serviceDate.getTime())) {
      throw new BadRequestException("Invalid service date");
    }
    const serviceTime = this.normalizeServiceTime(input.serviceTime, input.turn);
    const turn = this.deriveTurnFromServiceTime(serviceTime);
    const specialService = await this.resolveSpecialService(restaurantId, input.branchId, serviceDate, serviceTime);
    if (!specialService) await this.validateBookingException(restaurantId, input.branchId, serviceDate, serviceTime);
    await this.assertRoomIsBookable(restaurantId, input.roomId, serviceDate, turn, this.prisma, specialService?.id);
    const durationMinutes = specialService?.durationMinutes || input.durationMinutes || 180;
    const turnoverMinutes = specialService?.turnoverMinutes || 0;

    const preferredFeatures = input.preferredFeatures || [];
    const requestedAssignment = input.tableIds?.length
      ? await (input.manualTableSelection ? this.findManualRequestedAssignment(this.prisma, {
          restaurantId, roomId: input.roomId, serviceDate, turn, partySize: input.partySize,
          preferredZone: input.preferredZone, preferredFeatures, serviceTime, durationMinutes, turnoverMinutes
        }, input.tableIds) : this.findRequestedAssignment(this.prisma, {
          restaurantId, roomId: input.roomId, serviceDate, turn, partySize: input.partySize,
          preferredZone: input.preferredZone, preferredFeatures, serviceTime, durationMinutes, turnoverMinutes
        }, input.tableIds))
      : await this.assignTables(this.prisma, {
          restaurantId, roomId: input.roomId, serviceDate, turn, partySize: input.partySize,
          preferredZone: input.preferredZone, preferredFeatures, serviceTime, durationMinutes, turnoverMinutes
        });

    if (!requestedAssignment) {
      const generalAssignment = preferredFeatures.length
        ? await this.assignTables(this.prisma, {
            restaurantId,
            roomId: input.roomId,
            serviceDate,
            turn,
            partySize: input.partySize,
            preferredZone: input.preferredZone
            , serviceTime, durationMinutes, turnoverMinutes
          })
        : null;
      if (input.tableIds?.length) {
        throw new ConflictException("La mesa o combinación seleccionada ya no está disponible o no cumple las reglas de la reserva.");
      }
      if (preferredFeatures.length) {
        throw new ConflictException({
          code: "PREFERRED_FEATURE_UNAVAILABLE",
          message: "No hay mesas disponibles que cumplan las caracteristicas solicitadas.",
          preferredFeatures,
          generalAvailability: Boolean(generalAssignment)
        });
      }
      throw new ConflictException("No valid table or combination available");
    }

    const reservation = await this.prisma.$transaction(async (tx) => {
      // Serializes assignment attempts within a room. This prevents two public
      // requests from both seeing the same last table before either commits.
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Table" WHERE "roomId" = ${input.roomId} FOR UPDATE`);
      await this.assertRoomIsBookable(restaurantId, input.roomId, serviceDate, turn, tx, specialService?.id);
      const assignment = input.tableIds?.length
        ? await (input.manualTableSelection ? this.findManualRequestedAssignment(tx, {
            restaurantId, roomId: input.roomId, serviceDate, turn, partySize: input.partySize,
            preferredZone: input.preferredZone, preferredFeatures, serviceTime, durationMinutes, turnoverMinutes
          }, input.tableIds) : this.findRequestedAssignment(tx, {
            restaurantId, roomId: input.roomId, serviceDate, turn, partySize: input.partySize,
            preferredZone: input.preferredZone, preferredFeatures, serviceTime, durationMinutes, turnoverMinutes
          }, input.tableIds))
        : await this.assignTables(tx, {
            restaurantId, roomId: input.roomId, serviceDate, turn, partySize: input.partySize,
          preferredZone: input.preferredZone, preferredFeatures, serviceTime, durationMinutes, turnoverMinutes
          });
      if (!assignment) {
        if (input.tableIds?.length) {
          throw new ConflictException("La mesa o combinación seleccionada dejó de estar disponible o no cumple las reglas de la reserva.");
        }
        const generalAssignment = preferredFeatures.length
          ? await this.assignTables(tx, {
              restaurantId,
              roomId: input.roomId,
              serviceDate,
              turn,
              partySize: input.partySize,
              preferredZone: input.preferredZone,
              serviceTime,
              durationMinutes,
              turnoverMinutes
            })
          : null;
        if (preferredFeatures.length) {
          throw new ConflictException({
            code: "PREFERRED_FEATURE_UNAVAILABLE",
            message: "No hay mesas disponibles que cumplan las caracteristicas solicitadas.",
            preferredFeatures,
            generalAvailability: Boolean(generalAssignment)
          });
        }
        throw new ConflictException("No valid table or combination available");
      }
      const normalizedInput = {
        ...input,
        email: this.normalizeOptionalEmail(input.email)
      };
      const reservationCode = await this.createAvailableReservationCode(tx);
      const customer = await this.upsertCustomer(tx, restaurantId, normalizedInput, {
        incrementReservationCount: true
      });
      const created = await tx.reservation.create({
        data: {
          restaurantId,
          branchId: input.branchId,
          roomId: input.roomId,
          customerId: customer.id,
          code: reservationCode,
          codeNormalized: this.normalizeReservationCode(reservationCode),
          fullName: input.fullName,
          phone: input.phone,
          email: normalizedInput.email ?? null,
          partySize: input.partySize,
          status: "confirmed",
          turn,
          specialServiceId: specialService?.id || null,
          serviceDate,
          serviceTime,
          preferredZone: input.preferredZone,
          notes: input.notes,
          source: options?.source || "admin",
          durationMinutes,
          turnoverMinutes,
          metadata: {
            seatingPreference: {
              requestedFeatures: preferredFeatures,
              matched: true,
              assignedFeatures: assignment.features,
              assignedTableIds: assignment.tableIds,
              assignedTableLabels: assignment.tableLabels
            }
          } as Prisma.InputJsonValue,
          tables: {
            createMany: {
              data: assignment.tableIds.map((tableId) => ({ tableId }))
            }
          }
        },
        include: {
          room: true,
          customer: { include: { tags: true } },
          tables: { include: { table: true } }
        }
      });

      await Promise.all(
        assignment.tableIds.map((tableId) =>
          tx.serviceState.upsert({
            where: {
              tableId_reservationId: {
                tableId,
                reservationId: created.id
              }
            },
            update: {
              status: "reserved",
              roomId: input.roomId,
              branchId: input.branchId,
              reservationId: created.id
              , specialServiceId: specialService?.id || null
            },
            create: {
              restaurantId,
              branchId: input.branchId,
              roomId: input.roomId,
              tableId,
              reservationId: created.id,
              serviceDate,
              turn,
              specialServiceId: specialService?.id || null,
              status: "reserved"
            }
          })
        )
      );

      return created;
    });

    this.realtimeService.publish("reservation.created", {
      restaurantId,
      branchId: input.branchId,
      roomId: input.roomId,
      reservationId: reservation.id
    });

    await this.auditService.log({
      action: "reservation.created",
      targetType: "reservation",
      targetId: reservation.id,
      restaurantId,
      metadata: {
        actorUserId: options?.actorUserId || null,
        idempotencyKey: options?.idempotencyKey || null
      }
    });

    return reservation;
  }

  private async resolveSpecialService(restaurantId: string, branchId: string, serviceDate: Date, serviceTime: string, client: PrismaService | Prisma.TransactionClient = this.prisma) {
    const services = await client.specialService.findMany({ where: { restaurantId, branchId, serviceDate }, orderBy: { position: "asc" } });
    if (!services.length) return null;
    const start = this.timeToMinutes(serviceTime);
    const service = services.find((item) => {
      const windowStart = this.timeToMinutes(item.startTime);
      const windowEnd = this.timeToMinutes(item.endTime);
      return start === windowStart && start + item.durationMinutes + item.turnoverMinutes <= windowEnd;
    });
    if (!service) throw new ConflictException("El horario no pertenece a una franja especial disponible o invade el tiempo de recambio.");
    return service;
  }

  private normalizeReservationCode(code: string) {
    return normalizeReservationCode(code);
  }

  private async createAvailableReservationCode(client: PrismaService | Prisma.TransactionClient) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const code = createReservationCode();
      const normalizedCode = this.normalizeReservationCode(code);
      // Serialize only contenders for this candidate code. This closes the
      // check/create race while keeping normal reservation creation concurrent.
      await client.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${normalizedCode}))`);
      const exists = await client.reservation.findUnique({
        where: { codeNormalized: normalizedCode },
        select: { id: true }
      });
      if (!exists) return code;
    }
    throw new ConflictException("No se pudo generar un código de reserva único. Intentá nuevamente.");
  }

  async listManualTableOptions(user: RequestUser, input: {
    branchId: string;
    roomId: string;
    partySize: number;
    serviceDate: string;
    serviceTime: string;
    preferredZone?: string;
  }) {
    const restaurantId = this.restaurantScope(user);
    const serviceDate = new Date(input.serviceDate);
    if (Number.isNaN(serviceDate.getTime())) throw new BadRequestException("Invalid service date");
    const turn = this.deriveTurnFromServiceTime(input.serviceTime);
    const specialService = await this.resolveSpecialService(restaurantId, input.branchId, serviceDate, input.serviceTime);
    if (!specialService) await this.validateBookingException(restaurantId, input.branchId, serviceDate, input.serviceTime);
    await this.assertRoomIsBookable(restaurantId, input.roomId, serviceDate, turn, this.prisma, specialService?.id);
    const room = await this.prisma.room.findFirst({ where: { id: input.roomId, restaurantId, branchId: input.branchId, isActive: true } });
    if (!room) throw new NotFoundException("Room not found");
    const options = await this.listAvailableAssignments(this.prisma, {
      restaurantId, roomId: input.roomId, serviceDate, turn, partySize: input.partySize,
      preferredZone: input.preferredZone, serviceTime: input.serviceTime, durationMinutes: specialService?.durationMinutes || 180, turnoverMinutes: specialService?.turnoverMinutes || 0
    });
    return options.map((option) => ({ ...option, combination: option.tableIds.length > 1 }));
  }

  async listAvailableManualTables(user: RequestUser, input: {
    branchId: string;
    roomId: string;
    serviceDate: string;
    serviceTime: string;
    preferredZone?: string;
  }) {
    const restaurantId = this.restaurantScope(user);
    const serviceDate = new Date(input.serviceDate);
    if (Number.isNaN(serviceDate.getTime())) throw new BadRequestException("Invalid service date");
    const serviceTime = this.normalizeServiceTime(input.serviceTime);
    const turn = this.deriveTurnFromServiceTime(serviceTime);
    const specialService = await this.resolveSpecialService(restaurantId, input.branchId, serviceDate, serviceTime);
    if (!specialService) await this.validateBookingException(restaurantId, input.branchId, serviceDate, serviceTime);
    await this.assertRoomIsBookable(restaurantId, input.roomId, serviceDate, turn, this.prisma, specialService?.id);
    const room = await this.prisma.room.findFirst({ where: { id: input.roomId, restaurantId, branchId: input.branchId, isActive: true } });
    if (!room) throw new NotFoundException("Room not found");
    const tables = await this.listAvailableTables(this.prisma, {
      restaurantId, roomId: input.roomId, serviceDate, turn, partySize: 1,
      preferredZone: input.preferredZone, serviceTime, durationMinutes: specialService?.durationMinutes || 180, turnoverMinutes: specialService?.turnoverMinutes || 0, requireFreeState: true
    });
    return tables
      .sort((left, right) => left.label.localeCompare(right.label, "es", { numeric: true }))
      .map((table) => ({ id: table.id, label: table.label, seats: this.tableCapacity(table) }));
  }

  private async findRequestedAssignment(
    client: PrismaService | Prisma.TransactionClient,
    input: {
      restaurantId: string; roomId: string; serviceDate: Date; turn: "mediodia" | "noche"; partySize: number;
      preferredZone?: string; preferredFeatures?: PreferredFeature[]; excludeReservationId?: string; serviceTime?: string; durationMinutes?: number; turnoverMinutes?: number;
    },
    tableIds: string[]
  ) {
    const normalized = [...new Set(tableIds)].sort();
    if (normalized.length !== tableIds.length) throw new BadRequestException("Las mesas seleccionadas están repetidas.");
    const options = await this.listAvailableAssignments(client, input);
    return options.find((option) => option.tableIds.join("|") === normalized.join("|")) || null;
  }

  private async findManualRequestedAssignment(
    client: PrismaService | Prisma.TransactionClient,
    input: {
      restaurantId: string; roomId: string; serviceDate: Date; turn: "mediodia" | "noche"; partySize: number;
      preferredZone?: string; preferredFeatures?: PreferredFeature[]; excludeReservationId?: string; serviceTime?: string; durationMinutes?: number; turnoverMinutes?: number;
    },
    tableIds: string[]
  ) {
    const normalized = [...new Set(tableIds)].sort();
    if (normalized.length !== tableIds.length) throw new BadRequestException("Las mesas seleccionadas están repetidas.");
    const availableById = new Map((await this.listAvailableTables(client, { ...input, requireFreeState: true })).map((table) => [table.id, table]));
    const tables = normalized.map((id) => availableById.get(id)).filter(Boolean);
    if (tables.length !== normalized.length) return null;
    const seats = tables.reduce((total, table) => total + this.tableCapacity(table!), 0);
    if (seats < input.partySize) return null;
    return {
      tableIds: normalized,
      tableLabels: tables.map((table) => table!.label),
      seats,
      features: getSharedTableFeatures(tables as NonNullable<(typeof tables)[number]>[])
    };
  }

  private timeToMinutes(serviceTime: string) {
    const [hours, minutes] = serviceTime.split(":").map(Number);
    return hours * 60 + minutes;
  }

  async findAvailableRoomForRestaurant(input: {
    restaurantId: string;
    branchId: string;
    partySize: number;
    serviceDate: string;
    serviceTime: string;
    preferredFeatures?: PreferredFeature[];
    durationMinutes?: number;
    turnoverMinutes?: number;
  }) {
    const serviceDate = new Date(input.serviceDate);
    if (Number.isNaN(serviceDate.getTime())) throw new BadRequestException("Invalid service date");
    const serviceTime = this.normalizeServiceTime(input.serviceTime);
    const turn = this.deriveTurnFromServiceTime(serviceTime);
    const specialService = await this.resolveSpecialService(input.restaurantId, input.branchId, serviceDate, serviceTime);
    const [pointBlocks, recurringBlocks] = await Promise.all([
      this.prisma.roomBookingBlock.findMany({ where: { restaurantId: input.restaurantId, branchId: input.branchId, serviceDate, turn }, select: { roomId: true } }),
      this.prisma.roomBookingRule.findMany({
        where: { restaurantId: input.restaurantId, branchId: input.branchId, weekdays: { has: serviceDate.getUTCDay() }, turns: { has: turn }, startsAt: { lte: serviceDate }, OR: [{ endsAt: null }, { endsAt: { gte: serviceDate } }] },
        select: { roomId: true }
      })
    ]);
    const blockedRoomIds = [...new Set([...pointBlocks, ...recurringBlocks].map((block) => block.roomId))];
    const rooms = await this.prisma.room.findMany({
      where: { restaurantId: input.restaurantId, branchId: input.branchId, isActive: true, id: { notIn: blockedRoomIds } },
      orderBy: [{ bookingPriority: "asc" }, { createdAt: "asc" }]
    });
    for (const room of rooms) {
      if (await this.isRoomAssignedToActiveEvent(input.restaurantId, room.id, serviceDate, turn, specialService?.id)) continue;
      const assignment = await this.assignTables(this.prisma, {
        restaurantId: input.restaurantId,
        roomId: room.id,
        serviceDate,
        turn,
        partySize: input.partySize,
        preferredFeatures: input.preferredFeatures || []
        , serviceTime, durationMinutes: specialService?.durationMinutes || input.durationMinutes || 180, turnoverMinutes: specialService?.turnoverMinutes || input.turnoverMinutes || 0
      });
      if (assignment) return { roomId: room.id, serviceTime, turn };
    }
    return null;
  }

  async moveToState(user: RequestUser, reservationId: string, next: "seated" | "completed") {
    const restaurantId = this.restaurantScope(user);
    return this.moveReservationToStateForRestaurant(restaurantId, { reservationId }, next, { actorUserId: user.sub });
  }

  async deleteCancelled(user: RequestUser, reservationId: string) {
    const restaurantId = this.restaurantScope(user);
    if (!new Set(["restaurant_owner", "restaurant_manager"]).has(String(user.role))) {
      throw new ForbiddenException("Solo el dueño o gerente puede eliminar reservas");
    }

    const reservation = await this.prisma.reservation.findFirst({
      where: { id: reservationId, restaurantId },
      include: { deposit: { select: { id: true } } }
    });
    if (!reservation) throw new NotFoundException("Reservation not found");
    if (reservation.status !== "cancelled") {
      throw new ConflictException("Solo se pueden eliminar reservas canceladas");
    }
    if (reservation.deposit) {
      throw new ConflictException("No se puede eliminar una reserva con seña, pagos o comprobantes asociados");
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.serviceState.updateMany({
        where: { restaurantId, reservationId: reservation.id },
        data: { status: "free", reservationId: null }
      });
      await tx.reservation.delete({ where: { id: reservation.id } });
    });

    this.realtimeService.publish("reservation.deleted", { restaurantId, reservationId: reservation.id });
    await this.auditService.log({
      action: "reservation.deleted",
      targetType: "reservation",
      targetId: reservation.id,
      restaurantId,
      restaurantUserId: user.sub,
      metadata: { code: reservation.code, status: reservation.status }
    });
    return { id: reservation.id, code: reservation.code, deleted: true };
  }

  async cancelManual(user: RequestUser, reservationId: string, input: { reason?: string }) {
    const restaurantId = this.restaurantScope(user);
    const allowedRoles = new Set(["restaurant_owner", "restaurant_manager", "host", "events"]);
    if (!allowedRoles.has(String(user.role))) {
      throw new ForbiddenException("No tenés permiso para cancelar reservas");
    }

    const cancelled = await this.prisma.$transaction(async (tx) => {
      const current = await tx.reservation.findFirst({ where: { id: reservationId, restaurantId }, select: { status: true } });
      if (!current) throw new NotFoundException("Reservation not found");
      if (!( ["pending", "confirmed", "seated"] as ReservationStatus[]).includes(current.status)) {
        throw new ConflictException("La reserva ya no está activa y no puede cancelarse.");
      }
      const changedCount = await tx.reservation.updateMany({
        where: {
          id: reservationId,
          restaurantId,
          status: { in: ["pending", "confirmed", "seated"] }
        },
        data: { status: "cancelled" }
      });
      if (changedCount.count !== 1) {
        throw new ConflictException("La reserva ya no está activa y no puede cancelarse.");
      }

      const reservation = await tx.reservation.findUnique({
        where: { id: reservationId },
        include: {
          room: true,
          branch: true,
          customer: { include: { tags: true } },
          tables: { include: { table: true } },
          deposit: { select: { id: true, requiredAmount: true, paidAmount: true, currency: true, status: true } }
        }
      });
      if (!reservation) throw new NotFoundException("Reservation not found");

      await tx.serviceState.updateMany({
        where: { restaurantId, reservationId: reservation.id },
        data: { status: "free", reservationId: null }
      });
      return { reservation, previousStatus: current.status };
    });

    this.realtimeService.publish("reservation.cancelled", {
      restaurantId,
      branchId: cancelled.reservation.branchId,
      roomId: cancelled.reservation.roomId,
      reservationId: cancelled.reservation.id
    });
    await this.auditService.log({
      action: "reservation.cancelled",
      targetType: "reservation",
      targetId: cancelled.reservation.id,
      restaurantId,
      restaurantUserId: user.sub,
      metadata: {
        code: cancelled.reservation.code,
        previousStatus: cancelled.previousStatus,
        reason: input.reason?.trim() || null
      }
    });
    return cancelled.reservation;
  }

  async listTableOptions(user: RequestUser, reservationId: string) {
    const restaurantId = this.restaurantScope(user);
    const reservation = await this.reassignableReservationOrThrow(restaurantId, reservationId);
    await this.assertRoomIsBookable(restaurantId, reservation.roomId, reservation.serviceDate, reservation.turn, this.prisma, reservation.specialServiceId, reservation.id);

    return this.listAvailableAssignments(this.prisma, {
      restaurantId,
      roomId: reservation.roomId,
      serviceDate: reservation.serviceDate,
      turn: reservation.turn,
      partySize: reservation.partySize,
      serviceTime: reservation.serviceTime,
      durationMinutes: reservation.durationMinutes,
      turnoverMinutes: reservation.turnoverMinutes,
      excludeReservationId: reservation.id
    });
  }

  async listTableAvailabilityForReassignment(user: RequestUser, reservationId: string, roomId: string, excludedTableIds: string[] = []) {
    const restaurantId = this.restaurantScope(user);
    const reservation = await this.reassignableReservationOrThrow(restaurantId, reservationId);
    await this.assertStandardReservationForManualReassignment(reservationId, restaurantId);
    const room = await this.prisma.room.findFirst({
      where: { id: roomId, restaurantId, branchId: reservation.branchId, isActive: true },
      include: { tables: { where: { isActive: true } } }
    });
    if (!room) throw new NotFoundException("Salon no encontrado en la sucursal de la reserva.");

    const roomBlocked = await this.isRoomBlocked(restaurantId, room.id, reservation.serviceDate, reservation.turn);
    const assignedToEvent = await this.isRoomAssignedToActiveEvent(restaurantId, room.id, reservation.serviceDate, reservation.turn, reservation.specialServiceId, this.prisma, reservation.id);
    const roomUnavailableReason = roomBlocked
      ? "El salon esta cerrado para este turno."
      : assignedToEvent ? "El salon esta asignado a un evento." : null;
    const excludedTableIdSet = new Set(excludedTableIds);
    const availableTableIds = roomUnavailableReason ? new Set<string>() : new Set((await this.listAvailableTables(this.prisma, {
      restaurantId,
      roomId: room.id,
      serviceDate: reservation.serviceDate,
      turn: reservation.turn,
      serviceTime: reservation.serviceTime,
      durationMinutes: reservation.durationMinutes,
      turnoverMinutes: reservation.turnoverMinutes,
      partySize: reservation.partySize,
      excludeReservationId: reservation.id,
      requireFreeState: true
    })).map((table) => table.id));

    return {
      roomId: room.id,
      isBookable: !roomUnavailableReason,
      unavailableReason: roomUnavailableReason,
      tables: room.tables
        .sort((left, right) => left.label.localeCompare(right.label, "es", { numeric: true }))
        .map((table) => ({
          id: table.id,
          label: table.label,
          seats: this.tableCapacity(table),
          isAvailable: !roomUnavailableReason && table.isReservable && !excludedTableIdSet.has(table.id) && availableTableIds.has(table.id),
          unavailableReason: roomUnavailableReason || (excludedTableIdSet.has(table.id) ? "Esta mesa será modificada o eliminada." : !table.isReservable ? "Esta mesa no acepta reservas." : availableTableIds.has(table.id) ? null : "No disponible para este horario.")
        }))
    };
  }

  async reassignTables(user: RequestUser, reservationId: string, input: { roomId: string; tableIds: string[] }) {
    const restaurantId = this.restaurantScope(user);
    const normalizedTableIds = [...new Set(input.tableIds)].sort();
    if (normalizedTableIds.length !== input.tableIds.length) throw new BadRequestException("Las mesas seleccionadas están repetidas.");

    const reservation = await this.reassignableReservationOrThrow(restaurantId, reservationId);
    await this.assertStandardReservationForManualReassignment(reservationId, restaurantId);
    const updated = await this.prisma.$transaction(async (tx) => {
      const current = await this.reassignableReservationOrThrow(restaurantId, reservationId, tx);
      const targetRoom = await tx.room.findFirst({ where: { id: input.roomId, restaurantId, branchId: current.branchId, isActive: true } });
      if (!targetRoom) throw new NotFoundException("Salon no encontrado en la sucursal de la reserva.");
      await this.assertRoomIsBookable(restaurantId, targetRoom.id, current.serviceDate, current.turn, tx, current.specialServiceId, current.id);

      const assignment = await this.findManualRequestedAssignment(tx, {
        restaurantId,
        roomId: targetRoom.id,
        serviceDate: current.serviceDate,
        turn: current.turn,
        partySize: current.partySize,
        serviceTime: current.serviceTime,
        durationMinutes: current.durationMinutes,
        turnoverMinutes: current.turnoverMinutes,
        excludeReservationId: current.id
      }, normalizedTableIds);
      if (!assignment) throw new ConflictException("Las mesas seleccionadas ya no están disponibles para esta reserva.");

      await tx.reservationTable.deleteMany({ where: { reservationId: current.id } });
      await tx.serviceState.updateMany({
        where: { restaurantId, reservationId: current.id },
        data: { status: "free", reservationId: null }
      });

      const changed = await tx.reservation.update({
        where: { id: current.id },
        data: {
          roomId: targetRoom.id,
          ...(targetRoom.id === current.roomId ? {} : { preferredZone: null }),
          tables: { createMany: { data: assignment.tableIds.map((tableId) => ({ tableId })) } }
        },
        include: {
          room: true,
          branch: true,
          customer: { include: { tags: true } },
          tables: { include: { table: true } }
        }
      });

      await Promise.all(
        assignment.tableIds.map((tableId) =>
          tx.serviceState.upsert({
            where: { tableId_reservationId: { tableId, reservationId: current.id } },
            update: { status: "reserved", branchId: current.branchId, roomId: targetRoom.id, reservationId: current.id, specialServiceId: current.specialServiceId },
            create: {
              restaurantId,
              branchId: current.branchId,
              roomId: targetRoom.id,
              tableId,
              reservationId: current.id,
              serviceDate: current.serviceDate,
              turn: current.turn,
              specialServiceId: current.specialServiceId,
              status: "reserved"
            }
          })
        )
      );

      return changed;
    });

    this.realtimeService.publish("reservation.updated", { restaurantId, reservationId: updated.id, roomId: updated.roomId, previousRoomId: reservation.roomId });
    await this.auditService.log({
      action: "reservation.tables_reassigned",
      targetType: "reservation",
      targetId: updated.id,
      restaurantId,
      restaurantUserId: user.sub,
      metadata: { code: reservation.code, previousRoomId: reservation.roomId, roomId: input.roomId, tableIds: normalizedTableIds }
    });
    return updated;
  }

  async moveReservationToStateForRestaurant(
    restaurantId: string,
    input: { reservationId?: string; code?: string },
    next: "seated" | "completed",
    options?: { actorUserId?: string | null; idempotencyKey?: string | null }
  ) {
    const reservation = await this.prisma.reservation.findFirst({
      where: {
        restaurantId,
        ...(input.reservationId ? { id: input.reservationId } : {}),
        ...(input.code ? { codeNormalized: this.normalizeReservationCode(input.code) } : {})
      },
      include: { tables: true }
    });
    if (!reservation) throw new NotFoundException("Reservation not found");

    if (reservation.status === "cancelled") {
      throw new ConflictException("Cancelled reservation cannot be changed");
    }

    if (next === "seated" && reservation.status === "completed") {
      throw new ConflictException("Completed reservation cannot be checked in");
    }

    const nextStatus: ReservationStatus = next;
    const tableStatus = next === "seated" ? "occupied" : "free";

    const updated = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.reservation.update({
        where: { id: reservation.id },
        data: { status: nextStatus },
        include: {
          room: true,
          branch: true,
          customer: { include: { tags: true } },
          tables: { include: { table: true } }
        }
      });

      await Promise.all(
        reservation.tables.map((item) =>
          tx.serviceState.upsert({
            where: {
              tableId_reservationId: {
                tableId: item.tableId,
                reservationId: reservation.id
              }
            },
            update: {
              status: tableStatus,
              reservationId: next === "completed" ? null : reservation.id,
              specialServiceId: reservation.specialServiceId
            },
            create: {
              restaurantId,
              branchId: reservation.branchId,
              roomId: reservation.roomId,
              tableId: item.tableId,
              reservationId: next === "completed" ? null : reservation.id,
              serviceDate: reservation.serviceDate,
              turn: reservation.turn,
              specialServiceId: reservation.specialServiceId,
              status: tableStatus
            }
          })
        )
      );

      return changed;
    });

    this.realtimeService.publish("reservation.updated", {
      restaurantId,
      reservationId: reservation.id,
      status: nextStatus
    });

    await this.auditService.log({
      action: next === "seated" ? "reservation.checked_in" : "reservation.completed",
      targetType: "reservation",
      targetId: reservation.id,
      restaurantId,
      restaurantUserId: options?.actorUserId || null,
      metadata: {
        code: reservation.code,
        idempotencyKey: options?.idempotencyKey || null
      }
    });

    return updated;
  }

  async quoteReservationForRestaurant(input: {
    restaurantId: string;
    branchId: string;
    roomId: string;
    partySize: number;
    serviceDate: string;
    serviceTime?: string;
    turn?: "mediodia" | "noche";
    preferredZone?: string;
    preferredFeatures?: PreferredFeature[];
  }) {
    const room = await this.prisma.room.findFirst({
      where: {
        id: input.roomId,
        restaurantId: input.restaurantId,
        branchId: input.branchId
      },
      include: {
        zones: true
      }
    });

    if (!room) {
      throw new NotFoundException("Room not found");
    }

    const serviceDate = new Date(input.serviceDate);
    if (Number.isNaN(serviceDate.getTime())) {
      throw new BadRequestException("Invalid service date");
    }
    if (!input.serviceTime && await this.prisma.specialService.count({ where: { restaurantId: input.restaurantId, branchId: input.branchId, serviceDate } })) throw new BadRequestException("Las fechas con servicios especiales requieren un horario exacto.");
    const serviceTime = this.normalizeServiceTime(input.serviceTime, input.turn);
    const turn = this.deriveTurnFromServiceTime(serviceTime);
    const specialService = await this.resolveSpecialService(input.restaurantId, input.branchId, serviceDate, serviceTime);
    if (!specialService) await this.validateBookingException(input.restaurantId, input.branchId, serviceDate, serviceTime);
    if (
      await this.isRoomBlocked(input.restaurantId, input.roomId, serviceDate, turn) ||
      await this.isRoomAssignedToActiveEvent(input.restaurantId, input.roomId, serviceDate, turn, specialService?.id)
    ) {
      return {
        available: false, status: "unavailable", branchId: input.branchId, roomId: input.roomId, turn,
        serviceDate: serviceDate.toISOString(), serviceTime, partySize: input.partySize,
        room: { id: room.id, name: room.name, isOutdoor: room.isOutdoor }, preferredZone: input.preferredZone || null,
        preference: { requested: input.preferredFeatures || [], matched: false }, assignment: null,
        reason: "Room is unavailable for this service"
      };
    }
    const preferredFeatures = input.preferredFeatures || [];
    const preferredAssignment = await this.assignTables(this.prisma, {
      restaurantId: input.restaurantId,
      roomId: input.roomId,
      serviceDate,
      turn,
      partySize: input.partySize,
      preferredZone: input.preferredZone,
      preferredFeatures,
      serviceTime,
      durationMinutes: specialService?.durationMinutes || 180,
      turnoverMinutes: specialService?.turnoverMinutes || 0
    });
    const generalAssignment = preferredAssignment || !preferredFeatures.length
      ? null
      : await this.assignTables(this.prisma, {
          restaurantId: input.restaurantId,
          roomId: input.roomId,
          serviceDate,
          turn,
          partySize: input.partySize,
          preferredZone: input.preferredZone,
          serviceTime,
          durationMinutes: specialService?.durationMinutes || 180,
          turnoverMinutes: specialService?.turnoverMinutes || 0
        });
    const status = preferredAssignment
      ? "preferred_available"
      : generalAssignment
        ? "general_only"
        : "unavailable";

    return {
      available: Boolean(preferredAssignment || generalAssignment),
      status,
      branchId: input.branchId,
      roomId: input.roomId,
      turn,
      serviceDate: serviceDate.toISOString(),
      serviceTime,
      partySize: input.partySize,
      room: {
        id: room.id,
        name: room.name,
        isOutdoor: room.isOutdoor
      },
      preferredZone: input.preferredZone || null,
      preference: {
        requested: preferredFeatures,
        matched: Boolean(preferredAssignment)
      },
      assignment: preferredAssignment
        ? {
            tableIds: preferredAssignment.tableIds,
            tableLabels: preferredAssignment.tableLabels,
            seats: preferredAssignment.seats,
            combination: preferredAssignment.tableIds.length > 1,
            features: preferredAssignment.features
          }
        : null,
      reason: preferredAssignment || generalAssignment ? null : "No valid table or combination available"
    };
  }

  async findCustomerForRestaurant(restaurantId: string, input: { email?: string; phone?: string }) {
    const normalizedEmail = this.normalizeOptionalEmail(input.email);
    const normalizedPhone = input.phone?.trim();

    if (!normalizedEmail && !normalizedPhone) {
      throw new BadRequestException("Email or phone is required");
    }

    return this.prisma.customer.findFirst({
      where: {
        restaurantId,
        OR: [
          ...(normalizedEmail ? [{ email: normalizedEmail }] : []),
          ...(normalizedPhone ? [{ phone: normalizedPhone }] : [])
        ]
      },
      include: {
        tags: true,
        reservations: {
          include: {
            room: true,
            tables: { include: { table: true } }
          },
          orderBy: { serviceDate: "desc" },
          take: 10
        }
      }
    });
  }

  async findReservationForRestaurant(
    restaurantId: string,
    input: { code?: string; phone?: string; serviceDate?: string }
  ) {
    const normalizedPhone = input.phone?.trim();
    const serviceDate = input.serviceDate ? new Date(input.serviceDate) : undefined;

    if (!input.code && !normalizedPhone) {
      throw new BadRequestException("Reservation code or phone is required");
    }

    if (input.serviceDate && serviceDate && Number.isNaN(serviceDate.getTime())) {
      throw new BadRequestException("Invalid service date");
    }

    return this.prisma.reservation.findFirst({
      where: {
        restaurantId,
        ...(input.code ? { codeNormalized: this.normalizeReservationCode(input.code) } : {}),
        ...(normalizedPhone ? { phone: normalizedPhone } : {}),
        ...(serviceDate ? { serviceDate } : {})
      },
      include: {
        room: true,
        branch: true,
        customer: { include: { tags: true } },
        tables: { include: { table: true } }
      },
      orderBy: { createdAt: "desc" }
    });
  }

  async updateReservationForRestaurant(
    restaurantId: string,
    input: {
      code: string;
      branchId?: string;
      roomId?: string;
      fullName?: string;
      phone?: string;
      email?: string;
      partySize?: number;
      serviceDate?: string;
      serviceTime?: string;
      turn?: "mediodia" | "noche";
      preferredZone?: string | null;
      preferredTags?: string[];
      birthday?: string | null;
      notes?: string | null;
    },
    options?: { actorUserId?: string; idempotencyKey?: string }
  ) {
    const reservation = await this.prisma.reservation.findFirst({
      where: {
        restaurantId,
        codeNormalized: this.normalizeReservationCode(input.code)
      },
      include: {
        customer: true,
        tables: true
      }
    });

    if (!reservation) {
      throw new NotFoundException("Reservation not found");
    }

    if (["cancelled", "completed", "no_show", "seated"].includes(reservation.status)) {
      throw new ConflictException("Reservation can no longer be updated");
    }

    const nextBranchId = input.branchId || reservation.branchId;
    const nextRoomId = input.roomId || reservation.roomId;
    const nextPartySize = input.partySize || reservation.partySize;
    const nextServiceDate = input.serviceDate ? new Date(input.serviceDate) : reservation.serviceDate;
    const nextServiceTime = this.normalizeServiceTime(input.serviceTime ?? reservation.serviceTime, input.turn || reservation.turn);
    const nextTurn = this.deriveTurnFromServiceTime(nextServiceTime);

    if (Number.isNaN(nextServiceDate.getTime())) {
      throw new BadRequestException("Invalid service date");
    }
    const specialService = await this.resolveSpecialService(restaurantId, nextBranchId, nextServiceDate, nextServiceTime);
    if (!specialService) await this.validateBookingException(restaurantId, nextBranchId, nextServiceDate, nextServiceTime);
    const nextDurationMinutes = specialService?.durationMinutes || reservation.durationMinutes;
    const nextTurnoverMinutes = specialService?.turnoverMinutes ?? reservation.turnoverMinutes;
    await this.assertRoomIsBookable(restaurantId, nextRoomId, nextServiceDate, nextTurn, this.prisma, specialService?.id, reservation.id);

    const room = await this.prisma.room.findFirst({
      where: {
        id: nextRoomId,
        restaurantId,
        branchId: nextBranchId
      }
    });

    if (!room) {
      throw new NotFoundException("Room not found");
    }

    const assignment = await this.assignTables(this.prisma, {
      restaurantId,
      roomId: nextRoomId,
      serviceDate: nextServiceDate,
      turn: nextTurn,
      partySize: nextPartySize,
      preferredZone: input.preferredZone === null ? undefined : input.preferredZone || reservation.preferredZone || undefined,
      serviceTime: nextServiceTime,
      durationMinutes: nextDurationMinutes,
      turnoverMinutes: nextTurnoverMinutes,
      excludeReservationId: reservation.id
    });

    if (!assignment) {
      throw new ConflictException("No valid table or combination available");
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.assertRoomIsBookable(restaurantId, nextRoomId, nextServiceDate, nextTurn, tx, specialService?.id, reservation.id);
      const normalizedEmail = input.email !== undefined
        ? this.normalizeOptionalEmail(input.email)
        : reservation.email;
      const customer = await this.upsertCustomer(
        tx,
        restaurantId,
        {
          branchId: nextBranchId,
          fullName: input.fullName || reservation.fullName,
          phone: input.phone || reservation.phone,
          email: normalizedEmail ?? null,
          birthday:
            input.birthday === null
              ? undefined
              : input.birthday !== undefined
                ? input.birthday
                : reservation.customer?.birthday
                  ? reservation.customer.birthday.toISOString().slice(0, 10)
                  : undefined,
          preferredTags: input.preferredTags,
          notes: input.notes === null ? undefined : input.notes ?? reservation.notes ?? undefined
        },
        {
          incrementReservationCount: false
        }
      );

      await tx.reservationTable.deleteMany({
        where: { reservationId: reservation.id }
      });

      await tx.serviceState.updateMany({
        where: {
          restaurantId,
          reservationId: reservation.id
        },
        data: {
          status: "free",
          reservationId: null
        }
      });

      const nextReservation = await tx.reservation.update({
        where: { id: reservation.id },
        data: {
          branchId: nextBranchId,
          roomId: nextRoomId,
          customerId: customer.id,
          fullName: input.fullName || reservation.fullName,
          phone: input.phone || reservation.phone,
          email: normalizedEmail ?? null,
          partySize: nextPartySize,
          serviceDate: nextServiceDate,
          serviceTime: nextServiceTime,
          turn: nextTurn,
          specialServiceId: specialService?.id || null,
          durationMinutes: nextDurationMinutes,
          turnoverMinutes: nextTurnoverMinutes,
          preferredZone: input.preferredZone === null ? null : input.preferredZone ?? reservation.preferredZone,
          notes: input.notes === null ? null : input.notes ?? reservation.notes,
          tables: {
            createMany: {
              data: assignment.tableIds.map((tableId) => ({ tableId }))
            }
          }
        },
        include: {
          room: true,
          branch: true,
          customer: { include: { tags: true } },
          tables: { include: { table: true } }
        }
      });

      await Promise.all(
        assignment.tableIds.map((tableId) =>
          tx.serviceState.upsert({
            where: {
              tableId_reservationId: {
                tableId,
                reservationId: reservation.id
              }
            },
            update: {
              status: "reserved",
              roomId: nextRoomId,
              branchId: nextBranchId,
              reservationId: reservation.id,
              specialServiceId: specialService?.id || null
            },
            create: {
              restaurantId,
              branchId: nextBranchId,
              roomId: nextRoomId,
              tableId,
              reservationId: reservation.id,
              serviceDate: nextServiceDate,
              turn: nextTurn,
              specialServiceId: specialService?.id || null,
              status: "reserved"
            }
          })
        )
      );

      return nextReservation;
    });

    this.realtimeService.publish("reservation.updated", {
      restaurantId,
      branchId: updated.branchId,
      roomId: updated.roomId,
      reservationId: updated.id
    });

    await this.auditService.log({
      action: "reservation.updated",
      targetType: "reservation",
      targetId: updated.id,
      restaurantId,
      metadata: {
        actorUserId: options?.actorUserId || null,
        idempotencyKey: options?.idempotencyKey || null,
        externalCode: input.code
      }
    });

    return updated;
  }

  private async reassignableReservationOrThrow(
    restaurantId: string,
    reservationId: string,
    client: PrismaService | Prisma.TransactionClient = this.prisma
  ) {
    const reservation = await client.reservation.findFirst({
      where: { id: reservationId, restaurantId },
      include: { tables: true }
    });
    if (!reservation) throw new NotFoundException("Reservation not found");
    if (!(["pending", "confirmed"] as ReservationStatus[]).includes(reservation.status)) {
      throw new ConflictException("Solo se pueden cambiar las mesas de reservas pendientes o confirmadas.");
    }
    return reservation;
  }

  private async assertStandardReservationForManualReassignment(reservationId: string, restaurantId: string) {
    const eventAssignment = await this.prisma.reservationRoomAssignment.findFirst({
      where: { reservationId, reservation: { restaurantId } },
      select: { id: true }
    });
    if (eventAssignment) throw new ConflictException("Las reservas de evento se gestionan desde sus salones asignados.");
  }

  private tableCapacity(table: { seats: number; metadata?: unknown }) {
    const metadata = (table.metadata || {}) as { capacity?: { maxPartySize?: number } };
    return Math.max(1, metadata.capacity?.maxPartySize || table.seats);
  }

  private async listAvailableTables(
    client: PrismaService | Prisma.TransactionClient,
    input: {
      restaurantId: string;
      roomId: string;
      serviceDate: Date;
      turn: "mediodia" | "noche";
      partySize: number;
      preferredZone?: string;
      preferredFeatures?: PreferredFeature[];
      excludeReservationId?: string;
      serviceTime?: string;
      durationMinutes?: number;
      turnoverMinutes?: number;
      requireFreeState?: boolean;
    }
  ) {
    const roomTables = await client.table.findMany({
      where: {
        restaurantId: input.restaurantId,
        roomId: input.roomId,
        isActive: true,
        isReservable: true,
        ...(input.preferredZone ? { zoneId: input.preferredZone } : {})
      }
    });

    const requestedStart = this.timeToMinutes(input.serviceTime || "20:00");
    const requestedEnd = requestedStart + (input.durationMinutes || 180) + (input.turnoverMinutes || 0);
    const reservations = await client.reservation.findMany({
      where: {
        restaurantId: input.restaurantId,
        roomId: input.roomId,
        serviceDate: input.serviceDate,
        status: { notIn: ["cancelled", "completed", "no_show"] },
        ...(input.excludeReservationId ? { NOT: { id: input.excludeReservationId } } : {})
      },
      select: { serviceTime: true, durationMinutes: true, turnoverMinutes: true, tables: { select: { tableId: true } } }
    });
    const takenIds = new Set(reservations.flatMap((reservation) => {
      const start = this.timeToMinutes(reservation.serviceTime);
      const overlaps = requestedStart < start + reservation.durationMinutes + reservation.turnoverMinutes && start < requestedEnd;
      return overlaps ? reservation.tables.map((item) => item.tableId) : [];
    }));
    const blockedIds = await client.serviceState.findMany({
      where: {
        restaurantId: input.restaurantId,
        roomId: input.roomId,
        serviceDate: input.serviceDate,
        turn: input.turn,
        status: { in: ["blocked", "occupied"] }
      },
      select: { tableId: true }
    });
    blockedIds.forEach((item) => takenIds.add(item.tableId));

    const preferredFeatures = input.preferredFeatures || [];
    const availableTables = roomTables
      .filter((table) => !takenIds.has(table.id))
      .filter((table) => tableMatchesPreferredFeatures(table, preferredFeatures));

    return availableTables;
  }

  async reschedule(user: RequestUser, reservationId: string, input: { serviceDate: string }) {
    const restaurantId = this.restaurantScope(user);
    const reservation = await this.prisma.reservation.findFirst({
      where: { id: reservationId, restaurantId },
      select: { code: true }
    });

    if (!reservation) throw new NotFoundException("Reservation not found");

    return this.updateReservationForRestaurant(
      restaurantId,
      { code: reservation.code, serviceDate: input.serviceDate },
      { actorUserId: user.sub }
    );
  }

  private async listAvailableAssignments(
    client: PrismaService | Prisma.TransactionClient,
    input: {
      restaurantId: string;
      roomId: string;
      serviceDate: Date;
      turn: "mediodia" | "noche";
      partySize: number;
      preferredZone?: string;
      preferredFeatures?: PreferredFeature[];
      excludeReservationId?: string;
      serviceTime?: string;
      durationMinutes?: number;
      turnoverMinutes?: number;
    }
  ): Promise<Array<{ tableIds: string[]; tableLabels: string[]; seats: number; features: ReturnType<typeof getSharedTableFeatures> }>> {
    const availableTables = await this.listAvailableTables(client, input);
    const singles = availableTables
      .filter((table) => this.tableCapacity(table) >= input.partySize)
      .sort((a, b) => this.tableCapacity(a) - this.tableCapacity(b))
      .map((table) => ({ tableIds: [table.id], tableLabels: [table.label], seats: this.tableCapacity(table), features: getSharedTableFeatures([table]) }));

    const combinations = await client.tableCombination.findMany({
      where: {
        restaurantId: input.restaurantId,
        parentTable: { roomId: input.roomId },
        childTable: { roomId: input.roomId }
      }
    });
    const availableById = new Map(availableTables.map((table) => [table.id, table]));
    const adjacency = new Map<string, Set<string>>();
    for (const combo of combinations) {
      if (!availableById.has(combo.parentTableId) || !availableById.has(combo.childTableId)) continue;
      if (!adjacency.has(combo.parentTableId)) adjacency.set(combo.parentTableId, new Set());
      if (!adjacency.has(combo.childTableId)) adjacency.set(combo.childTableId, new Set());
      adjacency.get(combo.parentTableId)!.add(combo.childTableId);
      adjacency.get(combo.childTableId)!.add(combo.parentTableId);
    }

    // Every emitted set is connected: expand a set only through a neighbour of a member.
    const visited = new Set<string>();
    const combos: Array<{ tableIds: string[]; tableLabels: string[]; seats: number; features: ReturnType<typeof getSharedTableFeatures> }> = [];
    const explore = (ids: string[]) => {
      const sortedIds = [...ids].sort();
      const key = sortedIds.join("|");
      if (visited.has(key)) return;
      visited.add(key);
      const tables = sortedIds.map((id) => availableById.get(id)!).filter(Boolean);
      const seats = tables.reduce((total, table) => total + this.tableCapacity(table), 0);
      if (tables.length > 1 && seats >= input.partySize) {
        combos.push({ tableIds: sortedIds, tableLabels: tables.map((table) => table.label), seats, features: getSharedTableFeatures(tables) });
      }
      const nextIds = new Set<string>();
      for (const id of sortedIds) adjacency.get(id)?.forEach((neighbour) => { if (!sortedIds.includes(neighbour)) nextIds.add(neighbour); });
      nextIds.forEach((id) => explore([...sortedIds, id]));
    };
    adjacency.forEach((_neighbours, id) => explore([id]));

    return [...singles, ...combos].sort((left, right) => left.seats - right.seats);
  }

  private async assignTables(
    client: PrismaService | Prisma.TransactionClient,
    input: {
      restaurantId: string;
      roomId: string;
      serviceDate: Date;
      turn: "mediodia" | "noche";
      partySize: number;
      preferredZone?: string;
      preferredFeatures?: PreferredFeature[];
      excludeReservationId?: string;
      serviceTime?: string;
      durationMinutes?: number;
      turnoverMinutes?: number;
    }
  ) {
    const assignments = await this.listAvailableAssignments(client, input);
    return assignments.find((assignment) => assignment.tableIds.length === 1) || assignments[0] || null;
  }
  private async upsertCustomer(
    tx: any,
    restaurantId: string,
    input: {
      branchId: string;
      fullName: string;
      phone: string;
      email?: string | null;
      birthday?: string;
      preferredTags?: string[];
      notes?: string;
    },
    options?: {
      incrementReservationCount?: boolean;
    }
  ) {
    const normalizedEmail = this.normalizeOptionalEmail(input.email);
    const incrementReservationCount = options?.incrementReservationCount ?? true;
    // Sin email no hay una clave confiable para identificar a la persona.
    // Se crea un cliente nuevo para evitar unificar contactos distintos.
    const existing = normalizedEmail
      ? await tx.customer.findFirst({
          where: {
            restaurantId,
            email: normalizedEmail
          }
        })
      : null;

    const birthday = input.birthday ? new Date(input.birthday) : undefined;

    if (existing) {
      const customer = await tx.customer.update({
        where: { id: existing.id },
        data: {
          fullName: input.fullName,
          phone: input.phone,
          email: normalizedEmail ?? null,
          birthday,
          notes: input.notes,
          reservationCount: incrementReservationCount
            ? {
                increment: 1
              }
            : undefined
        }
      });

      if (input.preferredTags?.length) {
        await tx.customerTag.deleteMany({ where: { restaurantId, customerId: existing.id } });
        await tx.customerTag.createMany({
          data: input.preferredTags.map((label) => ({
            restaurantId,
            customerId: existing.id,
            label
          }))
        });
      }

      return customer;
    }

    const customer = await tx.customer.create({
      data: {
        restaurantId,
        branchId: input.branchId,
        fullName: input.fullName,
        phone: input.phone,
        email: normalizedEmail ?? null,
        birthday,
        notes: input.notes,
        reservationCount: incrementReservationCount ? 1 : 0
      }
    });

    if (input.preferredTags?.length) {
      await tx.customerTag.createMany({
        data: input.preferredTags.map((label) => ({
          restaurantId,
          customerId: customer.id,
          label
        }))
      });
    }

    return customer;
  }
}
