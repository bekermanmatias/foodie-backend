# Compra de varias Gift Cards

## Orden de publicación

1. Desplegar `foodie-backend` con `bash scripts/deploy-production.sh`. El script crea un respaldo y ejecuta `prisma migrate deploy` antes de recargar la aplicación. La migración conserva las órdenes existentes con `quantity = 1` y `unitAmount = amount`.
2. Comprobar que `/v1/health` responde y que una orden existente aparece con `quantity: 1`, `unitAmount` y `giftCards[]`.
3. Avisar que el backend está desplegado. Recién entonces actualizar y activar el Core de n8n con `n8n-foodie/FOODIE _ 02 AI Core _ V6.7.25 _ MULTI GIFT CARDS.json`. El workflow existente que invoca WhatsApp Realtime debe conservar su ID; no activar un clon independiente.
4. Desplegar `foodie-frontend` manualmente. La pantalla de órdenes presenta cada tarjeta, sus archivos, estado de canje y estado de envío.

## Contrato externo

- `POST /v1/external/gift-cards/checkouts`: producto, tipo, cantidad de 1 a 20, nombre y teléfono del comprador. Devuelve `checkout` con precio unitario, total y vencimiento. Acepta `Idempotency-Key`.
- `GET /v1/external/gift-cards/checkouts/pending?phone=...`: devuelve la compra pendiente vigente para ese teléfono.
- `POST /v1/external/gift-cards/checkouts/:id/confirm`: body `{ "purchaserPhone": "..." }` e `Idempotency-Key` del mensaje de confirmación. Crea una sola orden o devuelve la misma ante confirmaciones repetidas. Si cambió el producto o sus condiciones, devuelve `requiresReconfirmation: true` y una propuesta nueva que requiere otro “sí”.
- Las órdenes incluyen `quantity`, `unitAmount` y `giftCards[]`. La propiedad `giftCard` sigue disponible para órdenes de una sola tarjeta.

El pago se confirma una vez por el total de la orden. La confirmación emite tarjetas independientes. El botón **Enviar** transmite solo las tarjetas activas pendientes y registra cada éxito; si se interrumpe, permite reintentar las restantes.
