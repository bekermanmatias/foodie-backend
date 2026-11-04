const test = require("node:test");
const assert = require("node:assert/strict");
const { settingsSchema, calculateDeposit } = require("../dist/modules/deposits/deposit-rules");
const { verifyProofContent } = require("../dist/modules/deposits/proof-storage.service");
const { resolveFeatures } = require("../dist/common/restaurant-features");
const settings = { reviewed: true, currency: "ARS", bankAlias: "test.alias", bankCbu: "", bankHolder: "Test", paymentHours: 24, rules: [
  { id: "general", label: "General", minPeople: 15, maxPeople: 20, eventId: null, mode: "fixed", amount: 100 },
  { id: "event", label: "Evento", minPeople: 1, maxPeople: null, eventId: "event1", mode: "per_person", amount: 10 }
] };
test("deposits are disabled by default and independent of inherited modules", () => {
  assert.equal(resolveFeatures({}).deposits, false);
  assert.equal(resolveFeatures({ deposits: true }).deposits, true);
  assert.equal(resolveFeatures({ deposits: true }).giftCards, true);
});
test("reviewed settings, tiers, event overrides and Decimal amounts", () => {
  assert.equal(calculateDeposit({ ...settings, reviewed: false }, 16), null);
  assert.equal(calculateDeposit(settings, 14), null);
  assert.equal(calculateDeposit(settings, 16).requiredAmount.toString(), "100");
  assert.equal(calculateDeposit(settings, 16, "event1").requiredAmount.toString(), "160");
  assert.equal(calculateDeposit(settings, 21), null);
  const result = calculateDeposit(settings, 16);
  settings.bankAlias = "changed.alias";
  assert.equal(result.ruleSnapshot.bankAlias, "test.alias");
});
test("incomplete bank instructions and overlapping rules cannot be reviewed", () => {
  assert.equal(settingsSchema.safeParse({ ...settings, bankAlias: "", bankCbu: "" }).success, false);
  assert.equal(settingsSchema.safeParse({ ...settings, rules: [...settings.rules, { ...settings.rules[0], id: "overlap" }] }).success, false);
  assert.equal(settingsSchema.safeParse({ ...settings, paymentHours: -1 }).success, false);
});
test("proof validation checks actual content and size", () => {
  assert.doesNotThrow(() => verifyProofContent(Buffer.from("%PDF-1.4\nTest"), "application/pdf"));
  assert.throws(() => verifyProofContent(Buffer.from("<script>evil()</script>"), "application/pdf"));
  assert.throws(() => verifyProofContent(Buffer.alloc(11 * 1024 * 1024), "application/pdf"));
  assert.throws(() => verifyProofContent(Buffer.from("GIF89a"), "image/png"));
});
