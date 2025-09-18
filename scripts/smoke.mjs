#!/usr/bin/env node
// Simple smoke tests for prod server and proxy
const BASE = process.env.SMOKE_BASE || 'http://localhost:3000';

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForServer(retries = 10, delay = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(BASE + '/', { method: 'GET' });
      if (res.ok || res.status === 200) return true;
    } catch (_) {}
    await wait(delay);
  }
  return false;
}

async function get(path, opts = {}) {
  const url = BASE + path;
  const res = await fetch(url, { method: 'GET', ...opts });
  const ct = res.headers.get('content-type') || '';
  let body;
  if (ct.includes('application/json')) {
    body = await res.json().catch(() => ({}));
  } else {
    body = await res.text().catch(() => '');
  }
  return { status: res.status, ok: res.ok, ct, body };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

(async () => {
  const ready = await waitForServer();
  if (!ready) {
    console.error(`[SMOKE] Server not reachable at ${BASE}`);
    process.exit(2);
  }

  let failures = 0;
  const cases = [];

  // Case 1: Home page should load
  try {
    const r = await get('/');
    assert(r.status === 200, `Home status ${r.status}`);
    cases.push(['GET /', 'PASS']);
  } catch (e) {
    failures++; cases.push(['GET /', 'FAIL', String(e.message || e)]);
  }

  // Case 2: Proxy valid external HTML
  try {
    const r = await get('/api/proxy?url=' + encodeURIComponent('https://example.com'));
    assert(r.status === 200, `Proxy example.com status ${r.status}`);
    assert(/text\/html/i.test(r.ct), `Proxy example.com content-type ${r.ct}`);
    assert(typeof r.body === 'string' && r.body.toLowerCase().includes('<title>'), 'Proxy body missing <title>');
    cases.push(['GET /api/proxy?url=https://example.com', 'PASS']);
  } catch (e) {
    failures++; cases.push(['GET /api/proxy?url=https://example.com', 'FAIL', String(e.message || e)]);
  }

  // Case 3: Proxy about:blank should be rejected (400)
  try {
    const r = await get('/api/proxy?url=' + encodeURIComponent('about:blank'));
    assert(r.status === 400, `about:blank expected 400, got ${r.status}`);
    cases.push(['GET /api/proxy?url=about:blank', 'PASS']);
  } catch (e) {
    failures++; cases.push(['GET /api/proxy?url=about:blank', 'FAIL', String(e.message || e)]);
  }

  // Case 4: Proxy private host should be rejected (400)
  try {
    const r = await get('/api/proxy?url=' + encodeURIComponent('http://127.0.0.1:3000'));
    assert(r.status === 400, `127.0.0.1 expected 400, got ${r.status}`);
    cases.push(['GET /api/proxy?url=http://127.0.0.1:3000', 'PASS']);
  } catch (e) {
    failures++; cases.push(['GET /api/proxy?url=http://127.0.0.1:3000', 'FAIL', String(e.message || e)]);
  }

  // Report
  for (const row of cases) {
    if (row[1] === 'PASS') console.log(`[SMOKE] ${row[0]}: PASS`);
    else console.error(`[SMOKE] ${row[0]}: FAIL - ${row[2]}`);
  }

  if (failures > 0) {
    console.error(`[SMOKE] Failures: ${failures}`);
    process.exit(1);
  }
  console.log('[SMOKE] All checks passed');
  process.exit(0);
})().catch((e) => {
  console.error('[SMOKE] Unexpected error', e);
  process.exit(1);
});
