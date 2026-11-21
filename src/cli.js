const fs = require('fs');
const path = require('path');
const { parseKmzBuffer } = require('./kmzParser');
const { calculateOpname } = require('./opnameCalculator');
const { buildOpnameWorkbookBuffer } = require('./excelExporter');

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: node src/cli.js <input.kmz> [output.xlsx]');
    process.exit(1);
  }
  const absInput = path.resolve(inputPath);
  if (!fs.existsSync(absInput)) {
    console.error(`File tidak ditemukan: ${absInput}`);
    process.exit(1);
  }

  const baseName = path.basename(absInput, path.extname(absInput));
  const outPath = process.argv[3]
    ? path.resolve(process.argv[3])
    : path.join(path.dirname(absInput), `Opname_${baseName}.xlsx`);

  const buffer = fs.readFileSync(absInput);
  const kmzData = await parseKmzBuffer(buffer, path.basename(absInput));
  const opname = calculateOpname(kmzData);
  const xlsxBuffer = await buildOpnameWorkbookBuffer(opname);
  fs.writeFileSync(outPath, Buffer.from(xlsxBuffer));

  console.log(`Cluster : ${opname.clusterTitle}`);
  console.log(`Poles   : ${opname.totals.totalPoles} (New: ${opname.totals.newPoles}, Existing: ${opname.totals.existingPoles})`);
  console.log(`Dead End: ${opname.totals.deadEnd} | Suspension: ${opname.totals.suspension} | Slack Hanger: ${opname.totals.slackHanger} | Pole Clamp: ${opname.totals.poleClamp} | Buldog Grip: ${opname.totals.buldogGrip}`);
  console.log(`Saved   : ${outPath}`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
