const { distMeters, lineLengthMeters, turnAngleDeg, pointToLineProj } = require('./geo');

function is9mPole(pole) {
  const text = `${pole.label || ''} ${pole.folder || ''}`;
  return /(?:^|[^0-9])9\s*(?:m(?![a-z])|-)/i.test(text);
}

/**
 * Extract optical fiber core count (e.g. 24, 36, 48, 96, 144) from cable/folder/document text.
 */
function extractCableCore(text) {
  const s = (text || '').toString().trim();
  if (!s) return null;

  let m = s.match(/(?:^|[^0-9])0?(12|24|36|48|72|96|144|288)\s*(?:CORE|C)(?![A-Z0-9])/i);
  if (m) return parseInt(m[1], 10);

  m = s.match(/(?:^|[^0-9])0?(\d{1,3})\s*(?:CORE|C)(?![A-Z0-9])/i);
  if (m) {
    const val = parseInt(m[1], 10);
    if (val >= 2 && val <= 576) return val;
  }

  m = s.match(/[-_\s]0?(12|24|36|48|72|96|144|288)[-_\s]S\d+/i);
  if (m) return parseInt(m[1], 10);

  m = s.match(/[-_\s](012|024|036|048|072|096|144|288)(?:[-_\s]|$)/i);
  if (m) return parseInt(m[1], 10);

  return null;
}

/**
 * Detect network role from text: 'hubfeeder' | 'mainfeeder' | 'subfeeder' | 'feeder' | null.
 */
function detectCableRole(text) {
  const s = (text || '').toString();
  if (!s) return null;

  if (
    /(?:^|[^A-Z])HUB[\s_-]*FEEDER(?=[^A-Z]|$)/i.test(s) ||
    /(?:^|[^A-Z])(HFM|HF)(?=[^A-Z]|$)/i.test(s)
  ) {
    return 'hubfeeder';
  }
  if (
    /(?:^|[^A-Z])MAIN[\s_-]*FEEDER(?=[^A-Z]|$)/i.test(s) ||
    /(?:^|[^A-Z])(MFM|MF)(?=[^A-Z]|$)/i.test(s) ||
    /(?:^|[^A-Z])(BACKBONE|UPLINK)(?=[^A-Z]|$)/i.test(s)
  ) {
    return 'mainfeeder';
  }
  if (
    /(?:^|[^A-Z])SUB[\s_-]*FEEDER(?=[^A-Z]|$)/i.test(s) ||
    /(?:^|[^A-Z])(SFM|SF)(?=[^A-Z]|$)/i.test(s)
  ) {
    return 'subfeeder';
  }
  if (/(?:^|[^A-Z])FEEDER(?=[^A-Z]|$)/i.test(s)) {
    return 'feeder';
  }
  return null;
}

/**
 * Resolve Dead-End accessory name based on network role and cable core size:
 * - Cluster (distribusi) & Subfeeder for 24C/36C/48C (or default): "Dead-End Buaya 25-50"
 * - Hub Feeder & Main Feeder (or cables > 48C): "Helical Dead-End <core>C"
 */
function resolveDeadEndType(cableRole, cableCore) {
  const core = Number.isFinite(cableCore) && cableCore > 0 ? cableCore : null;
  const isHelicalRole =
    cableRole === 'hubfeeder' ||
    cableRole === 'mainfeeder' ||
    cableRole === 'feeder';

  if (isHelicalRole) {
    return core ? `Helical Dead-End ${core}C` : 'Helical Dead-End';
  }

  if (!core || core === 24 || core === 36 || core === 48 || core <= 48) {
    return 'Dead-End Buaya 25-50';
  }
  return `Helical Dead-End ${core}C`;
}

function resolveCableClassification(cab, kmzData, networkMode) {
  const candidates = [cab.name, cab.folder, kmzData.clusterTitle, kmzData.docName];

  let cableCore = null;
  for (const txt of candidates) {
    cableCore = extractCableCore(txt);
    if (cableCore) break;
  }

  let detectedRole = null;
  for (const txt of candidates) {
    detectedRole = detectCableRole(txt);
    if (detectedRole) break;
  }

  let cableRole;
  if (networkMode === 'distribusi') {
    cableRole = 'cluster';
  } else if (networkMode === 'subfeeder') {
    cableRole = 'subfeeder';
  } else if (networkMode === 'feeder') {
    cableRole =
      detectedRole === 'hubfeeder' || detectedRole === 'mainfeeder'
        ? detectedRole
        : 'mainfeeder';
  } else {
    cableRole =
      detectedRole || (cab.cableKind === 'feeder' ? 'feeder' : 'cluster');
  }

  const isFeeder = cableRole !== 'cluster';
  const deadEndType = resolveDeadEndType(cableRole, cableCore);
  return { cableRole, cableCore, isFeeder, deadEndType };
}

function calcHasbelEffectiveLength(routeLen, slackLen, slackInterval, sparePercent) {
  const slackCount = Math.floor(routeLen / slackInterval) + 1;
  const totalSlackMeters = slackCount * slackLen;
  const factor = 1 + sparePercent / 100;
  return (routeLen + totalSlackMeters) * factor;
}

/**
 * Find maximum route length <= maxRouteCap such that effective cable length
 * (including 400m intermediate slacks + 1 end/JC slack + spare %) <= maxHasbelMeters.
 */
function solveMaxRouteForHasbel(maxRouteCap, maxHasbelMeters, slackLen, slackInterval, sparePercent) {
  if (calcHasbelEffectiveLength(maxRouteCap, slackLen, slackInterval, sparePercent) <= maxHasbelMeters) {
    return maxRouteCap;
  }
  let lo = 0;
  let hi = maxRouteCap;
  for (let iter = 0; iter < 32; iter++) {
    const mid = (lo + hi) / 2;
    if (calcHasbelEffectiveLength(mid, slackLen, slackInterval, sparePercent) <= maxHasbelMeters) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Calculate FTTH pole accessories and material summary from parsed KMZ data.
 */
function calculateOpname(kmzData, options = {}) {
  const angleThreshold = options.angleThreshold ?? 30.0;
  const maxConsecSusp = options.maxConsecSusp ?? 2;
  const crossing9mMaxDist = options.crossing9mMaxDist ?? 60.0;
  const maxHasbelMeters = options.maxHasbelMeters ?? 3000;
  const slackLengthMeters = options.slackLengthMeters ?? 20;
  const sparePercent = options.sparePercent ?? 5;
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
    deadEndByType: {},
    suspension: 0,
    slackHanger: 0,
    poleClamp: 0,
    buldogGrip: 0,
    jointClosure: 0,
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

  const cableClassifications = kmzData.cables.map((cab) =>
    resolveCableClassification(cab, kmzData, networkMode)
  );

  function addDeadEnd(pole, qty, deadEndType) {
    if (!qty) return;
    pole.deadEnd += qty;
    pole.deadEndByType[deadEndType] = (pole.deadEndByType[deadEndType] || 0) + qty;
  }

  // 2. Trace each Cable route in order
  for (let cIdx = 0; cIdx < kmzData.cables.length; cIdx++) {
    const cab = kmzData.cables[cIdx];
    const { isFeeder, deadEndType: cabDeadEndType } = cableClassifications[cIdx];

    const onCable = [];
    for (const p of poleRecords) {
      const pr = pointToLineProj(p.coord, cab.pts);
      if (pr.dist <= cableSnapDist) {
        onCable.push({ pole: p, chainage: pr.chainage });
      }
    }
    onCable.sort((a, b) => a.chainage - b.chainage);

    // Detect consecutive pairs of 9m poles with distance < crossing9mMaxDist (default 60m)
    const crossing9mSpans = new Map();
    if (crossing9mMaxDist > 0) {
      for (let i = 0; i < onCable.length - 1; i++) {
        const pA = onCable[i].pole;
        const pB = onCable[i + 1].pole;
        if (is9mPole(pA) && is9mPole(pB)) {
          const spanDist = distMeters(pA.coord, pB.coord);
          if (spanDist < crossing9mMaxDist) {
            if (!crossing9mSpans.has(i) || spanDist < crossing9mSpans.get(i)) {
              crossing9mSpans.set(i, spanDist);
            }
            if (!crossing9mSpans.has(i + 1) || spanDist < crossing9mSpans.get(i + 1)) {
              crossing9mSpans.set(i + 1, spanDist);
            }
          }
        }
      }
    }

    // Detect Feeder Joint Closure (JC) poles per hasbel (default 3000m effective incl. slack + spare)
    const jcByIndex = new Map();
    if (isFeeder && maxHasbelMeters > 0 && onCable.length >= 3) {
      const totalCableLen = lineLengthMeters(cab.pts);
      let startCh = 0;
      let jcNum = 0;
      while (startCh < totalCableLen - 0.5) {
        const remaining = totalCableLen - startCh;
        const maxRoute = solveMaxRouteForHasbel(
          remaining,
          maxHasbelMeters,
          slackLengthMeters,
          slackIntervalMeters,
          sparePercent
        );
        let endCh = Math.min(totalCableLen, startCh + maxRoute);
        const isLastOfCable = endCh >= totalCableLen - 0.5;
        if (isLastOfCable) break;

        // Snap JC to the last intermediate pole before exceeding 1 hasbel
        let chosenIdx = -1;
        for (let k = 1; k < onCable.length - 1; k++) {
          if (onCable[k].chainage > startCh + 1.0 && onCable[k].chainage <= endCh + 0.5) {
            chosenIdx = k;
          }
        }
        if (chosenIdx !== -1) {
          jcNum += 1;
          jcByIndex.set(chosenIdx, jcNum);
          endCh = onCable[chosenIdx].chainage;
        }
        if (endCh <= startCh + 0.5) {
          break;
        }
        startCh = endCh;
      }
    }

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

      const jcNum = jcByIndex.get(i);
      const isJcPoint = jcNum !== undefined;

      let isSlackPoint = false;
      if (isJcPoint) {
        curr.jointClosure += 1;
        curr.slackHanger = Math.max(curr.slackHanger, 1);
        isSlackPoint = true;
        curr.remarks.push(`JC-${jcNum} (${Math.round(ch)}m)`);
        nextSlackTarget = ch + slackIntervalMeters;
      } else if (isFeeder && (isStart || isEnd)) {
        curr.slackHanger = Math.max(curr.slackHanger, 1);
        isSlackPoint = true;
        if (isStart) {
          nextSlackTarget = ch + slackIntervalMeters;
        }
      } else if (isFeeder && !isStart && !isEnd) {
        if (curr.hasSlack || ch >= nextSlackTarget) {
          curr.slackHanger = Math.max(curr.slackHanger, 1);
          isSlackPoint = true;
          if (!curr.hasSlack) {
            curr.remarks.push(`Slack ${Math.round(ch)}m`);
          }
          nextSlackTarget = ch + slackIntervalMeters;
        }
      }

      const crossing9mDist = crossing9mSpans.get(i);
      const isCrossing9m = crossing9mDist !== undefined;
      const clampQty = isCrossing9m ? 2 : 1;

      if (isStart || isEnd) {
        addDeadEnd(curr, 1, cabDeadEndType);
        curr.poleClamp += clampQty;
        consecSusp = 0;
        curr.remarks.push(`Ujung ${cab.line}`);
        if (
          isFeeder &&
          !curr.hasSlack &&
          !curr.hasFDT &&
          !curr.fatName &&
          !curr.remarks.includes('Slack Ujung')
        ) {
          curr.remarks.push('Slack Ujung');
        }
        if (isCrossing9m) {
          curr.remarks.push(`Crossing 9m (${Math.round(crossing9mDist)}m)`);
        }
      } else if (angle > angleThreshold) {
        addDeadEnd(curr, 2, cabDeadEndType);
        curr.poleClamp += clampQty;
        consecSusp = 0;
        curr.remarks.push(`Tikungan ${Math.round(angle)}°`);
        if (isCrossing9m) {
          curr.remarks.push(`Crossing 9m (${Math.round(crossing9mDist)}m)`);
        }
      } else if (curr.hasFDT || curr.fatName || isSlackPoint) {
        addDeadEnd(curr, 2, cabDeadEndType);
        curr.poleClamp += clampQty;
        consecSusp = 0;
        if (isCrossing9m) {
          curr.remarks.push(`Crossing 9m (${Math.round(crossing9mDist)}m)`);
        }
      } else if (isCrossing9m) {
        addDeadEnd(curr, 2, cabDeadEndType);
        curr.poleClamp += 2;
        consecSusp = 0;
        curr.remarks.push(`Crossing 9m (${Math.round(crossing9mDist)}m)`);
      } else if (consecSusp >= maxConsecSusp) {
        addDeadEnd(curr, 2, cabDeadEndType);
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
  const deadEndByType = {};
  for (const p of poleRecords) {
    for (const [deType, qty] of Object.entries(p.deadEndByType)) {
      if (qty > 0) {
        deadEndByType[deType] = (deadEndByType[deType] || 0) + qty;
      }
    }
  }

  const deadEndTypes = Object.keys(deadEndByType);
  const fallbackDeadEndType =
    cableClassifications[0]?.deadEndType ||
    resolveDeadEndType(
      detectCableRole(kmzData.clusterTitle) || detectCableRole(kmzData.docName) || 'cluster',
      extractCableCore(kmzData.clusterTitle) || extractCableCore(kmzData.docName)
    );
  const primaryDeadEndType =
    deadEndTypes.length === 1
      ? deadEndTypes[0]
      : deadEndTypes.length === 0
      ? fallbackDeadEndType
      : null;

  const totals = {
    totalPoles: poleRecords.length,
    newPoles: poleRecords.filter((p) => p.isNew).length,
    existingPoles: poleRecords.filter((p) => !p.isNew).length,
    deadEnd: poleRecords.reduce((s, p) => s + p.deadEnd, 0),
    deadEndByType,
    primaryDeadEndType,
    suspension: poleRecords.reduce((s, p) => s + p.suspension, 0),
    slackHanger: poleRecords.reduce((s, p) => s + p.slackHanger, 0),
    poleClamp: poleRecords.reduce((s, p) => s + p.poleClamp, 0),
    buldogGrip: poleRecords.reduce((s, p) => s + p.buldogGrip, 0),
    jointClosure: poleRecords.reduce((s, p) => s + p.jointClosure, 0),
    slingWireMeters: kmzData.slings.reduce((s, x) => s + x.nominalLength, 0),
    cableNominalMeters: kmzData.cables.reduce((s, x) => s + x.nominalLength, 0),
    cable2DMeters: Math.round(kmzData.cables.reduce((s, x) => s + x.length2D, 0)),
    poleByLabel: {},
    zeroAccPoles: poleRecords
      .filter(
        (p) =>
          p.deadEnd +
            p.suspension +
            p.slackHanger +
            p.poleClamp +
            p.buldogGrip +
            p.jointClosure ===
          0
      )
      .map((p) => p.name),
  };

  for (const p of poleRecords) {
    totals.poleByLabel[p.label] = (totals.poleByLabel[p.label] || 0) + 1;
  }

  return {
    clusterTitle: kmzData.clusterTitle,
    cables: kmzData.cables.map((c, idx) => {
      const byLine = kmzData.fats.filter((f) => f.line === c.line).length;
      const fatCount =
        byLine > 0
          ? byLine
          : kmzData.fats.filter(
              (f) => pointToLineProj(f.coord, c.pts).dist <= deviceSnapDist
            ).length;
      const cls = cableClassifications[idx];
      const jenisKabel = cls.cableCore
        ? cls.isFeeder
          ? `Feeder ${cls.cableCore}C`
          : `ADSS ${cls.cableCore}C`
        : cls.isFeeder
        ? 'Feeder'
        : 'ADSS';
      return {
        line: c.line,
        name: c.name,
        cableKind: cls.isFeeder ? 'feeder' : 'distribusi',
        cableRole: cls.cableRole,
        cableCore: cls.cableCore,
        jenisKabel,
        deadEndType: cls.deadEndType,
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
    rows: poleRecords.map((p) => {
      const rowDeadEndTypes = Object.keys(p.deadEndByType);
      return {
        poleId: p.name,
        label: p.label,
        isNew: p.isNew,
        line: p.line,
        deadEnd: p.deadEnd,
        deadEndType: rowDeadEndTypes.join(' + '),
        deadEndByType: p.deadEndByType,
        suspension: p.suspension,
        slackHanger: p.slackHanger,
        poleClamp: p.poleClamp,
        buldogGrip: p.buldogGrip,
        jointClosure: p.jointClosure,
        remark: p.remarks.join(', '),
        chainage: p.chainage < 999999 ? Math.round(p.chainage * 10) / 10 : null,
        lat: p.coord.lat,
        lon: p.coord.lon,
      };
    }),
    totals,
  };
}

module.exports = {
  calculateOpname,
  extractCableCore,
  detectCableRole,
  resolveDeadEndType,
};
