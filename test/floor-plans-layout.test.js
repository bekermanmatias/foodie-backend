const test = require("node:test");
const assert = require("node:assert/strict");
const { Prisma } = require("@prisma/client");
const { FloorPlansController } = require("../dist/modules/floor-plans/floor-plans.controller");
const { FloorPlansService } = require("../dist/modules/floor-plans/floor-plans.service");

const user = { scope: "restaurant", restaurantId: "restaurant-1" };
const table = (id, label) => ({
  id, label, shape: "round", seats: 4, x: 0, y: 0, width: 112, height: 112,
  rotation: 0, isReservable: true, zoneId: null, metadata: null,
  isActive: true, reservationLinks: []
});
const layout = (tables, combinations = []) => ({ zones: [], items: [], tables, combinations });
const combo = (parentTableId, childTableId, id = "combo-1") => ({ id, parentTableId, childTableId, combinedSeats: 8 });

test("saves a changed combination after a table is removed", async () => {
  const calls = [];
  const tx = {
    reservation: { findMany: async () => [] },
    serviceState: { findMany: async () => [] },
    table: {
      findMany: async () => [table("56", "56"), table("55", "55"), table("54", "54")],
      deleteMany: async (query) => { calls.push(["deleteTables", query]); },
      updateMany: async () => {},
      upsert: async () => {}
    },
    floorPlanItem: { findMany: async () => [], deleteMany: async () => {}, upsert: async () => {} },
    roomZone: { findMany: async () => [], deleteMany: async () => {}, upsert: async () => {} },
    tableCombination: {
      deleteMany: async () => { calls.push(["deleteCombinations"]); },
      createMany: async (query) => { calls.push(["createCombinations", query.data]); }
    },
    room: { findUnique: async () => ({ id: "gallery" }) }
  };
  const prisma = {
    room: { findFirst: async () => ({ id: "gallery", branch: { timezone: "America/Argentina/Buenos_Aires" } }) },
    $transaction: async (operation, options) => {
      assert.equal(options.timeout, 30000);
      return operation(tx);
    },
    restaurantCustomization: { upsert: async () => {} }
  };
  const service = new FloorPlansService(prisma, { publish: () => {} });
  const result = await service.replaceLayout(user, "gallery", layout([table("56", "56"), table("55", "55")], [combo("56", "55")]));

  assert.equal(result.id, "gallery");
  assert.deepEqual(calls.find(([name]) => name === "deleteTables")[1].where.id.in, ["54"]);
  assert.deepEqual(calls.find(([name]) => name === "createCombinations")[1][0].parentTableId, "55");
  assert.deepEqual(calls.find(([name]) => name === "createCombinations")[1][0].childTableId, "56");
});

test("reports invalid or stale combinations as client errors", async () => {
  const service = new FloorPlansService({}, {});
  await assert.rejects(
    service.replaceLayout(user, "gallery", layout([table("56", "56")], [combo("56", "54")])),
    (error) => error.status === 409 && error.message.includes("eliminada")
  );
  await assert.rejects(
    service.replaceLayout(user, "gallery", layout([table("56", "56"), table("55", "55")], [combo("56", "55"), combo("55", "56", "combo-2")])),
    (error) => error.status === 409 && error.message.includes("repetida")
  );
  const controller = new FloorPlansController({});
  assert.throws(() => controller.replaceLayout("gallery", { tables: [] }, user), (error) => error.status === 400);
});

test("explains when a removed table still reserves its old number", async () => {
  const oldTable = { ...table("old-56", "56"), isActive: false, reservationLinks: [{ id: "past-reservation" }] };
  const prisma = {
    room: { findFirst: async () => ({ id: "gallery", branch: { timezone: "America/Argentina/Buenos_Aires" } }) },
    $transaction: async (operation) => operation({
      table: { findMany: async () => [oldTable] },
      reservation: { findMany: async () => [] },
      serviceState: { findMany: async () => [] }
    })
  };
  const service = new FloorPlansService(prisma, {});
  await assert.rejects(
    service.replaceLayout(user, "gallery", layout([table("new-56", "56")])),
    (error) => error.status === 409 && error.message.includes("reservas anteriores")
  );
});

test("converts database conflicts and slow transactions to actionable responses", async () => {
  for (const [code, status] of [["P2002", 409], ["P2028", 503]]) {
    const prisma = {
      room: { findFirst: async () => ({ id: "gallery", branch: { timezone: "America/Argentina/Buenos_Aires" } }) },
      $transaction: async () => {
        throw new Prisma.PrismaClientKnownRequestError("database error", { code, clientVersion: "5.22.0" });
      }
    };
    const service = new FloorPlansService(prisma, {});
    await assert.rejects(service.replaceLayout(user, "gallery", layout([table("56", "56")])), (error) => error.status === status);
  }
});
