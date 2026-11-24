const JSZip = require('jszip');
const { parseKmzBuffer } = require('./kmzParser');
const { distMeters, pointToLineProj } = require('./geo');

const HASBEL_COLORS = [
  { hex: '#38bdf8', kml: 'fff8bd38', name: 'Biru Langit' },
  { hex: '#4ade80', kml: 'ff80de4a', name: 'Hijau' },
  { hex: '#facc15', kml: 'ff15ccfa', name: 'Kuning' },
  { hex: '#fb923c', kml: 'ff3c92fb', name: 'Oranye' },
  { hex: '#f472b6', kml: 'ffb672f4', name: 'Magenta' },
  { hex: '#a78bfa', kml: 'fffa8ba7', name: 'Ungu' },
  { hex: '#f87171', kml: 'ff7171f8', name: 'Merah' },
  { hex: '#2dd4bf', kml: 'ffbfd42d', name: 'Tosca' },
];

/**
 * Compute cumulative chainages for each vertex in a polyline.
 */
function buildChainages(pts) {
  const ch = [0];
  for (let i = 1; i < pts.length; i++) {
    ch.push(ch[i - 1] + distMeters(pts[i - 1], pts[i]));
  }
  return ch;
}

/**
 * Interpolate a { lon, lat } point at a given chainage along a polyline.
 */
function interpolateAtChainage(pts, chainages, targetCh) {
  if (targetCh <= 0) return { ...pts[0] };
  const total = chainages[chainages.length - 1];
  if (targetCh >= total) return { ...pts[pts.length - 1] };

  for (let i = 0; i < pts.length - 1; i++) {
    const c0 = chainages[i];
    const c1 = chainages[i + 1];
    if (targetCh >= c0 && targetCh <= c1) {
      const span = c1 - c0;
      const t = span > 0 ? (targetCh - c0) / span : 0;
      return {
        lon: pts[i].lon + t * (pts[i + 1].lon - pts[i].lon),
        lat: pts[i].lat + t * (pts[i + 1].lat - pts[i].lat),
      };
    }
  }
  return { ...pts[pts.length - 1] };
}

/**
 * Extract sub-polyline between startCh and endCh.
 */
function slicePolyline(pts, chainages, startCh, endCh) {
  const out = [interpolateAtChainage(pts, chainages, startCh)];
  for (let i = 1; i < pts.length - 1; i++) {
    if (chainages[i] > startCh && chainages[i] < endCh) {
      out.push({ ...pts[i] });
    }
  }
  out.push(interpolateAtChainage(pts, chainages, endCh));
  return out;
}

function calcEffectiveLength(routeLen, slackLen, slackInterval, sparePercent) {
  const slackCount = Math.floor(routeLen / slackInterval) + 1;
  const totalSlackMeters = slackCount * slackLen;
  const factor = 1 + sparePercent / 100;
  const effectiveLength = (routeLen + totalSlackMeters) * factor;
  return { slackCount, totalSlackMeters, factor, effectiveLength };
}

/**
 * Find maximum route length <= maxRouteCap such that effectiveLength <= maxHasbelMeters.
 */
function solveMaxRouteForHasbel(maxRouteCap, maxHasbelMeters, slackLen, slackInterval, sparePercent) {
  const full = calcEffectiveLength(maxRouteCap, slackLen, slackInterval, sparePercent);
  if (full.effectiveLength <= maxHasbelMeters) return maxRouteCap;

  let lo = 0;
  let hi = maxRouteCap;
  for (let iter = 0; iter < 32; iter++) {
    const mid = (lo + hi) / 2;
    const res = calcEffectiveLength(mid, slackLen, slackInterval, sparePercent);
    if (res.effectiveLength <= maxHasbelMeters) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function csvEscape(val) {
  const str = String(val ?? '');
  if (/[",\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

/**
 * Split feeder cable lines into hasbel segments (default 3000m incl. 20m/400m slack + 5% spare).
 */
async function splitKmzLinesByHasbel(buffer, filename = 'input.kmz', options = {}) {
  const maxHasbelMeters = Number.isFinite(options.maxHasbelMeters) && options.maxHasbelMeters > 0
    ? options.maxHasbelMeters
    : 3000;
  const slackLengthMeters = Number.isFinite(options.slackLengthMeters) && options.slackLengthMeters >= 0
    ? options.slackLengthMeters
    : 20;
  const slackIntervalMeters = Number.isFinite(options.slackIntervalMeters) && options.slackIntervalMeters > 0
    ? options.slackIntervalMeters
    : 400;
  const sparePercent = Number.isFinite(options.sparePercent) && options.sparePercent >= 0
    ? options.sparePercent
    : 5;
  const snapToPole = options.snapToPole ?? true;
  const outputFormat = options.outputFormat === 'kml' ? 'kml' : 'kmz';

  const kmzData = await parseKmzBuffer(buffer, filename);
  if (kmzData.cables.length === 0) {
    throw new Error('Tidak ditemukan jalur kabel (LineString) di dalam file KMZ/KML.');
  }

  const hasbels = [];
  const jointClosures = [];
  let globalHasbelIdx = 0;

  for (const cab of kmzData.cables) {
    const chainages = buildChainages(cab.pts);
    const totalLen = chainages[chainages.length - 1];
    if (totalLen <= 0) continue;

    // Project poles onto this cable (within 10m)
    const polesOnCable = [];
    if (snapToPole && kmzData.poles.length > 0) {
      for (const p of kmzData.poles) {
        const pr = pointToLineProj(p.coord, cab.pts);
        if (pr.dist <= 10.0) {
          polesOnCable.push({ name: p.name, chainage: pr.chainage, coord: p.coord });
        }
      }
      polesOnCable.sort((a, b) => a.chainage - b.chainage);
    }

    let startCh = 0;
    let cableHasbelNum = 0;

    while (startCh < totalLen - 0.5) {
      cableHasbelNum++;
      globalHasbelIdx++;
      const remaining = totalLen - startCh;
      const maxRoute = solveMaxRouteForHasbel(
        remaining,
        maxHasbelMeters,
        slackLengthMeters,
        slackIntervalMeters,
        sparePercent
      );

      let endCh = Math.min(totalLen, startCh + maxRoute);
      let isLastOfCable = endCh >= totalLen - 0.5;
      let snappedPoleName = '';

      if (!isLastOfCable && snapToPole && polesOnCable.length > 0) {
        // Find last pole strictly after startCh (+1m) and <= endCh
        const candidates = polesOnCable.filter(
          (p) => p.chainage > startCh + 1.0 && p.chainage <= endCh + 0.5
        );
        if (candidates.length > 0) {
          const chosen = candidates[candidates.length - 1];
          endCh = chosen.chainage;
          snappedPoleName = chosen.name;
        }
      }

      // Guard against zero-progress loop
      if (endCh <= startCh + 0.5) {
        endCh = Math.min(totalLen, startCh + Math.max(remaining, 1));
        isLastOfCable = endCh >= totalLen - 0.5;
      }

      const routeLen = endCh - startCh;
      const calc = calcEffectiveLength(
        routeLen,
        slackLengthMeters,
        slackIntervalMeters,
        sparePercent
      );
      const segPts = slicePolyline(cab.pts, chainages, startCh, endCh);
      const color = HASBEL_COLORS[(globalHasbelIdx - 1) % HASBEL_COLORS.length];

      // Nearest start/end pole labels for display
      const startPole = polesOnCable.find((p) => Math.abs(p.chainage - startCh) <= 2.0)?.name || '';
      const endPole = isLastOfCable
        ? (polesOnCable.find((p) => Math.abs(p.chainage - endCh) <= 2.0)?.name || 'Ujung Kabel')
        : (snappedPoleName || `JC-${cableHasbelNum}`);

      const hasbelName = `${cab.name || cab.line} - Hasbel ${cableHasbelNum}`;

      hasbels.push({
        no: globalHasbelIdx,
        cableName: cab.name || cab.line,
        line: cab.line,
        hasbelNumber: cableHasbelNum,
        hasbelName,
        startCh: Math.round(startCh * 10) / 10,
        endCh: Math.round(endCh * 10) / 10,
        routeLength: Math.round(routeLen * 10) / 10,
        slackCount: calc.slackCount,
        totalSlackMeters: calc.totalSlackMeters,
        sparePercent,
        effectiveLength: Math.round(calc.effectiveLength * 100) / 100,
        effectiveLengthCeil: Math.ceil(calc.effectiveLength),
        startPole: startPole || `CH ${Math.round(startCh)}m`,
        endPole,
        isJointClosure: !isLastOfCable,
        colorHex: color.hex,
        colorKml: color.kml,
        pts: segPts,
      });

      if (!isLastOfCable) {
        const jcPt = segPts[segPts.length - 1];
        jointClosures.push({
          name: `JC-${globalHasbelIdx} (${snappedPoleName || hasbelName})`,
          poleName: snappedPoleName || '-',
          chainage: Math.round(endCh * 10) / 10,
          coord: jcPt,
        });
      }

      startCh = endCh;
    }
  }

  // Build output KML
  const stylesXml = HASBEL_COLORS.map(
    (c, idx) => `
    <Style id="hasbel_style_${idx}">
      <LineStyle>
        <color>${c.kml}</color>
        <width>4</width>
      </LineStyle>
    </Style>`
  ).join('');

  const segPlacemarksXml = hasbels
    .map((h) => {
      const styleIdx = (h.no - 1) % HASBEL_COLORS.length;
      const coordsText = h.pts.map((pt) => `${pt.lon},${pt.lat},0`).join(' ');
      const desc = `Kabel Asal: ${h.cableName}\nPanjang Rute: ${h.routeLength} m\nJumlah Slack: ${h.slackCount} x ${slackLengthMeters} m = ${h.totalSlackMeters} m\nSpare: ${h.sparePercent}%\nTotal Kabel: ${h.effectiveLength} m\nDari: ${h.startPole} -> Ke: ${h.endPole}`;
      return `
      <Placemark>
        <name>${escapeXml(h.hasbelName)} (${h.effectiveLengthCeil}m)</name>
        <description>${escapeXml(desc)}</description>
        <styleUrl>#hasbel_style_${styleIdx}</styleUrl>
        <LineString>
          <tessellate>1</tessellate>
          <coordinates>${coordsText}</coordinates>
        </LineString>
      </Placemark>`;
    })
    .join('');

  const jcPlacemarksXml = jointClosures
    .map(
      (jc) => `
      <Placemark>
        <name>${escapeXml(jc.name)}</name>
        <description>Joint Closure di ${escapeXml(jc.poleName)} (Chainage: ${jc.chainage} m)</description>
        <styleUrl>#jc_style</styleUrl>
        <Point>
          <coordinates>${jc.coord.lon},${jc.coord.lat},0</coordinates>
        </Point>
      </Placemark>`
    )
    .join('');

  const polePlacemarksXml = kmzData.poles
    .map(
      (p) => `
      <Placemark>
        <name>${escapeXml(p.name)}</name>
        <description>${escapeXml(p.folder)}</description>
        <styleUrl>#pole_ref_style</styleUrl>
        <Point>
          <coordinates>${p.coord.lon},${p.coord.lat},0</coordinates>
        </Point>
      </Placemark>`
    )
    .join('');

  const outKml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(kmzData.clusterTitle)} - HASBEL SPLIT (${maxHasbelMeters}m)</name>
    ${stylesXml}
    <Style id="jc_style">
      <IconStyle>
        <color>ff0000ff</color>
        <scale>1.2</scale>
        <Icon><href>http://maps.google.com/mapfiles/kml/shapes/triangle.png</href></Icon>
      </IconStyle>
    </Style>
    <Style id="pole_ref_style">
      <IconStyle>
        <color>ffffffff</color>
        <scale>0.6</scale>
        <Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon>
      </IconStyle>
      <LabelStyle><scale>0.6</scale></LabelStyle>
    </Style>
    <Folder>
      <name>HASBEL SEGMENTS (${hasbels.length})</name>
      ${segPlacemarksXml}
    </Folder>
    <Folder>
      <name>JOINT CLOSURE (${jointClosures.length})</name>
      ${jcPlacemarksXml}
    </Folder>
    ${
      kmzData.poles.length > 0
        ? `<Folder><name>POLE REFERENSI (${kmzData.poles.length})</name>${polePlacemarksXml}</Folder>`
        : ''
    }
  </Document>
</kml>`;

  let outBuffer;
  if (outputFormat === 'kml') {
    outBuffer = Buffer.from(outKml, 'utf8');
  } else {
    const zip = new JSZip();
    zip.file('doc.kml', outKml);
    outBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  // Build CSV
  const csvHeaders = [
    'NO',
    'KABEL ASAL',
    'LINE',
    'HASBEL',
    'START (m)',
    'END (m)',
    'PANJANG RUTE (m)',
    'JUMLAH SLACK',
    'TOTAL SLACK (m)',
    'SPARE (%)',
    'TOTAL KABEL (m)',
    'PEMBULATAN ATAS (m)',
    'DARI POLE',
    'KE POLE / JC',
  ];
  const csvLines = [csvHeaders.map(csvEscape).join(',')];
  for (const h of hasbels) {
    csvLines.push(
      [
        h.no,
        h.cableName,
        h.line,
        h.hasbelName,
        h.startCh,
        h.endCh,
        h.routeLength,
        h.slackCount,
        h.totalSlackMeters,
        h.sparePercent,
        h.effectiveLength,
        h.effectiveLengthCeil,
        h.startPole,
        h.endPole,
      ]
        .map(csvEscape)
        .join(',')
    );
  }
  const csvBuffer = Buffer.from('\uFEFF' + csvLines.join('\r\n'), 'utf8');

  const summary = {
    clusterTitle: kmzData.clusterTitle,
    sourceCableCount: kmzData.cables.length,
    totalHasbels: hasbels.length,
    totalJointClosures: jointClosures.length,
    totalRouteMeters: Math.round(hasbels.reduce((s, h) => s + h.routeLength, 0) * 10) / 10,
    totalSlackCount: hasbels.reduce((s, h) => s + h.slackCount, 0),
    totalEffectiveMeters: Math.round(hasbels.reduce((s, h) => s + h.effectiveLength, 0) * 100) / 100,
    maxHasbelMeters,
    slackLengthMeters,
    slackIntervalMeters,
    sparePercent,
    snapToPole,
  };

  return {
    summary,
    hasbels: hasbels.map(({ pts, ...rest }) => rest),
    jointClosures,
    outBuffer,
    csvBuffer,
  };
}

module.exports = { splitKmzLinesByHasbel };
