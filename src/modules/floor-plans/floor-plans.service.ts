import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { RequestUser } from "../../common/auth/request-user";
import { RealtimeService } from "../realtime/realtime.service";

type LayoutFixedItem = {
  kind: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type TableMetadata = {
  manualFeatures?: {
    hasTvView?: boolean;
    hasWindowView?: boolean;
  };
  capacity?: {
    minPartySize?: number;
    maxPartySize?: number;
  };
  derivedFeatures?: {
    nearWindow?: boolean;
    nearColumn?: boolean;
    nearWall?: boolean;
    nearCorridor?: boolean;
  };
};

type LayoutInput = {
  zones: Array<{ id: string; name: string; slug: string }>;
  items: Array<{ id: string; kind: string; label?: string; x: number; y: number; width: number; height: number; rotation?: number; metadata?: Record<string, unknown> }>;
  tables: Array<{ id: string; label: string; shape: string; seats: number; x: number; y: number; width: number; height: number; rotation?: number; isReservable: boolean; metadata?: Record<string, unknown>; zoneId?: string | null }>;
  combinations: Array<{ id: string; parentTableId: string; childTableId: string; combinedSeats: number }>;
};

@Injectable()
export class FloorPlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeService: RealtimeService
  ) {}

  private restaurantScope(user: RequestUser) {
    if (user.scope !== "restaurant" || !user.restaurantId) {
      throw new ForbiddenException("Restaurant context required");
    }
    return user.restaurantId;
  }

  private async bumpAssistantContext(restaurantId: string) {
    await this.prisma.restaurantCustomization.upsert({
      where: { restaurantId },
      create: { restaurantId },
      update: { configVersion: { increment: 1 } }
    });
  }

  private distanceBetweenRects(
    a: { x: number; y: number; width: number; height: number },
    b: { x: number; y: number; width: number; height: number }
  ) {
    const ax2 = a.x + a.width;
    const ay2 = a.y + a.height;
    const bx2 = b.x + b.width;
    const by2 = b.y + b.height;
    const dx = Math.max(0, a.x - bx2, b.x - ax2);
    const dy = Math.max(0, a.y - by2, b.y - ay2);

    return Math.sqrt(dx * dx + dy * dy);
  }

  private deriveTableMetadata(
    table: { x: number; y: number; width: number; height: number; metadata?: Record<string, unknown> },
    items: LayoutFixedItem[]
  ): TableMetadata {
    const source = (table.metadata || {}) as TableMetadata;
    const near = (kind: LayoutFixedItem["kind"], threshold: number) =>
      items
        .filter((item) => item.kind === kind)
        .some((item) => this.distanceBetweenRects(table, item) <= threshold);

    return {
      manualFeatures: {
        hasTvView: Boolean(source.manualFeatures?.hasTvView),
        hasWindowView: Boolean(source.manualFeatures?.hasWindowView)
      },
      capacity: {
        minPartySize: source.capacity?.minPartySize,
        maxPartySize: source.capacity?.maxPartySize
      },
      derivedFeatures: {
        nearWindow: near("window", 120),
        nearColumn: near("column", 90),
        nearWall: near("wall", 80),
        nearCorridor: near("corridor", 120)
      }
    };
  }

  list(user: RequestUser, branchId?: string) {
    const restaurantId = this.restaurantScope(user);
    return this.prisma.room.findMany({
      where: {
        restaurantId,
        isActive: true,
        ...(branchId ? { branchId } : {})
      },
      include: {
        branch: true,
        zones: true,
        tables: { where: { isActive: true } }
      },
      orderBy: [{ bookingPriority: "asc" }, { createdAt: "asc" }]
    });
  }

  async create(
    user: RequestUser,
    input: { branchId: string; name: string; description?: string; isOutdoor?: boolean }
  ) {
    const restaurantId = this.restaurantScope(user);
    const lastRoom = await this.prisma.room.findFirst({
      where: { restaurantId, branchId: input.branchId },
      orderBy: { bookingPriority: "desc" },
      select: { bookingPriority: true }
    });
    const room = await this.prisma.room.create({
      data: {
        branchId: input.branchId,
        restaurantId,
        name: input.name,
        description: input.description,
        isOutdoor: input.isOutdoor || false,
        bookingPriority: (lastRoom?.bookingPriority || 0) + 1
      }
    });
    await this.bumpAssistantContext(restaurantId);
    return room;
  }

  private tableCapacity(table: { seats: number; metadata?: unknown }) {
    const metadata = (table.metadata || {}) as TableMetadata;
    return Math.max(1, metadata.capacity?.maxPartySize || table.seats);
  }

  async reorder(user: RequestUser, input: { branchId: string; roomIds: string[] }) {
    const restaurantId = this.restaurantScope(user);
    const rooms = await this.prisma.room.findMany({
      where: { restaurantId, branchId: input.branchId, isActive: true },
      select: { id: true }
    });
    const currentIds = new Set(rooms.map((room) => room.id));
    if (currentIds.size !== input.roomIds.length || input.roomIds.some((id) => !currentIds.has(id))) {
      throw new NotFoundException("Room order must include every active room in the branch");
    }
    await this.prisma.$transaction(input.roomIds.map((id, index) => this.prisma.room.update({
      where: { id },
      data: { bookingPriority: index + 1 }
    })));
    await this.bumpAssistantContext(restaurantId);
    return this.prisma.room.findMany({
      where: { restaurantId, branchId: input.branchId, isActive: true },
      orderBy: [{ bookingPriority: "asc" }, { createdAt: "asc" }]
    });
  }

  async blocks(user: RequestUser, input: { branchId: string; serviceDate: string; turn: "mediodia" | "noche" }) {
    const restaurantId = this.restaurantScope(user);
    return this.prisma.roomBookingBlock.findMany({
      where: { restaurantId, branchId: input.branchId, serviceDate: new Date(input.serviceDate), turn: input.turn },
      select: { id: true, roomId: true, serviceDate: true, turn: true, reason: true, createdAt: true }
    });
  }

  async block(user: RequestUser, roomId: string, input: { serviceDate: string; turn: "mediodia" | "noche"; reason?: string }) {
    const restaurantId = this.restaurantScope(user);
    const room = await this.prisma.room.findFirst({ where: { id: roomId, restaurantId, isActive: true } });
    if (!room) throw new NotFoundException("Room not found");
    const serviceDate = new Date(input.serviceDate);
    const activeReservations = await this.prisma.reservation.count({
      where: { restaurantId, roomId, serviceDate, turn: input.turn, status: { notIn: ["cancelled", "completed", "no_show"] } }
    });
    if (activeReservations) throw new ConflictException("No se puede bloquear un salon con reservas activas. Reasignalas o cancelalas primero.");
    const block = await this.prisma.roomBookingBlock.upsert({
      where: { roomId_serviceDate_turn: { roomId, serviceDate, turn: input.turn } },
      create: { restaurantId, branchId: room.branchId, roomId, serviceDate, turn: input.turn, reason: input.reason || null, createdByUserId: user.sub },
      update: { reason: input.reason || null, createdByUserId: user.sub }
    });
    await this.bumpAssistantContext(restaurantId);
    return block;
  }

  async unblock(user: RequestUser, roomId: string, input: { serviceDate: string; turn: "mediodia" | "noche" }) {
    const restaurantId = this.restaurantScope(user);
    await this.prisma.roomBookingBlock.deleteMany({ where: { restaurantId, roomId, serviceDate: new Date(input.serviceDate), turn: input.turn } });
    await this.bumpAssistantContext(restaurantId);
    return { ok: true };
  }

  private async roomOrThrow(restaurantId: string, roomId: string) {
    const room = await this.prisma.room.findFirst({ where: { id: roomId, restaurantId, isActive: true } });
    if (!room) throw new NotFoundException("Room not found");
    return room;
  }

  private async assertRuleHasNoReservationConflicts(
    restaurantId: string,
    roomId: string,
    input: { weekdays: number[]; turns: Array<"mediodia" | "noche">; startsAt: string; endsAt?: string | null }
  ) {
    const startsAt = new Date(input.startsAt);
    const reservations = await this.prisma.reservation.findMany({
      where: {
        restaurantId,
        roomId,
        serviceDate: { gte: startsAt, ...(input.endsAt ? { lte: new Date(input.endsAt) } : {}) },
        turn: { in: input.turns },
        status: { notIn: ["cancelled", "completed", "no_show"] }
      },
      select: { serviceDate: true, turn: true }
    });
    const conflicts = reservations.filter((reservation) => input.weekdays.includes(reservation.serviceDate.getUTCDay()));
    if (conflicts.length) {
      const dates = [...new Set(conflicts.slice(0, 5).map((item) => `${item.serviceDate.toISOString().slice(0, 10)} (${item.turn})`))];
      throw new ConflictException(`No se puede guardar el bloqueo porque hay reservas activas en: ${dates.join(", ")}${conflicts.length > dates.length ? "…" : ""}.`);
    }
  }

  async rules(user: RequestUser, roomId: string) {
    const restaurantId = this.restaurantScope(user);
    await this.roomOrThrow(restaurantId, roomId);
    return this.prisma.roomBookingRule.findMany({
      where: { restaurantId, roomId },
      orderBy: [{ startsAt: "asc" }, { createdAt: "asc" }]
    });
  }

  async createRule(user: RequestUser, roomId: string, input: { weekdays: number[]; turns: Array<"mediodia" | "noche">; startsAt: string; endsAt?: string | null; reason?: string | null }) {
    const restaurantId = this.restaurantScope(user);
    const room = await this.roomOrThrow(restaurantId, roomId);
    await this.assertRuleHasNoReservationConflicts(restaurantId, roomId, input);
    const rule = await this.prisma.roomBookingRule.create({
      data: { restaurantId, branchId: room.branchId, roomId, weekdays: input.weekdays, turns: input.turns, startsAt: new Date(input.startsAt), endsAt: input.endsAt ? new Date(input.endsAt) : null, reason: input.reason || null, createdByUserId: user.sub }
    });
    await this.bumpAssistantContext(restaurantId);
    return rule;
  }

  async updateRule(user: RequestUser, roomId: string, ruleId: string, input: { weekdays: number[]; turns: Array<"mediodia" | "noche">; startsAt: string; endsAt?: string | null; reason?: string | null }) {
    const restaurantId = this.restaurantScope(user);
    await this.roomOrThrow(restaurantId, roomId);
    const existing = await this.prisma.roomBookingRule.findFirst({ where: { id: ruleId, restaurantId, roomId } });
    if (!existing) throw new NotFoundException("Booking rule not found");
    await this.assertRuleHasNoReservationConflicts(restaurantId, roomId, input);
    const rule = await this.prisma.roomBookingRule.update({
      where: { id: ruleId },
      data: { weekdays: input.weekdays, turns: input.turns, startsAt: new Date(input.startsAt), endsAt: input.endsAt ? new Date(input.endsAt) : null, reason: input.reason || null, createdByUserId: user.sub }
    });
    await this.bumpAssistantContext(restaurantId);
    return rule;
  }

  async removeRule(user: RequestUser, roomId: string, ruleId: string) {
    const restaurantId = this.restaurantScope(user);
    const result = await this.prisma.roomBookingRule.deleteMany({ where: { id: ruleId, restaurantId, roomId } });
    if (!result.count) throw new NotFoundException("Booking rule not found");
    await this.bumpAssistantContext(restaurantId);
    return { ok: true };
  }

  async update(
    user: RequestUser,
    roomId: string,
    input: { name: string; description?: string; isOutdoor?: boolean }
  ) {
    const restaurantId = this.restaurantScope(user);
    const existing = await this.prisma.room.findFirst({
      where: { id: roomId, restaurantId, isActive: true }
    });

    if (!existing) {
      throw new NotFoundException("Room not found");
    }

    const room = await this.prisma.room.update({
      where: { id: roomId },
      data: {
        name: input.name,
        description: input.description,
        isOutdoor: input.isOutdoor || false
      }
    });
    await this.bumpAssistantContext(restaurantId);
    return room;
  }

  async remove(user: RequestUser, roomId: string) {
    const restaurantId = this.restaurantScope(user);
    const room = await this.prisma.room.findFirst({
      where: { id: roomId, restaurantId, isActive: true },
    });

    if (!room) {
      throw new NotFoundException("Room not found");
    }

    await this.prisma.room.update({
      where: { id: roomId },
      data: { isActive: false }
    });
    await this.bumpAssistantContext(restaurantId);

    return { ok: true };
  }

  async detail(user: RequestUser, roomId: string) {
    const restaurantId = this.restaurantScope(user);
    const room = await this.prisma.room.findFirst({
      where: { id: roomId, restaurantId, isActive: true },
      include: {
        zones: true,
        floorPlanItems: true,
        tables: { where: { isActive: true } }
      }
    });
    if (!room) {
      throw new NotFoundException("Room not found");
    }

    const combinations = await this.prisma.tableCombination.findMany({
      where: { restaurantId, parentTable: { roomId } }
    });

    return {
      ...room,
      combinations
    };
  }

  private tableChangedByLayout(
    table: { id: string; label: string; shape: string; seats: number; x: number; y: number; width: number; height: number; rotation: number; isReservable: boolean; zoneId: string | null; metadata: Prisma.JsonValue | null },
    next?: LayoutInput["tables"][number]
  ) {
    if (!next) return true;
    return table.label !== next.label || table.shape !== next.shape || table.seats !== next.seats || table.x !== next.x || table.y !== next.y || table.width !== next.width || table.height !== next.height || table.rotation !== (next.rotation || 0) || table.isReservable !== next.isReservable || table.zoneId !== (next.zoneId || null) || JSON.stringify(table.metadata || {}) !== JSON.stringify(next.metadata || {});
  }

  private async layoutTablesOrThrow(restaurantId: string, roomId: string) {
    const room = await this.prisma.room.findFirst({
      where: { id: roomId, restaurantId, isActive: true },
      include: { branch: { select: { timezone: true } } }
    });
    if (!room) throw new NotFoundException("Room not found");
    const tables = await this.prisma.table.findMany({
      where: { restaurantId, roomId, isActive: true },
      select: { id: true, label: true, shape: true, seats: true, x: true, y: true, width: true, height: true, rotation: true, isReservable: true, zoneId: true, metadata: true }
    });
    return { tables, timezone: room.branch.timezone };
  }

  private layoutImpactTableIds(existingTables: Awaited<ReturnType<FloorPlansService["layoutTablesOrThrow"]>>["tables"], input: LayoutInput) {
    const incomingById = new Map(input.tables.map((table) => [table.id, table]));
    return existingTables.filter((table) => this.tableChangedByLayout(table, incomingById.get(table.id))).map((table) => table.id);
  }

  private validateLayoutInput(input: LayoutInput) {
    const tableIds = new Set<string>();
    const labels = new Set<string>();
    for (const table of input.tables) {
      if (tableIds.has(table.id)) throw new ConflictException("Hay una mesa repetida en el plano. Revisá las mesas antes de guardar.");
      tableIds.add(table.id);
      const label = table.label.trim().toLocaleLowerCase("es");
      if (labels.has(label)) throw new ConflictException(`El nombre de la mesa ${table.label} está repetido en este salón.`);
      labels.add(label);
    }

    const combinationIds = new Set<string>();
    const combinationPairs = new Set<string>();
    for (const combination of input.combinations) {
      if (combinationIds.has(combination.id)) throw new ConflictException("Hay una combinación repetida. Revisá las mesas compatibles.");
      combinationIds.add(combination.id);
      if (combination.parentTableId === combination.childTableId) throw new ConflictException("Una mesa no puede combinarse consigo misma.");
      if (!tableIds.has(combination.parentTableId) || !tableIds.has(combination.childTableId)) {
        throw new ConflictException("Una combinación incluye una mesa eliminada del plano. Revisá las mesas compatibles.");
      }
      const pair = [combination.parentTableId, combination.childTableId].sort().join("|");
      if (combinationPairs.has(pair)) throw new ConflictException("La combinación entre estas mesas está repetida.");
      combinationPairs.add(pair);
    }
  }

  private todayInTimezone(timezone: string) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
    return new Date(`${value("year")}-${value("month")}-${value("day")}T00:00:00.000Z`);
  }

  private reservationLayoutCompatibility(
    reservation: { partySize: number; tables: Array<{ table: { id: string; roomId: string; seats: number; isReservable: boolean; metadata: Prisma.JsonValue | null } }> },
    roomId: string,
    input: LayoutInput
  ) {
    const incomingById = new Map(input.tables.map((table) => [table.id, table]));
    const finalTables = reservation.tables.map((link) => {
      const draft = link.table.roomId === roomId ? incomingById.get(link.table.id) : undefined;
      if (link.table.roomId === roomId && !draft) return null;
      return draft || link.table;
    });
    const missingTable = finalTables.some((table) => !table);
    const nonReservableTable = finalTables.some((table) => table && !table.isReservable);
    const capacity = finalTables.reduce((total, table) => total + (table ? this.tableCapacity(table) : 0), 0);
    return { missingTable, nonReservableTable, capacity, isCompatible: !missingTable && !nonReservableTable && capacity >= reservation.partySize };
  }

  async layoutImpact(user: RequestUser, roomId: string, input: LayoutInput, focusTableId?: string) {
    this.validateLayoutInput(input);
    const restaurantId = this.restaurantScope(user);
    const { tables: existingTables, timezone } = await this.layoutTablesOrThrow(restaurantId, roomId);
    const changedTableIds = this.layoutImpactTableIds(existingTables, input);
    if (focusTableId && !existingTables.some((table) => table.id === focusTableId)) {
      throw new NotFoundException("Table not found in this room");
    }
    if (focusTableId && !changedTableIds.includes(focusTableId)) {
      throw new ConflictException("La mesa seleccionada no tiene cambios para guardar.");
    }
    const affectedTableIds = focusTableId ? [focusTableId] : changedTableIds;
    if (!affectedTableIds.length) return { affectedTableIds: [], reservations: [], excludedTableIds: [] };

    const today = this.todayInTimezone(timezone);

    const [reservations, occupiedStates] = await Promise.all([
      this.prisma.reservation.findMany({
        where: {
          restaurantId,
          status: { in: ["pending", "confirmed", "seated"] },
          serviceDate: { gte: today },
          tables: { some: { tableId: { in: affectedTableIds } } }
        },
        include: { branch: true, room: true, customer: { include: { tags: true } }, tables: { include: { table: true } }, eventRoomAssignments: { include: { room: true } } },
        orderBy: [{ serviceDate: "asc" }, { serviceTime: "asc" }]
      }),
      this.prisma.serviceState.findMany({ where: { restaurantId, tableId: { in: affectedTableIds }, status: "occupied", reservationId: { not: null } }, select: { reservationId: true } })
    ]);
    const occupiedReservationIds = new Set(occupiedStates.map((state) => state.reservationId).filter((id): id is string => Boolean(id)));

    const impacted = reservations.map((reservation) => {
      const compatibility = this.reservationLayoutCompatibility(reservation, roomId, input);
      const affectedTables = reservation.tables.filter((link) => affectedTableIds.includes(link.table.id)).map((link) => link.table.label);
      const requiresReassignment = ["pending", "confirmed"].includes(reservation.status) && !compatibility.isCompatible;
      const blocksLayout = reservation.status === "seated" || occupiedReservationIds.has(reservation.id);
      const reasons = [
        compatibility.missingTable ? "La mesa será eliminada o desactivada." : null,
        compatibility.nonReservableTable ? "La mesa dejará de aceptar reservas." : null,
        !compatibility.missingTable && !compatibility.nonReservableTable && compatibility.capacity < reservation.partySize ? "La capacidad final no alcanza los comensales." : null,
        blocksLayout ? "La reserva está en curso y debe liberarse, completarse o cancelarse." : null
      ].filter((reason): reason is string => Boolean(reason));
      return { reservation, affectedTables, requiresReassignment, blocksLayout, reasons, finalCapacity: compatibility.capacity };
    });

    const excludedTableIds = input.tables
      .filter((table) => !table.isReservable)
      .map((table) => table.id)
      .concat(existingTables.filter((table) => !input.tables.some((next) => next.id === table.id)).map((table) => table.id));
    return { affectedTableIds, reservations: impacted, excludedTableIds: [...new Set(excludedTableIds)] };
  }

  private async assertLayoutReservationsRemainCompatible(
    tx: Prisma.TransactionClient,
    restaurantId: string,
    roomId: string,
    input: LayoutInput,
    affectedTableIds: string[],
    minimumServiceDate: Date
  ) {
    if (!affectedTableIds.length) return;
    const reservations = await tx.reservation.findMany({
      where: { restaurantId, status: { in: ["pending", "confirmed", "seated"] }, serviceDate: { gte: minimumServiceDate }, tables: { some: { tableId: { in: affectedTableIds } } } },
      include: { tables: { include: { table: true } } }
    });
    const occupiedStates = await tx.serviceState.findMany({ where: { restaurantId, tableId: { in: affectedTableIds }, status: "occupied", reservationId: { not: null } }, select: { reservationId: true } });
    const occupiedReservationIds = new Set(occupiedStates.map((state) => state.reservationId));
    for (const reservation of reservations) {
      if (reservation.status === "seated" || occupiedReservationIds.has(reservation.id)) {
        throw new ConflictException("Hay una reserva en curso en una mesa modificada. Liberala, completala o cancelala antes de guardar.");
      }
      const compatibility = this.reservationLayoutCompatibility(reservation, roomId, input);
      if (!compatibility.isCompatible) {
        throw new ConflictException("Hay reservas pendientes o confirmadas que deben reasignarse antes de guardar el plano.");
      }
    }
  }

  async replaceLayout(
    user: RequestUser,
    roomId: string,
    input: LayoutInput
  ) {
    this.validateLayoutInput(input);
    const restaurantId = this.restaurantScope(user);

    const room = await this.prisma.room.findFirst({
      where: { id: roomId, restaurantId, isActive: true },
      include: { branch: { select: { timezone: true } } }
    });
    if (!room) throw new NotFoundException("Room not found");

    const normalizedCombinations = (() => {
      const tablesById = new Map(input.tables.map((table) => [table.id, table]));
      const seen = new Set<string>();
      return input.combinations.map((item) => {
        if (item.parentTableId === item.childTableId) {
          throw new ConflictException("Una mesa no puede ser compatible consigo misma.");
        }
        const left = tablesById.get(item.parentTableId);
        const right = tablesById.get(item.childTableId);
        if (!left || !right) {
          throw new ConflictException("Las mesas compatibles deben pertenecer al mismo salón.");
        }
        const [parentTableId, childTableId] = [left.id, right.id].sort();
        const key = `${parentTableId}|${childTableId}`;
        if (seen.has(key)) throw new ConflictException("La compatibilidad entre estas mesas está repetida.");
        seen.add(key);
        return {
          id: item.id,
          parentTableId,
          childTableId,
          combinedSeats: this.tableCapacity(left) + this.tableCapacity(right)
        };
      });
    })();

    let result;
    try {
      result = await this.prisma.$transaction(async (tx) => {
      const existingTables = await tx.table.findMany({
        where: { restaurantId, roomId },
        select: {
          id: true,
          label: true,
          shape: true,
          seats: true,
          x: true,
          y: true,
          width: true,
          height: true,
          rotation: true,
          isReservable: true,
          isActive: true,
          zoneId: true,
          metadata: true,
          reservationLinks: { select: { id: true }, take: 1 }
        }
      });
      const incomingTableIds = new Set(input.tables.map((table) => table.id));
      const activeTables = existingTables.filter((table) => table.isActive);
      const affectedTableIds = activeTables
        .filter((table) => this.tableChangedByLayout(table, input.tables.find((next) => next.id === table.id)))
        .map((table) => table.id);
      await this.assertLayoutReservationsRemainCompatible(tx, restaurantId, roomId, input, affectedTableIds, this.todayInTimezone(room.branch.timezone));
      const removableTableIds = activeTables
        .filter((table) => !incomingTableIds.has(table.id) && !table.reservationLinks.length)
        .map((table) => table.id);
      const deactivatableTableIds = activeTables
        .filter((table) => !incomingTableIds.has(table.id) && table.reservationLinks.length)
        .map((table) => table.id);

      const retainedLabels = new Set(existingTables
        .filter((table) => !table.isActive || deactivatableTableIds.includes(table.id))
        .map((table) => table.label));
      const reusedLabel = input.tables.find((table) =>
        !existingTables.some((existing) => existing.id === table.id && existing.label === table.label) && retainedLabels.has(table.label)
      );
      if (reusedLabel) {
        throw new ConflictException(`La mesa ${reusedLabel.label} tiene reservas anteriores y su nombre sigue en uso. Elegí otro número para la mesa nueva.`);
      }

      const incomingZoneIds = new Set(input.zones.map((zone) => zone.id));
      const incomingItemIds = new Set(input.items.map((item) => item.id));
      const existingItems = await tx.floorPlanItem.findMany({
        where: { restaurantId, roomId },
        select: { id: true }
      });
      const removableItemIds = existingItems
        .filter((item) => !incomingItemIds.has(item.id))
        .map((item) => item.id);
      const existingZones = await tx.roomZone.findMany({
        where: { restaurantId, roomId },
        select: { id: true }
      });
      const removableZoneIds = existingZones
        .filter((zone) => !incomingZoneIds.has(zone.id))
        .map((zone) => zone.id);

      await tx.tableCombination.deleteMany({
        where: { restaurantId, OR: [{ parentTable: { roomId } }, { childTable: { roomId } }] }
      });

      if (removableItemIds.length) {
        await tx.floorPlanItem.deleteMany({
          where: { restaurantId, roomId, id: { in: removableItemIds } }
        });
      }

      const derivedTableInputs = input.tables.map((table) => ({
        ...table,
        metadata: this.deriveTableMetadata(table, input.items)
      }));

      for (const zone of input.zones) {
        await tx.roomZone.upsert({
          where: { id: zone.id },
          update: {
            name: zone.name,
            slug: zone.slug
          },
          create: {
            id: zone.id,
            roomId,
            restaurantId,
            name: zone.name,
            slug: zone.slug
          }
        });
      }

      for (const item of input.items) {
        await tx.floorPlanItem.upsert({
          where: { id: item.id },
          update: {
            kind: item.kind,
            label: item.label,
            x: item.x,
            y: item.y,
            width: item.width,
            height: item.height,
            rotation: item.rotation || 0,
            metadata: item.metadata as Prisma.InputJsonValue | undefined
          },
          create: {
            id: item.id,
            roomId,
            restaurantId,
            kind: item.kind,
            label: item.label,
            x: item.x,
            y: item.y,
            width: item.width,
            height: item.height,
            rotation: item.rotation || 0,
            metadata: item.metadata as Prisma.InputJsonValue | undefined
          }
        });
      }

      if (removableTableIds.length) {
        await tx.table.deleteMany({
          where: {
            restaurantId,
            roomId,
            id: { in: removableTableIds }
          }
        });
      }

      if (deactivatableTableIds.length) {
        await tx.table.updateMany({
          where: { restaurantId, roomId, id: { in: deactivatableTableIds } },
          data: { isActive: false, isReservable: false }
        });
      }

      for (const table of derivedTableInputs) {
        await tx.table.upsert({
          where: { id: table.id },
          update: {
            zoneId: table.zoneId || null,
            label: table.label,
            shape: table.shape,
            seats: table.seats,
            x: table.x,
            y: table.y,
            width: table.width,
            height: table.height,
            rotation: table.rotation || 0,
            metadata: table.metadata as Prisma.InputJsonValue | undefined,
            isReservable: table.isReservable,
            isActive: true
          },
          create: {
            id: table.id,
            roomId,
            restaurantId,
            zoneId: table.zoneId || null,
            label: table.label,
            shape: table.shape,
            seats: table.seats,
            x: table.x,
            y: table.y,
            width: table.width,
            height: table.height,
            rotation: table.rotation || 0,
            metadata: table.metadata as Prisma.InputJsonValue | undefined,
            isReservable: table.isReservable,
            isActive: true
          }
        });
      }

      if (removableZoneIds.length) {
        await tx.roomZone.deleteMany({
          where: {
            restaurantId,
            roomId,
            id: { in: removableZoneIds }
          }
        });
      }

      if (normalizedCombinations.length) {
        await tx.tableCombination.createMany({
          data: normalizedCombinations.map((item) => ({
            id: item.id,
            restaurantId,
            parentTableId: item.parentTableId,
            childTableId: item.childTableId,
            combinedSeats: item.combinedSeats
          }))
        });
      }

      return tx.room.findUnique({
        where: { id: roomId },
        include: {
          zones: true,
          floorPlanItems: true,
          tables: { where: { isActive: true } }
        }
      });
      }, { timeout: 30000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === "P2002") throw new ConflictException("Hay nombres o combinaciones de mesas repetidos. Revisá el plano y volvé a guardar.");
        if (error.code === "P2003") throw new ConflictException("Una mesa o zona del plano ya no está disponible. Actualizá el salón y revisá los cambios.");
        if (error.code === "P2028") throw new ServiceUnavailableException("El plano tardó demasiado en guardarse. Intentá de nuevo.");
      }
      throw error;
    }

    await this.bumpAssistantContext(restaurantId);
    this.realtimeService.publish("floor_plan.updated", { restaurantId, roomId });
    return result;
  }
}
