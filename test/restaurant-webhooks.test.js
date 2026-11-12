const test = require("node:test");
const assert = require("node:assert/strict");
const { restaurantWebhook } = require("../dist/common/restaurant-webhooks");

const demo = "cmw2g2za00027482q7kv3cujd";
const estilo = "cmougo5l70001e04moof2uvls";
const demoChannel = "1105616579311982";
const estiloChannel = "1357479224108088";

test("built-in webhooks only accept the corresponding restaurant and channel", () => {
  assert.match(restaurantWebhook("giftCard", demo, demoChannel), /foodie-gift-card-enviar-demo-matias-v1$/);
  assert.match(restaurantWebhook("depositConfirmation", demo, demoChannel), /foodie-deposit-confirmation-demo-matias-v1$/);
  assert.equal(restaurantWebhook("giftCard", demo, null), undefined);
  assert.equal(restaurantWebhook("giftCard", demo, estiloChannel), undefined);
  assert.equal(restaurantWebhook("depositConfirmation", estilo, demoChannel), undefined);
  assert.equal(restaurantWebhook("giftCard", "other", demoChannel), undefined);
});

test("Estilo Campo legacy settings do not become a fallback for other restaurants", () => {
  const gift = process.env.N8N_GIFT_CARD_SEND_WEBHOOK_URL;
  const deposits = process.env.N8N_DEPOSIT_CONFIRMATION_WEBHOOK_URL;
  try {
    process.env.N8N_GIFT_CARD_SEND_WEBHOOK_URL = "https://example.test/gift";
    process.env.N8N_DEPOSIT_CONFIRMATION_WEBHOOK_URL = "https://example.test/deposits";
    assert.equal(restaurantWebhook("giftCard", estilo, estiloChannel), "https://example.test/gift");
    assert.equal(restaurantWebhook("depositConfirmation", estilo, estiloChannel), "https://example.test/deposits");
    assert.equal(restaurantWebhook("giftCard", "other", estiloChannel), undefined);
    assert.equal(restaurantWebhook("depositConfirmation", "other", "unknown"), undefined);
  } finally {
    if (gift === undefined) delete process.env.N8N_GIFT_CARD_SEND_WEBHOOK_URL; else process.env.N8N_GIFT_CARD_SEND_WEBHOOK_URL = gift;
    if (deposits === undefined) delete process.env.N8N_DEPOSIT_CONFIRMATION_WEBHOOK_URL; else process.env.N8N_DEPOSIT_CONFIRMATION_WEBHOOK_URL = deposits;
  }
});

test("additional routes require an explicit and unique channel for the restaurant", () => {
  const previous = process.env.N8N_RESTAURANT_WEBHOOKS;
  try {
    const config = { channelId: "other-channel", giftCard: "https://example.test/other" };
    process.env.N8N_RESTAURANT_WEBHOOKS = JSON.stringify({ other: config });
    assert.equal(restaurantWebhook("giftCard", "other", "other-channel"), config.giftCard);
    assert.equal(restaurantWebhook("giftCard", "other", "wrong"), undefined);
    assert.equal(restaurantWebhook("depositConfirmation", "other", "other-channel"), undefined);
    process.env.N8N_RESTAURANT_WEBHOOKS = JSON.stringify({ other: config, another: config });
    assert.equal(restaurantWebhook("giftCard", "other", "other-channel"), undefined);
  } finally {
    if (previous === undefined) delete process.env.N8N_RESTAURANT_WEBHOOKS; else process.env.N8N_RESTAURANT_WEBHOOKS = previous;
  }
});
