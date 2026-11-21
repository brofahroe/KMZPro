const express = require('express');
const multer = require('multer');
const path = require('path');
const { parseKmzBuffer } = require('./kmzParser');
const { calculateOpname } = require('./opnameCalculator');
const { buildOpnameWorkbookBuffer, buildMultiOpnameWorkbookBuffer } = require('./excelExporter');
const { editKmzForMf } = require('./kmzMfEditor');
const { cleanKmzBuffer } = require('./kmzCleaner');
const { processBatchKmzToCsv } = require('./batchCsvExporter');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 500 },
});

app.use(express.static(path.join(__dirname, '..', 'public')));

function parseOptions(body = {}) {
  const angleThreshold = parseFloat(body.angleThreshold);
  const maxConsecSusp = parseInt(body.maxConsecSusp, 10);
  const slackIntervalMeters = parseFloat(body.slackIntervalMeters);
  const includeExisting =
    body.includeExisting === undefined
      ? true
      : body.includeExisting === 'true' || body.includeExisting === true;
  const networkMode = ['auto', 'distribusi', 'feeder'].includes(body.networkMode)
    ? body.networkMode
    : 'auto';

  return {
    angleThreshold: Number.isFinite(angleThreshold) ? angleThreshold : 30.0,
    maxConsecSusp: Number.isFinite(maxConsecSusp) ? maxConsecSusp : 2,
    slackIntervalMeters: Number.isFinite(slackIntervalMeters) ? slackIntervalMeters : 400,
    includeExisting,
    networkMode,
  };
}

const opnameUpload = upload.fields([
  { name: 'kmzFiles', maxCount: 500 },
  { name: 'kmzFile', maxCount: 1 },
]);

function extractUploadedFiles(req) {
  const arr = req.files?.kmzFiles || [];
  if (arr.length > 0) return arr;
  const single = req.files?.kmzFile || [];
  return single;
}

async function processOpnameFiles(files, options) {
  const opnameList = [];
  for (const f of files) {
    const kmzData = await parseKmzBuffer(f.buffer, f.originalname);
    const op = calculateOpname(kmzData, options);
    opnameList.push(op);
  }

  if (opnameList.length === 1) {
    return { isMulti: false, opnameList, opname: opnameList[0] };
  }

  const combinedRows = [];
  const combinedCables = [];
  const combinedSlings = [];
  const poleByLabel = {};
  const zeroAccPoles = [];
  const totals = {
    totalPoles: 0,
    newPoles: 0,
    existingPoles: 0,
    deadEnd: 0,
    suspension: 0,
    slackHanger: 0,
    poleClamp: 0,
    buldogGrip: 0,
    slingWireMeters: 0,
    cableNominalMeters: 0,
    cable2DMeters: 0,
    poleByLabel,
    zeroAccPoles,
  };

  for (const op of opnameList) {
    for (const r of op.rows) {
      combinedRows.push({ ...r, cluster: op.clusterTitle });
    }
    for (const c of op.cables) {
      combinedCables.push({ ...c, line: `${op.clusterTitle} | ${c.line}` });
    }
    combinedSlings.push(...op.slings);

    const t = op.totals;
    totals.totalPoles += t.totalPoles;
    totals.newPoles += t.newPoles;
    totals.existingPoles += t.existingPoles;
    totals.deadEnd += t.deadEnd;
    totals.suspension += t.suspension;
    totals.slackHanger += t.slackHanger;
    totals.poleClamp += t.poleClamp;
    totals.buldogGrip += t.buldogGrip;
    totals.slingWireMeters += t.slingWireMeters;
    totals.cableNominalMeters += t.cableNominalMeters;
    totals.cable2DMeters += t.cable2DMeters;
    for (const [lbl, cnt] of Object.entries(t.poleByLabel)) {
      poleByLabel[lbl] = (poleByLabel[lbl] || 0) + cnt;
    }
    zeroAccPoles.push(...t.zeroAccPoles);
  }

  const opname = {
    clusterTitle: `${opnameList.length} Cluster (${opnameList.map((o) => o.clusterTitle).join(', ')})`,
    cables: combinedCables,
    slings: combinedSlings,
    rows: combinedRows,
    totals,
  };

  return { isMulti: true, opnameList, opname };
}

app.post('/api/analyze', opnameUpload, async (req, res) => {
  try {
    const files = extractUploadedFiles(req);
    if (files.length === 0) {
      return res.status(400).json({ error: 'File KMZ/KML wajib diunggah.' });
    }
    const result = await processOpnameFiles(files, parseOptions(req.body));
    res.json({
      filename: files.map((f) => f.originalname).join(', '),
      fileCount: files.length,
      opname: result.opname,
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Gagal memproses file KMZ.' });
  }
});

app.post('/api/export', opnameUpload, async (req, res) => {
  try {
    const files = extractUploadedFiles(req);
    if (files.length === 0) {
      return res.status(400).json({ error: 'File KMZ/KML wajib diunggah.' });
    }
    const result = await processOpnameFiles(files, parseOptions(req.body));
    const xlsxBuffer = result.isMulti
      ? await buildMultiOpnameWorkbookBuffer(result.opnameList, result.opname)
      : await buildOpnameWorkbookBuffer(result.opname);

    const outName = result.isMulti
      ? `Opname_Gabungan_${files.length}_File.xlsx`
      : `Opname_${path
          .basename(files[0].originalname, path.extname(files[0].originalname))
          .replace(/[^\w\- ]+/g, '_')}.xlsx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
    res.send(Buffer.from(xlsxBuffer));
  } catch (err) {
    res.status(400).json({ error: err.message || 'Gagal mengekspor Excel.' });
  }
});

const mfUpload = upload.fields([
  { name: 'baseKmz', maxCount: 1 },
  { name: 'mfKmz', maxCount: 1 },
]);

function parseMfOptions(body = {}) {
  const toleranceMeters = parseFloat(body.toleranceMeters);
  const overrideColor =
    body.overrideColor === 'true' || body.overrideColor === true;
  return {
    toleranceMeters: Number.isFinite(toleranceMeters) ? toleranceMeters : 5.0,
    overrideColor,
    poleColor: body.poleColor || '#ef4444',
  };
}

app.post('/api/mf-preview', mfUpload, async (req, res) => {
  try {
    const baseFile = req.files?.baseKmz?.[0];
    const mfFile = req.files?.mfKmz?.[0];
    if (!baseFile || !mfFile) {
      return res.status(400).json({ error: 'KMZ Awal dan KMZ Jalur MF wajib diunggah.' });
    }
    const result = await editKmzForMf(
      baseFile.buffer,
      baseFile.originalname,
      mfFile.buffer,
      mfFile.originalname,
      parseMfOptions(req.body)
    );
    res.json({ summary: result.summary, changes: result.changes });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Gagal memproses edit KMZ.' });
  }
});

app.post('/api/mf-export', mfUpload, async (req, res) => {
  try {
    const baseFile = req.files?.baseKmz?.[0];
    const mfFile = req.files?.mfKmz?.[0];
    if (!baseFile || !mfFile) {
      return res.status(400).json({ error: 'KMZ Awal dan KMZ Jalur MF wajib diunggah.' });
    }
    const result = await editKmzForMf(
      baseFile.buffer,
      baseFile.originalname,
      mfFile.buffer,
      mfFile.originalname,
      parseMfOptions(req.body)
    );
    const baseName = path
      .basename(baseFile.originalname, path.extname(baseFile.originalname))
      .replace(/[^\w\- ]+/g, '_');
    const outName = `${baseName}_EDITED_MF.kmz`;

    res.setHeader('Content-Type', 'application/vnd.google-earth.kmz');
    res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
    res.send(result.kmzBuffer);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Gagal mengekspor KMZ hasil edit.' });
  }
});

function parseCleanOptions(body = {}) {
  let targets = [];
  if (typeof body.targets === 'string') {
    try {
      targets = JSON.parse(body.targets);
    } catch {
      targets = body.targets.split(',').map((s) => s.trim()).filter(Boolean);
    }
  } else if (Array.isArray(body.targets)) {
    targets = body.targets;
  }
  return {
    targets,
    mode: body.mode === 'hide' ? 'hide' : 'remove',
    outputFormat: body.outputFormat === 'kml' ? 'kml' : 'kmz',
  };
}

app.post('/api/clean-preview', upload.single('kmzFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File KMZ/KML wajib diunggah.' });
    }
    const result = await cleanKmzBuffer(
      req.file.buffer,
      req.file.originalname,
      parseCleanOptions(req.body)
    );
    res.json({ summary: result.summary, breakdown: result.breakdown });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Gagal memproses pembersihan KMZ.' });
  }
});

app.post('/api/clean-export', upload.single('kmzFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File KMZ/KML wajib diunggah.' });
    }
    const opts = parseCleanOptions(req.body);
    const result = await cleanKmzBuffer(
      req.file.buffer,
      req.file.originalname,
      opts
    );
    const baseName = path
      .basename(req.file.originalname, path.extname(req.file.originalname))
      .replace(/[^\w\- ]+/g, '_');
    const ext = opts.outputFormat === 'kml' ? 'kml' : 'kmz';
    const outName = `${baseName}_CLEAN.${ext}`;

    res.setHeader(
      'Content-Type',
      ext === 'kml'
        ? 'application/vnd.google-earth.kml+xml'
        : 'application/vnd.google-earth.kmz'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
    res.send(result.outBuffer);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Gagal mengekspor KMZ/KML.' });
  }
});

app.post('/api/batch-preview', upload.array('kmzFiles', 500), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Pilih minimal 1 file KMZ/KML.' });
    }
    const result = await processBatchKmzToCsv(req.files);
    res.json({
      clusterSummaries: result.clusterSummaries,
      rows: result.rows,
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Gagal memproses batch KMZ.' });
  }
});

app.post('/api/batch-export', upload.array('kmzFiles', 500), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Pilih minimal 1 file KMZ/KML.' });
    }
    const result = await processBatchKmzToCsv(req.files);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="Summary_Batch_KMZ.csv"');
    res.send(result.csvBuffer);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Gagal mengekspor CSV batch.' });
  }
});

app.use((err, req, res, next) => {
  const message =
    err?.code === 'LIMIT_UNEXPECTED_FILE' || err?.code === 'LIMIT_FILE_COUNT'
      ? 'Jumlah file melebihi batas unggahan (maks. 500 file).'
      : err?.code === 'LIMIT_FILE_SIZE'
      ? 'Ukuran file melebihi batas (maks. 50 MB per file).'
      : err?.message || 'Terjadi kesalahan pada server.';
  res.status(400).json({ error: message });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`KMZPro Opname App berjalan di http://localhost:${PORT}`);
  });
}

module.exports = app;
