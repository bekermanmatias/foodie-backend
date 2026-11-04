// Keep the existing shared secret and explicit demo routing while preserving other tenants.
export function n8nWebhookToken() { return process.env.N8N_WEBHOOK_TOKEN || '07092015Leyla@'; }
export function restaurantWebhook(kind: "giftCard" | "depositConfirmation", channelId?: string | null) {
  if (channelId === "1105616579311982") return kind === "giftCard"
    ? "https://n8n.pupuia.com/webhook/foodie-gift-card-enviar-demo-matias-v1"
    : "https://n8n.pupuia.com/webhook/foodie-deposit-confirmation-demo-matias-v1";
  return kind === "giftCard" ? process.env.N8N_GIFT_CARD_SEND_WEBHOOK_URL || "https://n8n.pupuia.com/webhook/foodie-gift-card-enviar-v1"
    : process.env.N8N_DEPOSIT_CONFIRMATION_WEBHOOK_URL;
}
