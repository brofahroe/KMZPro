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
 * Check if a DOM node is nested inside a Folder whose name matches regex.
 */
function isInsideFolderMatching(node, regex) {
  let cur = node ? node.parentNode : null;
  while (cur) {
    if (cur.nodeType === 1 && cur.nodeName === 'Folder') {
      const fName = getElementText(cur, 'name');
      if (regex.test(fName)) return true;
    }
    cur = cur.parentNode;
  }
  return false;
}

/**
 * Collect all LineString coordinate arrays from a KML document.
 * When excludeBoundaryAndDrop is true, skips BOUNDARY and DROP folders (falling back to all if empty).
 */
function extractAllLineStrings(kmlText, excludeBoundaryAndDrop = false) {
  const doc = new DOMParser().parseFromString(kmlText, 'text/xml');
  const lineNodes = doc.getElementsByTagName('LineString');
  const filtered = [];
  const all = [];
  for (let i = 0; i < lineNodes.length; i++) {
    const coordEl = getDirectChild(lineNodes[i], 'coordinates');
    if (coordEl && coordEl.textContent) {
      const pts = parseCoords(coordEl.textContent);
      if (pts.length >= 2) {
        all.push(pts);
        if (
          !excludeBoundaryAndDrop ||
          !isInsideFolderMatching(lineNodes[i], /^(BOUNDARY\b|.*\bDROP\b)/i)
        ) {
          filtered.push(pts);
        }
      }
    }
  }
  return excludeBoundaryAndDrop && filtered.length > 0 ? filtered : all;
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
 * Inject or replace a custom Style element for poles in <Document>.
 */
function ensureCustomStyle(xmlDoc, targetDocEl, styleId, kmlColor) {
  // Remove any existing Style with the same id to avoid duplicates
  const existingStyles = Array.from(targetDocEl.getElementsByTagName('Style'));
  for (const st of existingStyles) {
    if (st.getAttribute('id') === styleId && st.parentNode) {
      st.parentNode.removeChild(st);
    }
  }

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
 * Apply styleUrl to a Placemark, removing any inline <Style> that would override it.
 */
function applyStyleUrlToPlacemark(xmlDoc, pm, targetStyleUrl) {
  const inlineStyles = getDirectChildren(pm, 'Style');
  for (const st of inlineStyles) {
    pm.removeChild(st);
  }
  let styleUrlEl = getDirectChild(pm, 'styleUrl');
  if (!styleUrlEl) {
    styleUrlEl = xmlDoc.createElement('styleUrl');
    pm.appendChild(styleUrlEl);
  }
  styleUrlEl.textContent = targetStyleUrl;
}

/**
 * Find nearest parent folder name representing a LINE/SEGMENT, or fallback to immediate folder.
 */
function resolveLineName(folder) {
  let cur = folder ? folder.parentNode : null;
  while (cur && cur.nodeType === 1 && cur.nodeName === 'Folder') {
    const name = getElementText(cur, 'name');
    if (name && (/^(LINE|SEGMENT|SEG)\b/i.test(name) || /^S\d{1,3}$/i.test(name))) {
      return name;
    }
    cur = cur.parentNode;
  }
  const parent = folder ? folder.parentNode : null;
  if (parent && parent.nodeType === 1 && parent.nodeName === 'Folder') {
    return getElementText(parent, 'name') || 'MAIN';
  }
  return 'MAIN';
}

/**
 * Edit KMZ poles:
 * - mode 'upgrade_to_4': Base = Cluster KMZ, Ref = MF KMZ -> move 2.5" & 3" poles along MF route to NEW POLE 7-4
 * - mode 'mf_to_white': Base = MF Pole KMZ, Ref = Cluster KMZ(s) -> recolor MF poles intersecting cluster routes to white
 */
async function editKmzForMf(baseBuffer, baseFilename, refInput, maybeRefFilename, maybeOptions) {
  let refFiles = [];
  let options = {};
  if (Array.isArray(refInput)) {
    refFiles = refInput;
    options = maybeRefFilename || {};
  } else {
    refFiles = [{ buffer: refInput, filename: maybeRefFilename || 'ref.kmz' }];
    options = maybeOptions || {};
  }

  const mode = options.mode === 'mf_to_white' ? 'mf_to_white' : 'upgrade_to_4';
  const toleranceMeters = Number.isFinite(options.toleranceMeters)
    ? options.toleranceMeters
    : 5.0;
  const overrideColor = Boolean(options.overrideColor);
  const customHexColor =
    options.poleColor || (mode === 'mf_to_white' ? '#ffffff' : '#ef4444');

  const baseExtracted = await extractKmlFromBuffer(baseBuffer, baseFilename);

  const refLines = [];
  for (const rf of refFiles) {
    const extracted = await extractKmlFromBuffer(rf.buffer, rf.filename);
    const lines = extractAllLineStrings(extracted.kmlText, mode === 'mf_to_white');
    refLines.push(...lines);
  }
  if (refLines.length === 0) {
    throw new Error(
      mode === 'mf_to_white'
        ? 'Tidak ditemukan jalur kabel (LineString) di dalam KMZ Cluster.'
        : 'Tidak ditemukan jalur kabel (LineString) di dalam KMZ Jalur MF.'
    );
  }

  const xmlDoc = new DOMParser().parseFromString(baseExtracted.kmlText, 'text/xml');
  const documentEl =
    xmlDoc.getElementsByTagName('Document')[0] || xmlDoc.documentElement;

  const changes = [];
  let totalCandidatePoles = 0;
  let targetStyleUrl = '';

  if (mode === 'mf_to_white') {
    const customStyleId = 'kmzpro_pole_mf_white';
    ensureCustomStyle(
      xmlDoc,
      documentEl,
      customStyleId,
      hexToKmlColor(customHexColor)
    );
    targetStyleUrl = `#${customStyleId}`;

    const poleFolderRegex = /(?:NEW|EXISTING)\s+POLE|\bPOLE\b|\bTIANG\b/i;
    const nonPoleFolderRegex = /^(FDT|FAT|SLACK|BOUNDARY|HP\b|JC\b|JOINT\s*CLOSURE|OLT|ODP|ODC|SLING)/i;

    const allFolders = Array.from(xmlDoc.getElementsByTagName('Folder'));
    const poleFolders = allFolders.filter((f) =>
      poleFolderRegex.test(getElementText(f, 'name'))
    );

    const candidateEntries = [];
    if (poleFolders.length > 0) {
      for (const folder of poleFolders) {
        const folderName = getElementText(folder, 'name') || 'POLE';
        const lineName = resolveLineName(folder);
        const placemarks = getDirectChildren(folder, 'Placemark');
        for (const pm of placemarks) {
          candidateEntries.push({
            pm,
            sourceContainer: folder,
            targetParent: folder.parentNode || documentEl,
            folderName,
            lineName,
          });
        }
      }
    } else {
      // Fallback: inspect all Point placemarks not inside non-pole folders
      const allPlacemarks = Array.from(xmlDoc.getElementsByTagName('Placemark'));
      for (const pm of allPlacemarks) {
        const parent = pm.parentNode;
        const folderName =
          parent && parent.nodeName === 'Folder'
            ? getElementText(parent, 'name') || 'ROOT'
            : 'ROOT';
        if (nonPoleFolderRegex.test(folderName)) continue;
        if (isInsideFolderMatching(pm, nonPoleFolderRegex)) continue;
        const lineName =
          parent && parent.nodeName === 'Folder' ? resolveLineName(parent) : 'MAIN';
        candidateEntries.push({
          pm,
          sourceContainer: parent || documentEl,
          targetParent: parent || documentEl,
          folderName,
          lineName,
        });
      }
    }

    const colorLabel =
      customHexColor.toUpperCase() === '#FFFFFF'
        ? 'Putih'
        : customHexColor.toUpperCase();

    for (const { pm, sourceContainer, targetParent, folderName, lineName } of candidateEntries) {
      const pointEl = getDirectChild(pm, 'Point');
      if (!pointEl) continue;
      const coordText = getElementText(pointEl, 'coordinates');
      const pts = parseCoords(coordText);
      if (pts.length === 0) continue;

      totalCandidatePoles++;
      const coord = pts[0];

      let minDist = 1e9;
      for (const refPts of refLines) {
        const pr = pointToLineProj(coord, refPts);
        if (pr.dist < minDist) minDist = pr.dist;
      }

      if (minDist <= toleranceMeters) {
        const poleId = getElementText(pm, 'name') || '(Tanpa Nama)';
        applyStyleUrlToPlacemark(xmlDoc, pm, targetStyleUrl);

        // Find or create sibling "POLE CLUSTER" folder (unless already inside one)
        let targetClusterFolder = null;
        if (
          sourceContainer.nodeName === 'Folder' &&
          /^POLE\s+CLUSTER$/i.test(getElementText(sourceContainer, 'name'))
        ) {
          targetClusterFolder = sourceContainer;
        } else {
          const siblingFolders = getDirectChildren(targetParent, 'Folder');
          for (const sib of siblingFolders) {
            if (/^POLE\s+CLUSTER$/i.test(getElementText(sib, 'name'))) {
              targetClusterFolder = sib;
              break;
            }
          }
          if (!targetClusterFolder) {
            targetClusterFolder = xmlDoc.createElement('Folder');
            const nameEl = xmlDoc.createElement('name');
            nameEl.textContent = 'POLE CLUSTER';
            targetClusterFolder.appendChild(nameEl);
            targetParent.appendChild(targetClusterFolder);
          }
          if (pm.parentNode && pm.parentNode !== targetClusterFolder) {
            pm.parentNode.removeChild(pm);
            targetClusterFolder.appendChild(pm);
          }
        }

        changes.push({
          poleId,
          line: lineName,
          fromFolder: folderName,
          toFolder: `POLE CLUSTER (${colorLabel})`,
          distanceMeters: Math.round(minDist * 100) / 100,
        });
      }
    }
  } else {
    targetStyleUrl = overrideColor ? null : findExisting74StyleUrl(xmlDoc);
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
        for (const mfPts of refLines) {
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

          // Update styleUrl (removing any overriding inline Style)
          applyStyleUrlToPlacemark(xmlDoc, pm, targetStyleUrl);

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
      mode,
      mfLineCount: refLines.length,
      totalCandidatePoles,
      changedCount: changes.length,
      unchangedCount: totalCandidatePoles - changes.length,
      targetStyleUrl,
      poleColor: customHexColor,
      toleranceMeters,
    },
    changes,
    kmzBuffer,
  };
}

module.exports = { editKmzForMf };
