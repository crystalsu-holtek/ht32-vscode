#!/usr/bin/env node
// test-create-project.js
// 驗證 Standard + 49x 系列 Create Project 完整性。
// 第一層：靜態資源存在性（FWLib 檔案齊不齊）
// 第二層：實際呼叫 generateProjectFiles()，驗證輸出正確性
// 第三層：實際執行 make 編譯（預設啟用；加 --no-compile 可跳過）
// 第五層：lib 模式（每個 FWLib 取一個 MCU，驗證 ar rcs / .a 產出 / meta）
//
// Usage:
//   node test_scripts/test-create-project.js [options]
//
// FWLib 來源：讀取 test_scripts/fwlib-paths.ini（與 test-compile.js 共用）
//
// Options:
//   --lib <path|關鍵字>  指定單一 FWLib（在 ini 清單中搜尋）
//   --mcu <pattern>  只測符合的 MCU（支援 * ? 萬用字元，例：49365*）
//   --no-compile     跳過第三層 make 編譯
//   --no-heap-stack  跳過第四層 heap/stack RAM delta 驗證
//   --workers <n>    同時處理 n 個 MCU（預設 4）
//   --no-static      跳過第一層靜態資源檢查
//   --no-generate    跳過第二層實際產生+驗證（同時跳過第三、四、五層）
//   --no-lib         跳過第五層 lib 模式測試

'use strict';

// ── 0. vscode mock（必須在 require 任何 extension 程式碼之前）──────────────────
const vscodeMock = {
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {} }),
    showWarningMessage:     () => Promise.resolve(undefined),
    showInformationMessage: () => Promise.resolve(undefined),
    withProgress: (_, task) => task({ report: () => {} }, { isCancellationRequested: false }),
    createWebviewPanel: () => ({ webview: { html: '', onDidReceiveMessage: () => ({dispose:()=>{}}), asWebviewUri: u => u }, onDidDispose: () => ({dispose:()=>{}}), reveal: () => {} }),
  },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => d, inspect: () => undefined }),
    workspaceFolders: [],
  },
  Uri: { file: p => ({ fsPath: p, toString: () => p }) },
  ProgressLocation: { Notification: 15 },
  ExtensionContext: {},
};
const Module = require('module');
const _origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'vscode') return vscodeMock;
  return _origReq.apply(this, arguments);
};

// ── 1. Imports ────────────────────────────────────────────────────────────────
const fs            = require('fs');
const path          = require('path');
const { spawn }     = require('child_process');
const os            = require('os');

const EXT_ROOT = path.resolve(__dirname, '..');
const _extInstallDir = path.join(os.homedir(), '.vscode', 'extensions');
const _installed = fs.existsSync(_extInstallDir)
  ? fs.readdirSync(_extInstallDir).filter(d => d.startsWith('holtek.ht32-vscode-')).sort()
  : [];
if (!_installed.length) throw new Error(`ERROR: no installed holtek.ht32-vscode-* found under ${_extInstallDir}`);
const DFP_STORAGE_PATH = path.join(_extInstallDir, _installed[_installed.length - 1]);

const {
  detectFwlibSeries,
  listStdMcus,
  list49xMcus,
  generateProjectFiles,
} = require(path.join(EXT_ROOT, 'out/tools/createProject.js'));

const { MIN_HEAP_SIZE } = require(path.join(EXT_ROOT, 'out/tools/uv2make.js'));
const { locateArmGcc }  = require(path.join(EXT_ROOT, 'out/tools/toolchain.js'));

// ── 2. Config ─────────────────────────────────────────────────────────────────
const INI_FILE  = path.join(__dirname, 'fwlib-paths.ini');
let GCC     = '';
let GCC_BIN = '';
const MAKE_EXE  = path.join(EXT_ROOT, 'bin/win32-x64/make.exe');

/** 從 ini 檔讀取 lib 路徑清單（跳過空行與 # 注解） */
function readLibsFromIni() {
  try {
    return fs.readFileSync(INI_FILE, 'utf8')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
  } catch (e) {
    console.error(`[WARN] Cannot read ${INI_FILE}: ${e.message}`);
    return [];
  }
}
const _allIniLibs = readLibsFromIni();

// CLI args
const args = process.argv.slice(2);

if (!args.length) {
  console.log([
    'Usage:',
    '  node test_scripts/test-create-project.js [options]',
    '',
    `FWLib 來源：讀取 test_scripts/fwlib-paths.ini（與 test-compile.js 共用）`,
    '',
    'Options:',
    '  --lib <path|關鍵字>  指定單一 FWLib 路徑或名稱關鍵字（在 ini 清單中搜尋）',
    '  --mcu <pattern>  只測符合的 MCU（支援 * ? 萬用字元，例：49365*）',
    '  --no-compile     跳過第三層 make 編譯驗證',
    '  --no-heap-stack  跳過第四層：Stack_Size/Heap_Size 修改後 RAM usage 驗證',
    '                   （1xxx/4xxx/5xxx patch startup .equ；49x patch linker _Min_xxx）',
    '  --workers <n>    同時處理 n 個 MCU（預設 4）',
    '  --no-static      跳過第一層靜態資源檢查',
    '  --no-generate    跳過第二層實際產生+驗證（同時跳過第三、四、五層）',
    '  --no-lib         跳過第五層 lib 模式測試（每個 FWLib 取一 MCU）',
  ].join('\n'));
  process.exit(0);
}

const DO_STATIC     = !args.includes('--no-static');
const DO_GENERATE   = !args.includes('--no-generate');
const DO_COMPILE    = !args.includes('--no-compile');
const DO_HEAP_STACK = !args.includes('--no-heap-stack'); // 第四層：heap/stack RAM delta 驗證
const DO_LIB        = DO_GENERATE && !args.includes('--no-lib'); // 第五層：lib 模式測試
const MCU_ARG     = (() => { const i = args.indexOf('--mcu');     return i >= 0 ? args[i+1] : null; })();
const WORKERS     = (() => {
  const i = args.indexOf('--workers');
  if (i >= 0) return Math.max(1, parseInt(args[i+1]) || 1);
  return 4;
})();

const MCU_RE = MCU_ARG
  ? new RegExp('^' + MCU_ARG.toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
  : null;
function matchMcu(name) { return !MCU_RE || MCU_RE.test(name.toLowerCase()); }

function resolveLibArg(raw) {
  if (!raw) return null;
  if (fs.existsSync(raw)) return path.resolve(raw);
  const keyword = raw.toLowerCase();
  const matches = _allIniLibs.filter(p => p.toLowerCase().includes(keyword));
  if (!matches.length) { console.error(`[ERROR] --lib "${raw}": no match found in ${INI_FILE}`); process.exit(1); }
  if (matches.length > 1) { console.error(`[ERROR] --lib "${raw}": ambiguous:\n` + matches.map(m => '  ' + m).join('\n')); process.exit(1); }
  return matches[0];
}

const LIB_ARG = resolveLibArg((() => { const i = args.indexOf('--lib'); return i >= 0 ? args[i+1] : null; })());

// ── 3. FWLib 清單 ─────────────────────────────────────────────────────────────
function findFwlibs() {
  const result = [];
  for (const p of _allIniLibs) {
    if (!fs.existsSync(p)) continue;
    try {
      const series = detectFwlibSeries(p);
      if (series) result.push({ fwlibPath: p, series });
    } catch {}
  }
  return result;
}

// ── 4. 第一層：靜態資源存在性 ────────────────────────────────────────────────

const SETTINGS_PATH = path.join(EXT_ROOT, 'conf/Settings.ini');
let settingsRamMap = {};
try {
  const ini = fs.readFileSync(SETTINGS_PATH, 'utf8');
  const sramBlock = /\[SRAM\]([\s\S]*?)(?:\[|$)/i.exec(ini)?.[1] ?? '';
  for (const line of sramBlock.split('\n')) {
    const m = /^\s*([\w]+)\s*=\s*(0x[\da-fA-F]+|\d+)/i.exec(line);
    if (m) settingsRamMap[m[1].toUpperCase()] = m[2];
  }
} catch {}

function getAllPdscTexts() {
  const texts = [];
  const holtekDir = path.join(DFP_STORAGE_PATH, 'dfp', 'Holtek');
  try {
    for (const dfpName of fs.readdirSync(holtekDir).sort()) {
      const dfpPath = path.join(holtekDir, dfpName);
      try {
        const versions = fs.readdirSync(dfpPath).sort().reverse();
        for (const ver of versions) {
          const verPath = path.join(dfpPath, ver);
          const pdscFile = fs.readdirSync(verPath).find(f => f.endsWith('.pdsc'));
          if (pdscFile) texts.push(fs.readFileSync(path.join(verPath, pdscFile), 'utf8'));
        }
      } catch {}
    }
  } catch {}
  if (!texts.length) { console.error('ERROR: no PDSC found under', holtekDir); process.exit(1); }
  return texts;
}
const allPdscTexts = getAllPdscTexts();

function lookupRamFromSettings(deviceName) {
  const prefix = deviceName.toUpperCase();
  for (const [key, val] of Object.entries(settingsRamMap)) {
    if (key === prefix || key.startsWith(prefix + '_')) return val;
  }
  return undefined;
}

function lookupMemoryFromPdsc(deviceName, useMEMChip) {
  const tryName = (name) => {
    if (!name) return {};
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const devRe    = new RegExp(`<device\\s+Dname="${escaped}[^"]*"[^>]*>([\\s\\S]*?)</device>`, 'i');
    const familyRe = new RegExp(`<subFamily\\s+DsubFamily="${escaped}[^"]*"[^>]*>([\\s\\S]*?)</subFamily>`, 'i');
    for (const pdscText of allPdscTexts) {
      try {
        const block = devRe.exec(pdscText)?.[1] ?? familyRe.exec(pdscText)?.[1];
        if (!block) continue;
        const rom = /<memory[^>]+id="IROM1"[^>]*start="([^"]+)"[^>]*size="([^"]+)"/i.exec(block);
        const ram = /<memory[^>]+id="IRAM1"[^>]*start="([^"]+)"[^>]*size="([^"]+)"/i.exec(block);
        if (!rom && !ram) continue;
        return { flashOrigin: rom?.[1], flashLength: rom?.[2], ramOrigin: ram?.[1], ramLength: ram?.[2], foundAs: name };
      } catch {}
    }
    return {};
  };
  const r1 = tryName(deviceName);
  if (r1.ramLength || r1.flashLength) return r1;
  return tryName(useMEMChip);
}

const PLACEHOLDER_1024K = 0x100000;
function parseHexOrK(s) {
  if (!s) return 0;
  s = s.trim();
  if (/^\d+K$/i.test(s)) return parseInt(s) * 1024;
  if (/^0x/i.test(s)) return parseInt(s, 16);
  return parseInt(s);
}

function staticCheckStd(fwlibPath) {
  const gnuDir = path.join(fwlibPath, 'project_template', 'IP', 'Example', 'GNU_ARM');
  const results = [];
  let mcus;
  try { mcus = listStdMcus(fwlibPath); }
  catch (e) { return [{ name: '(list)', status: 'ERROR', issues: [`listStdMcus failed: ${e.message}`] }]; }

  for (const { displayName, mkPath } of mcus) {
    if (!matchMcu(displayName)) continue;
    const errs = [], warns = [];
    if (!fs.existsSync(mkPath)) errs.push(`mk missing: ${path.basename(mkPath)}`);
    if (!fs.existsSync(path.join(gnuDir, 'linker.ld'))) errs.push('linker.ld missing');

    const settingsRam = lookupRamFromSettings(displayName);
    const pdsc = !settingsRam ? lookupMemoryFromPdsc(displayName, undefined) : {};
    const ramVal = settingsRam ?? pdsc.ramLength;
    const flashVal = pdsc.flashLength;

    if (!ramVal) warns.push(`RAM not found (Settings.ini + PDSC)`);
    else if (parseHexOrK(ramVal) >= PLACEHOLDER_1024K) errs.push(`RAM=${ramVal} placeholder`);
    if (!flashVal) warns.push('Flash not found in PDSC');

    const ram   = ramVal   ? `RAM=${ramVal}`   : 'RAM=?';
    const flash = flashVal ? `Flash=${flashVal}` : 'Flash=?';
    results.push({ name: displayName, ram, flash,
      status: errs.length ? 'ERROR' : warns.length ? 'WARN' : 'OK',
      issues: [...errs, ...warns] });
  }
  return results;
}

function staticCheck49x(fwlibPath) {
  const gccDir    = path.join(fwlibPath, 'libraries', 'cmsis', 'cm4', 'device_support', 'startup', 'gcc');
  const linkerDir = path.join(gccDir, 'linker');
  const results = [];
  let mcus;
  try { mcus = list49xMcus(fwlibPath); }
  catch (e) { return [{ name: '(list)', status: 'ERROR', issues: [`list49xMcus failed: ${e.message}`] }]; }

  const startupExists = (() => {
    try { return fs.readdirSync(gccDir).some(f => f.startsWith('startup_') && f.endsWith('.s')); }
    catch { return false; }
  })();

  for (const { chipSuffix, displayName } of mcus) {
    if (!matchMcu(displayName)) continue;
    const errs = [], warns = [];
    const ldFile = path.join(linkerDir, `${chipSuffix}_FLASH.ld`);
    if (!fs.existsSync(ldFile)) {
      const anyLd = (() => { try { return fs.readdirSync(linkerDir).some(f => f.endsWith('_FLASH.ld')); } catch { return false; } })();
      if (!anyLd) errs.push(`linker script missing + no fallback`);
      else warns.push(`no ${chipSuffix}_FLASH.ld — will use fallback`);
    }
    if (!startupExists) errs.push('startup .s missing');

    const settingsRam = lookupRamFromSettings(displayName) ?? lookupRamFromSettings(displayName.split('_')[0]);
    const pdsc = !settingsRam ? lookupMemoryFromPdsc(displayName, displayName.split('_')[0]) : {};
    const ramVal = settingsRam ?? pdsc.ramLength;
    const flashVal = pdsc.flashLength;
    const ram   = ramVal   ? `RAM=${ramVal}`   : 'RAM=ld';
    const flash = flashVal ? `Flash=${flashVal}` : 'Flash=ld';
    const extra = !ramVal ? ' [PDSC/Settings.ini miss — ld authoritative]' : '';

    results.push({ name: displayName, ram, flash, extra,
      status: errs.length ? 'ERROR' : warns.length ? 'WARN' : 'OK',
      issues: [...errs, ...warns] });
  }
  return results;
}

// ── 5. 第二層：產生並驗證輸出 ────────────────────────────────────────────────

// temp 目錄必須和 FWLib 同磁碟（generateProjectFiles 不允許跨磁碟 relative path）
function getTempBase(fwlibPath) {
  const drive = path.resolve(fwlibPath).slice(0, 2); // e.g. "E:"
  return path.join(drive + path.sep, 'ht32-cp-test');
}
const TEMP_BASES_USED = new Set();

/**
 * Check Reset_Handler in a startup .s file has Thumb LSB marking.
 * Missing .type %function / .thumb_func → STT_NOTYPE → linker emits even address
 * in vector table → CPU enters ARM state → immediate HardFault.
 */
function checkThumbLsbFile(startupPath) {
  const issues = [];
  if (!fs.existsSync(startupPath)) return issues;
  const text = fs.readFileSync(startupPath, 'utf8');
  const labelIdx = text.search(/^Reset_Handler\s*:/m);
  if (labelIdx < 0) return issues;
  const preceding = text.slice(Math.max(0, labelIdx - 300), labelIdx);
  const hasType      = /\.type\s+Reset_Handler\s*,\s*%function/.test(preceding);
  const hasThumbFunc = /\.thumb_func/.test(preceding.split('\n').slice(-5).join('\n'));
  if (!hasType && !hasThumbFunc) {
    issues.push(`${path.basename(startupPath)}: Reset_Handler 缺 .type %function → Thumb LSB 未設 → HardFault`);
  }
  return issues;
}

function checkStartupStd(startupPath) {
  const issues = [];
  let text;
  try { text = fs.readFileSync(startupPath, 'utf8'); }
  catch { issues.push(`startup not found: ${startupPath}`); return issues; }

  if (!/\.section\s+"\.heap"\s*,\s*"aw"\s*,\s*%nobits/m.test(text))
    issues.push('.heap section 缺少 "aw",%nobits（SHF_ALLOC 未設）');
  if (!/\.section\s+"\.stack"\s*,\s*"aw"\s*,\s*%nobits/m.test(text))
    issues.push('.stack section 缺少 "aw",%nobits（SHF_ALLOC 未設）');

  // GNU AS：.equ Heap_Size, 0x100  或  ARM AS：Heap_Size EQU 0x100
  const heapM = /(?:\.equ\s+Heap_Size\s*,\s*|Heap_Size\s+EQU\s+)(0x[\da-fA-F]+|\d+)/i.exec(text);
  if (!heapM) issues.push('找不到 Heap_Size（.equ 或 EQU）');
  else {
    const sz = heapM[1].startsWith('0x') ? parseInt(heapM[1], 16) : parseInt(heapM[1]);
    if (MIN_HEAP_SIZE > 0 && sz < MIN_HEAP_SIZE) issues.push(`Heap_Size=${heapM[1]} < ${MIN_HEAP_SIZE}（最小 heap 不足）`);
  }
  issues.push(...checkThumbLsbFile(startupPath));
  return issues;
}

function checkLinkerStd(ldPath, startupDir) {
  const issues = [];
  let text;
  try { text = fs.readFileSync(ldPath, 'utf8'); }
  catch { issues.push(`linker script not found: ${ldPath}`); return issues; }

  if (!text.includes('KEEP(*(.heap))'))  issues.push('linker script 缺少 KEEP(*(.heap))');
  if (!text.includes('KEEP(*(.stack))')) issues.push('linker script 缺少 KEEP(*(.stack))');

  // __StackTop / __HT_check_sp: accept in LD or in startup .s (STD series uses .s)
  const startupText = (() => {
    if (!startupDir) return '';
    try {
      const files = fs.readdirSync(startupDir).filter(f => /^startup_/i.test(f) && f.endsWith('.s'));
      return files.map(f => fs.readFileSync(path.join(startupDir, f), 'utf8')).join('\n');
    } catch { return ''; }
  })();
  if (!/__StackTop\s*[=:]/.test(text) && !/__StackTop\b/.test(startupText))
    issues.push('__StackTop 缺失（LD 和 startup .s 都找不到）');
  if (!/__HT_check_sp\s*[=:]/.test(text) && !/__HT_check_sp\b/.test(startupText))
    issues.push('__HT_check_sp 缺失（LD 和 startup .s 都找不到）');
  return issues;
}

// 49x startup 無 .heap/.stack section，heap/stack 由 LD 的 ._user_heap_stack 分配
function checkLinker49x(ldPath) {
  const issues = [];
  let text;
  try { text = fs.readFileSync(ldPath, 'utf8'); }
  catch { issues.push(`linker script not found: ${ldPath}`); return issues; }

  const heapM = /_Min_Heap_Size\s*=\s*(0x[\da-fA-F]+|\d+)/i.exec(text);
  if (!heapM) issues.push('linker script 缺少 _Min_Heap_Size');
  else {
    const sz = heapM[1].startsWith('0x') ? parseInt(heapM[1], 16) : parseInt(heapM[1]);
    if (MIN_HEAP_SIZE > 0 && sz < MIN_HEAP_SIZE) issues.push(`_Min_Heap_Size=${heapM[1]} < ${MIN_HEAP_SIZE}（最小 heap 不足）`);
  }
  if (!text.includes('._user_heap_stack'))
    issues.push('linker script 缺少 ._user_heap_stack section（heap/stack 未計入 RAM）');
  if (!/__StackTop\s*=/.test(text))   issues.push('linker script 缺少 __StackTop（Stack Analysis 面板必需）');
  if (!/__HT_check_sp\s*=/.test(text)) issues.push('linker script 缺少 __HT_check_sp（Stack Analysis 面板必需）');
  return issues;
}

function parseMakefileDefines(mkPath) {
  try {
    const text = fs.readFileSync(mkPath, 'utf8');
    const defs = [];
    for (const m of text.matchAll(/^\s*(?:DEFS\s*[+:]=|-D)\s*(?:-D)?([\w]+)/mg)) defs.push(m[1]);
    for (const m of text.matchAll(/C_OPTION\s*\+=\s*-D([\w]+)/mg)) defs.push(m[1]);
    // DEFS 現在用 $(file <defines.list) 讀取，額外解析 defines.list
    const defsListPath = path.join(path.dirname(mkPath), 'defines.list');
    if (fs.existsSync(defsListPath)) {
      const defsText = fs.readFileSync(defsListPath, 'utf8');
      for (const m of defsText.matchAll(/-D([\w]+)/g)) defs.push(m[1]);
    }
    return [...new Set(defs)];
  } catch { return []; }
}

// ── 6. 第三層：make 編譯 ──────────────────────────────────────────────────────

function spawnAsync(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve) => {
    const { timeout = 180_000, env, cwd } = opts;
    const proc = spawn(cmd, cmdArgs, { cwd, env, stdio: 'pipe' });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch {}
    }, timeout);

    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ status: timedOut ? null : code, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000),
                error: timedOut ? 'ETIMEDOUT' : null });
    });
    proc.on('error', err => { clearTimeout(timer); resolve({ status: -1, stdout, stderr, error: err.message }); });
  });
}

async function runMake(bgDir) {
  if (!fs.existsSync(path.join(bgDir, 'Makefile'))) return { ok: false, out: 'Makefile not found' };
  const env = { ...process.env, PATH: GCC_BIN + ';' + (process.env.PATH || '') };
  const r = await spawnAsync(MAKE_EXE, ['-j', '--no-print-directory'], { cwd: bgDir, env });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  return { ok: r.status === 0 && !r.error, out, error: r.error };
}

// ── 7a. Heap/Stack RAM delta helpers ─────────────────────────────────────────

const HS_STACK_DELTA = 512;
const HS_HEAP_DELTA  = 256;

/** 使用 make -B 編譯並解析 --print-memory-usage 的 RAM 行 */
async function buildAndGetRam(bgDir) {
  const env = { ...process.env, PATH: GCC_BIN + ';' + (process.env.PATH || '') };
  const r = await spawnAsync(MAKE_EXE, ['-B', '--no-print-directory'], { cwd: bgDir, env });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = /^\s*RAM\s*:\s*(\d+)\s*B/m.exec(out);
  if (!m) {
    const tail = out.split('\n').slice(-6).join('\n');
    return { ok: false, ram: 0, err: r.error ?? `make exit=${r.status}, no RAM line\n${tail}` };
  }
  return { ok: true, ram: parseInt(m[1]) };
}

/** 修改檔案中 .equ SymName, value（只改 .equ，不改 #define）*/
function patchEqu(filePath, sym, val) {
  let text = fs.readFileSync(filePath, 'utf8');
  const re = new RegExp(`(\\.equ\\s+${sym}\\s*,\\s*)(?:0x[\\da-fA-F]+|\\d+)`, 'i');
  text = text.replace(re, `$1${val}`);
  fs.writeFileSync(filePath, text, 'utf8');
}

/** 修改 linker script 中 SymName = value; */
function patchLdSym(filePath, sym, val) {
  let text = fs.readFileSync(filePath, 'utf8');
  const re = new RegExp(`(${sym}\\s*=\\s*)[^;]+;`);
  text = text.replace(re, `$1${val};`);
  fs.writeFileSync(filePath, text, 'utf8');
}

/** 讀取 startup 中 .equ SymName 的值 */
function readEqu(filePath, sym) {
  const m = new RegExp(`\\.equ\\s+${sym}\\s*,\\s*(0x[\\da-fA-F]+|\\d+)`, 'i').exec(fs.readFileSync(filePath, 'utf8'));
  if (!m) return null;
  return m[1].startsWith('0x') || m[1].startsWith('0X') ? parseInt(m[1], 16) : parseInt(m[1]);
}

/** 讀取 linker script 中 SymName = 0xHHHH; 的值 */
function readLdSym(filePath, sym) {
  const m = new RegExp(`${sym}\\s*=\\s*(0x[\\da-fA-F]+|\\d+)`, 'i').exec(fs.readFileSync(filePath, 'utf8'));
  if (!m) return null;
  return m[1].startsWith('0x') ? parseInt(m[1], 16) : parseInt(m[1]);
}

/**
 * 第四層：驗證修改 Stack_Size/Heap_Size 後 --print-memory-usage RAM 值正確變化。
 * series.startsWith('49x') → 改 linker script _Min_Stack_Size/_Min_Heap_Size
 * 否則                     → 改 startup .equ Stack_Size/Heap_Size
 * 回傳 issues 陣列（空 = 全 PASS）。
 */
async function checkHeapStackDelta(bgDir, gnuArmDir, series) {
  const issues = [];
  const is49x = series.startsWith('49x');

  let stackFile, heapFile;
  let origStack, origHeap;
  let getStack, getHeap, setStack, setHeap;

  if (is49x) {
    // 49x: heap/stack 由 linker script _Min_Heap_Size / _Min_Stack_Size 控制
    const flashLd = (() => {
      try { return fs.readdirSync(gnuArmDir).find(f => f.endsWith('_FLASH.ld')); } catch { return undefined; }
    })();
    if (!flashLd) { issues.push('[HS] *_FLASH.ld not found in GNU_ARM/'); return issues; }
    const ldPath = path.join(gnuArmDir, flashLd);
    stackFile = heapFile = ldPath;
    origStack = readLdSym(ldPath, '_Min_Stack_Size') ?? 0x400;
    origHeap  = readLdSym(ldPath, '_Min_Heap_Size')  ?? 0x200;
    getStack  = () => readLdSym(stackFile, '_Min_Stack_Size');
    getHeap   = () => readLdSym(heapFile,  '_Min_Heap_Size');
    setStack  = (v) => patchLdSym(stackFile, '_Min_Stack_Size', `0x${v.toString(16).toUpperCase()}`);
    setHeap   = (v) => patchLdSym(heapFile,  '_Min_Heap_Size',  `0x${v.toString(16).toUpperCase()}`);
  } else {
    // 標準系列：heap/stack 由 startup .s .equ 控制（startup 在 GNU_ARM/）
    let startupFiles;
    try { startupFiles = fs.readdirSync(gnuArmDir).filter(f => f.startsWith('startup_') && f.endsWith('.s')); }
    catch { startupFiles = []; }
    if (!startupFiles.length) { issues.push('[HS] startup .s not found in GNU_ARM/'); return issues; }
    const startupPath = path.join(gnuArmDir, startupFiles[0]);
    stackFile = heapFile = startupPath;
    origStack = readEqu(startupPath, 'Stack_Size') ?? 0x200;
    origHeap  = readEqu(startupPath, 'Heap_Size')  ?? 0;
    getStack  = () => readEqu(stackFile, 'Stack_Size');
    getHeap   = () => readEqu(heapFile,  'Heap_Size');
    setStack  = (v) => patchEqu(stackFile, 'Stack_Size', v);
    setHeap   = (v) => patchEqu(heapFile,  'Heap_Size',  v);
  }

  // base build
  const base = await buildAndGetRam(bgDir);
  if (!base.ok) { issues.push(`[HS] base build failed: ${base.err}`); return issues; }

  // +stack
  setStack(origStack + HS_STACK_DELTA);
  const afterStack = await buildAndGetRam(bgDir);
  setStack(origStack); // 還原
  if (!afterStack.ok) {
    issues.push(`[HS] stack build failed: ${afterStack.err}`);
  } else {
    const diff = afterStack.ram - base.ram;
    if (diff !== HS_STACK_DELTA)
      issues.push(`[HS] Stack diff=${diff >= 0 ? '+' : ''}${diff}, expected +${HS_STACK_DELTA} (base=${base.ram} after=${afterStack.ram})`);
  }

  // +heap
  setHeap(origHeap + HS_HEAP_DELTA);
  const afterHeap = await buildAndGetRam(bgDir);
  setHeap(origHeap); // 還原
  if (!afterHeap.ok) {
    issues.push(`[HS] heap build failed: ${afterHeap.err}`);
  } else {
    const diff = afterHeap.ram - base.ram;
    if (diff !== HS_HEAP_DELTA)
      issues.push(`[HS] Heap diff=${diff >= 0 ? '+' : ''}${diff}, expected +${HS_HEAP_DELTA} (base=${base.ram} after=${afterHeap.ram})`);
  }

  return issues;
}

// ── 7. 產生 + 驗證 + 編譯 ────────────────────────────────────────────────────

async function generateAndCheck(fwlibPath, series, chipSuffix, displayName) {
  const tempBase = getTempBase(fwlibPath);
  TEMP_BASES_USED.add(tempBase);
  const projectFolder = path.join(tempBase, series, displayName.replace(/[^\w]/g, '_'));
  const projectName = `test_${displayName}`;
  const bgDirName = projectName;
  const bgDir     = path.join(projectFolder, 'HT32_VSCode', bgDirName);
  const gnuArmDir = path.join(bgDir, 'GNU_ARM');

  try { fs.rmSync(projectFolder, { recursive: true, force: true }); } catch {}

  const wizardResult = {
    fwlibPath, series, chipSuffix, displayName,
    projectName,
    projectFolder,
    outputType: 'app',
    usePrintf:  false,
  };

  try {
    await generateProjectFiles(wizardResult, EXT_ROOT, DFP_STORAGE_PATH);
  } catch (e) {
    return { status: 'ERROR', issues: [`generateProjectFiles 拋出例外: ${e.message}`], compile: 'SKIP' };
  }

  const issues = [];

  // ── 驗證 Makefile DEFS ────────────────────────────────────────────────────
  const mkPath = path.join(bgDir, 'Makefile');
  if (!fs.existsSync(mkPath)) {
    issues.push('Makefile 未產生');
  } else {
    const defs = parseMakefileDefines(mkPath);
    const boardDef = defs.find(d => d.startsWith('USE_') && /_(?:SK|DVB|EVB|BOARD)$/i.test(d));
    if (!boardDef && series.startsWith('49x')) {
      issues.push('Makefile 缺少 USE_xxx_SK board define（49x 必需）');
    } else if (boardDef && series.startsWith('49x')) {
      const skDef = defs.find(d => d.startsWith('USE_') && /_SK$/i.test(d));
      if (skDef) {
        const skChip = skDef.replace(/^USE_/i, '').replace(/_SK$/i, '').toLowerCase();
        const skDirExists = (() => {
          try { return fs.existsSync(path.join(fwlibPath, 'project', `${skChip}_sk`, 'templates', 'src')); }
          catch { return false; }
        })();
        if (!skDirExists) issues.push(`${skDef} 對應的 ${skChip}_sk/templates/src 不存在`);
      }
    }
    const useDevice = defs.find(d => d.startsWith('USE_') && !/_SK$/i.test(d) && !d.startsWith('USE_HT32_'));
    if (!useDevice) issues.push('Makefile 缺少 USE_xxx device selection define');
  }

  // ── 驗證 startup .s ───────────────────────────────────────────────────────
  // create project 的 startup .s 放在 GNU_ARM/（bgDir 的 subdirectory）
  const startupFiles = (() => {
    try { return fs.readdirSync(gnuArmDir).filter(f => f.startsWith('startup_') && f.endsWith('.s')); }
    catch { return []; }
  })();
  if (!startupFiles.length) {
    issues.push('startup .s 未複製到 GNU_ARM/');
  } else if (!series.startsWith('49x')) {
    issues.push(...checkStartupStd(path.join(gnuArmDir, startupFiles[0])));
  } else {
    // 49x: checkStartupStd 不適用（無 .heap/.stack section），但需檢查 Thumb LSB
    for (const f of startupFiles) issues.push(...checkThumbLsbFile(path.join(gnuArmDir, f)));
  }

  // ── 驗證 linker script ────────────────────────────────────────────────────
  // create project 的 linker 放在 GNU_ARM/（bgDir 的 subdirectory）
  const ldPath = (() => {
    if (series.startsWith('49x')) {
      try {
        const f = fs.readdirSync(gnuArmDir).find(f => f.endsWith('_FLASH.ld'));
        return f ? path.join(gnuArmDir, f) : null;
      } catch { return null; }
    } else {
      const p = path.join(gnuArmDir, 'linker.ld');
      return fs.existsSync(p) ? p : null;
    }
  })();
  if (!ldPath) {
    issues.push(series.startsWith('49x') ? '*_FLASH.ld 未產生（GNU_ARM/）' : 'linker.ld 未產生（GNU_ARM/）');
  } else {
    issues.push(...(series.startsWith('49x') ? checkLinker49x(ldPath) : checkLinkerStd(ldPath, gnuArmDir)));
  }

  // 輸出驗證失敗時不再進行編譯
  if (issues.length) {
    try { fs.rmSync(projectFolder, { recursive: true, force: true }); } catch {}
    return { status: 'FAIL', issues, compile: 'SKIP' };
  }

  // ── 第三層：make 編譯 ─────────────────────────────────────────────────────
  if (DO_COMPILE || DO_HEAP_STACK) {
    const make = await runMake(bgDir);
    if (!make.ok) {
      try { fs.rmSync(projectFolder, { recursive: true, force: true }); } catch {}
      // 取最後 8 行的 error/warning 訊息
      const errLines = make.out.split('\n')
        .filter(l => /error:|warning:|undefined|cannot/i.test(l))
        .slice(-8);
      return { status: 'FAIL', issues: ['make 編譯失敗'], compile: 'FAIL',
               makeOut: errLines.length ? errLines.join('\n') : make.out.split('\n').slice(-5).join('\n') };
    }

    // ── 第四層：heap/stack RAM delta 驗證 ──────────────────────────────────
    if (DO_HEAP_STACK) {
      const hsIssues = await checkHeapStackDelta(bgDir, gnuArmDir, series);
      try { fs.rmSync(projectFolder, { recursive: true, force: true }); } catch {}
      if (hsIssues.length) {
        return { status: 'FAIL', issues: hsIssues, compile: 'OK' };
      }
      return { status: 'OK', issues: [], compile: 'OK' };
    }

    try { fs.rmSync(projectFolder, { recursive: true, force: true }); } catch {}
    return { status: 'OK', issues: [], compile: 'OK' };
  }

  try { fs.rmSync(projectFolder, { recursive: true, force: true }); } catch {}
  return { status: 'OK', issues: [], compile: 'SKIP' };
}

// ── 7b. Lib 模式：generate + 驗證 + 編譯 ─────────────────────────────────────

async function generateAndCheckLib(fwlibPath, series, chipSuffix, displayName) {
  const tempBase = getTempBase(fwlibPath);
  TEMP_BASES_USED.add(tempBase);
  const projectFolder = path.join(tempBase, series, `lib_${displayName.replace(/[^\w]/g, '_')}`);
  const projectName = `test_lib_${displayName}`;
  const bgDirName = projectName;
  const bgDir     = path.join(projectFolder, 'HT32_VSCode', bgDirName);
  const gnuArmDir = path.join(bgDir, 'GNU_ARM');

  try { fs.rmSync(projectFolder, { recursive: true, force: true }); } catch {}
  const wizardResult = {
    fwlibPath, series, chipSuffix, displayName,
    projectName,
    projectFolder,
    outputType: 'lib',
    usePrintf:  false,
  };

  try {
    await generateProjectFiles(wizardResult, EXT_ROOT, DFP_STORAGE_PATH);
  } catch (e) {
    return { status: 'ERROR', issues: [`generateProjectFiles 拋出例外: ${e.message}`], compile: 'SKIP' };
  }

  const issues = [];

  // ── Makefile: 必須含 ar rcs，不能含 startup_ ──────────────────────────────
  const mkPath = path.join(bgDir, 'Makefile');
  if (!fs.existsSync(mkPath)) {
    issues.push('Makefile 未產生');
  } else {
    const mkText = fs.readFileSync(mkPath, 'utf8');
    if (!/\$\(AR\)"?\s+rcs/.test(mkText) && !/\bar\s+rcs/.test(mkText))
      issues.push('Makefile 缺少 $(AR) rcs（非 library 目標）');
    if (/startup_/i.test(mkText))
      issues.push('Makefile 含 startup_ 檔（lib 不應有 startup）');
    if (/syscalls\.c/i.test(mkText))
      issues.push('Makefile 含 syscalls.c（lib 不應有）');
    if (/stack_analysis/i.test(mkText))
      issues.push('Makefile 含 stack_analysis.c（lib 不應有）');
  }

  // ── src/<projectName>.c 必須存在 ─────────────────────────────────────────
  const emptyC = path.join(bgDir, 'src', `${projectName}.c`);
  if (!fs.existsSync(emptyC))
    issues.push(`src/${projectName}.c 未產生`);

  // ── project.meta.json: isLibrary + 只有 User group ───────────────────────
  const metaPath = path.join(bgDir, 'project.meta.json');
  if (!fs.existsSync(metaPath)) {
    issues.push('project.meta.json 未產生');
  } else {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (!meta.isLibrary)
        issues.push('project.meta.json 缺少 isLibrary: true');
      const groupKeys = Object.keys(meta.groups ?? {});
      const unexpected = groupKeys.filter(g => g !== 'User');
      if (unexpected.length)
        issues.push(`project.meta.json 含多餘 groups: ${unexpected.join(', ')}`);
    } catch { issues.push('project.meta.json 解析失敗'); }
  }

  // ── GNU_ARM/ 不應有 startup .s 或 linker .ld ─────────────────────────────
  if (fs.existsSync(gnuArmDir)) {
    const gnuFiles = fs.readdirSync(gnuArmDir);
    if (gnuFiles.some(f => f.startsWith('startup_') && f.endsWith('.s')))
      issues.push('GNU_ARM/ 含 startup .s（lib 不應有）');
    if (gnuFiles.some(f => f.endsWith('.ld')))
      issues.push('GNU_ARM/ 含 .ld linker script（lib 不應有）');
  }

  if (issues.length) {
    try { fs.rmSync(projectFolder, { recursive: true, force: true }); } catch {}
    return { status: 'FAIL', issues, compile: 'SKIP' };
  }

  // ── 第三層（lib）：make 編譯 + 驗證 .a 產出 ──────────────────────────────
  if (DO_COMPILE) {
    const make = await runMake(bgDir);
    if (!make.ok) {
      const errLines = make.out.split('\n')
        .filter(l => /error:|warning:|undefined|cannot/i.test(l)).slice(-8);
      try { fs.rmSync(projectFolder, { recursive: true, force: true }); } catch {}
      return { status: 'FAIL', issues: ['make 編譯失敗'], compile: 'FAIL',
               makeOut: errLines.length ? errLines.join('\n') : make.out.split('\n').slice(-5).join('\n') };
    }
    // 驗證 .a 已產出
    const buildDir = path.join(bgDir, 'build');
    const aFile = fs.existsSync(buildDir)
      ? fs.readdirSync(buildDir).find(f => f.endsWith('.a'))
      : undefined;
    if (!aFile) {
      try { fs.rmSync(projectFolder, { recursive: true, force: true }); } catch {}
      return { status: 'FAIL', issues: ['make 成功但 .a 未產出'], compile: 'OK-no-a' };
    }
    try { fs.rmSync(projectFolder, { recursive: true, force: true }); } catch {}
    return { status: 'OK', issues: [], compile: 'OK' };
  }

  try { fs.rmSync(projectFolder, { recursive: true, force: true }); } catch {}
  return { status: 'OK', issues: [], compile: 'SKIP' };
}

// ── 8. Ctrl+C 中斷 ───────────────────────────────────────────────────────────
let interrupted = false;
process.on('SIGINT', () => {
  if (interrupted) process.exit(1); // 連按兩次直接結束
  interrupted = true;
  console.log('\n[INTERRUPTED] Ctrl+C — 等待目前工作完成後結束...');
});

// ── 8b. Concurrent runner ─────────────────────────────────────────────────────
async function runConcurrent(items, fn, maxWorkers) {
  const results = [];
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < items.length) {
      if (interrupted) break;
      const i = nextIdx++;
      const r = await fn(items[i], i, items.length);
      results[i] = r;
      process.stdout.write(r.lines.join('\n') + '\n');
    }
  }
  const n = Math.min(maxWorkers, items.length || 1);
  await Promise.all(Array.from({ length: n }, worker));
  return results.filter(Boolean);
}

// ── 9. Per-MCU processor ──────────────────────────────────────────────────────
async function processMcu({ fwlibPath, series, chipSuffix, displayName, staticResult }, idx, total) {
  const lines = [];
  let status = staticResult?.status ?? 'OK';
  const issues = [...(staticResult?.issues ?? [])];
  let compile = '-';

  const pad = `[${String(idx+1).padStart(4)}/${total}]`;

  if (DO_GENERATE) {
    const gen = await generateAndCheck(fwlibPath, series, chipSuffix, displayName);
    if (gen.status === 'ERROR') status = 'ERROR';
    else if (gen.status === 'FAIL' && status !== 'ERROR') status = 'FAIL';
    issues.push(...gen.issues);
    compile = gen.compile ?? '-';
    if (gen.makeOut) issues.push(...gen.makeOut.split('\n').map(l => '  ' + l.trim()).filter(l => l.trim()));
  }

  const ram   = staticResult?.ram   ?? '';
  const flash = staticResult?.flash ?? '';
  const extra = staticResult?.extra ?? '';
  const compileTag = DO_COMPILE ? `  compile=${compile}` : '';
  const line = `  ${status.padEnd(6)} ${displayName.padEnd(28)} ${ram.padEnd(18)} ${flash}${compileTag}${extra}`;
  lines.push(`${pad}${line}`);
  for (const issue of issues) lines.push(`         ! ${issue}`);

  return { lines, status, issues };
}

// ── 10. Main ──────────────────────────────────────────────────────────────────
async function main() {
  GCC = await locateArmGcc();
  if (!GCC) { console.error('[FATAL] arm-none-eabi-gcc not found. Install the GNU Arm toolchain or set ht32.gccPath.'); process.exit(1); }
  GCC_BIN = path.dirname(GCC);
  console.log(`[GCC] ${GCC}`);

  const fwlibs = LIB_ARG
    ? [{ fwlibPath: LIB_ARG, series: detectFwlibSeries(LIB_ARG) }].filter(x => x.series)
    : findFwlibs();

  if (!fwlibs.length) {
    console.log(`No FWLib found. Check ${INI_FILE}`);
    process.exit(0);
  }

  let totalOK = 0, totalWarn = 0, totalFail = 0, totalErr = 0;

  for (const { fwlibPath, series } of fwlibs) {
    if (interrupted) break;

    let staticResults = {};
    if (DO_STATIC) {
      const rows = series === 'std' ? staticCheckStd(fwlibPath) : staticCheck49x(fwlibPath);
      for (const r of rows) staticResults[r.name] = r;
    }

    let mcus = [];
    try {
      const raw = series === 'std' ? listStdMcus(fwlibPath) : list49xMcus(fwlibPath);
      mcus = raw.filter(m => matchMcu(m.displayName));
    } catch (e) {
      console.log(`\n[ERROR] Cannot list MCUs for ${fwlibPath}: ${e.message}`);
      continue;
    }
    if (!mcus.length) continue;

    console.log(`\n${'='.repeat(72)}`);
    console.log(`${path.basename(fwlibPath)}  [${series}]  MCUs:${mcus.length}  Workers:${WORKERS}`);
    const flags = [
      `Static:${DO_STATIC?'YES':'NO'}`,
      `Generate:${DO_GENERATE?'YES':'NO'}`,
      `Compile:${DO_COMPILE?'YES':'NO'}`,
      `HeapStack:${DO_HEAP_STACK?'YES':'SKIP'}`,
    ].join('  ');
    console.log(flags);
    console.log('='.repeat(72));

    const items = mcus.map(m => ({
      fwlibPath, series,
      chipSuffix:   m.chipSuffix,
      displayName:  m.displayName,
      staticResult: staticResults[m.displayName] ?? null,
    }));

    const results = await runConcurrent(items, processMcu, WORKERS);
    for (const r of results) {
      if      (r.status === 'OK')    totalOK++;
      else if (r.status === 'WARN')  totalWarn++;
      else if (r.status === 'FAIL')  totalFail++;
      else if (r.status === 'ERROR') totalErr++;
    }
  }

  // ── 第五層：lib 模式測試（每個 FWLib 取第一個 MCU）──────────────────────
  if (DO_LIB && !interrupted) {
    console.log(`\n${'='.repeat(72)}`);
    console.log(`Lib mode test  (outputType='lib', one MCU per FWLib)`);
    const libFlags = `Compile:${DO_COMPILE ? 'YES' : 'NO'}`;
    console.log(libFlags);
    console.log('='.repeat(72));

    for (const { fwlibPath, series } of fwlibs) {
      if (interrupted) break;
      let mcus;
      try {
        const raw = series === 'std' ? listStdMcus(fwlibPath) : list49xMcus(fwlibPath);
        mcus = raw.filter(m => matchMcu(m.displayName));
      } catch { continue; }
      if (!mcus.length) continue;

      const { chipSuffix, displayName } = mcus[0];
      const r = await generateAndCheckLib(fwlibPath, series, chipSuffix, displayName);
      const compileTag = DO_COMPILE ? `  compile=${r.compile}` : '';
      const lib = path.basename(fwlibPath);
      console.log(`  ${r.status.padEnd(6)} ${lib.padEnd(36)} MCU:${displayName}${compileTag}`);
      for (const issue of r.issues) console.log(`         ! ${issue}`);
      if (r.makeOut) for (const l of r.makeOut.split('\n')) console.log(`  ${l.trim()}`);

      if      (r.status === 'OK')    totalOK++;
      else if (r.status === 'FAIL')  totalFail++;
      else if (r.status === 'ERROR') totalErr++;
    }
  }

  // 清理各磁碟 temp 目錄
  for (const tb of TEMP_BASES_USED) {
    try { fs.rmSync(tb, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${'='.repeat(72)}`);
  if (interrupted) console.log('[INTERRUPTED]');
  console.log(`Total: OK=${totalOK}  WARN=${totalWarn}  FAIL=${totalFail}  ERROR=${totalErr}`);
  if (interrupted) process.exit(130);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
