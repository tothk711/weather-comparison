'use strict';
// The unified cache replaced eight hand-rolled ones. Its three behaviours —
// coalescing, stale-on-error, and the validate hook — are each fixing a
// specific bug from the audit, so each gets a test.

const test = require('node:test');
const assert = require('node:assert');
const { TtlCache } = require('../src/lib/cache');

test('a fresh entry is served without calling the producer again', async () => {
  let calls = 0;
  const c = new TtlCache({ name: 't', ttlMs: 10_000 });
  const make = async () => { calls++; return calls; };
  assert.strictEqual(await c.get('k', make), 1);
  assert.strictEqual(await c.get('k', make), 1);
  assert.strictEqual(calls, 1);
  assert.strictEqual(c.stats.hits, 1);
});

test('concurrent callers share ONE producer run', async () => {
  // This is the /api/weather fix: the dashboard asks for four Czech cities at
  // once and v2.0 fired one upstream request per caller.
  let calls = 0;
  const c = new TtlCache({ name: 't', ttlMs: 10_000 });
  const slow = async () => { calls++; await new Promise(r => setTimeout(r, 30)); return 'v'; };
  const all = await Promise.all([c.get('k', slow), c.get('k', slow), c.get('k', slow), c.get('k', slow)]);
  assert.deepStrictEqual(all, ['v', 'v', 'v', 'v']);
  assert.strictEqual(calls, 1, 'four callers, one upstream request');
});

test('an expired entry is refetched', async () => {
  let calls = 0;
  const c = new TtlCache({ name: 't', ttlMs: 5 });
  const make = async () => ++calls;
  await c.get('k', make);
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(await c.get('k', make), 2);
});

test('stale-on-error serves the last good value when the upstream fails', async () => {
  const c = new TtlCache({ name: 't', ttlMs: 5, staleOnError: true });
  await c.get('k', async () => 'good');
  await new Promise(r => setTimeout(r, 20));
  const v = await c.get('k', async () => { throw new Error('429 rate limited'); });
  assert.strictEqual(v, 'good');
  assert.strictEqual(c.stats.stale, 1);
});

test('with staleOnError off the error propagates', async () => {
  const c = new TtlCache({ name: 't', ttlMs: 5, staleOnError: false });
  await c.get('k', async () => 'good');
  await new Promise(r => setTimeout(r, 20));
  await assert.rejects(() => c.get('k', async () => { throw new Error('boom'); }), /boom/);
});

test('a first-ever failure always throws — there is nothing stale to serve', async () => {
  const c = new TtlCache({ name: 't', ttlMs: 1000, staleOnError: true });
  await assert.rejects(() => c.get('k', async () => { throw new Error('cold'); }), /cold/);
});

test('validate expires an entry that is young but wrong', async () => {
  // The weather payloads carry baked-in day labels: one written at 23:40 is
  // WRONG at 00:10 even though it is only 30 minutes old.
  let day = 'monday';
  let calls = 0;
  const c = new TtlCache({
    name: 't', ttlMs: 60_000,
    validate: v => v.day === day,
  });
  await c.get('k', async () => { calls++; return { day }; });
  assert.strictEqual(calls, 1);
  await c.get('k', async () => { calls++; return { day }; });
  assert.strictEqual(calls, 1, 'still valid, still cached');

  day = 'tuesday';                                   // midnight happens
  await c.get('k', async () => { calls++; return { day }; });
  assert.strictEqual(calls, 2, 'the day rolled over, so the entry had to be refetched');
});

test('an invalid entry is never used as the stale fallback either', async () => {
  let day = 'monday';
  const c = new TtlCache({ name: 't', ttlMs: 5, staleOnError: true, validate: v => v.day === day });
  await c.get('k', async () => ({ day }));
  await new Promise(r => setTimeout(r, 20));
  day = 'tuesday';
  // Serving yesterday's labelled payload would be worse than an honest error.
  await assert.rejects(() => c.get('k', async () => { throw new Error('down'); }), /down/);
});

test('the cache is bounded and evicts least-recently-used entries', async () => {
  const c = new TtlCache({ name: 't', ttlMs: 60_000, maxEntries: 3 });
  for (const k of ['a', 'b', 'c']) await c.get(k, async () => k);
  await c.get('a', async () => 'a');       // touch 'a' so 'b' becomes oldest
  await c.get('d', async () => 'd');
  assert.strictEqual(c.size(), 3);
  assert.ok(c.peek('a'), 'the recently used entry survived');
  assert.strictEqual(c.peek('b'), null, 'the least recently used entry was evicted');
  assert.strictEqual(c.stats.evictions, 1);
});

test('peek never triggers a fetch and reports freshness', async () => {
  const c = new TtlCache({ name: 't', ttlMs: 5 });
  assert.strictEqual(c.peek('k'), null);
  await c.get('k', async () => 'v');
  assert.strictEqual(c.peek('k').fresh, true);
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(c.peek('k').fresh, false);
  assert.strictEqual(c.peek('k').value, 'v', 'the value is still there, just not fresh');
});
