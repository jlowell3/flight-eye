import test from 'node:test';
import assert from 'node:assert/strict';
import { admitSameSiteRequest } from './localRequestGate.mjs';

const same = {
  hostHeader: 'localhost:4173',
  protocol: 'http:',
  origin: 'http://localhost:4173',
  secFetchSite: 'same-origin',
};

test('the honest same-origin browser request is admitted', () => {
  assert.equal(admitSameSiteRequest(same).ok, true);
});

test('a cross-site Origin is refused', () => {
  const r = admitSameSiteRequest({ ...same, origin: 'https://evil.example' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('an opaque Origin ("null") is refused even when Host would match', () => {
  const r = admitSameSiteRequest({ ...same, origin: 'null' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('Sec-Fetch-Site cross-site without an Origin is refused (the <img> case)', () => {
  const r = admitSameSiteRequest({
    hostHeader: 'localhost:4173',
    protocol: 'http:',
    secFetchSite: 'cross-site',
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('Sec-Fetch-Site same-site (cross-origin sibling) is refused', () => {
  const r = admitSameSiteRequest({
    ...same,
    origin: 'http://localhost:4173',
    secFetchSite: 'same-site',
  });
  assert.equal(r.ok, false, 'same-site is not same-origin');
  assert.equal(r.status, 403);
});

test('a reverse-proxy signal header is refused', () => {
  for (const header of ['x-forwarded-for', 'forwarded', 'via', 'cf-connecting-ip', 'cf-ray', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto']) {
    const r = admitSameSiteRequest({ ...same, proxyHeaders: { [header]: 'anything' } });
    assert.equal(r.ok, false, `${header} present → refused`);
  }
  // An empty forwarding header is not a proxy signal.
  assert.equal(admitSameSiteRequest({ ...same, proxyHeaders: { 'x-forwarded-for': '' } }).ok, true);
});

test('same-origin Origin with Sec-Fetch-Site same-origin is admitted', () => {
  assert.equal(admitSameSiteRequest(same).ok, true);
});

test('no Origin and no Sec-Fetch headers (curl / Node harness) is admitted', () => {
  const r = admitSameSiteRequest({
    hostHeader: 'localhost:4173',
    protocol: 'http:',
  });
  assert.equal(r.ok, true, 'non-browser loopback tools pass');
});

test('Sec-Fetch-Site none (typed URL / bookmark) is admitted', () => {
  const r = admitSameSiteRequest({
    hostHeader: 'localhost:4173',
    protocol: 'http:',
    secFetchSite: 'none',
  });
  assert.equal(r.ok, true);
});

test('a LAN remote address is irrelevant: the function takes no remoteAddress', () => {
  // The credential-panel gate requires a loopback socket; this gate does not.
  // Passing a LAN-shaped Host/Origin pair must still match (LAN opt-in works).
  const lan = admitSameSiteRequest({
    hostHeader: '192.168.1.5:4173',
    protocol: 'http:',
    origin: 'http://192.168.1.5:4173',
    secFetchSite: 'same-origin',
  });
  assert.equal(lan.ok, true, 'a same-origin LAN browser request is admitted');
});

test('a cross-port or cross-scheme Origin against the same Host is refused', () => {
  assert.equal(admitSameSiteRequest({ ...same, origin: 'http://localhost:4174' }).ok, false, 'cross-port');
  assert.equal(admitSameSiteRequest({ ...same, origin: 'https://localhost:4173' }).ok, false, 'cross-scheme');
  assert.equal(admitSameSiteRequest({ ...same, origin: 'http://127.0.0.1:4173' }).ok, false, 'different loopback host');
});

test('an unparseable Origin is refused', () => {
  assert.equal(admitSameSiteRequest({ ...same, origin: 'not a url' }).ok, false);
});

test('a missing Host with a present Origin is refused (no authority to match)', () => {
  assert.equal(admitSameSiteRequest({ ...same, hostHeader: '' }).ok, false, 'empty Host → null authority');
  assert.equal(admitSameSiteRequest({ ...same, hostHeader: undefined }).ok, false, 'absent Host → null authority');
});

test('a foreign Host is refused when an Origin is present', () => {
  assert.equal(admitSameSiteRequest({ ...same, hostHeader: 'evil.example:4173' }).ok, false, 'foreign Host does not match local Origin');
});

// Flight Eye hosting (GEV_TRUSTED_PROXY): the caller vouches for the socket
// peer with `trustedProxy`, and the forwarding headers then describe the
// request instead of refusing it. Caddy's defaults in front of the preview
// server add X-Forwarded-For, X-Forwarded-Proto and X-Forwarded-Host and pass
// the browser's Host and Origin through unchanged.
const caddy = {
  hostHeader: 'flight-eye.example',
  protocol: 'http:', // the proxy connects over plain HTTP on loopback
  origin: 'https://flight-eye.example',
  secFetchSite: 'same-origin',
  proxyHeaders: {
    'x-forwarded-for': '203.0.113.9',
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'flight-eye.example',
  },
};

test('a Caddy-style request is refused unless the caller trusts the proxy', () => {
  const r = admitSameSiteRequest(caddy);
  assert.equal(r.ok, false, 'today: forwarding headers mean not local');
  assert.equal(r.status, 403);
  assert.equal(admitSameSiteRequest({ ...caddy, trustedProxy: false }).ok, false);
});

test('behind a trusted proxy the scheme comes from X-Forwarded-Proto, so the https Origin matches', () => {
  assert.equal(admitSameSiteRequest({ ...caddy, trustedProxy: true }).ok, true);
  // The socket scheme alone would never match an https Origin.
  const noProto = { ...caddy, trustedProxy: true, proxyHeaders: { 'x-forwarded-for': '203.0.113.9' } };
  assert.equal(admitSameSiteRequest(noProto).ok, false, 'without X-Forwarded-Proto the socket scheme (http) stays');
  // A proxy that says http while the Origin says https is still a mismatch.
  const plain = { ...caddy, trustedProxy: true, proxyHeaders: { ...caddy.proxyHeaders, 'x-forwarded-proto': 'http' } };
  assert.equal(admitSameSiteRequest(plain).ok, false);
  // Multi-hop lists use the first (client-facing) value.
  const chained = { ...caddy, trustedProxy: true, proxyHeaders: { ...caddy.proxyHeaders, 'x-forwarded-proto': 'https, http' } };
  assert.equal(admitSameSiteRequest(chained).ok, true);
  // An unreadable value falls back to the socket scheme rather than admitting.
  const junk = { ...caddy, trustedProxy: true, proxyHeaders: { ...caddy.proxyHeaders, 'x-forwarded-proto': 'ftp' } };
  assert.equal(admitSameSiteRequest(junk).ok, false);
});

test('behind a trusted proxy X-Forwarded-Host, when present, is the authority', () => {
  // A proxy that rewrites Host to its upstream still carries the public name.
  const rewritten = { ...caddy, trustedProxy: true, hostHeader: '127.0.0.1:4173' };
  assert.equal(admitSameSiteRequest(rewritten).ok, true);
  // Without X-Forwarded-Host the Host header is used as before.
  const hostOnly = { ...caddy, trustedProxy: true, proxyHeaders: { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' } };
  assert.equal(admitSameSiteRequest(hostOnly).ok, true);
  assert.equal(admitSameSiteRequest({ ...hostOnly, hostHeader: '127.0.0.1:4173' }).ok, false, 'a rewritten Host without X-Forwarded-Host cannot match');
});

test('trusting the proxy relaxes nothing else', () => {
  const trusted = { ...caddy, trustedProxy: true };
  assert.equal(admitSameSiteRequest({ ...trusted, origin: 'https://evil.example' }).ok, false, 'cross-origin');
  assert.equal(admitSameSiteRequest({ ...trusted, origin: 'null' }).ok, false, 'opaque origin');
  assert.equal(admitSameSiteRequest({ ...trusted, secFetchSite: 'cross-site' }).ok, false, 'cross-site fetch metadata');
  assert.equal(admitSameSiteRequest({ ...trusted, origin: 'http://flight-eye.example' }).ok, false, 'scheme downgrade in Origin');
});

test('a trusted proxy connection with no forwarding headers is an ordinary local request', () => {
  // The operator's own curl against the backend port, from loopback.
  assert.equal(admitSameSiteRequest({ ...same, trustedProxy: true }).ok, true);
  assert.equal(admitSameSiteRequest({ hostHeader: 'localhost:4173', protocol: 'http:', trustedProxy: true }).ok, true);
});
