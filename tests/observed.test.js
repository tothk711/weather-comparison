'use strict';
// Offline tests for the METAR observation feature's pure helpers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bucketReports, reportMs, hourKeyInTz } = require('../src/features/observed');

test('reportMs: obsTime preferred, UTC reportTime fallback, junk -> null', () => {
  assert.equal(reportMs({ obsTime: 1000 }), 1000000);
  assert.equal(reportMs({ reportTime: '2026-08-25 06:00:00' }), Date.parse('2026-08-25T06:00:00Z'));
  // the live API's actual format: ISO with explicit zone
  assert.equal(reportMs({ reportTime: '2026-08-25T12:00:00.000Z' }), Date.parse('2026-08-25T12:00:00.000Z'));
  assert.equal(reportMs({ obsTime: 1000, reportTime: '2026-08-25 06:00:00' }), 1000000);
  assert.equal(reportMs({}), null);
  assert.equal(reportMs(null), null);
});

test('hourKeyInTz: UTC instant renders as an app-timezone hour key', () => {
  // 22:00Z on Aug 24 is 00:00 CEST on Aug 25.
  assert.equal(hourKeyInTz(Date.parse('2026-08-24T22:00:00Z'), 'Europe/Prague'), '2026-08-25T00:00');
  // Winter (CET, UTC+1): 23:00Z Jan 5 -> 00:00 Jan 6.
  assert.equal(hourKeyInTz(Date.parse('2026-01-05T23:00:00Z'), 'Europe/Prague'), '2026-01-06T00:00');
});

test('bucketReports: nearest hour, closest report wins, junk skipped', () => {
  const base = Date.parse('2026-08-25T04:00:00Z'); // 06:00 CEST
  const min = m => (base + m * 60000) / 1000;
  const b = bucketReports([
    { icaoId: 'LKPR', obsTime: base / 1000, temp: 10 },   // exactly on the hour
    { icaoId: 'LKPR', obsTime: min(20), temp: 11 },       // :20 -> same hour, farther
    { icaoId: 'LKPR', obsTime: min(40), temp: 12 },       // :40 -> rounds to next hour
    { icaoId: 'LKTB', obsTime: base / 1000, temp: 15 },
    { icaoId: 'LKPR', obsTime: base / 1000, temp: 'x' },  // non-numeric temp: skipped
    { icaoId: null, obsTime: base / 1000, temp: 9 },      // no station: skipped
  ], 'Europe/Prague');
  assert.equal(b.LKPR['2026-08-25T06:00'], 10);
  assert.equal(b.LKPR['2026-08-25T07:00'], 12);
  assert.equal(b.LKTB['2026-08-25T06:00'], 15);
  assert.equal(Object.keys(b).length, 2);
});

test('bucketReports: reportTime-only reports still bucket', () => {
  const b = bucketReports([
    { icaoId: 'LHBP', reportTime: '2026-08-25 04:30:00', temp: 18.3 }, // 06:30 CEST -> 07:00
  ], 'Europe/Prague');
  assert.equal(b.LHBP['2026-08-25T07:00'], 18.3);
});

test('bucketReports: empty / bad input -> empty object', () => {
  assert.deepEqual(bucketReports([]), {});
  assert.deepEqual(bucketReports(null), {});
});
