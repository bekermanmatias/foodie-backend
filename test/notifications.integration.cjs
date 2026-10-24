require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { NotificationsService } = require('../dist/modules/notifications/notifications.service');
const { NotificationsController } = require('../dist/modules/notifications/notifications.controller');
const { IntegrationsService } = require('../dist/modules/integrations/integrations.service');
const { IntegrationsController } = require('../dist/modules/integrations/integrations.controller');
const { chatOrderSchema } = require('../dist/modules/notifications/order-input');
const { AuditService } = require('../dist/modules/audit/audit.service');
const { hashOpaqueToken } = require('../dist/common/security/token-hash');

const input = { channelId: '1234567', chatId: '5491112345678', contactPhone: '5491112345678', sourceMessageId: 'm1', contactName: 'Cliente', occurredAt: '2026-10-23T18:00:00-03:00', orderMode: 'delivery', summary: 'Quiero hacer un pedido' };
test('invalid payloads and filters are rejected as HTTP 400', () => {
  const controller = new IntegrationsController({});
  for (const patch of [{ sourceMessageId: '' }, { occurredAt: 'not-a-date' }, { orderMode: 'gift_card' }, { summary: '' }, { contactPhone: 'invalid' }]) {
    assert(!chatOrderSchema.safeParse({ ...input, ...patch }).success);
    assert.throws(() => controller.chatOrder('key', { ...input, ...patch }), err => err.getStatus() === 400);
  }
  const notifications = new NotificationsController({});
  assert.throws(() => notifications.list({}, { page: 0 }), err => err.getStatus() === 400);
});

const testUrl = process.env.FOODIE39_TEST_DATABASE_URL;
test('PostgreSQL: concurrency, idempotency, read receipts, attention, tenant isolation and integration auth', { skip: !testUrl }, async () => {
  const url = new URL(testUrl);
  assert(url.pathname.slice(1).startsWith('foodie39_test'), 'Use a dedicated foodie39_test database');
  const prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });
  const suffix = randomUUID();
  const restaurant = await prisma.restaurant.create({ data: { name: 'FOODIE39 Test', slug: `foodie39-${suffix}`, chatPhoneNumberId: input.channelId } });
  const other = await prisma.restaurant.create({ data: { name: 'Other', slug: `other-${suffix}`, chatPhoneNumberId: 'other-channel' } });
  try {
    const owner = await prisma.restaurantUser.create({ data: { restaurantId: restaurant.id, fullName: 'Owner', email: 'owner@test.local', passwordHash: 'unused', role: 'restaurant_owner' } });
    const host = await prisma.restaurantUser.create({ data: { restaurantId: restaurant.id, fullName: 'Host', email: 'host@test.local', passwordHash: 'unused', role: 'host' } });
    const user = { sub: owner.id, restaurantId: restaurant.id, scope: 'restaurant', role: 'restaurant_owner' };
    const second = { ...user, sub: host.id, role: 'host' };
    const foreign = { ...user, restaurantId: other.id };
    const service = new NotificationsService(prisma, new AuditService(prisma));
    const key = randomBytes(24).toString('hex');
    await prisma.integrationToken.create({ data: { restaurantId: restaurant.id, label: 'test', tokenHash: hashOpaqueToken(key) } });
    const integrations = new IntegrationsService(prisma, undefined, undefined, undefined, service);
    const initial = await Promise.all(Array.from({ length: 12 }, () => integrations.receiveChatOrder(key, input)));
    assert.equal(new Set(initial.map(n => n.notificationId)).size, 1);
    assert.equal(initial.filter(n => n.created).length, 1);
    assert.equal(initial.filter(n => n.duplicate).length, 11);
    const id = initial[0].notificationId;
    const coalesced = await Promise.all(Array.from({ length: 8 }, (_, i) => integrations.receiveChatOrder(key, { ...input, sourceMessageId: `new-${i}` })));
    assert(coalesced.every(n => n.notificationId === id && !n.created));
    assert.equal(await prisma.notificationEvent.count({ where: { restaurantId: restaurant.id } }), 9);
    assert.deepEqual(await service.counts(user), { unread: 1, pending: 1 });
    await Promise.all([service.read(user, id), service.read(user, id)]);
    assert.deepEqual(await service.counts(user), { unread: 0, pending: 1 });
    assert.deepEqual(await service.counts(second), { unread: 1, pending: 1 });
    assert.equal((await service.list(second, { page: 1, pageSize: 25, unread: true })).items.length, 1);
    await service.attend(second, id); await service.attend(user, id);
    assert.equal((await prisma.notification.findUnique({ where: { id } })).attendedByUserId, host.id);
    assert.deepEqual(await service.counts(user), { unread: 0, pending: 0 });
    assert.deepEqual(await service.counts(second), { unread: 0, pending: 0 });
    const duplicateAfterAttention = await integrations.receiveChatOrder(key, input);
    assert.equal(duplicateAfterAttention.notificationId, id); assert(duplicateAfterAttention.duplicate);
    const later = await integrations.receiveChatOrder(key, { ...input, sourceMessageId: 'next-order', orderMode: 'takeaway' });
    assert.notEqual(later.notificationId, id); assert(later.created);
    const older = { ...input, sourceMessageId: 'older', orderMode: 'unknown', occurredAt: '2026-10-22T18:00:00Z', summary: 'Old data' };
    await integrations.receiveChatOrder(key, older);
    assert.notEqual((await prisma.notification.findUnique({ where: { id: later.notificationId } })).summary, 'Old data');
    assert.equal((await service.list(foreign, { page: 1, pageSize: 25 })).total, 0);
    await assert.rejects(service.read(foreign, id), err => err.getStatus() === 404);
    await assert.rejects(service.attend(foreign, id), err => err.getStatus() === 404);
    for (const role of ['waiter', 'cashier', 'kitchen', 'events', 'platform_admin']) {
      await assert.rejects(service.counts({ ...user, role }), err => err.getStatus() === 403);
      await assert.rejects(service.read({ ...user, role }, id), err => err.getStatus() === 403);
      await assert.rejects(service.attend({ ...user, role }, id), err => err.getStatus() === 403);
    }
    await assert.rejects(service.counts({ ...user, scope: 'platform' }), err => err.getStatus() === 403);
    await assert.rejects(integrations.receiveChatOrder('bad-key', input), err => err.getStatus() === 403);
    await assert.rejects(integrations.receiveChatOrder(key, { ...input, channelId: 'other-channel' }), err => err.getStatus() === 403);
    await assert.rejects(integrations.receiveChatOrder(key, { ...input, chatId: '5491199999999' }), err => err.getStatus() === 403);
    assert.equal((await service.list(user, { page: 1, pageSize: 1 })).items.length, 1);
    assert.equal((await service.list(user, { status: 'attended', page: 1, pageSize: 25 })).total, 1);
    assert.equal(await prisma.auditLog.count({ where: { restaurantId: restaurant.id, action: 'notification.attended' } }), 1);
  } finally {
    await prisma.restaurant.deleteMany({ where: { id: { in: [restaurant.id, other.id] } } });
    await prisma.$disconnect();
  }
});
