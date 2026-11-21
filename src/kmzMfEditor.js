const JSZip = require('jszip');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const { parseCoords, pointToLineProj } = require('./geo');

/**
 * Extract KML string from a KMZ or KML buffer, returning { zip, kmlName, kmlText }.
 */
async function extractKmlFromBuffer(buffer, filename = 'input.kmz') {
  if (filename.toLowerCase().endsWith('.kml')) {
    return { zip: null, kmlName: filename, kmlText: buffer.toString('utf8') };
  }
  const zip = await JSZip.loadAsync(buffer);
  const kmlFile =
    zip.file('doc.kml') ||
    Object.values(zip.files).find((f) => f.name.toLowerCase().endsWith('.kml'));
  if (!kmlFile) {
    throw new Error(`Tidak ditemukan file .kml di dalam ${filename}`);
  }
  const kmlText = await kmlFile.async('string');
  return { zip, kmlName: kmlFile.name, kmlText };
}

/**
 * Convert #RRGGBB hex color to KML aabbggrr color (full opacity ff).
 */
function hexToKmlColor(hex) {
  const clean = (hex || '#ef4444').replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return 'ff4444ef';
  const rr = clean.slice(0, 2);
  const gg = clean.slice(2, 4);
  const bb = clean.slice(4, 6);
  return `ff${bb}${gg}${rr}`.toLowerCase();
}

/**
 * Get direct child element by tag name.
 */
function getDirectChild(parent, tagName) {
  for (let i = 0; i < parent.childNodes.length; i++) {
    const n = parent.childNodes[i];
    if (n.nodeType === 1 && n.nodeName === tagName) return n;
  }
  return null;
}

/**
 * Get direct child elements by tag name.
 */
function getDirectChildren(parent, tagName) {
  const res = [];
  for (let i = 0; i < parent.childNodes.length; i++) {
    const n = parent.childNodes[i];
    if (n.nodeType === 1 && n.nodeName === tagName) res.push(n);
  }
  return res;
}

function getElementText(parent, tagName) {
  const el = getDirectChild(parent, tagName);
  return el ? (el.textContent || '').trim() : '';
}

/**
 * Collect all LineString coordinate arrays from a KML document.
 */
function extractAllLineStrings(kmlText) {
  const doc = new DOMParser().parseFromString(kmlText, 'text/xml');
  const lineNodes = doc.getElementsByTagName('LineString');
  const lines = [];
  for (let i = 0; i < lineNodes.length; i++) {
    const coordEl = getDirectChild(lineNodes[i], 'coordinates');
    if (coordEl && coordEl.textContent) {
      const pts = parseCoords(coordEl.textContent);
      if (pts.length >= 2) lines.push(pts);
    }
  }
  return lines;
}

/**
 * Find first styleUrl used inside any NEW POLE 7-4 folder.
 */
function findExisting74StyleUrl(rootDoc) {
  const folders = rootDoc.getElementsByTagName('Folder');
  for (let i = 0; i < folders.length; i++) {
    const name = getElementText(folders[i], 'name');
    if (/^NEW\s+POLE\s+7-4$/i.test(name)) {
      const pms = getDirectChildren(folders[i], 'Placemark');
      for (const pm of pms) {
        const sUrl = getElementText(pm, 'styleUrl');
        if (sUrl) return sUrl;
      }
    }
  }
  return null;
}

/**
 * Inject or replace a custom Style element for 4-inch poles in <Document>.
 */
function ensureCustomStyle(xmlDoc, targetDocEl, styleId, kmlColor) {
  const styleEl = xmlDoc.createElement('Style');
  styleEl.setAttribute('id', styleId);

  const iconStyle = xmlDoc.createElement('IconStyle');
  const colorEl = xmlDoc.createElement('color');
  colorEl.textContent = kmlColor;
  const scaleEl = xmlDoc.createElement('scale');
  scaleEl.textContent = '1.1';
  const iconEl = xmlDoc.createElement('Icon');
  const hrefEl = xmlDoc.createElement('href');
  hrefEl.textContent =
    'http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png';
  iconEl.appendChild(hrefEl);
  iconStyle.appendChild(colorEl);
  iconStyle.appendChild(scaleEl);
  iconStyle.appendChild(iconEl);

  const labelStyle = xmlDoc.createElement('LabelStyle');
  const lblScale = xmlDoc.createElement('scale');
  lblScale.textContent = '0.7';
  labelStyle.appendChild(lblScale);

  styleEl.appendChild(iconStyle);
  styleEl.appendChild(labelStyle);

  // Insert before first Folder or Placemark
  const firstFolder = getDirectChild(targetDocEl, 'Folder');
  if (firstFolder) {
    targetDocEl.insertBefore(styleEl, firstFolder);
  } else {
    targetDocEl.appendChild(styleEl);
  }
}

/**
 * Edit KMZ poles (2.5" and 3" -> 4") that lie along MF cable routes.
 */
async function editKmzForMf(baseBuffer, baseFilename, mfBuffer, mfFilename, options = {}) {
  const toleranceMeters = Number.isFinite(options.toleranceMeters)
    ? options.toleranceMeters
    : 5.0;
  const overrideColor = Boolean(options.overrideColor);
  const customHexColor = options.poleColor || '#ef4444';

  const baseExtracted = await extractKmlFromBuffer(baseBuffer, baseFilename);
  const mfExtracted = await extractKmlFromBuffer(mfBuffer, mfFilename);

  const mfLines = extractAllLineStrings(mfExtracted.kmlText);
  if (mfLines.length === 0) {
    throw new Error('Tidak ditemukan jalur kabel (LineString) di dalam KMZ Jalur MF.');
  }

  const xmlDoc = new DOMParser().parseFromString(baseExtracted.kmlText, 'text/xml');
  const documentEl =
    xmlDoc.getElementsByTagName('Document')[0] || xmlDoc.documentElement;

  let targetStyleUrl = overrideColor ? null : findExisting74StyleUrl(xmlDoc);
  if (!targetStyleUrl) {
    const customStyleId = 'kmzpro_pole_7_4';
    ensureCustomStyle(
      xmlDoc,
      documentEl,
      customStyleId,
      hexToKmlColor(customHexColor)
    );
    targetStyleUrl = `#${customStyleId}`;
  }

  const allFolders = Array.from(xmlDoc.getElementsByTagName('Folder'));
  let totalCandidatePoles = 0;
  const changes = [];

  for (const folder of allFolders) {
    const folderName = getElementText(folder, 'name');
    if (!/^NEW\s+POLE\s+7-(2\.5|3)$/i.test(folderName)) continue;

    const parentFolder = folder.parentNode;
    const parentLineName =
      parentFolder && parentFolder.nodeName === 'Folder'
        ? getElementText(parentFolder, 'name') || 'MAIN'
        : 'MAIN';

    const placemarks = getDirectChildren(folder, 'Placemark');
    for (const pm of placemarks) {
      const pointEl = getDirectChild(pm, 'Point');
      if (!pointEl) continue;
      const coordText = getElementText(pointEl, 'coordinates');
      const pts = parseCoords(coordText);
      if (pts.length === 0) continue;

      totalCandidatePoles++;
      const coord = pts[0];

      let minDist = 1e9;
      for (const mfPts of mfLines) {
        const pr = pointToLineProj(coord, mfPts);
        if (pr.dist < minDist) minDist = pr.dist;
      }

      if (minDist <= toleranceMeters) {
        const poleId = getElementText(pm, 'name') || '(Tanpa Nama)';

        // Find or create sibling NEW POLE 7-4 folder
        let target74Folder = null;
        const siblingFolders = getDirectChildren(parentFolder, 'Folder');
        for (const sib of siblingFolders) {
          if (/^NEW\s+POLE\s+7-4$/i.test(getElementText(sib, 'name'))) {
            target74Folder = sib;
            break;
          }
        }
        if (!target74Folder) {
          target74Folder = xmlDoc.createElement('Folder');
          const nameEl = xmlDoc.createElement('name');
          nameEl.textContent = 'NEW POLE 7-4';
          target74Folder.appendChild(nameEl);
          parentFolder.appendChild(target74Folder);
        }

        // Update styleUrl
        let styleUrlEl = getDirectChild(pm, 'styleUrl');
        if (!styleUrlEl) {
          styleUrlEl = xmlDoc.createElement('styleUrl');
          pm.appendChild(styleUrlEl);
        }
        styleUrlEl.textContent = targetStyleUrl;

        // Move placemark to NEW POLE 7-4
        folder.removeChild(pm);
        target74Folder.appendChild(pm);

        changes.push({
          poleId,
          line: parentLineName,
          fromFolder: folderName,
          toFolder: 'NEW POLE 7-4',
          distanceMeters: Math.round(minDist * 100) / 100,
        });
      }
    }
  }

  const updatedKml = new XMLSerializer().serializeToString(xmlDoc);

  // Repack into KMZ (preserving any other assets in original KMZ)
  const outZip = baseExtracted.zip || new JSZip();
  outZip.file(baseExtracted.kmlName, updatedKml);
  const kmzBuffer = await outZip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });

  return {
    summary: {
      mfLineCount: mfLines.length,
      totalCandidatePoles,
      changedCount: changes.length,
      unchangedCount: totalCandidatePoles - changes.length,
      targetStyleUrl,
      toleranceMeters,
    },
    changes,
    kmzBuffer,
  };
}

module.exports = { editKmzForMf };
