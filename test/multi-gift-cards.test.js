const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Prisma } = require('@prisma/client');
const { GiftCardsService } = require('../dist/modules/gift-cards/gift-cards.service');
const { createHash } = require('node:crypto');

const decimal = (value) => new Prisma.Decimal(value);
const product = () => ({ id: 'product-1', restaurantId: 'restaurant-1', type: 'FIXED_MENU', name: 'Menú del Campo', description: 'Dos personas', price: decimal(132000), partySize: 2, currency: 'ARS', validityDays: 60, isActive: true, paymentAlias: 'alias.test', paymentCbu: null, paymentHolder: null });
const buyer = { productId: 'product-1', type: 'FIXED_MENU', purchaserName: 'Ayelén Rojas', purchaserPhone: '5491112345678' };
const audit = { log: async () => {} };
const owner = { sub: 'owner-1', scope: 'restaurant', restaurantId: 'restaurant-1', role: 'restaurant_owner' };

test('refreshing legacy artwork is scoped to the owner and preserves the issued card', async () => {
  const code = 'ABCDEFGH';
  const date = new Date('2026-12-31');
  const card = {
    id: 'card-1', restaurantId: owner.restaurantId, orderId: 'order-1', displayCode: code,
    status: 'ACTIVE', validFrom: date, validUntil: date, sentAt: date,
    imageUrl: '/uploads/gift-cards/restaurant-1/order-1/gift-card-ABCDEFGH.png',
    order: { id: 'order-1', restaurantId: owner.restaurantId, restaurant: { name: 'Demo Foodie' } }
  };
  const assets = { imageUrl: '/new-card.png', pdfUrl: '/new-card.pdf' };
  const service = new GiftCardsService({
    restaurant: { findUnique: async () => ({ featureOverrides: {} }) },
    giftCard: {
      findFirst: async ({ where }) => where.id === card.id && where.restaurantId === card.restaurantId ? card : null,
      update: async ({ where, data }) => {
        assert.deepEqual(where, { id: card.id, restaurantId: owner.restaurantId });
        assert.deepEqual(data, assets);
        return { ...card, ...data };
      }
    }
  }, audit);
  service.generateAssets = async (order, displayCode, validUntil) => {
    assert.equal(order.restaurant.name, 'Demo Foodie');
    assert.equal(displayCode, code);
    assert.equal(validUntil, date);
    return assets;
  };
  await assert.rejects(service.refreshArtwork({ ...owner, restaurantId: 'another-restaurant' }, card.id), /no encontrada/);
  const updated = await service.refreshArtwork(owner, card.id);
  assert.equal(updated.code, code);
  assert.equal(updated.sentAt, date);
  assert.equal(updated.needsArtworkUpdate, false);
});

test('quantity defaults to one and three cards have one total', async () => {
  const prisma = { restaurant: { findUnique: async () => ({ isDemo: false, featureOverrides: {} }) }, giftCardProduct: { findFirst: async () => product() } };
  const service = new GiftCardsService(prisma, audit);
  const one = await service.resolveOrder('restaurant-1', buyer);
  const three = await service.resolveOrder('restaurant-1', { ...buyer, quantity: 3 });
  assert.equal(one.quantity, 1);
  assert.equal(Number(one.totalAmount), 132000);
  assert.equal(three.quantity, 3);
  assert.equal(Number(three.unitAmount), 132000);
  assert.equal(Number(three.totalAmount), 396000);
  await assert.rejects(service.resolveOrder('restaurant-1', { ...buyer, quantity: 21 }));
});

test('confirmation creates one order and repeated confirmation returns it', async () => {
  const quote = { id: 'checkout-1', restaurantId: 'restaurant-1', productId: 'product-1', product: product(), status: 'PENDING', expiresAt: new Date(Date.now() + 60000), type: 'FIXED_MENU', quantity: 3, unitAmount: decimal(132000), totalAmount: decimal(396000), currency: 'ARS', purchaserName: buyer.purchaserName, purchaserPhone: buyer.purchaserPhone, partySize: 2, recipientName: null, message: null, order: null };
  const orders = [];
  const prisma = { restaurant: { findUnique: async () => ({ isDemo: false, featureOverrides: {} }) },
    giftCardCheckout: { findFirst: async () => quote },
    $transaction: async (fn) => fn({
      giftCardCheckout: { updateMany: async () => { if (quote.status !== 'PENDING') return { count: 0 }; quote.status = 'CONFIRMED'; return { count: 1 }; } },
      giftCardOrder: { create: async ({ data }) => { const order = { id: 'order-1', status: 'PENDING_PAYMENT', paymentMethod: 'TRANSFER', ...data }; quote.order = order; orders.push(order); return order; }, findUnique: async () => quote.order },
    }),
  };
  const service = new GiftCardsService(prisma, audit);
  service.externalRestaurant = async () => 'restaurant-1';
  const first = await service.confirmExternal('key', quote.id, buyer.purchaserPhone);
  const second = await service.confirmExternal('key', quote.id, buyer.purchaserPhone);
  assert.equal(orders.length, 1);
  assert.equal(first.order.id, second.order.id);
  assert.equal(first.order.amount, 396000);
  assert.equal(first.order.quantity, 3);
});

test('price change produces a new proposal and requires another confirmation', async () => {
  const quote = { id: 'checkout-1', restaurantId: 'restaurant-1', productId: 'product-1', product: { ...product(), price: decimal(140000) }, status: 'PENDING', expiresAt: new Date(Date.now() + 60000), type: 'FIXED_MENU', quantity: 3, unitAmount: decimal(132000), totalAmount: decimal(396000), currency: 'ARS', purchaserName: buyer.purchaserName, purchaserPhone: buyer.purchaserPhone, partySize: 2, recipientName: null, message: null, order: null };
  const prisma = { restaurant: { findUnique: async () => ({ isDemo: false, featureOverrides: {} }) }, giftCardCheckout: { findFirst: async () => quote } };
  const service = new GiftCardsService(prisma, audit);
  service.externalRestaurant = async () => 'restaurant-1';
  service.prepareExternal = async (_key, input) => {
    assert.equal(input.quantity, 3);
    return { checkout: { id: 'checkout-2', quantity: 3, unitAmount: 140000, amount: 420000 } };
  };
  const result = await service.confirmExternal('key', quote.id, buyer.purchaserPhone);
  assert.equal(result.requiresReconfirmation, true);
  assert.equal(result.checkout.amount, 420000);
});

test('a repeated WhatsApp confirmation key cannot confirm a newer quote', async () => {
  const firstResponse = { order: { id: 'order-1', quantity: 3, amount: 396000 } };
  const prisma = { restaurant: { findUnique: async () => ({ isDemo: false, featureOverrides: {} }) },
    externalApiRequest: { findFirst: async () => ({ requestHash: createHash('sha256').update(buyer.purchaserPhone).digest('hex'), responseData: firstResponse }) },
  };
  const service = new GiftCardsService(prisma, audit);
  service.externalRestaurant = async () => 'restaurant-1';
  const repeated = await service.confirmExternal('key', 'newer-checkout', buyer.purchaserPhone, 'same-message');
  assert.deepEqual(repeated, firstResponse);
});

test('one payment issues three independent codes and cards', async () => {
  const order = { id: 'order-1', restaurantId: 'restaurant-1', productId: 'product-1', product: product(), type: 'FIXED_MENU', purchaserName: buyer.purchaserName, purchaserPhone: buyer.purchaserPhone, quantity: 3, unitAmount: decimal(132000), amount: decimal(396000), currency: 'ARS', paymentStatus: 'PENDING', giftCards: [] };
  const cards = [];
  const prisma = { restaurant: { findUnique: async () => ({ isDemo: false, featureOverrides: {} }) },
    giftCardOrder: { findFirst: async () => order },
    $transaction: async (fn) => fn({
      giftCardOrder: { updateMany: async () => { order.paymentStatus = 'CONFIRMED'; return { count: 1 }; } },
      giftCard: { create: async ({ data }) => { const card = { id: `card-${cards.length + 1}`, status: 'ACTIVE', createdAt: new Date(), issuedAt: new Date(), redeemedAt: null, sentAt: null, ...data }; cards.push(card); return card; } },
    }),
  };
  const service = new GiftCardsService(prisma, audit);
  service.generateAssets = async (_order, code) => ({ imageUrl: `/image-${code}.png`, pdfUrl: `/file-${code}.pdf` });
  const issued = await service.confirmPayment(owner, order.id, true);
  assert.equal(issued.giftCards.length, 3);
  assert.equal(new Set(issued.giftCards.map((card) => card.code)).size, 3);
  assert.deepEqual(cards.map((card) => Number(card.originalAmount)), [132000, 132000, 132000]);
  assert.equal(order.paymentStatus, 'CONFIRMED');
});

test('one-card payment keeps the legacy giftCard response', async () => {
  const order = { id: 'order-one', restaurantId: 'restaurant-1', productId: 'product-1', product: product(), type: 'FIXED_MENU', purchaserName: buyer.purchaserName, purchaserPhone: buyer.purchaserPhone, quantity: 1, unitAmount: decimal(132000), amount: decimal(132000), currency: 'ARS', paymentStatus: 'PENDING', giftCards: [] };
  const prisma = { restaurant: { findUnique: async () => ({ isDemo: false, featureOverrides: {} }) },
    giftCardOrder: { findFirst: async () => order },
    $transaction: async (fn) => fn({ giftCardOrder: { updateMany: async () => ({ count: 1 }) }, giftCard: { create: async ({ data }) => ({ id: 'card-one', status: 'ACTIVE', issuedAt: new Date(), sentAt: null, ...data }) } }),
  };
  const service = new GiftCardsService(prisma, audit);
  service.generateAssets = async () => ({ imageUrl: '/one.png', pdfUrl: '/one.pdf' });
  const result = await service.confirmPayment(owner, order.id, true);
  assert.equal(result.giftCards.length, 1);
  assert.equal(result.giftCard.code, result.giftCards[0].code);
});

test('cancelling one card keeps the other cards active', async () => {
  const cards = [1, 2, 3].map((i) => ({ id: `card-${i}`, orderId: 'order-1', restaurantId: 'restaurant-1', status: 'ACTIVE', redemptions: [], order: { status: 'PAID' } }));
  const prisma = { restaurant: { findUnique: async () => ({ isDemo: false, featureOverrides: {} }) },
    giftCard: { findFirst: async () => cards[0] },
    $transaction: async (fn) => fn({ giftCard: { updateMany: async ({ where }) => { cards.find((card) => card.id === where.id).status = 'CANCELLED'; return { count: 1 }; }, count: async () => cards.filter((card) => card.status !== 'CANCELLED').length }, giftCardOrder: { update: async () => { throw new Error('Order should stay paid'); } } }),
  };
  const service = new GiftCardsService(prisma, audit);
  const result = await service.cancelCard(owner, 'card-1');
  assert.equal(result.status, 'CANCELLED');
  assert.deepEqual(cards.map((card) => card.status), ['CANCELLED', 'ACTIVE', 'ACTIVE']);
});

test('partial send records successes and retry sends only pending cards', async () => {
  const cards = [1, 2, 3].map((i) => ({ id: `card-${i}`, displayCode: `CODE000${i}`, status: 'ACTIVE', imageUrl: `/card-${i}.png`, sentAt: null }));
  const order = { id: 'order-1', restaurantId: 'restaurant-1', purchaserPhone: buyer.purchaserPhone, quantity: 3, giftCards: cards, restaurant: { chatPhoneNumberId: 'phone-id' }, sentAt: null };
  const prisma = { restaurant: { findUnique: async () => ({ isDemo: false, featureOverrides: {} }) },
    giftCardOrder: { findFirst: async () => order, update: async ({ data }) => { order.sentAt = data.sentAt; return order; } },
    giftCard: { update: async ({ where, data }) => { cards.find((card) => card.id === where.id).sentAt = data.sentAt; }, count: async () => cards.filter((card) => card.sentAt).length },
  };
  const service = new GiftCardsService(prisma, audit);
  const originalFetch = global.fetch;
  const originalRoutes = process.env.N8N_RESTAURANT_WEBHOOKS;
  process.env.N8N_RESTAURANT_WEBHOOKS = JSON.stringify({ 'restaurant-1': { channelId: 'phone-id', giftCard: 'https://example.test/gift' } });
  const sentCodes = [];
  let failSecond = true;
  global.fetch = async (_url, options) => {
    const code = JSON.parse(options.body).code;
    sentCodes.push(code);
    if (code === 'CODE0002' && failSecond) return { ok: true, json: async () => ({ sent: false, reason: 'OUTSIDE_24H_WINDOW' }) };
    return { ok: true, json: async () => ({ sent: true }) };
  };
  try {
    order.restaurant.chatPhoneNumberId = null;
    await assert.rejects(service.sendGiftCard(owner, order.id), /Configurá el canal/);
    order.restaurant.chatPhoneNumberId = 'different-channel';
    await assert.rejects(service.sendGiftCard(owner, order.id), /Falta configurar el envío/);
    assert.deepEqual(sentCodes, []);
    order.restaurant.chatPhoneNumberId = 'phone-id';
    const partial = await service.sendGiftCard(owner, order.id);
    assert.equal(partial.sent, false);
    assert.equal(partial.sentCount, 1);
    assert.equal(order.sentAt, null);
    failSecond = false;
    const completed = await service.sendGiftCard(owner, order.id);
    assert.equal(completed.sent, true);
    assert.deepEqual(sentCodes, ['CODE0001', 'CODE0002', 'CODE0002', 'CODE0003']);
    assert.ok(cards.every((card) => card.sentAt));
    assert.ok(order.sentAt);
  } finally {
    global.fetch = originalFetch;
    if (originalRoutes === undefined) delete process.env.N8N_RESTAURANT_WEBHOOKS;
    else process.env.N8N_RESTAURANT_WEBHOOKS = originalRoutes;
  }
});
