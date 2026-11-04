const test = require("node:test");
const assert = require("node:assert/strict");
const { restaurantWebhook } = require("../dist/common/restaurant-webhooks");
test("Matias test channel uses separate gift card and confirmation webhooks", () => {
  assert.match(restaurantWebhook("giftCard", "1105616579311982"), /foodie-gift-card-enviar-demo-matias-v1$/);
  assert.match(restaurantWebhook("depositConfirmation", "1105616579311982"), /foodie-deposit-confirmation-demo-matias-v1$/);
});
test("other channels retain their configured production routing", () => {
  const gift = process.env.N8N_GIFT_CARD_SEND_WEBHOOK_URL;
  const deposits = process.env.N8N_DEPOSIT_CONFIRMATION_WEBHOOK_URL;
  try {
    process.env.N8N_GIFT_CARD_SEND_WEBHOOK_URL = "https://example.test/gift";
    process.env.N8N_DEPOSIT_CONFIRMATION_WEBHOOK_URL = "https://example.test/deposits";
    assert.equal(restaurantWebhook("giftCard", "other"), "https://example.test/gift");
    assert.equal(restaurantWebhook("depositConfirmation", "other"), "https://example.test/deposits");
    assert.equal(restaurantWebhook("giftCard", null), "https://example.test/gift");
  } finally {
    if (gift === undefined) delete process.env.N8N_GIFT_CARD_SEND_WEBHOOK_URL; else process.env.N8N_GIFT_CARD_SEND_WEBHOOK_URL = gift;
    if (deposits === undefined) delete process.env.N8N_DEPOSIT_CONFIRMATION_WEBHOOK_URL; else process.env.N8N_DEPOSIT_CONFIRMATION_WEBHOOK_URL = deposits;
  }
});
