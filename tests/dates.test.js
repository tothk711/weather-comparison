'use strict';
// Date maths: the whole app's day boundaries rest on these, and v2.0 asserted
// none of it — despite 20 lines of comments in getDateString explaining exactly
// how easy it is to get wrong.

const test = require('node:test');
const assert = require('node:assert');
const d = require('../src/lib/dates');

test('addDays crosses month and year boundaries', () => {
  assert.strictEqual(d.addDays('2026-01-31', 1), '2026-02-01');
  assert.strictEqual(d.addDays('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(d.addDays('2026-01-01', -1), '2025-12-31');
  assert.strictEqual(d.addDays('2024-02-28', 1), '2024-02-29'); // leap year
});

test('daysBetween is signed and DST-proof', () => {
  assert.strictEqual(d.daysBetween('2026-03-28', '2026-03-30'), 2);  // spring forward
  assert.strictEqual(d.daysBetween('2026-10-24', '2026-10-26'), 2);  // fall back
  assert.strictEqual(d.daysBetween('2026-01-05', '2026-01-01'), -4);
});

test('getDateString steps whole days across a DST change', () => {
  // Anchoring at noon UTC is what makes this safe; a midnight anchor lands on
  // the wrong date in the hour a clock change adds or removes.
  const a = d.getDateString(0);
  assert.match(a, /^\d{4}-\d{2}-\d{2}$/);
  assert.strictEqual(d.daysBetween(d.getDateString(-7), d.getDateString(0)), 7);
  assert.strictEqual(d.daysBetween(d.getDateString(0), d.getDateString(2)), 2);
});

test('isoWeekOf handles the year-boundary cases ISO weeks are famous for', () => {
  assert.deepStrictEqual(d.isoWeekOf('2026-01-01'), { year: 2026, week: 1 });
  // 2027-01-01 is a Friday, so it belongs to ISO week 53 of 2026.
  assert.deepStrictEqual(d.isoWeekOf('2027-01-01'), { year: 2026, week: 53 });
  // 2023-01-01 is a Sunday -> ISO week 52 of 2022.
  assert.deepStrictEqual(d.isoWeekOf('2023-01-01'), { year: 2022, week: 52 });
  assert.deepStrictEqual(d.isoWeekOf('2026-08-21'), { year: 2026, week: 34 });
});

test('isoWeekDates returns Monday..Sunday', () => {
  const week = d.isoWeekDates(2026, 34);
  assert.strictEqual(week.length, 7);
  assert.strictEqual(week[0], '2026-08-17');
  assert.strictEqual(week[6], '2026-08-23');
  assert.strictEqual(d.isoWeekOf(week[0]).week, 34);
  assert.strictEqual(d.isoWeekOf(week[6]).week, 34);
});

test('isoWeeksInYear knows which years have 53 weeks', () => {
  assert.strictEqual(d.isoWeeksInYear(2026), 53);
  assert.strictEqual(d.isoWeeksInYear(2025), 52);
  assert.strictEqual(d.isoWeeksInYear(2020), 53);
});

test('shiftIsoWeek rolls backwards across the year boundary', () => {
  // THIS is the v2.0 Weekly-tab bug: the year came from "now", so in January
  // last December was unreachable and the dropdown offered three weeks total.
  assert.deepStrictEqual(d.shiftIsoWeek({ year: 2026, week: 1 }, -1), { year: 2025, week: 52 });
  assert.deepStrictEqual(d.shiftIsoWeek({ year: 2026, week: 2 }, -5), { year: 2025, week: 49 });
  assert.deepStrictEqual(d.shiftIsoWeek({ year: 2026, week: 53 }, 1), { year: 2027, week: 1 });
  // 2025-W52 is 22-28 Dec; +2 weeks is 5-11 Jan, which is 2026-W2 (2026-W1
  // starts on 29 Dec 2025).
  assert.deepStrictEqual(d.shiftIsoWeek({ year: 2025, week: 52 }, 2), { year: 2026, week: 2 });
  // Cross-check the shift against the calendar itself rather than by hand.
  for (const n of [-60, -13, -1, 0, 1, 9]) {
    const shifted = d.shiftIsoWeek({ year: 2026, week: 34 }, n);
    const expectedMonday = d.addDays(d.isoWeekDates(2026, 34)[0], n * 7);
    assert.deepStrictEqual(shifted, d.isoWeekOf(expectedMonday), `shift ${n} disagrees with the calendar`);
  }
  // A round trip of any size must land back where it started.
  for (const n of [1, 7, 30, 52, 53, 78]) {
    assert.deepStrictEqual(
      d.shiftIsoWeek(d.shiftIsoWeek({ year: 2026, week: 20 }, -n), n),
      { year: 2026, week: 20 }, `round trip failed for ${n}`);
  }
});

test('localHourIndex maps UTC instants onto app-timezone hours', () => {
  // 10:00Z in high summer is 12:00 in Prague (UTC+2).
  assert.strictEqual(d.localHourIndex('2026-08-21T10:00:00Z', 'Europe/Prague', '2026-08-21'), 12);
  // An instant on a different local day is rejected, not silently bucketed.
  assert.strictEqual(d.localHourIndex('2026-08-22T10:00:00Z', 'Europe/Prague', '2026-08-21'), null);
  // 23:30Z on the 21st is already 01:30 on the 22nd in Prague.
  assert.strictEqual(d.localHourIndex('2026-08-21T23:30:00Z', 'Europe/Prague', '2026-08-22'), 1);
  assert.strictEqual(d.localHourIndex('not a date', 'Europe/Prague', '2026-08-21'), null);
});

test('nowInTz returns a well-formed local date and hour', () => {
  const n = d.nowInTz('Europe/Prague');
  assert.match(n.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Number.isInteger(n.hour) && n.hour >= 0 && n.hour <= 23);
});
