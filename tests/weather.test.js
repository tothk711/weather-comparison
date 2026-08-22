'use strict';
// The freeze invariant, the day-label guard and the revision signal — the three
// things the post-trade-review use case rests on, all untested in v2.0.

const test = require('node:test');
const assert = require('node:assert');
const {
  parseWeatherPayload, computePastAvg, freezePastDays, hasCurrentDayLabels,
} = require('../src/weather/parse');
const { reviseDay, computeRevisions } = require('../src/weather/revisions');
const { getDateString } = require('../src/lib/dates');

function payload(temps = h => 20 + h * 0.1) {
  const time = [], values = [];
  for (let off = -8; off <= 2; off++) {
    const date = getDateString(off);
    for (let h = 0; h < 24; h++) {
      time.push(`${date}T${String(h).padStart(2, '0')}:00`);
      values.push(temps(h, off));
    }
  }
  return { hourly: { time, temperature_2m: values } };
}

test('parseWeatherPayload buckets hours into the right dated days', () => {
  const r = parseWeatherPayload(payload(), null);
  assert.strictEqual(r.today.date, getDateString(0));
  assert.strictEqual(r.yesterday.date, getDateString(-1));
  assert.strictEqual(r.dayAfterTomorrow.date, getDateString(2));
  assert.strictEqual(r.today.temps.length, 24);
  assert.strictEqual(r.today.temps[10], 21);
  assert.ok(r.pastDaysAvg, 'the 3-7 day average must be computed');
});

test('parseWeatherPayload survives a completely empty response', () => {
  const r = parseWeatherPayload({}, null);
  assert.strictEqual(r.today.temps.filter(v => v !== null).length, 0);
  assert.strictEqual(r.pastDaysAvg.temps.filter(v => v !== null).length, 0);
});

test('previous-run values land in todayForecast and tomorrowForecast', () => {
  const today = getDateString(0), tomorrow = getDateString(1);
  const time = [], values = [];
  for (const d of [today, tomorrow]) {
    for (let h = 0; h < 24; h++) { time.push(`${d}T${String(h).padStart(2, '0')}:00`); values.push(h); }
  }
  const r = parseWeatherPayload(payload(), { hourly: { time, temperature_2m_previous_day1: values } });
  assert.strictEqual(r.todayForecast.temps[7], 7);
  assert.strictEqual(r.tomorrowForecast.temps[7], 7);
  assert.strictEqual(r.todayForecast.date, today);
});

test('computePastAvg averages only the days that have values', () => {
  const r = { threeDaysAgo: { temps: Array(24).fill(10) }, fourDaysAgo: { temps: Array(24).fill(20) } };
  computePastAvg(r);
  assert.strictEqual(r.pastDaysAvg.temps[0], 15);
  const empty = {};
  computePastAvg(empty);
  assert.strictEqual(empty.pastDaysAvg.temps[0], null);
});

test('freezePastDays keeps cached values for days 2+ days old, matched by DATE', () => {
  const cached = parseWeatherPayload(payload(() => 10), null);
  const fresh = parseWeatherPayload(payload(() => 30), null);
  const overridden = freezePastDays(fresh, cached, true);

  assert.ok(overridden > 0, 'something must have been frozen');
  // Frozen: everything 2+ days old.
  assert.strictEqual(fresh.threeDaysAgo.temps[12], 10);
  assert.strictEqual(fresh.twoDaysAgo.temps[12], 10);
  // NOT frozen: yesterday and today still re-analyse.
  assert.strictEqual(fresh.yesterday.temps[12], 30);
  assert.strictEqual(fresh.today.temps[12], 30);
  assert.strictEqual(fresh.tomorrow.temps[12], 30);
  assert.strictEqual(fresh.frozenPast.enabled, true);
});

test('freezePastDays gap-fills cached nulls from fresh data instead of blanking', () => {
  const cached = parseWeatherPayload(payload(() => 10), null);
  cached.threeDaysAgo.temps[5] = null;               // a hole in the cache
  const fresh = parseWeatherPayload(payload(() => 30), null);
  freezePastDays(fresh, cached, true);
  assert.strictEqual(fresh.threeDaysAgo.temps[5], 30, 'a cached null must be filled, not preserved');
  assert.strictEqual(fresh.threeDaysAgo.temps[6], 10, 'its neighbour stays frozen');
});

test('freezePastDays is a no-op when disabled or with nothing cached', () => {
  const fresh = parseWeatherPayload(payload(() => 30), null);
  assert.strictEqual(freezePastDays(fresh, parseWeatherPayload(payload(() => 10), null), false), 0);
  assert.strictEqual(fresh.threeDaysAgo.temps[12], 30);
  assert.strictEqual(freezePastDays(fresh, null, true), 0);
});

test('freezePastDays matches by date, so a day-key shift cannot corrupt history', () => {
  // Simulate a cache written yesterday: the SAME calendar date sits under a
  // different key. Matching by key would freeze the wrong day.
  const cached = parseWeatherPayload(payload(() => 10), null);
  const shiftedDate = cached.threeDaysAgo.date;
  const fresh = parseWeatherPayload(payload(() => 30), null);
  freezePastDays(fresh, cached, true);
  const frozenDay = ['sevenDaysAgo', 'sixDaysAgo', 'fiveDaysAgo', 'fourDaysAgo', 'threeDaysAgo', 'twoDaysAgo']
    .map(k => fresh[k]).find(day => day.date === shiftedDate);
  assert.ok(frozenDay, 'the date must still be present after the overlay');
  assert.strictEqual(frozenDay.temps[3], 10);
});

test('hasCurrentDayLabels rejects a payload built for a different day', () => {
  const good = parseWeatherPayload(payload(), null);
  assert.strictEqual(hasCurrentDayLabels(good), true);
  // This is the 23:40 -> 00:40 bug: same object, one day later.
  const stale = JSON.parse(JSON.stringify(good));
  stale.today.date = getDateString(-1);
  assert.strictEqual(hasCurrentDayLabels(stale), false);
  assert.strictEqual(hasCurrentDayLabels(null), false);
  assert.strictEqual(hasCurrentDayLabels({}), false);
});

test('reviseDay needs a real overlap before it reports anything', () => {
  const curr = Array(24).fill(20), prev = Array(24).fill(18);
  const r = reviseDay(curr, prev);
  assert.strictEqual(r.avg, 2);
  assert.strictEqual(r.peakAvg, 2);
  assert.strictEqual(r.hours, 24);

  // Fewer than six overlapping hours is not enough to say anything.
  const sparse = Array(24).fill(null);
  sparse[1] = 20; sparse[2] = 20;
  assert.strictEqual(reviseDay(sparse, curr), null);
  assert.strictEqual(reviseDay(null, curr), null);
});

test('reviseDay separates the peak window and finds the worst hour', () => {
  const prev = Array(24).fill(20);
  const curr = Array(24).fill(20);
  for (let h = 8; h <= 20; h++) curr[h] = 26;   // afternoon warm-up only
  curr[15] = 31;                                 // the single worst revision
  const r = reviseDay(curr, prev);
  assert.strictEqual(r.maxHour, 15);
  assert.strictEqual(r.max, 11);
  assert.ok(r.peakAvg > r.avg, 'the peak window moved more than the whole day');
});

test('computeRevisions covers today and tomorrow, and tolerates gaps', () => {
  const data = {
    today: { temps: Array(24).fill(21) }, todayForecast: { temps: Array(24).fill(20) },
    tomorrow: { temps: Array(24).fill(19) }, tomorrowForecast: { temps: Array(24).fill(23) },
  };
  const r = computeRevisions(data);
  assert.strictEqual(r.today.avg, 1);
  assert.strictEqual(r.tomorrow.avg, -4);
  assert.strictEqual(computeRevisions(null), null);
  assert.strictEqual(computeRevisions({}).today, null);
});
