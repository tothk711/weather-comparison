'use strict';
// analyzeCrossCheck is the ONLY function in the codebase that can silently
// change a temperature the desk sees. The v2.0 audit found it had zero tests.
// This file is that suite.

const test = require('node:test');
const assert = require('node:assert');
const { analyzeCrossCheck, seriesToDays } = require('../src/features/crosscheck');
const { getDateString } = require('../src/lib/dates');

const CFG = { DEVIATION_C: 4, MIN_SOURCES: 2, CONSENSUS_SPREAD_C: 2, CONSENSUS_MIN_SOURCES: 3 };
const flat = v => Array(24).fill(v);
const at = (arr, h, v) => { const c = arr.slice(); c[h] = v; return c; };

test('agreement leaves the displayed value alone', () => {
  const r = analyzeCrossCheck(flat(20), { A: flat(20.5), B: flat(19.6), C: flat(20.2) }, CFG);
  assert.deepStrictEqual(r.correctedHours, []);
  assert.deepStrictEqual(r.suspectHours, []);
  assert.strictEqual(r.hours[12].display, 20);
  assert.strictEqual(r.status, undefined); // status is added by the caller
});

test('a clear outlier against a TIGHT consensus is replaced by their median', () => {
  const primary = at(flat(20), 14, 35);           // planted 35° spike
  const sources = { A: flat(21), B: flat(21.4), C: flat(20.6), D: flat(21.2) };
  const r = analyzeCrossCheck(primary, sources, CFG);
  assert.deepStrictEqual(r.correctedHours, [14]);
  assert.deepStrictEqual(r.suspectHours, []);
  const row = r.hours[14];
  assert.strictEqual(row.corrected, true);
  assert.strictEqual(row.primary, 35, 'the raw model value must be preserved');
  assert.strictEqual(row.display, 21.1, 'display becomes the median of the others');
  assert.ok(row.spread <= CFG.CONSENSUS_SPREAD_C);
  // Untouched hours stay exactly as they were.
  assert.strictEqual(r.hours[13].display, 20);
});

test('a clear outlier against a LOOSE consensus is flagged, never replaced', () => {
  const primary = at(flat(20), 9, 35);
  // The other sources disagree among themselves by 8 °C: a median of a
  // scattered set is not a trustworthy number to substitute.
  const sources = { A: flat(18), B: flat(22), C: flat(26), D: flat(20) };
  const r = analyzeCrossCheck(primary, sources, CFG);
  assert.deepStrictEqual(r.suspectHours, [9]);
  assert.deepStrictEqual(r.correctedHours, []);
  assert.strictEqual(r.hours[9].display, 35, 'the shown value must survive a flag-only verdict');
  assert.strictEqual(r.hours[9].suspect, true);
});

test('a missing primary is filled only when the consensus is tight', () => {
  const tight = analyzeCrossCheck(at(flat(20), 5, null), { A: flat(21), B: flat(21.5), C: flat(20.5) }, CFG);
  assert.deepStrictEqual(tight.filledHours, [5]);
  assert.strictEqual(tight.hours[5].display, 21);
  assert.strictEqual(tight.hours[5].primary, null);

  const loose = analyzeCrossCheck(at(flat(20), 5, null), { A: flat(15), B: flat(25), C: flat(20) }, CFG);
  assert.deepStrictEqual(loose.filledHours, []);
  assert.strictEqual(loose.hours[5].display, null);
});

test('too few sources means no verdict at all', () => {
  // One source can never override a model, however far apart they are.
  const r = analyzeCrossCheck(at(flat(20), 3, 40), { A: flat(20) }, CFG);
  assert.deepStrictEqual(r.correctedHours, []);
  assert.deepStrictEqual(r.suspectHours, []);
  assert.strictEqual(r.hours[3].display, 40);
});

test('a deviation exactly at the limit is NOT flagged (strictly greater)', () => {
  const exact = analyzeCrossCheck(at(flat(20), 8, 25), { A: flat(21), B: flat(21), C: flat(21) }, CFG);
  assert.deepStrictEqual(exact.suspectHours, [], '25 vs median 21 is exactly 4 — the limit is exclusive');
  assert.deepStrictEqual(exact.correctedHours, []);
  const over = analyzeCrossCheck(at(flat(20), 8, 25.1), { A: flat(21), B: flat(21), C: flat(21) }, CFG);
  assert.deepStrictEqual(over.correctedHours, [8]);
});

test('no sources at all is handled without throwing', () => {
  const r = analyzeCrossCheck(flat(20), {}, CFG);
  assert.strictEqual(r.sourceCount, 0);
  assert.strictEqual(r.meanSpread, null);
  assert.deepStrictEqual(r.correctedHours, []);
  assert.strictEqual(r.hours[0].display, 20);
});

test('non-numeric junk in a source array is ignored, not counted', () => {
  const sources = { A: at(flat(21), 6, null), B: at(flat(21), 6, 'warm'), C: flat(21), D: flat(21) };
  const r = analyzeCrossCheck(at(flat(20), 6, 40), sources, CFG);
  assert.strictEqual(r.hours[6].others.length, 2, 'null and a string must both drop out');
  // Only two usable sources left, below CONSENSUS_MIN_SOURCES -> flag, no swap.
  assert.deepStrictEqual(r.correctedHours, []);
  assert.deepStrictEqual(r.suspectHours, [6]);
});

test('model-agreement summary reports mean and worst spread', () => {
  const sources = { A: flat(20), B: flat(22), C: at(flat(21), 7, 30) };
  const r = analyzeCrossCheck(flat(21), sources, CFG);
  assert.strictEqual(r.maxSpreadHour, 7);
  assert.strictEqual(r.maxSpread, 10);
  assert.ok(r.meanSpread > 2 && r.meanSpread < 3);
  assert.strictEqual(r.sourceCount, 3);
});

test('an even number of sources medians correctly', () => {
  const r = analyzeCrossCheck(at(flat(20), 1, 40), { A: flat(20), B: flat(21), C: flat(21), D: flat(22) }, CFG);
  assert.strictEqual(r.hours[1].median, 21, 'median of [20,21,21,22] is 21');
  assert.strictEqual(r.hours[1].display, 21);
});

test('seriesToDays splits a series into today/tomorrow and drops other dates', () => {
  const today = getDateString(0), tomorrow = getDateString(1), other = getDateString(5);
  const time = [], values = [];
  for (const d of [today, tomorrow, other]) {
    for (let h = 0; h < 24; h++) { time.push(`${d}T${String(h).padStart(2, '0')}:00`); values.push(h); }
  }
  const out = seriesToDays(time, values);
  assert.strictEqual(out.today.length, 24);
  assert.strictEqual(out.today[13], 13);
  assert.strictEqual(out.tomorrow[0], 0);
  // A series with nothing for tomorrow reports null rather than 24 nulls.
  const onlyToday = seriesToDays(time.slice(0, 24), values.slice(0, 24));
  assert.strictEqual(onlyToday.tomorrow, null);
});
