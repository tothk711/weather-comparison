'use strict';
// The front-end escaping helpers, tested in Node.
//
// An audit of v3.0's own first draft found a live injection path: the tooltip
// rendered its body with innerHTML while the Market tab built tips from
// /api/market strings, and tipAttr escaped `<` but not `>`, so the attribute
// round trip handed raw markup back. These tests exist so that cannot return.

const test = require('node:test');
const assert = require('node:assert');

const XSS = '<img src=x onerror="alert(1)">';

test('esc neutralises every HTML-significant character', async () => {
  const { esc } = await import('../public/js/util.js');
  assert.strictEqual(esc('<b>'), '&lt;b&gt;');
  assert.strictEqual(esc('"'), '&quot;');
  assert.strictEqual(esc("'"), '&#39;');
  assert.strictEqual(esc('&'), '&amp;');
  assert.strictEqual(esc(null), '');
  assert.strictEqual(esc(undefined), '');
  const out = esc(XSS);
  assert.ok(!out.includes('<') && !out.includes('>'), 'no angle brackets survive');
});

test('tipAttr escapes both angle brackets and both quote styles', async () => {
  const { tipAttr } = await import('../public/js/tooltip.js');
  const attr = tipAttr(XSS, 'Title');
  assert.ok(!/[<>]/.test(attr.replace(/^ data-tip="|"$/g, '')), 'no raw brackets in the attribute');
  assert.ok(attr.includes('&lt;img'), 'the opening bracket is encoded');
  assert.ok(attr.includes('&gt;'), 'and so is the closing one — this was the hole');
  // Nothing can terminate the attribute early.
  assert.strictEqual(tipAttr('a" onmouseover="evil()').match(/"/g).length, 2,
    'the only unescaped quotes are the attribute delimiters');
  assert.strictEqual(tipAttr(''), '');
  assert.strictEqual(tipAttr(null), '');
});

test('hh coerces through Number instead of pasting arbitrary text', async () => {
  const { hh } = await import('../public/js/util.js');
  assert.strictEqual(hh(0), '00:00');
  assert.strictEqual(hh(9), '09:00');
  assert.strictEqual(hh(23), '23:00');
  // Hour indexes come out of API arrays (correctedHours, maxHour), so junk
  // must become a dash, not markup.
  assert.strictEqual(hh(XSS), '—:—');
  assert.strictEqual(hh(null), '—:—');
  assert.strictEqual(hh('abc'), '—:—');
});

test('fx and fint never throw on a non-number', async () => {
  const { fx, fint, fnum } = await import('../public/js/util.js');
  assert.strictEqual(fx(1.234), '1.2');
  assert.strictEqual(fx(1.234, 2), '1.23');
  // `x.toFixed()` on an API string used to take a whole tab down.
  assert.strictEqual(fx('4' + XSS), '—');
  assert.strictEqual(fx(null), '—');
  assert.strictEqual(fint(4.6), '5');
  assert.strictEqual(fint('nope'), '—');
  assert.strictEqual(fnum(4), '4');
  assert.strictEqual(fnum(XSS), '—');
});

test('pick refuses to walk the prototype chain', async () => {
  const { pick } = await import('../public/js/util.js');
  const map = { CZ: 'flag-cz' };
  assert.strictEqual(pick(map, 'CZ'), 'flag-cz');
  assert.strictEqual(pick(map, 'HU'), '');
  assert.strictEqual(pick(map, '__proto__'), '', 'an API country code cannot reach Object.prototype');
  assert.strictEqual(pick(map, 'constructor'), '');
  assert.strictEqual(pick(map, 'toString', 'fallback'), 'fallback');
});

test('fmtTemp and the heat scale stay numeric', async () => {
  const { fmtTemp, heatColor, heatColorLight } = await import('../public/js/util.js');
  assert.strictEqual(fmtTemp(12.34, 1), '12.3°');
  assert.strictEqual(fmtTemp(null), '—');
  assert.match(heatColor(15, 10, 20), /^hsl\(\d+,62%,30%\)$/);
  assert.match(heatColorLight(15, 10, 20), /^hsl\(\d+,58%,68%\)$/);
  // Coldest is green (hue 120), warmest is red (hue 0).
  assert.strictEqual(heatColor(10, 10, 20), 'hsl(120,62%,30%)');
  assert.strictEqual(heatColor(20, 10, 20), 'hsl(0,62%,30%)');
  // A zero-width range must not divide by zero.
  assert.match(heatColor(10, 10, 10), /^hsl\(60,/);
});

test('weekdayName is timezone-proof', async () => {
  const { weekdayName, shortDate } = await import('../public/js/util.js');
  assert.strictEqual(weekdayName('2026-08-21'), 'Friday');
  assert.strictEqual(weekdayName('2026-08-21', true), 'Fri');
  assert.strictEqual(weekdayName('nonsense'), '');
  assert.strictEqual(weekdayName(null), '');
  assert.match(shortDate('2026-08-21'), /21 Aug/);
});
