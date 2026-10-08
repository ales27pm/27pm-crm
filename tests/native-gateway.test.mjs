import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeGateway } from '../worker/native-gateway.ts';
const origin = 'https://crm.27pm.org';
const cap = '/api/mobile/capabilities';
const base = '/api/mobile/attachments';
const id = '11111111-1111-4111-8111-111111111111';
const auth = { authorization: 'Bearer device.token' };
const req = (path, init = {}) => new Request(origin + path, { ...init, headers: { ...auth, ...init.headers } });
const env = fetch => ({ NATIVE_GATEWAY_ENABLED: '1', CRM_BACKEND: { fetch } });

test('gateway defaults disabled without invoking storage operations', async () => {
  let calls = 0;
  const response = await nativeGateway(req(base, { method: 'POST', body: 'data' }), { CRM_BACKEND: { fetch() { calls++; } } });
  assert.equal(response.status, 503); assert.equal(calls, 0);
});
test('capabilities preserve upstream authentication and are masked while disabled', async () => {
  const denied = await nativeGateway(req(cap), env(async () => Response.json({ error: 'authentication_required' }, { status: 401 })));
  assert.equal(denied.status, 401);
  const e = env(async () => Response.json({ attachments: true })); delete e.NATIVE_GATEWAY_ENABLED;
  assert.deepEqual(await (await nativeGateway(req(cap), e)).json(), { attachments: false });
});
test('positive capability needs exact true from authenticated backend and explicit flag', async () => {
  for (const value of [false, 'true', null, true]) {
    const response = await nativeGateway(req(cap), env(async () => Response.json({ attachments: value })));
    assert.deepEqual(await response.json(), { attachments: value === true });
  }
});
test('no bearer: 401 with no backend request', async () => {
  let calls = 0;
  const response = await nativeGateway(new Request(origin + cap), env(async () => { calls++; }));
  assert.equal(response.status, 401); assert.equal(calls, 0);
});
test('same host streams a complete 20 MiB file plus multipart envelope without a redirect', async () => {
  const count = 20 * 1024 * 1024 + 1000;
  let remaining = count, consumed = 0;
  const body = new ReadableStream({ pull(controller) {
    if (!remaining) { controller.close(); return; }
    const bytes = new Uint8Array(Math.min(65536, remaining)); remaining -= bytes.length; controller.enqueue(bytes);
  } });
  const response = await nativeGateway(req(base, { method: 'POST', body, duplex: 'half', headers: {
    'content-type': 'multipart/form-data; boundary=test', 'content-length': String(count),
  } }), env(async request => {
    assert.equal(request.url, origin + base);
    const reader = request.body.getReader();
    for (;;) { const part = await reader.read(); if (part.done) break; consumed += part.value.length; }
    return Response.json({ id });
  }));
  assert.equal(response.status, 200); assert.equal(consumed, count); assert.equal(response.headers.get('location'), null);
});
test('streaming overflow gets 413 even without declared length', async () => {
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(22 * 1024 * 1024)); c.close(); } });
  const response = await nativeGateway(req(base, { method: 'POST', body, duplex: 'half' }), env(async r => {
    await r.arrayBuffer(); return Response.json({ id });
  }));
  assert.equal(response.status, 413); assert.deepEqual(await response.json(), { error: 'file_too_large' });
});
test('declared overflow is rejected before backend consumption', async () => {
  let calls = 0;
  const response = await nativeGateway(req(base, { method: 'POST', body: 'x', headers: { 'content-length': '99999999' } }), env(async () => { calls++; }));
  assert.equal(response.status, 413); assert.equal(calls, 0);
});
test('client identity and cookies cannot become a trusted server identity', async () => {
  const response = await nativeGateway(req(cap, { headers: { cookie: 'session=private',
    'oai-authenticated-user-email': 'forged@example.invalid', 'x-27pm-internal-assertion': 'forged',
    'x-forwarded-for': '192.0.2.1', 'x-forwarded-host': 'attacker.invalid' } }), env(async r => {
    for (const key of ['cookie', 'oai-authenticated-user-email', 'x-27pm-internal-assertion', 'x-forwarded-for', 'x-forwarded-host']) {
      assert.equal(r.headers.get(key), null);
    }
    assert.equal(r.headers.get('authorization'), auth.authorization);
    return Response.json({ attachments: true });
  })); assert.equal(response.status, 200);
});
test('all backend redirects are refused, including same-host redirects', async () => {
  for (const location of [origin + base, 'https://other.invalid/file']) {
    const response = await nativeGateway(req(`${base}/${id}/file`), env(async () => new Response(null, { status: 302, headers: { location } })));
    assert.equal(response.status, 502); assert.equal(response.headers.get('location'), null);
  }
});
test('423 status, retry-after, privacy and streaming bytes are preserved', async () => {
  const response = await nativeGateway(req(`${base}/${id}/file`), env(async () => Response.json({ error: 'attachment_quarantined' }, {
    status: 423, headers: { 'retry-after': '60', 'set-cookie': 'secret=value', 'x-middleware-rewrite': 'https://private.invalid' },
  })));
  assert.equal(response.status, 423); assert.equal(response.headers.get('retry-after'), '60');
  assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('x-middleware-rewrite'), null);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});
for (const path of ['/api/dashboard', base + '/../health', base + '/bad-id/file', cap + '?token=secret', `${base}?ownerKind=account&ownerId=x&token=secret`]) {
  test(`gateway refuses outside-contract route ${path}`, async () => {
    const response = await nativeGateway(req(path), env(async () => { throw new Error('must not call'); }));
    assert.ok([400, 404].includes(response.status));
  });
}
test('literal IPs and alternate subdomains are rejected', async () => {
  for (const host of ['https://127.0.0.1', 'https://[::1]', 'https://api.crm.27pm.org', 'http://crm.27pm.org']) {
    assert.equal((await nativeGateway(new Request(host + cap, { headers: auth }), env(async () => {}))).status, 400);
  }
});
test('malformed or oversized capability payloads cannot be advertised', async () => {
  for (const make of [() => new Response('<html>'), () => new Response('x'.repeat(1025), { headers: { 'content-type': 'application/json' } })]) {
    assert.equal((await nativeGateway(req(cap), env(async () => make()))).status, 502);
  }
});
