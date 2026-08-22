'use strict';
// Route-level tests against the mocked upstream.
//
// tests/mock-fetch.js has existed since v1.3.0 and was capable of driving the
// whole app offline — but nothing ever ran it automatically, so all 14 handlers,
// the cache layer and the DB-absent path went unexercised. This file is that
// harness, wired up.

// Keep a handle on the REAL fetch before the mock takes over, so these tests
// can still talk to their own server over HTTP.
const realFetch = globalThis.fetch.bind(globalThis);
require('./mock-fetch.js');              // replaces global.fetch for the app

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

process.env.METNO_USER_AGENT = process.env.METNO_USER_AGENT || 'ZephyrWeather-test/3.0 test@example.com';
const { createApp, config } = require('../server.js');
const { isoWeekOf, nowInTz, shiftIsoWeek } = require('../src/lib/dates');

let server, base;

test.before(async () => {
  server = http.createServer(createApp());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise(resolve => server.close(resolve)));

async function get(path) {
  const res = await realFetch(`${base}${path}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}
async function post(path) {
  const res = await realFetch(`${base}${path}`, { method: 'POST' });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('GET /api/cities lists the configured cities', async () => {
  const { status, body } = await get('/api/cities');
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(body));
  assert.ok(body.includes('Prague') && body.includes('Budapest'));
  assert.strictEqual(body.length, config.cities.length);
});

test('GET /api/config gives the client everything it needs to boot', async () => {
  const { status, body } = await get('/api/config');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.app.name, 'Zephyr Weather');
  assert.strictEqual(body.defaultSource, 'median');
  assert.ok(body.weekly.weeks.length > 50, 'the week list must span more than one year');
  assert.ok(body.countries.some(c => c.code === 'CZ' && c.name === 'Czechia'));
});

test('GET /api/health reports db, cache and upstream state', async () => {
  const { status, body } = await get('/api/health');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.status, 'ok');
  assert.ok(body.db, 'db status is part of health');
  assert.ok(Array.isArray(body.caches));
  assert.ok(body.upstream);
});

test('GET /api/status degrades gracefully with no database', async () => {
  // In v2.0 this was the ONE route with no dbReady guard: it returned a hard
  // 500 whenever Postgres was absent, which is the default for a local run.
  const { status, body } = await get('/api/status');
  assert.strictEqual(status, 200, '/api/status must never 500 just because there is no DB');
  assert.strictEqual(body.db.configured, false);
  assert.strictEqual(body.cities.length, config.cities.length);
});

test('GET /api/weather returns a full series, median by default', async () => {
  const { status, body } = await get('/api/weather/Prague');
  assert.strictEqual(status, 200);
  assert.strictEqual(body._source, 'median', 'global median is the default everywhere');
  assert.strictEqual(body.today.temps.length, 24);
  assert.ok(body.pastDaysAvg);
  assert.ok(body.todayForecast, 'the previous run must be included');
});

test('GET /api/weather?source=openmeteo switches to best_match', async () => {
  const { status, body } = await get('/api/weather/Prague?source=openmeteo');
  assert.strictEqual(status, 200);
  assert.strictEqual(body._source, 'openmeteo');
});

test('an unknown city is a clean 404, not a crash', async () => {
  for (const p of ['/api/weather/Atlantis', '/api/live/Atlantis', '/api/verify/Atlantis',
                   '/api/crosscheck/Atlantis', '/api/weekly/Atlantis?week=1']) {
    const { status, body } = await get(p);
    assert.strictEqual(status, 404, `${p} should 404`);
    assert.ok(body.error, `${p} should return a JSON error`);
  }
});

test('an unknown API path returns JSON, not the index page', async () => {
  const { status, body } = await get('/api/does-not-exist');
  assert.strictEqual(status, 404);
  assert.match(body.error, /Unknown API route/);
});

test('GET /api/crosscheck compares against the independent sources', async () => {
  const { status, body } = await get('/api/crosscheck/Prague');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.hours.length, 24);
  assert.ok(body.sourceCount >= 4, 'four models plus MET Norway should respond to the mock');
  assert.ok(body.tomorrow, 'tomorrow is analysed too');
  assert.ok(['ok', 'warning', 'corrected', 'unavailable'].includes(body.status));
  assert.strictEqual(body.forDate.length, 10, 'the verdict is stamped with the day it is for');
});

test('GET /api/revisions reports the change since yesterday\'s run', async () => {
  const { status, body } = await get('/api/revisions/Prague');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.city, 'Prague');
  assert.ok('today' in body && 'tomorrow' in body);
});

test('GET /api/verify runs all five check families', async () => {
  const { status, body } = await get('/api/verify/Prague');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.checks.length, 5);
  assert.ok(['ok', 'warning'].includes(body.status));
});

test('GET /api/future returns both countries in one response', async () => {
  const { status, body } = await get('/api/future');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.countries.length, 2);
  const [cz, hu] = body.countries;
  assert.strictEqual(cz.country, 'CZ');
  assert.strictEqual(hu.country, 'HU');
  assert.strictEqual(cz.days.length, 6);
  assert.strictEqual(cz.source, 'median', 'the Future tab reads the median by default');
  assert.ok(cz.models.length >= 4, 'and reports which models contributed');
  assert.strictEqual(cz.days[0].label, 'Today');
});

test('the Future temperatures match what /api/weather serves for the same hour', async () => {
  // The whole point of the v3.0 source unification: these two tabs cannot
  // disagree about the same hour any more.
  const future = (await get('/api/future')).body.countries.find(c => c.country === 'CZ');
  const weather = (await get('/api/weather/Prague')).body;
  const today = future.days.find(d => d.label === 'Today');
  assert.strictEqual(today.date, weather.today.date);
  for (const [key, hour] of [['h8', 8], ['h12', 12], ['h16', 16], ['h20', 20]]) {
    assert.strictEqual(today.temp[key], weather.today.temps[hour],
      `Future ${key} disagrees with the Graphs at ${hour}:00`);
  }
});

test('back-compat: /api/preparation/:city still answers', async () => {
  const { status, body } = await get('/api/preparation/Budapest');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.country, 'HU');
  assert.strictEqual((await get('/api/preparation/Berlin')).status, 404);
});

test('GET /api/live gives a snapshot with yesterday deltas', async () => {
  const { status, body } = await get('/api/live/Prague');
  assert.strictEqual(status, 200);
  assert.ok(typeof body.temperature.value === 'number');
  assert.ok('delta' in body.temperature);
  assert.ok(body.pressure.unit === 'hPa');
});

test('GET /api/market returns structured risks and a residual-load call', async () => {
  const { status, body } = await get('/api/market');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.countries.length, 2);
  const cz = body.countries[0];
  assert.strictEqual(cz.days.length, 4);
  assert.strictEqual(cz.days[0].context, true, 'yesterday is context');
  assert.ok(cz.headline, 'the card needs a headline');
  assert.ok(cz.stability, 'forecast stability is folded into the same request');
  assert.ok(Array.isArray(cz.days[1].risks), 'risks are typed objects, not strings');
  assert.ok(cz.days[1].residual, 'every forecast day gets a residual verdict');
  assert.ok(['tighter', 'softer', 'neutral', 'unknown'].includes(cz.days[1].residual.direction));
});

test('GET /api/market/:country validates the code', async () => {
  assert.strictEqual((await get('/api/market/CZ')).status, 200);
  assert.strictEqual((await get('/api/market/cz')).status, 200, 'case-insensitive');
  assert.strictEqual((await get('/api/market/FR')).status, 404);
});

test('GET /api/weekly builds a 24x7 grid for the current week', async () => {
  const cur = isoWeekOf(nowInTz(config.app.timezone).date);
  const { status, body } = await get(`/api/weekly/Prague?year=${cur.year}&week=${cur.week}`);
  assert.strictEqual(status, 200);
  assert.strictEqual(body.temps.length, 24);
  assert.strictEqual(body.temps[0].length, 7);
  assert.strictEqual(body.days.length, 7);
  assert.ok(body.cutoff.date, 'the past/future boundary must be reported');
  assert.ok(body.sources.length >= 4, 'median mode should use several models');
});

test('GET /api/weekly can reach the previous ISO year', async () => {
  // The v2.0 hole: the year came from "now", so in January the previous
  // December was simply unaddressable.
  const cur = isoWeekOf(nowInTz(config.app.timezone).date);
  const back = shiftIsoWeek(cur, -40);
  const { status, body } = await get(`/api/weekly/Prague?year=${back.year}&week=${back.week}`);
  assert.strictEqual(status, 200, `week ${back.year}-W${back.week} must be reachable`);
  assert.strictEqual(body.year, back.year);
  assert.strictEqual(body.week, back.week);
});

test('GET /api/weekly rejects a week outside the selectable range', async () => {
  const cur = isoWeekOf(nowInTz(config.app.timezone).date);
  const { status, body } = await get(`/api/weekly/Prague?year=${cur.year + 5}&week=1`);
  assert.strictEqual(status, 400);
  assert.match(body.error, /outside the selectable range/);
  assert.strictEqual((await get('/api/weekly/Prague?week=notanumber')).status, 400);
});

test('back-compat: /api/history/:city still answers with the current year', async () => {
  const cur = isoWeekOf(nowInTz(config.app.timezone).date);
  const { status, body } = await get(`/api/history/Prague?week=${cur.week}`);
  assert.strictEqual(status, 200);
  assert.strictEqual(body.week, cur.week);
});

test('POST /api/fetch is coalesced and then throttled', async () => {
  // v2.0 ran 8 cities x 2 endpoints on ANY unauthenticated POST with no
  // in-flight guard, so repeated clicks stacked overlapping runs — and two
  // concurrent runs for one city could LOSE frozen history.
  const [a, b] = await Promise.all([post('/api/fetch'), post('/api/fetch')]);
  const ok = [a, b].filter(r => r.status === 200);
  assert.ok(ok.length >= 1, 'at least one refresh should succeed');
  for (const r of ok) assert.strictEqual(r.body.success, true);

  const again = await post('/api/fetch');
  assert.strictEqual(again.status, 429, 'an immediate second refresh is throttled');
  assert.ok(again.body.retryAfterMs > 0);
});

test('the static dashboard is served with security headers', async () => {
  const res = await realFetch(`${base}/`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(res.headers.get('content-security-policy'), 'a CSP must be set');
  assert.strictEqual(res.headers.get('x-powered-by'), null, 'express must not advertise itself');
  const html = await res.text();
  assert.match(html, /<title>Zephyr Weather<\/title>/);
  assert.match(html, /favicon\.svg/);
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net/, 'Chart.js must be served locally, not from a CDN');
});

test('the vendored chart library is actually present', async () => {
  const res = await realFetch(`${base}/vendor/chart.umd.min.js`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('cache-control') || '', /immutable/);
});
