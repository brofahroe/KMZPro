const { distMeters, turnAngleDeg, pointToLineProj } = require('./geo');

/**
 * Calculate FTTH pole accessories and material summary from parsed KMZ data.
 */
function calculateOpname(kmzData, options = {}) {
  const angleThreshold = options.angleThreshold ?? 30.0;
  const maxConsecSusp = options.maxConsecSusp ?? 2;
  const cableSnapDist = options.cableSnapDist ?? 5.0;
  const deviceSnapDist = options.deviceSnapDist ?? 10.0;
  const includeExisting = options.includeExisting ?? true;
  const networkMode = options.networkMode ?? 'auto';
  const slackIntervalMeters = options.slackIntervalMeters ?? 400;

  const sourcePoles = includeExisting
    ? kmzData.poles
    : kmzData.poles.filter((p) => p.isNew);

  const poleRecords = sourcePoles.map((p) => ({
    ...p,
    deadEnd: 0,
    suspension: 0,
    slackHanger: 0,
    poleClamp: 0,
    buldogGrip: 0,
    remarks: [],
    hasFDT: false,
    fatName: '',
    hasSlack: false,
    onSling: false,
    slingName: '',
    chainage: 999999,
  }));

  // 1. Match FDT, FAT, Slack Hanger, Sling Wire, and own-line chainage
  for (const p of poleRecords) {
    for (const f of kmzData.fdts) {
      if (distMeters(p.coord, f.coord) <= deviceSnapDist) {
        p.hasFDT = true;
        p.remarks.push(`FDT ${f.name}`);
      }
    }
    for (const f of kmzData.fats) {
      if (distMeters(p.coord, f.coord) <= deviceSnapDist) {
        p.fatName = f.name;
        const parts = f.name.split('-');
        const shortFat = parts.length >= 2 ? parts.slice(-2).join('-') : f.name;
        p.remarks.push(`FAT ${shortFat}`);
        break;
      }
    }
    for (const sl of kmzData.slacks) {
      if (distMeters(p.coord, sl.coord) <= deviceSnapDist) {
        p.hasSlack = true;
        break;
      }
    }
    if (p.hasFDT || p.fatName || p.hasSlack) {
      p.slackHanger = 1;
    }

    for (const s of kmzData.slings) {
      const pr = pointToLineProj(p.coord, s.pts);
      if (pr.dist <= cableSnapDist) {
        p.onSling = true;
        p.slingName = s.name;
        p.buldogGrip = 3;
        p.poleClamp += 1;
        p.remarks.push(`Sling ${s.name}`);
        break;
      }
    }

    const ownCable = kmzData.cables.find((c) => c.line === p.line);
    if (ownCable) {
      p.chainage = pointToLineProj(p.coord, ownCable.pts).chainage;
    }
  }

  // 2. Trace each Cable route in order
  for (const cab of kmzData.cables) {
    const isFeeder =
      networkMode === 'feeder' ||
      (networkMode === 'auto' && cab.cableKind === 'feeder');

    const onCable = [];
    for (const p of poleRecords) {
      const pr = pointToLineProj(p.coord, cab.pts);
      if (pr.dist <= cableSnapDist) {
        onCable.push({ pole: p, chainage: pr.chainage });
      }
    }
    onCable.sort((a, b) => a.chainage - b.chainage);

    let consecSusp = 0;
    let nextSlackTarget = slackIntervalMeters;

    for (let i = 0; i < onCable.length; i++) {
      const curr = onCable[i].pole;
      const ch = onCable[i].chainage;
      const isStart = i === 0;
      const isEnd = i === onCable.length - 1;
      let angle = 0;
      if (!isStart && !isEnd) {
        angle = turnAngleDeg(
          onCable[i - 1].pole.coord,
          curr.coord,
          onCable[i + 1].pole.coord
        );
      }

      let isSlackPoint = false;
      if (isFeeder && !isStart && !isEnd) {
        if (curr.hasSlack || ch >= nextSlackTarget) {
          curr.slackHanger = 1;
          isSlackPoint = true;
          if (!curr.hasSlack) {
            curr.remarks.push(`Slack ${Math.round(ch)}m`);
          }
          nextSlackTarget = ch + slackIntervalMeters;
        }
      }

      if (isStart || isEnd) {
        curr.deadEnd += 1;
        curr.poleClamp += 1;
        consecSusp = 0;
        curr.remarks.push(`Ujung ${cab.line}`);
      } else if (angle > angleThreshold) {
        curr.deadEnd += 2;
        curr.poleClamp += 1;
        consecSusp = 0;
        curr.remarks.push(`Tikungan ${Math.round(angle)}°`);
      } else if (curr.hasFDT || curr.fatName || isSlackPoint) {
        curr.deadEnd += 2;
        curr.poleClamp += 1;
        consecSusp = 0;
      } else if (consecSusp >= maxConsecSusp) {
        curr.deadEnd += 2;
        curr.poleClamp += 1;
        consecSusp = 0;
        curr.remarks.push(`Setelah ${maxConsecSusp} Susp`);
      } else {
        curr.suspension += 1;
        consecSusp += 1;
      }
    }
  }

  // Sort poles by line then chainage
  poleRecords.sort((a, b) => {
    if (a.line !== b.line) return a.line.localeCompare(b.line);
    if (a.chainage !== b.chainage) return a.chainage - b.chainage;
    return a.name.localeCompare(b.name);
  });

  // 3. Summary totals
  const totals = {
    totalPoles: poleRecords.length,
    newPoles: poleRecords.filter((p) => p.isNew).length,
    existingPoles: poleRecords.filter((p) => !p.isNew).length,
    deadEnd: poleRecords.reduce((s, p) => s + p.deadEnd, 0),
    suspension: poleRecords.reduce((s, p) => s + p.suspension, 0),
    slackHanger: poleRecords.reduce((s, p) => s + p.slackHanger, 0),
    poleClamp: poleRecords.reduce((s, p) => s + p.poleClamp, 0),
    buldogGrip: poleRecords.reduce((s, p) => s + p.buldogGrip, 0),
    slingWireMeters: kmzData.slings.reduce((s, x) => s + x.nominalLength, 0),
    cableNominalMeters: kmzData.cables.reduce((s, x) => s + x.nominalLength, 0),
    cable2DMeters: Math.round(kmzData.cables.reduce((s, x) => s + x.length2D, 0)),
    poleByLabel: {},
    zeroAccPoles: poleRecords
      .filter(
        (p) =>
          p.deadEnd + p.suspension + p.slackHanger + p.poleClamp + p.buldogGrip ===
          0
      )
      .map((p) => p.name),
  };

  for (const p of poleRecords) {
    totals.poleByLabel[p.label] = (totals.poleByLabel[p.label] || 0) + 1;
  }

  return {
    clusterTitle: kmzData.clusterTitle,
    cables: kmzData.cables.map((c) => {
      const byLine = kmzData.fats.filter((f) => f.line === c.line).length;
      const fatCount =
        byLine > 0
          ? byLine
          : kmzData.fats.filter(
              (f) => pointToLineProj(f.coord, c.pts).dist <= deviceSnapDist
            ).length;
      const isFeeder =
        networkMode === 'feeder' ||
        (networkMode === 'auto' && c.cableKind === 'feeder');
      return {
        line: c.line,
        name: c.name,
        cableKind: isFeeder ? 'feeder' : 'distribusi',
        nominalLength: c.nominalLength,
        length2D: c.length2D,
        fatCount,
      };
    }),
    slings: kmzData.slings.map((s) => ({
      line: s.line,
      name: s.name,
      nominalLength: s.nominalLength,
      length2D: s.length2D,
    })),
    rows: poleRecords.map((p) => ({
      poleId: p.name,
      label: p.label,
      isNew: p.isNew,
      line: p.line,
      deadEnd: p.deadEnd,
      suspension: p.suspension,
      slackHanger: p.slackHanger,
      poleClamp: p.poleClamp,
      buldogGrip: p.buldogGrip,
      remark: p.remarks.join(', '),
      chainage: p.chainage < 999999 ? Math.round(p.chainage * 10) / 10 : null,
      lat: p.coord.lat,
      lon: p.coord.lon,
    })),
    totals,
  };
}

module.exports = { calculateOpname };
