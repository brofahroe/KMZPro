const { parseKmzBuffer } = require('./kmzParser');
const { pointToLineProj } = require('./geo');

/**
 * Extract cable type / core count from cable name (e.g. "-024-" -> "24C", "-036-" -> "36C").
 */
function extractCableType(cableName, cableKind) {
  const name = (cableName || '').trim();
  const coreMatch =
    name.match(/[-_\s](0?\d{2,3})[-_\s]S\d+/i) ||
    name.match(/(\d{2,3})\s*C\b/i) ||
    name.match(/[-_\s](012|024|036|048|072|096|144|288)[-_\s]/i);

  if (coreMatch) {
    const cores = parseInt(coreMatch[1], 10);
    return cableKind === 'feeder' ? `Feeder ${cores}C` : `ADSS ${cores}C`;
  }
  return cableKind === 'feeder' ? 'Feeder' : 'ADSS';
}

/**
 * Match a cable to its FDT by name prefix, or fallback to the single FDT in cluster.
 */
function matchCableFdt(cableName, fdts) {
  if (!fdts || fdts.length === 0) return '-';
  const upperCab = (cableName || '').toUpperCase();
  const sortedFdts = [...fdts].sort((a, b) => b.name.length - a.name.length);
  for (const f of sortedFdts) {
    if (upperCab.includes(f.name.toUpperCase())) {
      return f.name;
    }
  }
  if (fdts.length === 1) return fdts[0].name;
  return fdts.map((f) => f.name).join(' / ');
}

function csvEscape(val) {
  const str = String(val ?? '');
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function extractSegmentName(cableName, lineFolder, idx) {
  if (lineFolder && lineFolder !== 'MAIN') return lineFolder;
  const m = (cableName || '').match(/[-_\s](S\d{1,3})[-_\s]/i) || (cableName || '').match(/\b(S\d{1,3})\b/i);
  if (m) return m[1].toUpperCase();
  return `Segment ${idx + 1}`;
}

/**
 * Assign each FAT to its corresponding cable segment (by folder/name first, else nearest cable).
 */
function countFatsPerCable(cables, fats) {
  const counts = new Array(cables.length).fill(0);
  if (cables.length === 0 || fats.length === 0) return counts;

  const cablesByLine = {};
  cables.forEach((c, idx) => {
    cablesByLine[c.line] = cablesByLine[c.line] || [];
    cablesByLine[c.line].push(idx);
  });

  for (const fat of fats) {
    let matchedIdx = -1;

    // 1. Exact single-cable line folder match (not MAIN)
    if (fat.line && fat.line !== 'MAIN' && cablesByLine[fat.line]?.length === 1) {
      matchedIdx = cablesByLine[fat.line][0];
    }

    // 2. Match by FDT + Segment code in FAT name vs Cable name
    if (matchedIdx === -1 && fat.name) {
      const upperFat = fat.name.toUpperCase();
      const segMatch = upperFat.match(/[-_](S\d{1,3})[-_]/);
      if (segMatch) {
        const segCode = segMatch[1];
        const fdtPrefix = upperFat.split(segMatch[0])[0];
        matchedIdx = cables.findIndex((c) => {
          const uc = (c.name || '').toUpperCase();
          return uc.includes(segCode) && (!fdtPrefix || uc.includes(fdtPrefix));
        });
      }
    }

    // 3. Geometric nearest cable fallback
    if (matchedIdx === -1) {
      let bestDist = 1e9;
      for (let i = 0; i < cables.length; i++) {
        const d = pointToLineProj(fat.coord, cables[i].pts).dist;
        if (d < bestDist) {
          bestDist = d;
          matchedIdx = i;
        }
      }
    }

    if (matchedIdx !== -1) counts[matchedIdx] += 1;
  }

  return counts;
}

/**
 * Process multiple KMZ/KML files into a unified batch summary and CSV buffer.
 */
async function processBatchKmzToCsv(files) {
  const rows = [];
  const clusterSummaries = [];

  for (const file of files) {
    const kmz = await parseKmzBuffer(file.buffer, file.originalname);

    const totalPoles = kmz.poles.length;
    const newPoles = kmz.poles.filter((p) => p.isNew).length;
    const existingPoles = totalPoles - newPoles;
    const np7m2 = kmz.poles.filter((p) => p.label === 'NP7m2').length;
    const np7m3 = kmz.poles.filter((p) => p.label === 'NP7m3').length;
    const np7m4 = kmz.poles.filter((p) => p.label === 'NP7m4').length;
    const np9m4 = kmz.poles.filter((p) => p.label === 'NP9m4').length;
    const fdtCount = kmz.fdts.length;

    const fatCounts = countFatsPerCable(kmz.cables, kmz.fats);
    const cableEntries = kmz.cables.map((c, idx) => {
      const fdtId = matchCableFdt(c.name, kmz.fdts);
      const cableType = extractCableType(c.name, c.cableKind);
      const segmentName = extractSegmentName(c.name, c.line, idx);

      return {
        fdtId,
        line: segmentName,
        cableName: c.name,
        cableType,
        length2D: c.length2D,
        nominalLength: c.nominalLength,
        fatCount: fatCounts[idx],
      };
    });

    // Count how many lines belong to each FDT
    const linesPerFdt = {};
    for (const ce of cableEntries) {
      linesPerFdt[ce.fdtId] = (linesPerFdt[ce.fdtId] || 0) + 1;
    }

    clusterSummaries.push({
      filename: file.originalname,
      clusterName: kmz.clusterTitle,
      totalPoles,
      newPoles,
      existingPoles,
      fdtCount,
      totalLines: cableEntries.length,
      totalFats: kmz.fats.length,
    });

    if (cableEntries.length === 0) {
      rows.push({
        filename: file.originalname,
        clusterName: kmz.clusterTitle,
        totalPoles,
        newPoles,
        np7m2,
        np7m3,
        np7m4,
        np9m4,
        existingPoles,
        fdtCount,
        fdtId: kmz.fdts.map((f) => f.name).join(' / ') || '-',
        linesInFdt: 0,
        line: '-',
        cableName: '-',
        cableType: '-',
        length2D: 0,
        fatCount: kmz.fats.length,
      });
    } else {
      for (const ce of cableEntries) {
        rows.push({
          filename: file.originalname,
          clusterName: kmz.clusterTitle,
          totalPoles,
          newPoles,
          np7m2,
          np7m3,
          np7m4,
          np9m4,
          existingPoles,
          fdtCount,
          fdtId: ce.fdtId,
          linesInFdt: linesPerFdt[ce.fdtId] || 1,
          line: ce.line,
          cableName: ce.cableName,
          cableType: ce.cableType,
          length2D: ce.length2D,
          fatCount: ce.fatCount,
        });
      }
    }
  }

  const headers = [
    'FILE KMZ',
    'NAMA CLUSTER',
    'TOTAL POLE',
    'NEW POLE',
    'NP 7-2.5"',
    'NP 7-3"',
    'NP 7-4"',
    'NP 9-4"',
    'EXISTING POLE',
    'JUMLAH FDT',
    'FDT ID',
    'JUMLAH SEGMENT/LINE PER FDT',
    'SEGMENT / LINE',
    'NAMA KABEL',
    'JENIS KABEL',
    'PANJANG RUTE (m)',
    'JUMLAH FAT PER SEGMENT/LINE',
  ];

  const csvLines = [headers.map(csvEscape).join(',')];
  for (const r of rows) {
    csvLines.push(
      [
        r.filename,
        r.clusterName,
        r.totalPoles,
        r.newPoles,
        r.np7m2,
        r.np7m3,
        r.np7m4,
        r.np9m4,
        r.existingPoles,
        r.fdtCount,
        r.fdtId,
        r.linesInFdt,
        r.line,
        r.cableName,
        r.cableType,
        r.length2D,
        r.fatCount,
      ]
        .map(csvEscape)
        .join(',')
    );
  }

  // Add UTF-8 BOM so Excel opens Indonesian characters/headers cleanly
  const csvBuffer = Buffer.from('\uFEFF' + csvLines.join('\r\n'), 'utf8');
  return { clusterSummaries, rows, csvBuffer };
}

module.exports = { processBatchKmzToCsv };
