/**
 * test_scripts/test-mcu.js
 * MCU coverage test — run with:  node test_scripts/test-mcu.js
 *
 * Uses PDSC as the primary source of truth (same as the extension).
 * For every base device name across all bundled DFP versions, checks:
 *
 *   1. parseMcuCfg     — flash / option addresses from PDSC algorithm entries
 *   2. selectInternalFlm — FLM name from PDSC; flmToHlm → HLM existence in FlashLoader/
 *   3. hasMcuCfg       — openocd/MCU/<device>.cfg existence (OpenOCD only)
 *   4. selectTargetCfg — which target cfg is selected
 *   5. WORKAREASIZE    — Settings.ini → PDSC IRAM1 → MISSING
 *
 * Warnings (!) = PDSC flash info missing OR any OpenOCD resource missing.
 * SVD lookup uses findSvdFile() imported from the compiled extension (out/tools/uv2make.js).
 */

// vscode mock — uv2make.js creates an output channel at module level
const Module = require('module');
const _origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'vscode') return {
    window: { createOutputChannel: () => ({ appendLine: () => {}, show: () => {} }) },
    workspace: { getConfiguration: () => ({ get: (_, d) => d }) },
  };
  return _origReq.apply(this, arguments);
};

const fs   = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const EXT_ROOT = path.resolve(__dirname, '..');
const { findSvdFile: _findSvdFile } = require(path.join(EXT_ROOT, 'out/tools/uv2make.js'));

const _extInstallDir = path.join(require('os').homedir(), '.vscode', 'extensions');
const _installed = fs.existsSync(_extInstallDir)
  ? fs.readdirSync(_extInstallDir).filter(d => d.startsWith('holtek.ht32-vscode-')).sort()
  : [];
if (!_installed.length) throw new Error(`ERROR: no installed holtek.ht32-vscode-* found under ${_extInstallDir}`);
const EXT = path.join(_extInstallDir, _installed[_installed.length - 1]);

// ── Module-level PDSC raw cache (avoid re-reading files) ─────────────────────
const _pdscRawCache = new Map();

// ── getAllPdscPaths: scan all DFP versions, newest first ─────────────────────
function getAllPdscPaths() {
  const result = [];
  const holtek = path.join(EXT, 'dfp', 'Holtek');
  try {
    for (const dfpName of fs.readdirSync(holtek).sort()) {
      const dfpPath = path.join(holtek, dfpName);
      let versions;
      try { versions = fs.readdirSync(dfpPath).sort().reverse(); } catch { continue; }
      for (const ver of versions) {
        const versionPath = path.join(dfpPath, ver);
        let files;
        try { files = fs.readdirSync(versionPath); } catch { continue; }
        const pdscFile = files.find(f => f.endsWith('.pdsc'));
        if (pdscFile) result.push(path.join(versionPath, pdscFile));
      }
    }
  } catch {}
  return result;
}

// ── parseMcuCfg: flash/option addresses from PDSC algorithm entries ───────────
// Replicates extension's parseMcuCfg() — kept in sync with main source.
function parseMcuCfg(deviceName) {
  const stripped = deviceName.replace(/_[^_]+$/, '');
  const parser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '',
    isArray: (name) => ['family', 'subFamily', 'device', 'algorithm'].includes(name),
  });
  for (const pdscPath of getAllPdscPaths()) {
    try {
      if (!_pdscRawCache.has(pdscPath)) _pdscRawCache.set(pdscPath, fs.readFileSync(pdscPath, 'utf8'));
      const doc      = parser.parse(_pdscRawCache.get(pdscPath));
      const families = doc?.package?.devices?.family ?? [];
      for (const fam of families) {
        for (const subfam of [fam, ...(fam.subFamily ?? [])]) {
          for (const dev of (subfam.device ?? [])) {
            const dname = dev.Dname ?? '';
            if (dname !== deviceName && dname !== stripped && dname.replace(/_[^_]+$/, '') !== stripped) continue;
            const algos = [
              ...(dev.algorithm    ?? []),
              ...(subfam.algorithm ?? []),
              ...(fam.algorithm    ?? []),
            ];
            let flashStart, flashEnd, optStart, optEnd;
            for (const algo of algos) {
              const algName = algo.name ?? '';
              if (/EXT_TYPE\d+_REAMP\d+/i.test(algName)) continue;
              const start = parseInt(algo.start);
              const size  = parseInt(algo.size);
              if (isNaN(start) || isNaN(size) || size <= 0) continue;
              if (/OPT/i.test(algName)) {
                if (optStart === undefined) { optStart = start; optEnd = start + size - 1; }
              } else if (flashStart === undefined) {
                flashStart = start; flashEnd = start + size - 1;
              }
            }
            if (flashStart !== undefined) {
              return { flashStart, flashEnd,
                optStart: optStart ?? 0x1FF00000,
                optEnd:   optEnd   ?? 0x1FF00FFF };
            }
          }
        }
      }
    } catch {}
  }
  return null;
}

// ── selectInternalFlm: FLM name from PDSC matching flash size ────────────────
// Replicates extension's selectInternalFlm() — kept in sync with main source.
function selectInternalFlm(deviceName, flashSizeBytes) {
  const stripped = deviceName.replace(/_[^_]+$/, '');
  const parser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '',
    isArray: (name) => ['family', 'subFamily', 'device', 'algorithm'].includes(name),
  });
  for (const pdscPath of getAllPdscPaths()) {
    try {
      if (!_pdscRawCache.has(pdscPath)) _pdscRawCache.set(pdscPath, fs.readFileSync(pdscPath, 'utf8'));
      const doc      = parser.parse(_pdscRawCache.get(pdscPath));
      const families = doc?.package?.devices?.family ?? [];
      for (const fam of families) {
        for (const subfam of [fam, ...(fam.subFamily ?? [])]) {
          for (const dev of (subfam.device ?? [])) {
            const dname = dev.Dname ?? '';
            if (dname !== deviceName && dname !== stripped && dname.replace(/_[^_]+$/, '') !== stripped) continue;
            const algos = [
              ...(dev.algorithm    ?? []),
              ...(subfam.algorithm ?? []),
              ...(fam.algorithm    ?? []),
            ];
            for (const algo of algos) {
              const algName = algo.name ?? '';
              if (/EXT_TYPE\d+_REAMP\d+/i.test(algName)) continue;
              if (/OPT/i.test(algName)) continue;
              const algSize = parseInt(algo.size);
              if (!isNaN(algSize) && Math.abs(algSize - flashSizeBytes) < 1024) {
                return path.basename(algName);
              }
            }
          }
        }
      }
    } catch {}
  }
  return undefined;
}

// ── flmToHlm: check HLM existence for a given FLM ───────────────────────────
// Replicates extension's flmToHlm() (internal flash path) — kept in sync with main source.
function flmToHlm(flmBasename) {
  const loaderDir = path.join(EXT, 'openocd', 'FlashLoader');
  const hlm = flmBasename.replace(/\.FLM$/i, '.HLM');
  return fs.existsSync(path.join(loaderDir, hlm)) ? hlm : null;
}

// ── SVD lookup — delegates to compiled extension code ────────────────────────
function hasSvd(deviceName) {
  return !!_findSvdFile('', deviceName, EXT);
}

// ── hasMcuCfg: check openocd/MCU/<device>.cfg existence ─────────────────────
function hasMcuCfg(deviceName) {
  const mcuDir = path.join(EXT, 'openocd', 'MCU');
  if (fs.existsSync(path.join(mcuDir, `${deviceName}.cfg`))) return true;
  const stripped = deviceName.replace(/_[^_]+$/, '');
  try {
    return fs.readdirSync(mcuDir).some(
      f => f.toLowerCase().startsWith(`${stripped.toLowerCase()}_`) && f.endsWith('.cfg')
    );
  } catch { return false; }
}

// ── parseMcuCfgFile: read pageSize/Flash/Option from openocd/MCU/<device>.cfg ─
function parseMcuCfgFile(deviceName) {
  const mcuDir = path.join(EXT, 'openocd', 'MCU');
  let cfgPath = path.join(mcuDir, `${deviceName}.cfg`);
  if (!fs.existsSync(cfgPath)) {
    const stripped = deviceName.replace(/_[^_]+$/, '');
    try {
      const found = fs.readdirSync(mcuDir).find(
        f => f.toLowerCase().startsWith(`${stripped.toLowerCase()}_`) && f.endsWith('.cfg')
      );
      if (!found) return null;
      cfgPath = path.join(mcuDir, found);
    } catch { return null; }
  }
  let pageSize, flashStart, flashSize, optStart, optSize;
  try {
    for (const line of fs.readFileSync(cfgPath, 'utf8').split(/\r?\n/)) {
      const t = line.replace(/\s+/g, '');
      if (/^pageSize=/i.test(t)) {
        pageSize = parseInt(t.split('=')[1]);
      } else if (/^Flash=/i.test(t)) {
        const parts = t.split('=')[1].split(',');
        flashStart = parseInt(parts[0]); flashSize = parseInt(parts[1]);
      } else if (/^Option=/i.test(t)) {
        const parts = t.split('=')[1].split(',');
        optStart = parseInt(parts[0]); optSize = parseInt(parts[1]);
      }
    }
  } catch { return null; }
  if (flashStart === undefined || isNaN(flashStart) || flashSize === undefined || isNaN(flashSize)) return null;
  return { pageSize, flashStart, flashSize, optStart, optSize };
}

// ── selectTargetCfg ──────────────────────────────────────────────────────────
// Replicates extension's selectTargetCfg() — kept in sync with main source.
function selectTargetCfg(mcu, deviceName) {
  const stripped  = (deviceName || '').replace(/_[^_]+$/, '');
  const targetDir = path.join(EXT, 'openocd', 'scripts', 'target');
  try {
    for (const f of fs.readdirSync(targetDir).sort()) {
      const m = /^HLM([0-9]\w*)\.cfg$/i.exec(f);
      if (!m) continue;
      const pat = new RegExp(m[1].replace(/x/gi, '.'), 'i');
      if (pat.test(stripped)) return `target/${f}`;
    }
  } catch {}
  const core = (mcu || '').toLowerCase();
  if (core.includes('m4') || core.includes('m7')) return 'target/HLMm4x.cfg';
  if (core.includes('m3'))                        return 'target/HLMm3x.cfg';
  return 'target/HLMm0x.cfg';
}

// ── readSettingsIni ──────────────────────────────────────────────────────────
function readSettingsIni() {
  const result = {};
  try {
    const lines = fs.readFileSync(path.join(EXT, 'conf', 'Settings.ini'), 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith(';') || t.startsWith('[')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim();
      const num = val.startsWith('0x') || val.startsWith('0X') ? parseInt(val, 16) : parseInt(val, 10);
      if (!isNaN(num)) result[key] = num;
    }
  } catch {}
  return result;
}

// ── readFlashInfoXlsx: parse HT32_Flash_Information.xlsx ─────────────────────
// Returns Map<deviceName, {pageSize, flashStart, flashSize, optStart, optSize, mdidStr}>
function readFlashInfoXlsx() {
  const xlsxPath = path.join(__dirname, 'HT32_Flash_Information.xlsx');
  if (!fs.existsSync(xlsxPath)) return new Map();
  try {
    const AdmZip = require(path.join(EXT_ROOT, 'node_modules', 'adm-zip'));
    const zip = new AdmZip(xlsxPath);

    // shared strings — parseTagValue:false keeps numeric text (e.g. "512") as strings
    const ssXml = new XMLParser({
      ignoreAttributes: false, attributeNamePrefix: '',
      isArray: name => ['si', 'r'].includes(name),
      parseTagValue: false,
    }).parse(zip.readAsText('xl/sharedStrings.xml'));
    const strs = (ssXml?.sst?.si ?? []).map(si => {
      if (si.t !== undefined && si.t !== null) return String(si.t);
      if (Array.isArray(si.r)) return si.r.map(r => r.t !== undefined && r.t !== null ? String(r.t) : (r.t?.['#text'] ?? '')).join('');
      return '';
    });

    // sheet2 — parseTagValue:false keeps hex strings like "0x1FC00" from being coerced
    const shXml = new XMLParser({
      ignoreAttributes: false, attributeNamePrefix: '',
      isArray: name => ['row', 'c'].includes(name),
      parseTagValue: false,
    }).parse(zip.readAsText('xl/worksheets/sheet2.xml'));
    const rows = shXml?.worksheet?.sheetData?.row ?? [];

    // column letter(s) → 0-based index (A=0, B=1, ..., Z=25, AA=26, ...)
    const colToIdx = (s) => {
      let n = 0;
      for (const ch of s.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
      return n - 1;
    };

    // parse one row into { colIdx: cellValue }
    const parseRowCells = (row) => {
      const cells = {};
      for (const c of (row.c ?? [])) {
        const colStr = (c.r ?? '').replace(/[0-9]/g, '');
        const idx    = colToIdx(colStr);
        const rawVal = c.v !== undefined ? String(c.v) : '';
        cells[idx]   = (c.t === 's') ? (strs[parseInt(rawVal)] ?? '') : rawVal;
      }
      return cells;
    };

    // parse any hex string → number (with or without 0x prefix)
    const parseHex = (s) => {
      s = String(s || '').trim().replace(/_/g, '');
      if (!s) return NaN;
      return parseInt(s, 16);
    };

    // The right-hand columns (PageSizeHex, PROMStart, PROMSize, OPTStart, OPTSize,
    // DataStart, DataSize) are always the LAST 7 cells in each data row — regardless
    // of whether the middle SRAM-End helper columns are present or empty.
    // Index from right: [n-7] .. [n-1]
    const C_TYPE = colToIdx('A');
    const C_NAME = colToIdx('B');
    const C_MDID = colToIdx('C');
    const C_PGSZ = colToIdx('I'); // Page Size (bytes, decimal integer)
    const R_PROMSZ = 5; // 5th from right (0-based from right, so arr[n-5-1] = arr[n-6]?)
    // Layout from right (1-based from right end):
    //  1 = DataSize, 2 = DataStart, 3 = OPTSize, 4 = OPTStart,
    //  5 = PROMSize,  6 = PROMStart, 7 = PageSizeHex

    const result = new Map();
    for (const row of rows) {
      if (parseInt(row.r ?? '0') <= 2) continue;
      const cells = parseRowCells(row);
      const devName = cells[C_NAME] ?? '';
      if (!devName.match(/^[A-Z]{2,}\d/)) continue;

      // sorted column values for this row (excluding fixed-position cols we read directly)
      const sorted = Object.entries(cells)
        .sort(([a], [b]) => parseInt(a) - parseInt(b))
        .map(([, v]) => v);
      const n = sorted.length;
      if (n < 7) continue;

      const pageSize   = parseInt(cells[C_PGSZ] ?? '', 10);
      const promSizeStr  = sorted[n - 5]; // 5th from right
      const promStartStr = sorted[n - 6]; // 6th from right
      const optStartStr  = sorted[n - 4]; // 4th from right
      const optSizeStr   = sorted[n - 3]; // 3rd from right

      const flashSize  = parseHex(promSizeStr);
      const flashStart = parseHex(promStartStr);
      const optStart   = parseHex(optStartStr);
      const optSize    = parseHex(optSizeStr);

      if (isNaN(pageSize) || isNaN(flashSize) || isNaN(optStart)) continue;
      const entry = {
        pageSize, flashStart: isNaN(flashStart) ? 0 : flashStart,
        flashSize, optStart, optSize: isNaN(optSize) ? 0 : optSize,
        mdidStr: cells[C_MDID] ?? '',
      };
      result.set(devName, entry);
      // XLS zero-pads model numbers (col B: "HT32F01251") but col A has the canonical type
      // number ("1251") that PDSC uses. If B ends with "0"+A, strip the extra zero.
      const typeVal = cells[C_TYPE] ?? '';
      if (typeVal && devName.endsWith('0' + typeVal)) {
        const canonical = devName.slice(0, -(typeVal.length + 1)) + typeVal;
        result.set(canonical, entry);
      }
    }
    return result;
  } catch (e) {
    console.error('Warning: failed to read HT32_Flash_Information.xlsx:', e.message);
    return new Map();
  }
}

// ── readPdscDevices: all base device names from all DFP versions (union) ─────
function readPdscDevices() {
  const parser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '',
    isArray: (name) => ['family', 'subFamily', 'device', 'memory', 'processor'].includes(name),
  });
  const seen = new Map();
  for (const pdscPath of getAllPdscPaths()) {
    try {
      const doc      = parser.parse(fs.readFileSync(pdscPath, 'utf8'));
      const families = doc?.package?.devices?.family ?? [];
      for (const fam of families) {
        const famCore = fam.processor?.[0]?.Dcore ?? '';
        for (const sub of (fam.subFamily ?? [{ ...fam, subFamily: undefined }])) {
          const subCore = sub.processor?.[0]?.Dcore ?? famCore;
          for (const dev of (sub.device ?? [])) {
            const dname = dev.Dname ?? '';
            if (!dname) continue;
            const base = dname.replace(/_[^_]+$/, '');
            if (seen.has(base)) continue;  // newest version wins (getAllPdscPaths is newest-first)
            const iram1 = (dev.memory ?? []).find(m => (m.id ?? m.name) === 'IRAM1');
            const irom1 = (dev.memory ?? []).find(m => (m.id ?? m.name) === 'IROM1');
            const sramSize  = iram1 ? parseInt(iram1.size)  : 0;
            const irom1Start = irom1 ? parseInt(irom1.start) : undefined;
            const irom1Size  = irom1 ? parseInt(irom1.size)  : undefined;
            const devCore = dev.processor?.[0]?.Dcore ?? subCore;
            seen.set(base, {
              name: base, core: devCore || subCore || famCore, sramSize,
              irom1Start, irom1Size,
            });
          }
        }
      }
    } catch {}
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ── Main ─────────────────────────────────────────────────────────────────────

const settingsMap = readSettingsIni();
const devices     = readPdscDevices();
const xlsMap      = readFlashInfoXlsx();
const hex = (n) => '0x' + n.toString(16).toUpperCase().padStart(8, '0');

const COL = { dev: 22, core: 12, flash: 26, flm: 26, cfg: 20, wa: 12, waSrc: 8, issues: 0 };
const pad = (s, w) => w ? String(s).padEnd(w) : String(s);
const hr  = '-'.repeat(Object.values(COL).reduce((a, b) => a + b, 0) + Object.keys(COL).length - 1);

console.log('\nHT32 MCU Coverage Test  (PDSC → OpenOCD resource check)');
console.log(hr);
console.log(
  pad('Device',      COL.dev)  +
  pad('Core',        COL.core) +
  pad('PDSC Flash',  COL.flash) +
  pad('FLM',         COL.flm)  +
  pad('Target CFG',  COL.cfg)  +
  pad('WorkArea',    COL.wa)   +
  pad('WA src',      COL.waSrc) +
  ' Issues'
);
console.log(hr);

let okCount   = 0;
let warnCount = 0;
const issueList = [];

for (const dev of devices) {
  const mcuInfo    = parseMcuCfg(dev.name);
  const flashRange = mcuInfo
    ? `${hex(mcuInfo.flashStart)}-${hex(mcuInfo.flashEnd)}`
    : '-';

  const flashSize = mcuInfo ? (mcuInfo.flashEnd - mcuInfo.flashStart + 1) : 0;
  const flmFile   = mcuInfo ? (selectInternalFlm(dev.name, flashSize) ?? '-') : '-';
  const hlmFile   = (flmFile !== '-') ? (flmToHlm(flmFile) ?? null) : null;
  const mcuCfgOk  = hasMcuCfg(dev.name);
  const cfg       = selectTargetCfg(dev.core, dev.name);

  const prefix  = dev.name.replace(/_[^_]+$/, '');
  const waNum   = settingsMap[dev.name] ?? settingsMap[prefix];
  let waSrc, waSz;
  if (waNum !== undefined) {
    waSz = waNum; waSrc = 'INI';
  } else if (dev.sramSize > 0) {
    waSz = dev.sramSize; waSrc = 'PDSC';
  } else {
    waSz = 0; waSrc = 'MISSING';
  }

  // Build issue list for this device
  const reasons = [];
  if (!mcuInfo)          reasons.push('no-PDSC-flash');
  if (flmFile === '-')   reasons.push('no-FLM');
  if (hlmFile === null)  reasons.push('no-HLM');
  if (!mcuCfgOk)         reasons.push(xlsMap.get(dev.name) ? 'no-MCUcfg(generated)' : 'no-MCUcfg');
  if (!hasSvd(dev.name)) reasons.push('no-SVD');
  if (waSrc === 'MISSING') reasons.push('no-WorkArea');

  // Consistency check: prefer XLS; fall back to PDSC when device not in XLS
  const xlsEntry = xlsMap.get(dev.name);
  if (mcuCfgOk && xlsEntry) {
    const cfgFile = parseMcuCfgFile(dev.name);
    if (cfgFile) {
      if (cfgFile.pageSize !== undefined && cfgFile.pageSize !== xlsEntry.pageSize)
        reasons.push(`xls-pagesize-mismatch(cfg=${hex(cfgFile.pageSize)},xls=${hex(xlsEntry.pageSize)})`);
      if (cfgFile.flashStart !== xlsEntry.flashStart)
        reasons.push(`xls-flash-start-mismatch(cfg=${hex(cfgFile.flashStart)},xls=${hex(xlsEntry.flashStart)})`);
      if (cfgFile.flashSize !== xlsEntry.flashSize)
        reasons.push(`xls-flash-size-mismatch(cfg=${hex(cfgFile.flashSize)},xls=${hex(xlsEntry.flashSize)})`);
      if (cfgFile.optStart !== undefined && cfgFile.optStart !== xlsEntry.optStart)
        reasons.push(`xls-opt-start-mismatch(cfg=${hex(cfgFile.optStart)},xls=${hex(xlsEntry.optStart)})`);
      if (cfgFile.optSize !== undefined && cfgFile.optSize !== xlsEntry.optSize)
        reasons.push(`xls-opt-size-mismatch(cfg=${hex(cfgFile.optSize)},xls=${hex(xlsEntry.optSize)})`);
    }
  } else if (mcuCfgOk && !xlsEntry) {
    const cfgFile = parseMcuCfgFile(dev.name);
    if (cfgFile) {
      if (dev.irom1Start !== undefined && cfgFile.flashStart !== dev.irom1Start)
        reasons.push(`pdsc-flash-start-mismatch(cfg=${hex(cfgFile.flashStart)},pdsc=${hex(dev.irom1Start)})`);
      if (dev.irom1Size !== undefined && cfgFile.flashSize !== dev.irom1Size)
        reasons.push(`pdsc-flash-size-mismatch(cfg=${hex(cfgFile.flashSize)},pdsc=${hex(dev.irom1Size)})`);
    }
  }

  const warn = reasons.length > 0;
  if (warn) { warnCount++; issueList.push({ name: dev.name, reasons }); } else { okCount++; }

  const marker = warn ? '!' : ' ';
  console.log(
    marker +
    pad(dev.name,               COL.dev - 1)  +
    pad(dev.core,               COL.core)      +
    pad(flashRange,             COL.flash)     +
    pad(flmFile,                COL.flm)       +
    pad(cfg,                    COL.cfg)       +
    pad(waSz ? hex(waSz) : '-', COL.wa)        +
    pad(waSrc,                  COL.waSrc)     +
    (warn ? ' ' + reasons.join(', ') : '')
  );
}

console.log(hr);
console.log(`\nTotal: ${devices.length}  OK: ${okCount}  Warnings: ${warnCount}`);
if (issueList.length) {
  console.log('\nDevices with warnings (!):');
  issueList.forEach(({ name, reasons }) => console.log(`  ${name.padEnd(24)} ${reasons.join(', ')}`))
}
console.log();

// Write summary to file
const reportPath = path.join(__dirname, 'test-mcu-report.txt');
const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
const lines = [
  `Generated: ${now}`,
  `Total: ${devices.length}  OK: ${okCount}  Warnings: ${warnCount}`,
  '',
];
if (issueList.length) {
  lines.push('Devices with warnings (!):');
  issueList.forEach(({ name, reasons }) => lines.push(`  ${name.padEnd(24)} ${reasons.join(', ')}`));
} else {
  lines.push('All devices OK.');
}
lines.push('');
fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
console.log(`Report written to: ${reportPath}`);

// ── Generate cfg for no-mcucfg devices that have XLS data ───────────────────
const mcuOutDir = path.join(__dirname, 'mcu');
if (!fs.existsSync(mcuOutDir)) fs.mkdirSync(mcuOutDir);

const CFG_HEADER = ';format: MID_OR_DID (Hex), CheckID (0-SkipReadID / 1-MDID / 2-DID / 3-MDID & DID), pageSize : program_size (Hex), Flash :  program_startAddr (Hex), program_size (Hex), option_startAddr (Hex),option_size (Hex)\n';
const toHex = (n, width = 0) => {
  const s = n.toString(16).toUpperCase();
  return '0x' + (width ? s.padStart(width, '0') : s);
};

const normalizeMdid = (s) => {
  const raw = String(s || '').replace(/_/g, '').replace(/^0x/i, '');
  const n = parseInt(raw, 16);
  return isNaN(n) ? null : '0x' + n.toString(16).toUpperCase().padStart(8, '0');
};

let genCount = 0;
for (const dev of devices) {
  if (hasMcuCfg(dev.name)) continue;
  const xls = xlsMap.get(dev.name);
  if (!xls) continue;

  const mdid = normalizeMdid(xls.mdidStr);
  const idSection = mdid
    ? `[ID]\nCheckID=1\nMDID=${mdid},0xFFFFFFFF\n`
    : '[ID]\nCheckID=0\n';

  const cfgContent =
    CFG_HEADER +
    idSection +
    '[Bank]\n' +
    `pageSize=${toHex(xls.pageSize)}\n` +
    `Flash=${xls.flashStart === 0 ? '0' : toHex(xls.flashStart)},${toHex(xls.flashSize)}\n` +
    `Option=${toHex(xls.optStart)},${toHex(xls.optSize)}\n`;

  const cfgPath = path.join(mcuOutDir, `${dev.name}.cfg`);
  fs.writeFileSync(cfgPath, cfgContent, 'utf8');
  genCount++;
}

if (genCount > 0) {
  console.log(`\nGenerated ${genCount} cfg file(s) from XLS data → ${mcuOutDir}`);
} else {
  console.log('\nNo new cfg files to generate (all no-mcucfg devices missing from XLS).');
}
