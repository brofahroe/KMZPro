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

/**
 * Remove or hide selected KML folders (including SLACK HANGER).
 */
async function cleanKmzBuffer(buffer, filename = 'input.kmz', options = {}) {
  const targets = (
    Array.isArray(options.targets) && options.targets.length > 0
      ? options.targets
      : DEFAULT_TARGETS
  ).map((t) => t.trim().toUpperCase());

  const mode = options.mode === 'hide' ? 'hide' : 'remove';
  const outputFormat = options.outputFormat === 'kml' ? 'kml' : 'kmz';

  const extracted = await extractKmlFromBuffer(buffer, filename);
  const xmlDoc = new DOMParser().parseFromString(extracted.kmlText, 'text/xml');

  const counts = {};
  for (const t of targets) {
    counts[t] = { folders: 0, placemarks: 0 };
  }

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

  const breakdown = targets.map((t) => ({
    category: t,
    foldersAffected: counts[t].folders,
    placemarksAffected: counts[t].placemarks,
  }));

  const totalFoldersAffected = breakdown.reduce((s, b) => s + b.foldersAffected, 0);
  const totalPlacemarksAffected = breakdown.reduce((s, b) => s + b.placemarksAffected, 0);

  return {
    summary: {
      mode,
      outputFormat,
      originalSizeBytes: buffer.length,
      outputSizeBytes: outBuffer.length,
      totalFoldersAffected,
      totalPlacemarksAffected,
    },
    breakdown,
    outBuffer,
  };
}

module.exports = { cleanKmzBuffer, DEFAULT_TARGETS };
