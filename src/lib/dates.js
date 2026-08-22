'use strict';
// Pure date/time helpers. Every one of these is timezone-explicit on purpose:
// the app's day boundaries are Europe/Prague, the container's clock is usually
// UTC, and mixing the two silently shifts whole series by a day.

const { APP_TIMEZONE } = require('../config');

// Today's calendar date in `tz`, as YYYY-MM-DD.
function todayInTz(tz = APP_TIMEZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// YYYY-MM-DD for "today + offsetDays" in APP_TIMEZONE.
// Anchored at noon UTC so adding whole days can never cross a DST change or a
// midnight boundary into the wrong date.
function getDateString(offsetDays = 0, tz = APP_TIMEZONE) {
  const [y, m, d] = todayInTz(tz).split('-').map(Number);
  const anchor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  anchor.setUTCDate(anchor.getUTCDate() + offsetDays);
  return anchor.toISOString().slice(0, 10);
}

// 'YYYY-MM-DD' + n days -> 'YYYY-MM-DD' (UTC math, DST-proof).
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Whole days from a to b ('YYYY-MM-DD' each); positive when b is later.
function daysBetween(a, b) {
  const toUTC = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((toUTC(b) - toUTC(a)) / 86400000);
}

// ISO week number + ISO week-year for a 'YYYY-MM-DD' date.
function isoWeekOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = (dt.getUTCDay() + 6) % 7;      // 0 = Monday … 6 = Sunday
  dt.setUTCDate(dt.getUTCDate() - dow + 3);  // this week's Thursday
  const year = dt.getUTCFullYear();          // ISO week-year
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week1Mon = new Date(Date.UTC(year, 0, 4 - ((jan4.getUTCDay() + 6) % 7)));
  const week = 1 + Math.round(((dt - week1Mon) / 86400000 - 3) / 7);
  return { year, week };
}

// The 7 dates (Mon..Sun) of ISO week `week` in ISO week-year `year`.
function isoWeekDates(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4)); // Jan 4 is always in ISO week 1
  const week1Mon = new Date(Date.UTC(year, 0, 4 - ((jan4.getUTCDay() + 6) % 7)));
  const out = [];
  for (let i = 0; i < 7; i++) {
    out.push(new Date(week1Mon.getTime() + ((week - 1) * 7 + i) * 86400000).toISOString().slice(0, 10));
  }
  return out;
}

// How many ISO weeks a given ISO week-year has (52 or 53).
function isoWeeksInYear(year) {
  return isoWeekOf(`${year}-12-28`).week; // Dec 28 is always in the last ISO week
}

// Step an {year, week} pair by n weeks, rolling across year boundaries.
// This is what makes the Weekly tab able to address last December from January
// — v2.0 derived the year from "now" and could only ever offer weeks of the
// current ISO year (three of them, in the first week of January).
function shiftIsoWeek({ year, week }, n) {
  let y = year, w = week + n;
  while (w < 1) { y -= 1; w += isoWeeksInYear(y); }
  let len = isoWeeksInYear(y);
  while (w > len) { w -= len; y += 1; len = isoWeeksInYear(y); }
  return { year: y, week: w };
}

// Current local 'YYYY-MM-DD' + hour (0-23) in timezone `tz`.
function nowInTz(tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = t => (parts.find(p => p.type === t) || {}).value;
  let hh = parseInt(get('hour'), 10);
  if (hh === 24) hh = 0; // some ICU builds report midnight as 24
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: hh };
}

// Map a UTC ISO instant to a "today-local" hour index 0..23 in `tz`, or null
// if it does not fall on `todayLocal`. Lines MET Norway's UTC stamps up with
// the app's Prague hours.
function localHourIndex(utcIso, tz, todayLocal) {
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = t => (parts.find(p => p.type === t) || {}).value;
  if (`${get('year')}-${get('month')}-${get('day')}` !== todayLocal) return null;
  let hh = parseInt(get('hour'), 10);
  if (hh === 24) hh = 0;
  return (hh >= 0 && hh <= 23) ? hh : null;
}

module.exports = {
  todayInTz, getDateString, addDays, daysBetween,
  isoWeekOf, isoWeekDates, isoWeeksInYear, shiftIsoWeek,
  nowInTz, localHourIndex,
};
