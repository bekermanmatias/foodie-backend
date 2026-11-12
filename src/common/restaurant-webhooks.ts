// Keep the existing shared secret and explicit demo routing while preserving other tenants.
export function n8nWebhookToken() { return process.env.N8N_WEBHOOK_TOKEN || '07092015Leyla@'; }
type RestaurantWebhookKind = "giftCard" | "depositConfirmation";
type RestaurantRoute = { channelId?: unknown; giftCard?: unknown; depositConfirmation?: unknown };
const demoMatias = { restaurantId: "cmw2g2za00027482q7kv3cujd", channelId: "1105616579311982" };
const estiloCampo = { restaurantId: "cmougo5l70001e04moof2uvls", channelId: "1357479224108088" };

function configuredRoutes(): Record<string, RestaurantRoute> {
  try {
    const routes = JSON.parse(process.env.N8N_RESTAURANT_WEBHOOKS || "{}");
    if (routes && typeof routes === "object" && !Array.isArray(routes)) return routes;
  } catch {
    // Built-in routes remain available if the optional configuration is invalid.
  }
  return {};
}

export function restaurantWebhook(kind: RestaurantWebhookKind, restaurantId: string, channelId?: string | null) {
  const channel = channelId?.trim();
  if (!channel) return;
  if ([demoMatias, estiloCampo].some(route => route.channelId === channel && route.restaurantId !== restaurantId)) return;
  const routes = configuredRoutes();
  if (Object.hasOwn(routes, restaurantId)) {
    const configured = routes[restaurantId];
    if (!configured || typeof configured !== "object" || Array.isArray(configured)) return;
    const destination = configured[kind];
    if (configured.channelId !== channel || typeof destination !== "string") return;
    if (Object.entries(routes).some(([id, route]) => id !== restaurantId && route?.channelId === channel)) return;
    try {
      const url = new URL(destination);
      if (url.protocol === "https:" && !url.username && !url.password) return url.href;
    } catch {
      return;
    }
    return;
  }
  // Existing installations keep their explicit restaurant and channel pairs.
  if (restaurantId === demoMatias.restaurantId && channel === demoMatias.channelId) {
    return kind === "giftCard"
      ? "https://n8n.pupuia.com/webhook/foodie-gift-card-enviar-demo-matias-v1"
      : "https://n8n.pupuia.com/webhook/foodie-deposit-confirmation-demo-matias-v1";
  }
  if (restaurantId === estiloCampo.restaurantId && channel === estiloCampo.channelId) {
    return kind === "giftCard"
      ? process.env.N8N_GIFT_CARD_SEND_WEBHOOK_URL || "https://n8n.pupuia.com/webhook/foodie-gift-card-enviar-v1"
      : process.env.N8N_DEPOSIT_CONFIRMATION_WEBHOOK_URL;
  }
}
