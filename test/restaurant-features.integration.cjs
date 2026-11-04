// Run only against an empty disposable database after prisma db push.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
const { RestaurantFeaturesController } = require("../dist/modules/restaurants/restaurant-features.controller");
const { GiftCardsService } = require("../dist/modules/gift-cards/gift-cards.service");
const { requireExternalAccess } = require("../dist/common/restaurant-features");

const url = new URL(process.env.FOODIE_FEATURES_TEST_DATABASE_URL || "http://invalid");
if (url.hostname !== "127.0.0.1" || url.port !== "5437" || url.pathname !== "/foodie_features_check") {
  throw new Error("Requires disposable 127.0.0.1:5437/foodie_features_check database");
}
const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
async function main() {
  assert.equal(await prisma.restaurant.count(), 0, "Use an empty disposable database");
  const existing = await prisma.restaurant.create({ data: { name: "Existing", slug: "existing" } });
  // Exercise the actual additive migration with a pre-existing restaurant.
  await prisma.$executeRawUnsafe('ALTER TABLE "Restaurant" DROP COLUMN "isDemo", DROP COLUMN "featureOverrides"');
  await prisma.$executeRawUnsafe(fs.readFileSync(path.join(__dirname, "../prisma/migrations/20261104_restaurant_features/migration.sql"), "utf8"));
  const controller = new RestaurantFeaturesController(prisma);
  assert.deepEqual((await controller.get(existing.id)).enabled, { giftCards: true, notifications: true });
  assert.equal((await controller.get(existing.id)).isDemo, false);
  const demo = await prisma.restaurant.create({ data: { name: "Demo", slug: "demo" } });
  const admin = await prisma.platformUser.create({ data: { fullName: "Admin", email: "admin@features.test", passwordHash: "test-only", role: "platform_admin" } });
  const actor = { sub: admin.id, scope: "platform", role: "platform_admin" };
  await controller.patch(demo.id, { isDemo: true }, actor);
  const gift = await prisma.giftCardProduct.create({ data: { restaurantId: demo.id, name: "Test gift", description: "Local test", type: "OPEN_AMOUNT", validityDays: 30 } });
  // Concurrent partial PATCH requests must preserve both changes.
  await Promise.all([
    controller.patch(demo.id, { overrides: { giftCards: false } }, actor),
    controller.patch(demo.id, { overrides: { notifications: false } }, actor)
  ]);
  assert.deepEqual((await controller.get(demo.id)).enabled, { giftCards: false, notifications: false });
  assert.deepEqual((await controller.get(existing.id)).enabled, { giftCards: true, notifications: true });
  const service = new GiftCardsService(prisma, {});
  const owner = { sub: "owner", restaurantId: demo.id, scope: "restaurant", role: "restaurant_owner" };
  await assert.rejects(service.listProducts(owner), (error) => error.getResponse().code === "MODULE_DISABLED");
  await controller.patch(demo.id, { overrides: { giftCards: true } }, actor);
  assert.equal((await service.listProducts(owner))[0].id, gift.id, "Data survives disable/re-enable");
  await assert.rejects(service.sendGiftCard(owner, "order"), (error) => error.getResponse().code === "DEMO_EXTERNAL_BLOCKED");
  await assert.rejects(requireExternalAccess(prisma, demo.id), (error) => error.getResponse().code === "DEMO_EXTERNAL_BLOCKED");
  await requireExternalAccess(prisma, existing.id);
  // Audit failure must roll back the settings change.
  await assert.rejects(controller.patch(demo.id, { overrides: { giftCards: false } }, { ...actor, sub: "missing-admin" }));
  assert.equal((await controller.get(demo.id)).enabled.giftCards, true);
  const logs = await prisma.auditLog.findMany({ where: { restaurantId: demo.id }, orderBy: { createdAt: "asc" } });
  assert.equal(logs.length, 4);
  assert.equal(logs[0].metadata.before.isDemo, false);
  assert.equal(logs[0].metadata.after.isDemo, true);
  await prisma.restaurant.update({ where: { id: existing.id }, data: { chatClientId: "external-account" } });
  await assert.rejects(controller.patch(existing.id, { isDemo: true }, actor), (error) => error.getResponse().code === "DEMO_HAS_CONNECTIONS");
  assert.equal((await controller.get(existing.id)).isDemo, false);
  console.log("PASS: actual migration defaults, persistence, concurrent PATCH, tenant isolation, audit rollback, retained Gift Cards and demo egress blocks");
}
main().finally(() => prisma.$disconnect()).catch((error) => { console.error(error); process.exitCode = 1; });
