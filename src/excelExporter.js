const ExcelJS = require('exceljs');

const POLE_LABEL_DESCRIPTIONS = {
  NP9m4: 'New Pole 9m 4"',
  NP7m4: 'New Pole 7m 4"',
  NP7m3: 'New Pole 7m 3"',
  NP7m2: 'New Pole 7m 2.5"',
  EP9m4: 'Existing Pole EMR 9m 4"',
  EP7m4: 'Existing Pole EMR 7m 4"',
  EP7m3: 'Existing Pole EMR 7m 3"',
  EP7m2: 'Existing Pole EMR 7m 2.5"',
  EPP9m4: 'Existing Pole Partner 9m 4"',
  EPP7m4: 'Existing Pole Partner 7m 4"',
};

/**
 * Generate an Excel (.xlsx) Buffer from the calculated opname result.
 */
async function buildOpnameWorkbookBuffer(opname) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'KMZPro Opname Generator';
  wb.created = new Date();

  const ws = wb.addWorksheet('OPNAME', {
    views: [{ state: 'frozen', ySplit: 2 }],
  });

  // Row 1: Cluster header
  ws.getCell('A1').value = 'Cluster';
  ws.getCell('B1').value = opname.clusterTitle || '-';
  ws.getRow(1).font = { bold: true, size: 11 };

  // Row 2: Table headers
  const headers = [
    'POLE ID',
    'TIPE POLE',
    'LINE',
    'DEAD END',
    'SUSPENSION',
    'SLACK HANGER',
    'POLE CLAMP',
    'BULDOG GRIP',
    'REMARK',
  ];
  const headerRow = ws.getRow(2);
  headerRow.values = headers;
  headerRow.font = { bold: true, color: { argb: 'FF0F172A' } };
  headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
  headerRow.height = 22;

  for (let c = 1; c <= headers.length; c++) {
    const cell = headerRow.getCell(c);
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE2E8F0' },
    };
    cell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' },
    };
  }

  // Data rows (start at row 3)
  let r = 3;
  for (const item of opname.rows) {
    const row = ws.getRow(r);
    row.values = [
      item.poleId,
      item.label,
      item.line,
      item.deadEnd || null,
      item.suspension || null,
      item.slackHanger || null,
      item.poleClamp || null,
      item.buldogGrip || null,
      item.remark || '',
    ];
    for (let c = 1; c <= 9; c++) {
      const cell = row.getCell(c);
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' },
      };
      if (c >= 2 && c <= 8) {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      }
    }
    r++;
  }

  const lastDataRow = r - 1;
  const sumRowIdx = r;
  const sumRow = ws.getRow(sumRowIdx);
  sumRow.getCell(1).value = 'TOTAL';
  if (lastDataRow >= 3) {
    sumRow.getCell(4).value = { formula: `SUM(D3:D${lastDataRow})`, result: opname.totals.deadEnd };
    sumRow.getCell(5).value = { formula: `SUM(E3:E${lastDataRow})`, result: opname.totals.suspension };
    sumRow.getCell(6).value = { formula: `SUM(F3:F${lastDataRow})`, result: opname.totals.slackHanger };
    sumRow.getCell(7).value = { formula: `SUM(G3:G${lastDataRow})`, result: opname.totals.poleClamp };
    sumRow.getCell(8).value = { formula: `SUM(H3:H${lastDataRow})`, result: opname.totals.buldogGrip };
  }
  sumRow.font = { bold: true };
  for (let c = 1; c <= 9; c++) {
    const cell = sumRow.getCell(c);
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFEF3C7' },
    };
    cell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' },
    };
    if (c >= 4 && c <= 8) {
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    }
  }

  // Rekapitulasi Material & Pole section
  const rekapStart = sumRowIdx + 2;
  const rekapHeader = ws.getRow(rekapStart);
  rekapHeader.getCell(1).value = 'REKAPITULASI MATERIAL & POLE';
  rekapHeader.getCell(2).value = 'QTY';
  rekapHeader.getCell(3).value = 'SATUAN';
  rekapHeader.font = { bold: true };
  for (let c = 1; c <= 3; c++) {
    const cell = rekapHeader.getCell(c);
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE2E8F0' },
    };
    cell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' },
    };
  }

  const rekapItems = [
    ['DEAD END', { formula: `D${sumRowIdx}`, result: opname.totals.deadEnd }, 'pcs'],
    ['SUSPENSION', { formula: `E${sumRowIdx}`, result: opname.totals.suspension }, 'pcs'],
    ['SLACK HANGER', { formula: `F${sumRowIdx}`, result: opname.totals.slackHanger }, 'pcs'],
    ['POLE CLAMP', { formula: `G${sumRowIdx}`, result: opname.totals.poleClamp }, 'pcs'],
    ['BULDOG GRIP', { formula: `H${sumRowIdx}`, result: opname.totals.buldogGrip }, 'pcs'],
    ['SLING WIRE', opname.totals.slingWireMeters, 'm'],
    ['Kabel (KMZ Label)', opname.totals.cableNominalMeters, 'm'],
  ];

  // Add New Pole & Existing Pole types present (always include standard NP9m4..NP7m2)
  const standardNewLabels = ['NP9m4', 'NP7m4', 'NP7m3', 'NP7m2'];
  const extraLabels = Object.keys(opname.totals.poleByLabel).filter(
    (l) => !standardNewLabels.includes(l)
  );
  for (const lbl of [...standardNewLabels, ...extraLabels]) {
    const desc = POLE_LABEL_DESCRIPTIONS[lbl] || `Pole (${lbl})`;
    const countVal = opname.totals.poleByLabel[lbl] || 0;
    const formulaVal =
      lastDataRow >= 3
        ? { formula: `COUNTIF(B3:B${lastDataRow},"${lbl}")`, result: countVal }
        : 0;
    rekapItems.push([desc, formulaVal, 'btg']);
  }

  let rr = rekapStart + 1;
  for (const [name, qty, unit] of rekapItems) {
    const row = ws.getRow(rr);
    row.getCell(1).value = name;
    row.getCell(2).value = qty;
    row.getCell(3).value = unit;
    row.getCell(2).alignment = { horizontal: 'right', vertical: 'middle' };
    row.getCell(3).alignment = { horizontal: 'center', vertical: 'middle' };
    for (let c = 1; c <= 3; c++) {
      row.getCell(c).border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' },
      };
    }
    rr++;
  }

  // Set column widths cleanly
  ws.columns = [
    { width: 28 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 13 },
    { width: 15 },
    { width: 13 },
    { width: 14 },
    { width: 34 },
  ];

  return wb.xlsx.writeBuffer();
}

/**
 * Generate a multi-cluster Excel (.xlsx) Buffer with REKAP GABUNGAN and combined OPNAME sheets.
 */
async function buildMultiOpnameWorkbookBuffer(opnameList, combinedOpname) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'KMZPro Opname Generator';
  wb.created = new Date();

  // 1. Sheet REKAP GABUNGAN
  const wsRekap = wb.addWorksheet('REKAP GABUNGAN', {
    views: [{ state: 'frozen', ySplit: 2 }],
  });
  wsRekap.getCell('A1').value = `REKAPITULASI OPNAME GABUNGAN (${opnameList.length} FILE KMZ)`;
  wsRekap.getRow(1).font = { bold: true, size: 12 };

  const rekapHeaders = [
    'NO',
    'CLUSTER',
    'TOTAL POLE',
    'NEW POLE',
    'EXISTING POLE',
    'DEAD END',
    'SUSPENSION',
    'SLACK HANGER',
    'POLE CLAMP',
    'BULDOG GRIP',
    'SLING WIRE (m)',
    'KABEL (m)',
  ];
  const rHdr = wsRekap.getRow(2);
  rHdr.values = rekapHeaders;
  rHdr.font = { bold: true, color: { argb: 'FF0F172A' } };
  rHdr.alignment = { horizontal: 'center', vertical: 'middle' };
  rHdr.height = 22;
  for (let c = 1; c <= rekapHeaders.length; c++) {
    const cell = rHdr.getCell(c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
    cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
  }

  let rr = 3;
  opnameList.forEach((op, idx) => {
    const t = op.totals;
    const row = wsRekap.getRow(rr);
    row.values = [
      idx + 1,
      op.clusterTitle,
      t.totalPoles,
      t.newPoles,
      t.existingPoles,
      t.deadEnd,
      t.suspension,
      t.slackHanger,
      t.poleClamp,
      t.buldogGrip,
      t.slingWireMeters,
      t.cableNominalMeters,
    ];
    for (let c = 1; c <= rekapHeaders.length; c++) {
      const cell = row.getCell(c);
      cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      if (c !== 2) cell.alignment = { horizontal: 'center', vertical: 'middle' };
    }
    rr++;
  });

  const lastRekapRow = rr - 1;
  const gtRow = wsRekap.getRow(rr);
  gtRow.getCell(2).value = 'GRAND TOTAL';
  const colLetters = ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
  colLetters.forEach((col, i) => {
    gtRow.getCell(i + 3).value = { formula: `SUM(${col}3:${col}${lastRekapRow})` };
  });
  gtRow.font = { bold: true };
  for (let c = 1; c <= rekapHeaders.length; c++) {
    const cell = gtRow.getCell(c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
    cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    if (c !== 2) cell.alignment = { horizontal: 'center', vertical: 'middle' };
  }

  wsRekap.columns = [
    { width: 6 },
    { width: 38 },
    { width: 12 },
    { width: 11 },
    { width: 14 },
    { width: 12 },
    { width: 13 },
    { width: 15 },
    { width: 13 },
    { width: 14 },
    { width: 15 },
    { width: 13 },
  ];

  // 2. Sheet OPNAME (Combined all poles)
  const ws = wb.addWorksheet('OPNAME', {
    views: [{ state: 'frozen', ySplit: 2 }],
  });
  ws.getCell('A1').value = 'Cluster';
  ws.getCell('B1').value = combinedOpname.clusterTitle;
  ws.getRow(1).font = { bold: true, size: 11 };

  const headers = [
    'CLUSTER',
    'POLE ID',
    'TIPE POLE',
    'LINE',
    'DEAD END',
    'SUSPENSION',
    'SLACK HANGER',
    'POLE CLAMP',
    'BULDOG GRIP',
    'REMARK',
  ];
  const headerRow = ws.getRow(2);
  headerRow.values = headers;
  headerRow.font = { bold: true, color: { argb: 'FF0F172A' } };
  headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
  headerRow.height = 22;
  for (let c = 1; c <= headers.length; c++) {
    const cell = headerRow.getCell(c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
    cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
  }

  let r = 3;
  for (const item of combinedOpname.rows) {
    const row = ws.getRow(r);
    row.values = [
      item.cluster || '-',
      item.poleId,
      item.label,
      item.line,
      item.deadEnd || null,
      item.suspension || null,
      item.slackHanger || null,
      item.poleClamp || null,
      item.buldogGrip || null,
      item.remark || '',
    ];
    for (let c = 1; c <= 10; c++) {
      const cell = row.getCell(c);
      cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      if (c >= 3 && c <= 9) cell.alignment = { horizontal: 'center', vertical: 'middle' };
    }
    r++;
  }

  const lastDataRow = r - 1;
  const sumRow = ws.getRow(r);
  sumRow.getCell(1).value = 'TOTAL';
  if (lastDataRow >= 3) {
    sumRow.getCell(5).value = { formula: `SUM(E3:E${lastDataRow})`, result: combinedOpname.totals.deadEnd };
    sumRow.getCell(6).value = { formula: `SUM(F3:F${lastDataRow})`, result: combinedOpname.totals.suspension };
    sumRow.getCell(7).value = { formula: `SUM(G3:G${lastDataRow})`, result: combinedOpname.totals.slackHanger };
    sumRow.getCell(8).value = { formula: `SUM(H3:H${lastDataRow})`, result: combinedOpname.totals.poleClamp };
    sumRow.getCell(9).value = { formula: `SUM(I3:I${lastDataRow})`, result: combinedOpname.totals.buldogGrip };
  }
  sumRow.font = { bold: true };
  for (let c = 1; c <= 10; c++) {
    const cell = sumRow.getCell(c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
    cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    if (c >= 5 && c <= 9) cell.alignment = { horizontal: 'center', vertical: 'middle' };
  }

  ws.columns = [
    { width: 32 },
    { width: 28 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 13 },
    { width: 15 },
    { width: 13 },
    { width: 14 },
    { width: 34 },
  ];

  return wb.xlsx.writeBuffer();
}

module.exports = { buildOpnameWorkbookBuffer, buildMultiOpnameWorkbookBuffer };
