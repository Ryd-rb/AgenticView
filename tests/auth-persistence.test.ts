import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { fixture, secrets } from './server-fixture.ts';

const day = 24 * 60 * 60 * 1000;
function cookie(response: Response) {
  const header = response.headers.get('set-cookie');
  assert.ok(header, 'login returns a session cookie');
  const fields = header.split(';').map(field => field.trim());
  assert.match(fields[0]!, /^av_session=/);
  const attributes = new Map(fields.slice(1).map<[string, string]>(field => {
    const separator = field.indexOf('=');
    return separator < 0 ? [field.toLowerCase(), ''] : [field.slice(0, separator).toLowerCase(), field.slice(separator + 1)];
  }));
  return { pair: fields[0]!, value: decodeURIComponent(fields[0]!.slice('av_session='.length)), attributes };
}
function assertCookieScope(attributes: Map<string, string>) {
  assert.ok(attributes.has('httponly'));
  assert.equal(attributes.get('samesite')?.toLowerCase(), 'strict');
  assert.equal(attributes.get('path'), '/');
  assert.equal(attributes.has('domain'), false, 'viewer sessions remain host-only');
}
function assertSignedExpiry(value: string, earliest: number, latest: number) {
  const parts = value.split('.');
  assert.equal(parts.length, 3);
  const expires = Number(parts[1]);
  assert.ok(expires >= earliest && expires <= latest, `signed expiry ${expires} is within the requested lifetime`);
  assert.ok(!value.includes(secrets.viewerToken), 'the cookie never contains the installation access token');
  return expires;
}

test('default and explicit remembered login issue host-only persistent cookies for one year', async () => {
  const f = await fixture();
  try {
    for (const body of [{ token: secrets.viewerToken }, { token: secrets.viewerToken, remember: true }]) {
      const before = Date.now(), response = await f.call('/api/login', '', body), after = Date.now();
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { authenticated: true });
      const saved = cookie(response);
      assertCookieScope(saved.attributes);
      const maxAge = Number(saved.attributes.get('max-age'));
      assert.ok(maxAge >= 364 * day / 1000 && maxAge <= 366 * day / 1000, 'persistent cookie lasts about 365 days');
      const expires = Date.parse(saved.attributes.get('expires') ?? '');
      assert.ok(expires >= before + 364 * day && expires <= after + 366 * day, 'persistent cookie has an explicit browser expiry');
      const signedExpiry = assertSignedExpiry(saved.value, before + 364 * day, after + 366 * day);
      assert.ok(Math.abs(expires - signedExpiry) < 2_000, 'browser and signed expiries agree');
      assert.equal((await f.call('/api/snapshot', '', undefined, 'GET', { Cookie: saved.pair })).status, 200);
    }
  } finally { await f.close(); }
});

test('opting out creates a browser-session cookie with a twelve-hour signed lifetime', async () => {
  const f = await fixture();
  try {
    const before = Date.now(), response = await f.call('/api/login', '', { token: secrets.viewerToken, remember: false }), after = Date.now();
    assert.equal(response.status, 200);
    const saved = cookie(response);
    assertCookieScope(saved.attributes);
    assert.equal(saved.attributes.has('max-age'), false);
    assert.equal(saved.attributes.has('expires'), false);
    assertSignedExpiry(saved.value, before + day / 2 - 1_000, after + day / 2 + 1_000);
    assert.equal((await f.call('/api/snapshot', '', undefined, 'GET', { Cookie: saved.pair })).status, 200);
  } finally { await f.close(); }
});

test('malformed persistence choices and invalid viewer tokens cannot create cookies', async () => {
  const f = await fixture();
  try {
    for (const remember of [null, 'true', 0, [], {}]) {
      const response = await f.call('/api/login', '', { token: secrets.viewerToken, remember });
      assert.equal(response.status, 400, `invalid remember value ${JSON.stringify(remember)}`);
      assert.equal(response.headers.get('set-cookie'), null);
    }
    for (const token of ['synthetic-invalid-viewer-token', secrets.ingestToken, undefined]) {
      const response = await f.call('/api/login', '', { token, remember: true });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('set-cookie'), null);
    }
  } finally { await f.close(); }
});

test('remembered cookies survive a server restart while forged and expired cookies fail and logout clears the root path', async () => {
  let f = await fixture();
  try {
    const login = await f.call('/api/login', '', { token: secrets.viewerToken, remember: true });
    assert.equal(login.status, 200);
    const saved = cookie(login), directory = f.dir;
    await f.close(false);
    f = await fixture(directory);
    const authenticated = await f.call('/api/session', '', undefined, 'GET', { Cookie: saved.pair });
    assert.deepEqual(await authenticated.json(), { authenticated: true });
    assert.equal((await f.call('/api/snapshot', '', undefined, 'GET', { Cookie: saved.pair })).status, 200);

    const parts = saved.value.split('.');
    const forgedSignature = `${parts[0]}.${parts[1]}.${parts[2]![0] === '0' ? '1' : '0'}${parts[2]!.slice(1)}`;
    const forgedExpiry = `${parts[0]}.${Date.now() + 730 * day}.${parts[2]}`;
    const expiredValue = `synthetic-expired-session.${Date.now() - day}`;
    const expired = expiredValue + '.' + createHmac('sha256', secrets.viewerToken).update(expiredValue).digest('hex');
    for (const value of [forgedSignature, forgedExpiry, expired]) {
      const headers = { Cookie: `av_session=${value}` };
      const session = await f.call('/api/session', '', undefined, 'GET', headers);
      assert.deepEqual(await session.json(), { authenticated: false });
      assert.equal((await f.call('/api/snapshot', '', undefined, 'GET', headers)).status, 401);
    }
    const logout = await f.call('/api/logout', '', {}, 'POST', { Cookie: saved.pair });
    assert.equal(logout.status, 200);
    assert.deepEqual(await logout.json(), { authenticated: false });
    const cleared = cookie(logout);
    assert.equal(cleared.pair, 'av_session=');
    assert.equal(cleared.attributes.get('path'), '/');
    assert.ok(Date.parse(cleared.attributes.get('expires') ?? '') < Date.now(), 'logout expires the browser cookie');
    assert.equal((await f.call('/api/snapshot')).status, 401);
  } finally { await f.close(true); }
});
