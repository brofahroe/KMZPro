const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');
const { parseCoords, lineLengthMeters } = require('./geo');

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  isArray: (name) => name === 'Folder' || name === 'Placemark',
  processEntities: {
    enabled: true,
    maxTotalExpansions: 100000,
  },
});

/**
 * Map KML pole folder name to short opname pole type label.
 */
function normalizePoleLabel(folderName) {
  const upper = (folderName || '').toUpperCase();
  if (/NEW POLE.*7-2\.5/.test(upper)) return 'NP7m2';
  if (/NEW POLE.*7-3/.test(upper)) return 'NP7m3';
  if (/NEW POLE.*7-4/.test(upper)) return 'NP7m4';
  if (/NEW POLE.*9-4/.test(upper)) return 'NP9m4';
  if (/EXISTING POLE.*PARTNER.*7-4/.test(upper)) return 'EPP7m4';
  if (/EXISTING POLE.*PARTNER.*9-4/.test(upper)) return 'EPP9m4';
  if (/EXISTING POLE.*7-2\.5/.test(upper)) return 'EP7m2';
  if (/EXISTING POLE.*7-3/.test(upper)) return 'EP7m3';
  if (/EXISTING POLE.*7-4/.test(upper)) return 'EP7m4';
  if (/EXISTING POLE.*9-4/.test(upper)) return 'EP9m4';
  return folderName;
}

/**
 * Extract nominal length in meters from a cable/sling name (e.g. "BLA-KDT-D01-024-S01-1337m" or "SW-177m").
 */
function extractNominalLength(name, fallback2D) {
  const m = (name || '').match(/(\d+(?:\.\d+)?)\s*m\b/i);
  if (m) return parseFloat(m[1]);
  return Math.round(fallback2D);
}

/**
 * Extract all LineString coordinate arrays from a Placemark (direct or inside MultiGeometry).
 */
function extractLineStringsFromPm(pm) {
  const results = [];
  const addLs = (ls) => {
    if (!ls) return;
    const arr = Array.isArray(ls) ? ls : [ls];
    for (const item of arr) {
      if (item && item.coordinates) {
        const pts = parseCoords(item.coordinates);
        if (pts.length >= 2) results.push(pts);
      }
    }
  };
  addLs(pm.LineString);
  if (pm.MultiGeometry) {
    const mgs = Array.isArray(pm.MultiGeometry) ? pm.MultiGeometry : [pm.MultiGeometry];
    for (const mg of mgs) addLs(mg.LineString);
  }
  return results;
}

function isFeederText(text) {
  const s = text || '';
  return (
    /(SUB\s*FEEDER|HUB\s*FEEDER|MAIN\s*FEEDER|FEEDER|UPLINK|BACKBONE)/i.test(s) ||
    /(?:^|[^A-Z])(MFM|MF|SFM|SF|HF)(?=[^A-Z]|$)/i.test(s)
  );
}

/**
 * Recursively walk KML folders (or Document) to collect FTTH network elements.
 */
function walkFolder(folder, currentLine, state, isDocRoot = false) {
  const fName = isDocRoot ? '' : (folder.name || '').toString().trim();
  const fUpper = fName.toUpperCase();

  let activeLine = currentLine;
  if (!isDocRoot && (/^(LINE|SEGMENT|SEG)\b/i.test(fName) || /^S\d{1,3}$/i.test(fName))) {
    activeLine = fName;
  }

  const placemarks = folder.Placemark || [];

  if (fUpper === 'FDT') {
    for (const pm of placemarks) {
      if (pm.Point && pm.Point.coordinates) {
        const pts = parseCoords(pm.Point.coordinates);
        if (pts.length > 0) {
          state.fdts.push({ name: pm.name || 'FDT', coord: pts[0] });
        }
      }
    }
  } else if (/^(NEW|EXISTING)\s+POLE/i.test(fUpper)) {
    const label = normalizePoleLabel(fName);
    const isNew = fUpper.startsWith('NEW POLE');
    for (const pm of placemarks) {
      if (pm.Point && pm.Point.coordinates) {
        const pts = parseCoords(pm.Point.coordinates);
        if (pts.length > 0) {
          state.poles.push({
            name: (pm.name || '').toString().trim(),
            folder: fName,
            label,
            isNew,
            line: activeLine || 'MAIN',
            coord: pts[0],
          });
        }
      }
    }
  } else if (fUpper === 'FAT') {
    for (const pm of placemarks) {
      if (pm.Point && pm.Point.coordinates) {
        const pts = parseCoords(pm.Point.coordinates);
        if (pts.length > 0) {
          state.fats.push({
            name: (pm.name || '').toString().trim(),
            line: activeLine || 'MAIN',
            coord: pts[0],
          });
        }
      }
    }
  } else if (fUpper === 'SLACK HANGER') {
    for (const pm of placemarks) {
      if (pm.Point && pm.Point.coordinates) {
        const pts = parseCoords(pm.Point.coordinates);
        if (pts.length > 0) {
          state.slacks.push({
            name: (pm.name || '').toString().trim(),
            line: activeLine || 'MAIN',
            coord: pts[0],
          });
        }
      }
    }
  } else if (/\bSLING\b/i.test(fUpper)) {
    for (const pm of placemarks) {
      for (const pts of extractLineStringsFromPm(pm)) {
        const len2D = lineLengthMeters(pts);
        state.slings.push({
          name: (pm.name || '').toString().trim(),
          line: activeLine || 'MAIN',
          pts,
          length2D: Math.round(len2D * 10) / 10,
          nominalLength: extractNominalLength(pm.name, len2D),
        });
      }
    }
  } else if (fUpper === 'BOUNDARY CLUSTER') {
    for (const pm of placemarks) {
      if (pm.name && !state.clusterLocation) {
        state.clusterLocation = pm.name.toString().trim();
      }
    }
  } else if (!/^BOUNDARY/i.test(fUpper) && !/\bDROP\b/i.test(fUpper)) {
    const isFeederFolder = isFeederText(fUpper);
    const isFeederDoc = isFeederText(state.docName);
    for (const pm of placemarks) {
      const lineArrays = extractLineStringsFromPm(pm);
      for (const pts of lineArrays) {
        const cName = (pm.name || fName || 'CABLE').toString().trim();
        const len2D = lineLengthMeters(pts);
        const isFeederName = isFeederText(cName);
        state.cables.push({
          name: cName,
          line: activeLine || 'MAIN',
          cableKind: isFeederFolder || isFeederName || isFeederDoc ? 'feeder' : 'distribusi',
          pts,
          length2D: Math.round(len2D * 10) / 10,
          nominalLength: extractNominalLength(cName, len2D),
        });
      }
    }
  }

  const subFolders = folder.Folder || [];
  for (const sub of subFolders) {
    walkFolder(sub, activeLine, state);
  }
}

/**
 * Parse a KMZ (or KML) buffer into structured FTTH network data.
 */
async function parseKmzBuffer(buffer, filename = 'input.kmz') {
  let kmlText = null;
  if (filename.toLowerCase().endsWith('.kml')) {
    kmlText = buffer.toString('utf8');
  } else {
    const zip = await JSZip.loadAsync(buffer);
    const kmlFile =
      zip.file('doc.kml') ||
      Object.values(zip.files).find((f) => f.name.toLowerCase().endsWith('.kml'));
    if (!kmlFile) {
      throw new Error('Tidak ditemukan file .kml di dalam arsip KMZ.');
    }
    kmlText = await kmlFile.async('string');
  }

  const parsed = xmlParser.parse(kmlText);
  const doc = parsed?.kml?.Document || parsed?.kml;
  if (!doc) {
    throw new Error('Struktur KML tidak valid (Document tidak ditemukan).');
  }

  const state = {
    docName: (doc.name || filename).toString().trim(),
    clusterCode: '',
    clusterLocation: '',
    fdts: [],
    poles: [],
    fats: [],
    slacks: [],
    cables: [],
    slings: [],
  };

  const topFolders = doc.Folder || [];
  if (topFolders.length > 0) {
    const firstTopName = (topFolders[0].name || '').toString().trim();
    if (
      firstTopName &&
      !/^(LINE|SEGMENT|SEG|NEW POLE|EXISTING POLE|FDT|FAT|SLACK|BOUNDARY|HP )/i.test(firstTopName)
    ) {
      state.clusterCode = firstTopName;
    }
  }
  walkFolder(doc, null, state, true);

  state.clusterTitle = [state.clusterCode, state.clusterLocation]
    .filter(Boolean)
    .join(' - ') || state.docName;

  return state;
}

module.exports = { parseKmzBuffer };
