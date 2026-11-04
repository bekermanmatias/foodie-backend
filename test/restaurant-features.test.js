const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveFeatures, requireFeature, requireExternalAccess } = require("../dist/common/restaurant-features");
const { RestaurantFeaturesController } = require("../dist/modules/restaurants/restaurant-features.controller");
const { GiftCardsService } = require("../dist/modules/gift-cards/gift-cards.service");
const { NotificationsService } = require("../dist/modules/notifications/notifications.service");
const { RolesGuard } = require("../dist/common/auth/roles.guard");
const { Reflector } = require("@nestjs/core");

function fixture() {
  const rows = { demo: { isDemo: true, featureOverrides: {} }, real: { isDemo: false, featureOverrides: {} } };
  const audits = [];
  const prisma = {
    restaurant: {
      findUnique: async ({ where }) => structuredClone(rows[where.id] || null),
      update: async ({ where, data }) => Object.assign(rows[where.id], structuredClone(data))
    },
    restaurantCustomization: { upsert: async () => ({}) },
    auditLog: { create: async ({ data }) => audits.push(structuredClone(data)) },
    $queryRaw: async () => [],
    $transaction: async (fn) => fn(prisma)
  };
  return { prisma, rows, audits, controller: new RestaurantFeaturesController(prisma) };
}
const actor = { sub: "admin", scope: "platform", role: "platform_admin" };
const owner = (restaurantId) => ({ sub: "owner", scope: "restaurant", role: "restaurant_owner", restaurantId });

test("current modules remain on; future definitions default off and previews depend on modules", () => {
  assert.deepEqual(resolveFeatures({}), { deposits: false, giftCards: true, notifications: true });
  const catalog = [{ key: "module", group: "module" }, { key: "preview", group: "preview", module: "module" }];
  assert.deepEqual(resolveFeatures({}, catalog), { module: false, preview: false });
  assert.equal(resolveFeatures({ preview: true }, catalog).preview, false);
  assert.equal(resolveFeatures({ module: true, preview: true }, catalog).preview, true);
  assert.equal(resolveFeatures({ unknown: true }).unknown, undefined);
});

test("PATCH merges only selected options, audits before/after, and isolates restaurants", async () => {
  const f = fixture();
  await f.controller.patch("demo", { overrides: { giftCards: false } }, actor);
  await f.controller.patch("demo", { overrides: { notifications: false } }, actor);
  assert.deepEqual((await f.controller.get("demo")).enabled, { deposits: false, giftCards: false, notifications: false });
  assert.deepEqual((await f.controller.get("real")).enabled, { deposits: false, giftCards: true, notifications: true });
  assert.equal(f.audits[0].platformUserId, "admin");
  assert.deepEqual(f.audits[0].metadata.before.featureOverrides, {});
  assert.deepEqual(f.audits[0].metadata.after.featureOverrides, { giftCards: false });
  await f.controller.patch("demo", { isDemo: false }, actor);
  assert.equal((await f.controller.get("demo")).isDemo, false);
  assert.equal((await f.controller.get("demo")).enabled.giftCards, false);
});

test("unknown flags, unknown fields and invalid types return 400 before writes", async () => {
  const f = fixture();
  for (const body of [{ overrides: { invented: true } }, { overrides: { giftCards: "yes" } }, { restaurantId: "real" }, {}, { isDemo: "yes" }]) {
    await assert.rejects(f.controller.patch("demo", body, actor), (error) => error.getStatus() === 400);
  }
  assert.equal(f.audits.length, 0);
  await assert.rejects(f.controller.get("missing"), (error) => error.getStatus() === 404);
});

test("platform feature endpoints require platform_admin", () => {
  const guard = new RolesGuard(new Reflector());
  for (const role of ["restaurant_owner", "host", "restaurant_manager"]) {
    const context = { getHandler: () => RestaurantFeaturesController.prototype.patch, getClass: () => RestaurantFeaturesController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role, scope: "restaurant" } }) }) };
    assert.throws(() => guard.canActivate(context));
  }
});

test("disabled modules block service operations before accessing records and can be re-enabled", async () => {
  const f = fixture();
  await f.controller.patch("real", { overrides: { giftCards: false, notifications: false } }, actor);
  const giftCards = new GiftCardsService(f.prisma, {});
  const notifications = new NotificationsService(f.prisma, {});
  await assert.rejects(giftCards.listProducts(owner("real")), (error) => error.getResponse().code === "MODULE_DISABLED");
  await assert.rejects(notifications.list(owner("real"), { page: 1, pageSize: 25 }), (error) => error.getResponse().code === "MODULE_DISABLED");
  await assert.rejects(notifications.receiveOrder("real", {}), (error) => error.getResponse().code === "MODULE_DISABLED");
  await requireFeature(f.prisma, "demo", "giftCards");
  await f.controller.patch("real", { overrides: { giftCards: true } }, actor);
  await requireFeature(f.prisma, "real", "giftCards");
});

test("demo blocks webhook delivery before records, credentials or network are accessed", async () => {
  const f = fixture();
  await assert.rejects(new GiftCardsService(f.prisma, {}).sendGiftCard(owner("demo"), "order"), (error) => error.getResponse().code === "DEMO_EXTERNAL_BLOCKED");
  await assert.rejects(requireExternalAccess(f.prisma, "demo"), (error) => error.getResponse().code === "DEMO_EXTERNAL_BLOCKED");
  await requireExternalAccess(f.prisma, "real");
});

test("API-key gift card access checks the token restaurant and blocks disabled modules and demo", async () => {
  const f = fixture();
  let restaurantId = "demo";
  f.prisma.integrationToken = { findFirst: async () => ({ restaurantId }) };
  const service = new GiftCardsService(f.prisma, {});
  await assert.rejects(service.listExternalProducts("key"), (error) => error.getResponse().code === "DEMO_EXTERNAL_BLOCKED");
  restaurantId = "real";
  await f.controller.patch("real", { overrides: { giftCards: false } }, actor);
  await assert.rejects(service.listExternalProducts("key"), (error) => error.getResponse().code === "MODULE_DISABLED");
});
