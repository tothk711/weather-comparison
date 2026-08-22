// Shared front-end helpers: escaping, formatting, dates, heat colours.

// v2.0 had 37 innerHTML assignments and no escaping helper anywhere — including
// one that wrote an API error message straight into the DOM. Everything that
// comes from a payload now goes through this.
export function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export const isNum = v => typeof v === 'number' && !Number.isNaN(v);

export function fmtTemp(v, dp = 1) {
  return isNum(v) ? `${v.toFixed(dp)}°` : '—';
}

export function fmtSigned(v, dp = 1, suffix = '') {
  if (!isNum(v)) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(dp)}${suffix}`;
}

// Hour label. Coerces through Number on purpose: `h` sometimes comes from an
// API array (crosscheck correctedHours, revisions maxHour), and String().padStart
// would have passed arbitrary text straight into the DOM.
export function hh(h) {
  // Note the explicit type check before Number(): Number(null), Number('') and
  // Number([]) are all 0, so a bare coercion would happily print "00:00" for a
  // missing hour.
  const n = typeof h === 'number' ? h
    : (typeof h === 'string' && h.trim() !== '' ? Number(h) : NaN);
  return (Number.isFinite(n) && n >= 0 && n <= 23)
    ? `${String(Math.trunc(n)).padStart(2, '0')}:00`
    : '—:—';
}

// Fixed-decimal formatting that cannot throw on a non-number. `x.toFixed()` on
// an API string used to take a whole tab down with a TypeError.
export function fx(v, dp = 1, fallback = '—') {
  return isNum(v) ? v.toFixed(dp) : fallback;
}

// Integer formatting with the same guarantee.
export function fint(v, fallback = '—') {
  return isNum(v) ? String(Math.round(v)) : fallback;
}

// Render an API-supplied integer inside text. Anything non-numeric becomes '—'
// rather than reaching innerHTML.
export const fnum = v => (isNum(v) ? String(v) : '—');

export const APP_TZ = 'Europe/Prague';

// Today's date in the app timezone — the same zone the server pins its day
// maths to, so the header and the "today" column can't drift around midnight.
export function appToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Weekday for a 'YYYY-MM-DD' string. Anchored at noon UTC and formatted in UTC
// so the browser's zone can never shift it.
export function weekdayName(dateStr, short = false) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: short ? 'short' : 'long' }).format(dt);
}

export function shortDate(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' })
    .format(new Date(Date.UTC(y, m - 1, d, 12)));
}

export function localTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

// Heat colouring, shared by the Values view and the Weekly grid: position of v
// within [vMin, vMax] -> hue 120 (dark green, coldest) … 0 (dark red, warmest).
export function heatColor(v, vMin, vMax) {
  const t = vMax > vMin ? (v - vMin) / (vMax - vMin) : 0.5;
  return `hsl(${Math.round(120 * (1 - t))},62%,30%)`;
}

// Forecast cells: same hue, light background + dark text. Fully readable, and
// the light/dark flip separates model data from actuals at a glance.
export function heatColorLight(v, vMin, vMax) {
  const t = vMax > vMin ? (v - vMin) / (vMax - vMin) : 0.5;
  return `hsl(${Math.round(120 * (1 - t))},58%,68%)`;
}

export const FLAGS = {
  CZ: '<svg class="flag" viewBox="0 0 900 600" aria-hidden="true"><rect width="900" height="600" fill="#fff"/><rect y="300" width="900" height="300" fill="#d7141a"/><path d="M0 0 450 300 0 600Z" fill="#11457e"/></svg>',
  HU: '<svg class="flag" viewBox="0 0 900 600" aria-hidden="true"><rect width="900" height="600" fill="#436f4d"/><rect width="900" height="400" fill="#fff"/><rect width="900" height="200" fill="#cd2a3e"/></svg>',
};

export function el(id) { return document.getElementById(id); }

// Own-property lookup, so an API value like "__proto__" cannot walk the
// prototype chain into something unexpected.
export function pick(map, key, fallback = '') {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : fallback;
}
