'use strict';
// Numeric helpers. v2.0 had three separate implementations of "median of an
// array" and two of "pull each model's series out of a batched response".

const isNum = v => typeof v === 'number' && !Number.isNaN(v);

// Median of the numeric entries of an array; null when there are none.
function medianOf(values) {
  const nums = (values || []).filter(isNum).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function meanOf(values) {
  const nums = (values || []).filter(isNum);
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// Median-merge {time, values} series onto the first series' time grid.
function medianSeries(seriesList) {
  const maps = seriesList.map(s => {
    const m = {};
    for (let i = 0; i < s.time.length; i++) {
      if (isNum(s.values[i])) m[s.time[i]] = s.values[i];
    }
    return m;
  });
  const time = seriesList[0].time.slice();
  return { time, values: time.map(t => medianOf(maps.map(m => m[t]))) };
}

// Great-circle distance between two points in kilometres.
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const round = (v, dp = 1) => (isNum(v) ? +v.toFixed(dp) : null);

module.exports = { isNum, medianOf, meanOf, medianSeries, haversineKm, round };
