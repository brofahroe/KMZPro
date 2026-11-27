const JSZip = require('jszip');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

const DEFAULT_TARGETS = [
  'BOUNDARY CLUSTER',
  'BOUNDARY FAT',
  'HP COVER',
  'HP UNCOVER',
  'SLACK HANGER',
];

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

function getDirectChild(parent, tagName) {
  for (let i = 0; i < parent.childNodes.length; i++) {
    const n = parent.childNodes[i];
    if (n.nodeType === 1 && n.nodeName === tagName) return n;
  }
  return null;
}

function getElementText(parent, tagName) {
  const el = getDirectChild(parent, tagName);
  return el ? (el.textContent || '').trim() : '';
}

function setVisibilityZero(xmlDoc, node) {
  let vis = getDirectChild(node, 'visibility');
  if (!vis) {
    vis = xmlDoc.createElement('visibility');
    const nameEl = getDirectChild(node, 'name');
    if (nameEl && nameEl.nextSibling) {
      node.insertBefore(vis, nameEl.nextSibling);
    } else {
      node.appendChild(vis);
    }
  }
  vis.textContent = '0';
}

function hideNodeRecursively(xmlDoc, folderNode) {
  setVisibilityZero(xmlDoc, folderNode);
  const subFolders = folderNode.getElementsByTagName('Folder');
  for (let i = 0; i < subFolders.length; i++) {
    setVisibilityZero(xmlDoc, subFolders[i]);
  }
  const placemarks = folderNode.getElementsByTagName('Placemark');
  for (let i = 0; i < placemarks.length; i++) {
    setVisibilityZero(xmlDoc, placemarks[i]);
  }
}

const FEATURE_TAGS = [
  'Placemark',
  'GroundOverlay',
  'ScreenOverlay',
  'PhotoOverlay',
  'NetworkLink',
];

function folderHasFeatures(folderNode) {
  for (const tag of FEATURE_TAGS) {
    if (folderNode.getElementsByTagName(tag).length > 0) return true;
  }
  return false;
}

function formatScaleValue(num) {
  return String(Math.round(num * 1000) / 1000);
}

/**
 * Resize KML <IconStyle><scale> elements matching `fromScale` (or all if `applyAll` is true) to `toScale`.
 */
function resizeIconStyles(xmlDoc, { fromScale = 0.8, toScale = 1.5, applyAll = false } = {}) {
  const iconStyles = Array.from(xmlDoc.getElementsByTagName('IconStyle'));
  const toText = formatScaleValue(toScale);
  let updatedCount = 0;

  for (const iconStyle of iconStyles) {
    const scaleEl = getDirectChild(iconStyle, 'scale');
    const hasExplicitScale = Boolean(scaleEl && (scaleEl.textContent || '').trim() !== '');
    const currentVal = hasExplicitScale ? parseFloat(scaleEl.textContent.trim()) : 1.0;

    if (!Number.isFinite(currentVal)) continue;

    const matches = applyAll || Math.abs(currentVal - fromScale) < 1e-4;
    if (!matches) continue;

    if (scaleEl) {
      scaleEl.textContent = toText;
    } else {
      const newScaleEl = xmlDoc.createElement('scale');
      newScaleEl.textContent = toText;
      const iconEl = getDirectChild(iconStyle, 'Icon');
      if (iconEl) {
        iconStyle.insertBefore(newScaleEl, iconEl);
      } else {
        iconStyle.appendChild(newScaleEl);
      }
    }
    updatedCount += 1;
  }

  return updatedCount;
}

/**
 * Remove or hide selected KML folders (including SLACK HANGER),
 * optionally remove empty folders, and optionally resize map icons.
 */
async function cleanKmzBuffer(buffer, filename = 'input.kmz', options = {}) {
  const removeEmptyFolders = Boolean(options.removeEmptyFolders);
  const resizeIcons = Boolean(options.resizeIcons);
  const iconScaleFrom =
    Number.isFinite(options.iconScaleFrom) && options.iconScaleFrom > 0
      ? options.iconScaleFrom
      : 0.8;
  const iconScaleTo =
    Number.isFinite(options.iconScaleTo) && options.iconScaleTo > 0
      ? options.iconScaleTo
      : 1.5;
  const iconScaleAll = Boolean(options.iconScaleAll);

  const hasExtraOptions = removeEmptyFolders || resizeIcons;
  const targets = (
    Array.isArray(options.targets)
      ? options.targets.length === 0 && !hasExtraOptions
        ? DEFAULT_TARGETS
        : options.targets
      : DEFAULT_TARGETS
  )
    .map((t) => String(t).trim().toUpperCase())
    .filter(Boolean);

  const mode = options.mode === 'hide' ? 'hide' : 'remove';
  const outputFormat = options.outputFormat === 'kml' ? 'kml' : 'kmz';

  const extracted = await extractKmlFromBuffer(buffer, filename);
  const xmlDoc = new DOMParser().parseFromString(extracted.kmlText, 'text/xml');

  const counts = {};
  for (const t of targets) {
    counts[t] = { folders: 0, placemarks: 0 };
  }

  // 1. Remove or hide selected target folders
  if (targets.length > 0) {
    // Snapshot folders so DOM mutations don't shift iteration
    const allFolders = Array.from(xmlDoc.getElementsByTagName('Folder'));
    for (const folder of allFolders) {
      // Skip if already detached as part of a parent folder
      if (!folder.parentNode) continue;

      const fName = getElementText(folder, 'name').toUpperCase();
      if (!targets.includes(fName)) continue;

      const pmCount = folder.getElementsByTagName('Placemark').length;
      counts[fName].folders += 1;
      counts[fName].placemarks += pmCount;

      if (mode === 'hide') {
        hideNodeRecursively(xmlDoc, folder);
      } else {
        folder.parentNode.removeChild(folder);
      }
    }
  }

  // 2. Remove empty folders (bottom-up so nested empty folders are removed too)
  let emptyFoldersRemoved = 0;
  if (removeEmptyFolders) {
    const remainingFolders = Array.from(xmlDoc.getElementsByTagName('Folder'));
    for (let i = remainingFolders.length - 1; i >= 0; i--) {
      const folder = remainingFolders[i];
      if (!folder.parentNode) continue;
      if (
        !folderHasFeatures(folder) &&
        folder.getElementsByTagName('Folder').length === 0
      ) {
        folder.parentNode.removeChild(folder);
        emptyFoldersRemoved += 1;
      }
    }
  }

  // 3. Resize map icon styles (e.g. 0.8 -> 1.5)
  let iconsResized = 0;
  if (resizeIcons) {
    iconsResized = resizeIconStyles(xmlDoc, {
      fromScale: iconScaleFrom,
      toScale: iconScaleTo,
      applyAll: iconScaleAll,
    });
  }

  const updatedKml = new XMLSerializer().serializeToString(xmlDoc);
  const kmlBuffer = Buffer.from(updatedKml, 'utf8');

  let outBuffer;
  if (outputFormat === 'kml') {
    outBuffer = kmlBuffer;
  } else {
    const outZip = extracted.zip || new JSZip();
    outZip.file(extracted.kmlName, updatedKml);
    outBuffer = await outZip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    });
  }

  const targetStatusLabel =
    mode === 'hide' ? 'Disembunyikan (visibility=0)' : 'Dihapus Permanen';

  const breakdown = targets.map((t) => ({
    category: t,
    foldersAffected: counts[t].folders,
    placemarksAffected: counts[t].placemarks,
    affected: counts[t].folders > 0,
    statusLabel: counts[t].folders > 0 ? targetStatusLabel : 'Tidak ditemukan',
  }));

  if (removeEmptyFolders) {
    breakdown.push({
      category: 'FOLDER KOSONG',
      foldersAffected: emptyFoldersRemoved,
      placemarksAffected: 0,
      affected: emptyFoldersRemoved > 0,
      statusLabel:
        emptyFoldersRemoved > 0 ? 'Dihapus Permanen' : 'Tidak ditemukan',
    });
  }

  if (resizeIcons) {
    const fromLabel = iconScaleAll ? 'Semua' : formatScaleValue(iconScaleFrom);
    const toLabel = formatScaleValue(iconScaleTo);
    breakdown.push({
      category: `ICON MAP (${fromLabel} → ${toLabel})`,
      foldersAffected: '-',
      placemarksAffected: `${iconsResized} style`,
      affected: iconsResized > 0,
      statusLabel:
        iconsResized > 0
          ? `Diperbesar (${fromLabel} → ${toLabel})`
          : 'Tidak ditemukan',
    });
  }

  const totalTargetFolders = targets.reduce((s, t) => s + counts[t].folders, 0);
  const totalFoldersAffected = totalTargetFolders + emptyFoldersRemoved;
  const totalPlacemarksAffected = targets.reduce((s, t) => s + counts[t].placemarks, 0);

  return {
    summary: {
      mode,
      outputFormat,
      originalSizeBytes: buffer.length,
      outputSizeBytes: outBuffer.length,
      totalFoldersAffected,
      totalPlacemarksAffected,
      removeEmptyFolders,
      emptyFoldersRemoved,
      resizeIcons,
      iconsResized,
      iconScaleFrom,
      iconScaleTo,
      iconScaleAll,
    },
    breakdown,
    outBuffer,
  };
}

module.exports = { cleanKmzBuffer, DEFAULT_TARGETS };
