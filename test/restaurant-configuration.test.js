const test = require("node:test");
const assert = require("node:assert/strict");
const { z } = require("zod");
const { RestaurantConfigurationController } = require("../dist/modules/restaurant-configuration/restaurant-configuration.controller");
const { RestaurantConfigurationService } = require("../dist/modules/restaurant-configuration/restaurant-configuration.service");

const user = { sub: "owner", scope: "restaurant", role: "restaurant_owner", restaurantId: "restaurant-1" };
const cuid = (index) => `c${String(index).padStart(24, "0")}`;
const legacyId = "imported-faq-26";
const faq = (id, index = 0, restaurantId = user.restaurantId) => ({
  id, restaurantId, topic: "General", question: `Pregunta ${index + 1}?`, answer: "Respuesta de prueba", isActive: true, position: index
});
const promotion = { title: "Promoción de prueba", category: "promotion", content: "Descuento de prueba para esta semana", isActive: true, validityType: "indefinite", startsAt: null, endsAt: null };
const wire = (value) => JSON.parse(JSON.stringify(value));

// Stateful Prisma double: exercises the real controller and service without a database connection.
function setup(ids = Array.from({ length: 26 }, (_, index) => index === 25 ? legacyId : cuid(index + 1))) {
  let state = {
    faqs: [...ids.map((id, index) => faq(id, index)), faq("other-restaurant-faq", 0, "restaurant-2")],
    updates: [], customization: null, booking: null
  };
  let transactions = 0;
  let created = 100;
  const audits = [];
  const models = (getState) => {
    const collection = (key) => ({
      findMany: async ({ where, select }) => getState()[key]
        .filter((row) => row.restaurantId === where.restaurantId)
        .sort((a, b) => a.position - b.position)
        .map((row) => select ? { id: row.id } : structuredClone(row)),
      deleteMany: async ({ where }) => {
        getState()[key] = getState()[key].filter((row) => row.restaurantId !== where.restaurantId || where.id?.notIn.includes(row.id));
      },
      update: async ({ where, data }) => {
        const row = getState()[key].find((item) => item.id === where.id);
        assert.ok(row, "cannot update a missing record");
        Object.assign(row, data);
      },
      create: async ({ data }) => {
        const row = { id: cuid(++created), ...data };
        getState()[key].push(row);
        return structuredClone(row);
      }
    });
    return {
      restaurantFaq: collection("faqs"), restaurantAssistantUpdate: collection("updates"),
      restaurantSpecial: { findMany: async () => [], deleteMany: async () => {} },
      branch: { findMany: async () => [] },
      branchOpeningHour: { deleteMany: async () => {}, createMany: async () => {} },
      restaurantCustomization: {
        findUnique: async () => structuredClone(getState().customization),
        upsert: async ({ create, update }) => { getState().customization = getState().customization ? { ...getState().customization, ...update } : { ...create }; }
      },
      onlineBookingSettings: {
        findUnique: async () => structuredClone(getState().booking),
        upsert: async ({ create, update }) => { getState().booking = getState().booking ? { ...getState().booking, ...update } : { ...create }; }
      }
    };
  };
  const prisma = {
    ...models(() => state),
    $transaction: async (callback) => {
      transactions++;
      const pending = structuredClone(state);
      await callback(models(() => pending));
      state = pending;
    }
  };
  const service = new RestaurantConfigurationService(prisma, { log: async (entry) => audits.push(entry) });
  return {
    controller: new RestaurantConfigurationController(service),
    snapshot: () => structuredClone(state), transactions: () => transactions, audits
  };
}

test("GET -> JSON -> PUT saves a promotion with 26 FAQs including the original non-CUID ID", async () => {
  const fixture = setup();
  const original = wire(await fixture.controller.getPersonalize(user));
  assert.equal(original.faqs.length, 26);
  assert.equal(original.faqs[25].id, legacyId);
  assert.equal(z.string().cuid().safeParse(original.faqs[25].id).success, false);
  const payload = { ...original, assistantUpdates: [promotion] };
  const saved = await fixture.controller.savePersonalize(user, payload);
  const reloaded = wire(await fixture.controller.getPersonalize(user));
  assert.deepEqual(reloaded, wire(saved));
  assert.deepEqual(reloaded.faqs, original.faqs);
  assert.equal(reloaded.assistantUpdates[0].category, "promotion");
  assert.equal(reloaded.assistantUpdates[0].content, promotion.content);
  await fixture.controller.savePersonalize(user, reloaded);
  assert.equal(fixture.snapshot().updates.length, 1, "repeat save must not duplicate the promotion");
  assert.equal(fixture.audits.length, 2);
});

test("edit, reorder, delete and create FAQs without replacing existing IDs or touching another restaurant", async () => {
  const fixture = setup();
  const config = wire(await fixture.controller.getPersonalize(user));
  const removedId = config.faqs[0].id;
  config.faqs.shift();
  config.faqs.reverse();
  config.faqs[0].answer = "Respuesta editada";
  config.faqs.push({ topic: "Nuevo tema", question: "Nueva pregunta?", answer: "Nueva respuesta", isActive: false });
  const saved = await fixture.controller.savePersonalize(user, config);
  assert.equal(saved.faqs.length, 26);
  assert.equal(saved.faqs[0].id, legacyId);
  assert.equal(saved.faqs[0].answer, "Respuesta editada");
  assert.deepEqual(saved.faqs.slice(0, -1).map((row) => row.id), config.faqs.slice(0, -1).map((row) => row.id));
  assert.deepEqual(saved.faqs.map((row) => row.position), Array.from({ length: 26 }, (_, index) => index));
  assert.equal(saved.faqs.some((row) => row.id === removedId), false);
  assert.equal(z.string().cuid().safeParse(saved.faqs[25].id).success, true);
  assert.equal(saved.faqs[25].isActive, false);
  await fixture.controller.savePersonalize(user, wire(saved));
  assert.deepEqual(wire(await fixture.controller.getPersonalize(user)).faqs, wire(saved).faqs);
  assert.deepEqual(fixture.snapshot().faqs.find((row) => row.restaurantId === "restaurant-2"), faq("other-restaurant-faq", 0, "restaurant-2"));
});

test("existing CUID FAQs still round-trip unchanged", async () => {
  const fixture = setup([cuid(1), cuid(2)]);
  const config = wire(await fixture.controller.getPersonalize(user));
  const saved = await fixture.controller.savePersonalize(user, config);
  assert.deepEqual(wire(saved).faqs, config.faqs);
});

for (const id of ["", "   ", null, 42]) {
  test(`invalid FAQ ID ${JSON.stringify(id)} is rejected before any write`, async () => {
    const fixture = setup();
    const before = fixture.snapshot();
    const config = wire(await fixture.controller.getPersonalize(user));
    config.faqs[25].id = id;
    config.assistantUpdates = [promotion];
    assert.throws(() => fixture.controller.savePersonalize(user, config), (error) => {
      assert.equal(error.getStatus(), 400);
      assert.ok(error.getResponse().issues.some((issue) => issue.path === "faqs.25.id"));
      return true;
    });
    assert.deepEqual(fixture.snapshot(), before);
    assert.equal(fixture.transactions(), 0);
    assert.equal(fixture.audits.length, 0);
  });
}

for (const id of ["unknown-faq", "other-restaurant-faq"]) {
  test(`FAQ ID ${id} is rejected by ownership validation before any write`, async () => {
    const fixture = setup();
    const before = fixture.snapshot();
    const config = wire(await fixture.controller.getPersonalize(user));
    config.faqs[25].id = id;
    config.assistantUpdates = [promotion];
    await assert.rejects(fixture.controller.savePersonalize(user, config), (error) => {
      assert.equal(error.getStatus(), 403);
      assert.equal(error.message, "FAQ inválida");
      return true;
    });
    assert.deepEqual(fixture.snapshot(), before);
    assert.equal(fixture.transactions(), 0);
    assert.equal(fixture.audits.length, 0);
  });
}

test("non-CUID special, assistant update and branch IDs remain invalid", async () => {
  const fixture = setup([cuid(1)]);
  const config = wire(await fixture.controller.getPersonalize(user));
  const cases = [
    { ...config, assistantUpdates: [{ ...promotion, id: "legacy-update" }] },
    { ...config, specials: [{ id: "legacy-special", title: "Especial", isActive: true, startsAt: "2026-11-04", endsAt: "2026-11-05" }] },
    { ...config, branches: [{ id: "legacy-branch", openingHours: [] }] }
  ];
  for (const payload of cases) {
    assert.throws(() => fixture.controller.savePersonalize(user, payload), (error) => error.getStatus() === 400);
  }
  assert.equal(fixture.transactions(), 0);
});
