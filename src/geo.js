/**
 * Pure geographic / geometric helpers for KML coordinate analysis.
 */

const EARTH_RADIUS_M = 6371000.0;
const DEG_TO_RAD = Math.PI / 180.0;
const RAD_TO_DEG = 180.0 / Math.PI;

/**
 * Parse KML coordinates text ("lon,lat[,alt] ...") into [{ lon, lat }].
 */
function parseCoords(coordText) {
  if (!coordText || typeof coordText !== 'string') return [];
  const pts = [];
  const tokens = coordText.trim().split(/\s+/);
  for (const t of tokens) {
    const parts = t.split(',');
    if (parts.length >= 2) {
      const lon = parseFloat(parts[0]);
      const lat = parseFloat(parts[1]);
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        pts.push({ lon, lat });
      }
    }
  }
  return pts;
}

/**
 * Haversine distance in meters between two { lon, lat } points.
 */
function distMeters(p1, p2) {
  const lat1 = p1.lat * DEG_TO_RAD;
  const lat2 = p2.lat * DEG_TO_RAD;
  const dLat = (p2.lat - p1.lat) * DEG_TO_RAD;
  const dLon = (p2.lon - p1.lon) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Total 2D length in meters of a polyline.
 */
function lineLengthMeters(pts) {
  let sum = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    sum += distMeters(pts[i], pts[i + 1]);
  }
  return sum;
}

/**
 * Forward azimuth bearing in degrees [0, 360) from p1 to p2.
 */
function bearingDeg(p1, p2) {
  const lat1 = p1.lat * DEG_TO_RAD;
  const lat2 = p2.lat * DEG_TO_RAD;
  const dLon = (p2.lon - p1.lon) * DEG_TO_RAD;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * RAD_TO_DEG + 360.0) % 360.0;
}

/**
 * Deflection / turning angle in degrees [0, 180] at pCurr from pPrev->pCurr to pCurr->pNext.
 */
function turnAngleDeg(pPrev, pCurr, pNext) {
  const b1 = bearingDeg(pPrev, pCurr);
  const b2 = bearingDeg(pCurr, pNext);
  let diff = Math.abs(b2 - b1);
  if (diff > 180.0) diff = 360.0 - diff;
  return diff;
}

/**
 * Distance in meters from point p to segment a-b using local equirectangular projection.
 */
function pointToSegDist(p, a, b) {
  const latMid = ((a.lat + b.lat) / 2.0) * DEG_TO_RAD;
  const mPerDegLat = 111132.92;
  const mPerDegLon = 111412.84 * Math.cos(latMid);
  const ax = (a.lon - p.lon) * mPerDegLon;
  const ay = (a.lat - p.lat) * mPerDegLat;
  const bx = (b.lon - p.lon) * mPerDegLon;
  const by = (b.lat - p.lat) * mPerDegLat;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    return { dist: Math.sqrt(ax * ax + ay * ay), t: 0.0 };
  }
  let t = -(ax * dx + ay * dy) / lenSq;
  if (t < 0) t = 0.0;
  else if (t > 1) t = 1.0;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return { dist: Math.sqrt(cx * cx + cy * cy), t };
}

/**
 * Project point p onto polyline linePts, returning minimum distance (m) and chainage (m).
 */
function pointToLineProj(p, linePts) {
  let bestDist = 1e9;
  let cumDist = 0.0;
  let bestChainage = 0.0;
  for (let i = 0; i < linePts.length - 1; i++) {
    const segLen = distMeters(linePts[i], linePts[i + 1]);
    const res = pointToSegDist(p, linePts[i], linePts[i + 1]);
    if (res.dist < bestDist) {
      bestDist = res.dist;
      bestChainage = cumDist + res.t * segLen;
    }
    cumDist += segLen;
  }
  return { dist: bestDist, chainage: bestChainage, totalLen: cumDist };
}

module.exports = {
  parseCoords,
  distMeters,
  lineLengthMeters,
  bearingDeg,
  turnAngleDeg,
  pointToLineProj,
};
