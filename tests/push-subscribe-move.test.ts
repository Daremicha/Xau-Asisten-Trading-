import { describe, expect, mock, test } from 'bun:test';

// An in-memory stand-in for the push store, so the route runs without Redis.
const store = new Map<string, unknown>();
mock.module('@/lib/push-store', () => ({
  storeConfigured: () => true,
  recordId: (endpoint: string) => `id:${endpoint}`,
  loadRecord: async (id: string) => (store.get(id) as never) ?? null,
  saveRecord: async (id: string, record: unknown) => {
    store.set(id, record);
  },
  deleteRecord: async (id: string) => {
    store.delete(id);
  },
}));

const { POST } = await import('../app/api/push/subscribe/route');

const sub = (endpoint: string) => ({
  endpoint,
  keys: { p256dh: 'BOr8Yp2CMiVgbbHOhVQRcCVNeQmkIjv-QKZhTZFjxB0_bCJgO04qq1zLX1SHBkuTxGxSjYEykJ4bWOnFCo84XLA', auth: 'yTJWB2EKP6bC-1RNSmETTQ' },
});

function request(body: unknown): Request {
  return new Request('https://example.test/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('a subscription the browser replaced', () => {
  test('carries the watched trade and the scan settings to the new address', async () => {
    store.clear();
    const old = {
      subscription: sub('https://fcm.googleapis.com/fcm/send/old'),
      setup: { id: 'setup_1' },
      sent: ['setup_1:filled'],
      finished: false,
      scan: { equity: 2 },
      offer: null,
      lastOffer: null,
      lastScan: null,
      updatedAt: '2026-10-15T00:00:00.000Z',
    };
    store.set('id:https://fcm.googleapis.com/fcm/send/old', old);

    const res = await POST(request({ subscription: sub('https://fcm.googleapis.com/fcm/send/new'), previousEndpoint: 'https://fcm.googleapis.com/fcm/send/old' }));
    expect(res.status).toBe(200);
    expect((await res.json()).moved).toBe(true);

    expect(store.has('id:https://fcm.googleapis.com/fcm/send/old')).toBe(false);
    const moved = store.get('id:https://fcm.googleapis.com/fcm/send/new') as typeof old;
    expect(moved.setup).toEqual({ id: 'setup_1' });
    expect(moved.sent).toEqual(['setup_1:filled']);
    expect(moved.scan).toEqual({ equity: 2 });
    expect(moved.subscription.endpoint).toBe('https://fcm.googleapis.com/fcm/send/new');
  });

  test('an unknown old address moves nothing and breaks nothing', async () => {
    store.clear();
    const res = await POST(request({ subscription: sub('https://fcm.googleapis.com/fcm/send/new'), previousEndpoint: 'https://fcm.googleapis.com/fcm/send/gone' }));
    expect(res.status).toBe(200);
    expect((await res.json()).moved).toBe(false);
  });
});
