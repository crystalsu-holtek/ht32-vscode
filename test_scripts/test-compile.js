#!/usr/bin/env node
// scripts/test-compile.js
// 對 STD FWLib 每個 example 執行：
//   1. _CreateProject.bat（如未執行過）
//   2. uVision   (.uvprojx)    → build-gen → make
//   3. HT32-IDE  (.project/.cproject) → build-gen → make
// 每個 example 隨機抽 VARIANTS 個 MCU variant 測試。
//
// Usage:
//   node scripts/test-compile.js                              # STD_1xxxx（預設）
//   node scripts/test-compile.js --lib e:/HT32_STD_5xxxx_... # 指定 library 路徑
//   node scripts/test-compile.js --all                        # 掃描 e:\ 所有 FWLib
//   node scripts/test-compile.js --limit 5                    # 只跑前 5 個 examples
//   node scripts/test-compile.js --no-compile                 # 只測轉換，不 make
//   node scripts/test-compile.js --variants 1                 # 每個 example 只測 1 個 MCU
//   node scripts/test-compile.js --workers 4                  # 同時跑 4 個 examples

'use strict';

// ── 0. vscode mock（必須在 require 任何 extension 程式碼之前） ──────────────
// uv2make.js line 11: const CHANNEL = vscode.window.createOutputChannel(...)
// 這是 module-level code，require() 瞬間就執行，所以需要先 mock。
const vscodeMock = {
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {} }),
    showWarningMessage:     (m) => Promise.resolve(undefined),
    showInformationMessage: (m) => Promise.resolve(undefined),
    withProgress: (_, task) => task({ report: () => {} }, { isCancellationRequested: false }),
  },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => d, inspect: () => undefined }),
  },
  ProgressLocation: { Notification: 15 },
};
const Module = require('module');
const _origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'vscode') return vscodeMock;
  return _origReq.apply(this, arguments);
};

// ── 1. Imports ────────────────────────────────────────────────────────────────
const path          = require('path');
const fs            = require('fs');
const os            = require('os');
const { spawn }     = require('child_process');

const EXT_ROOT = path.resolve(__dirname, '..');
const _extInstallDir = path.join(os.homedir(), '.vscode', 'extensions');
const _installed = fs.existsSync(_extInstallDir)
  ? fs.readdirSync(_extInstallDir).filter(d => d.startsWith('holtek.ht32-vscode-')).sort()
  : [];
if (!_installed.length) throw new Error(`ERROR: no installed holtek.ht32-vscode-* found under ${_extInstallDir}`);
const DFP_STORAGE_PATH = path.join(_extInstallDir, _installed[_installed.length - 1]);

// 載入編譯好的 extension 工具
const {
  uv2make,
  regenerateMakefileFlags,
} = require(path.join(EXT_ROOT, 'out/tools/uv2make.js'));

const { locateArmGcc } = require(path.join(EXT_ROOT, 'out/tools/toolchain.js'));

const { DEFAULT_PROJECT_SETTINGS, readProjectSettings, writeProjectSettings } = require(path.join(EXT_ROOT, 'out/tools/settingsWebview.js'));

const { convertHt32IdeProject } = require(path.join(EXT_ROOT, 'out/tools/ht32ide2make.js'));

// ── 2. Config ─────────────────────────────────────────────────────────────────
const INI_FILE = path.join(__dirname, 'fwlib-paths.ini');

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
const DEFAULT_LIB = _allIniLibs.find(p => fs.existsSync(path.join(p, 'example')))
  || 'e:/HT32_STD_1xxxx_FWLib_V1.7.1_3596';
const EXT_PATH    = EXT_ROOT;
let GCC     = '';   // resolved in main() via locateArmGcc()
let GCC_BIN = '';
const MAKE_EXE    = path.join(EXT_ROOT, 'bin/win32-x64/make.exe');
const REPORT_DIR  = path.join(__dirname, 'test-compile-report');

// CLI args
const args = process.argv.slice(2);

if (!args.length) {
  console.log([
    'Usage:',
    '  node test_scripts/test-compile.js [options]',
    '',
    '  預設不執行 _CreateProject.bat（需先跑 create-prj.js）。',
    '',
    'Options:',
    '  --lib <path|關鍵字>  指定 library 路徑或名稱關鍵字（例：4xxxx、STD_5）',
    '  --all            掃描所有 FWLib（來自 fwlib-paths.ini）',
    '  --filter <name>  只跑 example 資料夾名稱完全吻合 <name> 的 examples（大小寫不分）',
    '  --limit <n>      只跑前 n 個 examples',
    '  --mcu <pattern>  只測符合的 MCU（支援 * ? 萬用字元，例：6624*）',
    '  --variants <n>   每個 example 隨機測 n 個 MCU（預設 3，--mcu 時忽略）',
    '  --create         執行 _CreateProject.bat（否則假設已由 create-prj.js 建好）',
    '  --no-compile     只測轉換，不執行 make',
    '  --workers <n>    同時處理 n 個 examples（預設 4）',
  ].join('\n'));
  process.exit(0);
}

const DO_COMPILE = !args.includes('--no-compile');
const DO_CREATE  = args.includes('--create');
const SCAN_ALL   = args.includes('--all');
const LIMIT      = (() => { const i = args.indexOf('--limit');    return i >= 0 ? parseInt(args[i+1]) || 0 : 0; })();
const VARIANTS   = (() => { const i = args.indexOf('--variants'); return i >= 0 ? parseInt(args[i+1]) || 3 : 3; })();
const FILTER     = (() => { const i = args.indexOf('--filter');   return i >= 0 ? args[i+1] : null; })();
const MCU_ARG    = (() => { const i = args.indexOf('--mcu');      return i >= 0 ? args[i+1] : null; })();
const WORKERS    = (() => { const i = args.indexOf('--workers');  return i >= 0 ? Math.max(1, parseInt(args[i+1]) || 4) : 4; })();

/** --mcu 萬用字元比對（支援 * 和 ?） */
const MCU_RE = MCU_ARG
  ? new RegExp('^' + MCU_ARG.toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
  : null;
function matchMcu(code) { return !MCU_RE || MCU_RE.test(code.toLowerCase()); }

/** --lib 支援局部名稱：若不是現有絕對路徑，就在 ini 清單裡找路徑含該字串的項目 */
function resolveLibArg(raw) {
  if (!raw) return null;
  if (fs.existsSync(raw)) return path.resolve(raw);
  const keyword = raw.toLowerCase();
  const matches = _allIniLibs.filter(p => p.toLowerCase().includes(keyword));
  if (matches.length === 0) { console.error(`[ERROR] --lib "${raw}": no match found in ${INI_FILE}`); process.exit(1); }
  if (matches.length > 1) {
    console.error(`[ERROR] --lib "${raw}": ambiguous, matches:\n` + matches.map(m => '  ' + m).join('\n'));
    process.exit(1);
  }
  return matches[0];
}

const LIB_ARG = resolveLibArg((() => { const i = args.indexOf('--lib'); return i >= 0 ? args[i+1] : null; })());
if (SCAN_ALL && LIB_ARG) { console.error('[ERROR] --all 與 --lib 互斥，擇一使用'); process.exit(1); }

/** 從 ini 取得所有 STD FWLib（有 example/ 目錄） */
function findAllLibs() {
  return _allIniLibs.filter(p => fs.existsSync(path.join(p, 'example')));
}

/** 從 ini 取得所有 49x FWLib（有 project/ 但沒有 example/） */
function findAll49xLibs() {
  return _allIniLibs.filter(p =>
    fs.existsSync(path.join(p, 'project')) &&
    !fs.existsSync(path.join(p, 'example')));
}

/**
 * 掃描 49x FWLib 底下所有 example 目錄。
 * 結構：project/{board}/examples/{category}/{example_name}/
 * 每個 example 有 mdk_v5/*.uvprojx 和可能的 HT32-IDE/.project/.cproject
 */
function scan49xExamples(libRoot) {
  const result = [];
  const projectRoot = path.join(libRoot, 'project');
  if (!fs.existsSync(projectRoot)) return result;
  for (const board of fs.readdirSync(projectRoot)) {
    const examplesDir = path.join(projectRoot, board, 'examples');
    if (!fs.existsSync(examplesDir)) continue;
    try {
      for (const cat of fs.readdirSync(examplesDir)) {
        const catPath = path.join(examplesDir, cat);
        try { if (!fs.statSync(catPath).isDirectory()) continue; } catch { continue; }
        for (const ex of fs.readdirSync(catPath)) {
          const exPath = path.join(catPath, ex);
          try { if (!fs.statSync(exPath).isDirectory()) continue; } catch { continue; }
          const mdk5 = path.join(exPath, 'mdk_v5');
          if (fs.existsSync(mdk5) && fs.readdirSync(mdk5).some(f => f.endsWith('.uvprojx'))) {
            result.push({ exPath, board, relPath: `project/${board}/examples/${cat}/${ex}` });
          }
        }
      }
    } catch {}
  }
  return result.sort((a, b) => a.exPath.localeCompare(b.exPath));
}

/** 找 49x example 的 uVision .uvprojx 和 HT32-IDE project dir */
function findVariants49x(exPath) {
  let uvFile = null;
  try {
    const mdk5 = path.join(exPath, 'mdk_v5');
    const f = fs.readdirSync(mdk5).find(f => f.endsWith('.uvprojx'));
    if (f) uvFile = path.join(mdk5, f);
  } catch {}

  let ideDir = null;
  const ht32ideDir = path.join(exPath, 'HT32-IDE');
  if (fs.existsSync(path.join(ht32ideDir, '.project')) &&
      fs.existsSync(path.join(ht32ideDir, '.cproject'))) {
    ideDir = ht32ideDir;
  }
  return { uvFile, ideDir };
}

// ── 3. Helpers ────────────────────────────────────────────────────────────────
function pickRandom(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, arr.length));
}

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

/**
 * Check linker script has heap/stack counted in RAM usage.
 * Accepts either KEEP(*(.heap/.stack)) or ._user_heap_stack / __StackTop patterns.
 * Returns array of issue strings (empty = OK).
 */
function checkLinkerHeapStack(ldPath, startupDir) {
  const issues = [];
  if (!fs.existsSync(ldPath)) {
    issues.push('linker_script.ld not found');
    return issues;
  }
  const ld = fs.readFileSync(ldPath, 'utf8');
  const hasKeepHeap  = /KEEP\s*\(\s*\*\s*\(\s*\.heap\s*\)\s*\)/.test(ld);
  const hasKeepStack = /KEEP\s*\(\s*\*\s*\(\s*\.stack\s*\)\s*\)/.test(ld);
  const hasUserHpStk = /\._user_heap_stack/.test(ld);
  const hasStackTop  = /__StackTop\s*[=:]/.test(ld);
  const hasHtCheckSp = /__HT_check_sp\s*[=:]/.test(ld);
  const startupText  = (() => {
    if (!startupDir) return '';
    try {
      const files = fs.readdirSync(startupDir).filter(f => /^startup_/i.test(f) && f.endsWith('.s'));
      return files.map(f => fs.readFileSync(path.join(startupDir, f), 'utf8')).join('\n');
    } catch { return ''; }
  })();
  if (!hasKeepHeap && !hasUserHpStk) {
    issues.push('heap not in RAM (no KEEP(*(.heap)) and no ._user_heap_stack)');
  }
  if (!hasKeepStack && !hasStackTop && !hasUserHpStk) {
    issues.push('stack not in RAM (no KEEP(*(.stack)), __StackTop, or ._user_heap_stack)');
  }
  // needs 2: STD 系列（KEEP(*(.heap)) 模式）時，_Min_Heap_Size 必須為 0x0
  // （startup .s 已透過 .space 分配 heap，LD 不應再額外分配）
  // 49x 系列使用 ._user_heap_stack，_Min_Heap_Size > 0 是正確的（唯一的 heap 分配）
  if (hasKeepHeap) {
    const minHeapM = /_Min_Heap_Size\s*=\s*(0x[\da-fA-F]+|\d+)\s*;/i.exec(ld);
    if (minHeapM) {
      const v = minHeapM[1].startsWith('0x') ? parseInt(minHeapM[1], 16) : parseInt(minHeapM[1]);
      if (v > 0) issues.push(`_Min_Heap_Size=${minHeapM[1]} > 0 — startup + LD double allocation`);
    }
  }
  // Stack Usage Analysis panel symbols: accept in LD or startup .s (STD series uses .s).
  if (!hasStackTop  && !/__StackTop\b/.test(startupText))
    issues.push('__StackTop 缺失 — Stack Analysis 面板無法讀取 stack 頂端位址');
  if (!hasHtCheckSp && !/__HT_check_sp\b/.test(startupText))
    issues.push('__HT_check_sp 缺失 — Stack Analysis 面板無法取得 stack 底部');
  return issues;
}

/**
 * Check Reset_Handler in a startup .s file has Thumb LSB marking.
 * Missing .type %function / .thumb_func → STT_NOTYPE → linker emits even address
 * in vector table → CPU enters ARM state → immediate HardFault.
 * Returns array of issue strings (empty = OK).
 */
function checkThumbLsbFile(startupPath) {
  const issues = [];
  if (!fs.existsSync(startupPath)) return issues;
  const text = fs.readFileSync(startupPath, 'utf8');
  const labelIdx = text.search(/^Reset_Handler\s*:/m);
  if (labelIdx < 0) return issues; // no Reset_Handler in this file
  const preceding = text.slice(Math.max(0, labelIdx - 300), labelIdx);
  const hasType      = /\.type\s+Reset_Handler\s*,\s*%function/.test(preceding);
  const hasThumbFunc = /\.thumb_func/.test(preceding.split('\n').slice(-5).join('\n'));
  if (!hasType && !hasThumbFunc) {
    issues.push(`${path.basename(startupPath)}: Reset_Handler 缺 .type %function → Thumb LSB 未設 → HardFault`);
  }
  return issues;
}

/** Check all startup_*.s files in a directory for Thumb LSB. */
function checkThumbLsbInDir(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^startup_/i.test(f) && f.toLowerCase().endsWith('.s')); }
  catch {}
  return files.flatMap(f => checkThumbLsbFile(path.join(dir, f)));
}

/** Parse --print-memory-usage RAM value (bytes) from make output. Returns null if not found. */
function parseRamFromMakeOutput(stdout, stderr) {
  const m = /^\s*RAM\s*:\s*(\d+)\s*B/m.exec((stdout || '') + (stderr || ''));
  return m ? parseInt(m[1]) : null;
}

/** Read `sym = 0xVAL;` or `sym = VAL;` from LD content. Returns null if not found. */
function readLdSym(ldContent, sym) {
  const m = new RegExp(`\\b${sym}\\s*=\\s*(0x[\\da-fA-F]+|\\d+)\\s*;`).exec(ldContent);
  if (!m) return null;
  return /^0x/i.test(m[1]) ? parseInt(m[1], 16) : parseInt(m[1]);
}

/**
 * Read heap/stack sizes for dynamic RAM check.
 * STD style (KEEP(*(.heap))): read Heap_Size/Stack_Size from startup in dir.
 * 49x style (._user_heap_stack): read _Min_Heap_Size/_Min_Stack_Size from LD.
 * Returns { heap, stack } in bytes.
 */
function readHeapStackSizes(dir, ldPath) {
  let ldContent = '';
  try { ldContent = fs.readFileSync(ldPath, 'utf8'); } catch {}
  const isUserHeapStack = /\._user_heap_stack/.test(ldContent) &&
                          !/KEEP\s*\(\s*\*\s*\(\s*\.heap/.test(ldContent);
  if (isUserHeapStack) {
    return {
      heap:  readLdSym(ldContent, '_Min_Heap_Size')  ?? 256,
      stack: readLdSym(ldContent, '_Min_Stack_Size') ?? 512,
    };
  }
  return {
    heap:  readStartupEquFromDir(dir, 'Heap_Size')  ?? 0,
    stack: readStartupEquFromDir(dir, 'Stack_Size') ?? 512,
  };
}

/** Read .equ SymName decimal value from startup_*.s in dir. Returns null if not found. */
function readStartupEquFromDir(dir, sym) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^startup_/i.test(f) && f.toLowerCase().endsWith('.s')); }
  catch {}
  for (const f of files) {
    try {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const m = new RegExp(`\\.equ\\s+${sym}\\s*,\\s*(0x[\\da-fA-F]+|\\d+)`, 'i').exec(text);
      if (m) return /^0x/i.test(m[1]) ? parseInt(m[1], 16) : parseInt(m[1]);
    } catch {}
  }
  return null;
}

/**
 * Check startup_*.s files in dir have "aw",%nobits on .heap/.stack sections.
 * Used for uVision path (startup is in GNU_ARM/, not tracked via sources).
 * Heap_Size=0 is allowed (original Keil intent); printf(%f) warning is shown at conversion time.
 */
function checkStartupDir(dir) {
  const issues = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^startup_/i.test(f) && f.toLowerCase().endsWith('.s')); }
  catch {}
  for (const f of files) {
    try {
      const content = fs.readFileSync(path.join(dir, f), 'utf8');
      if (!/\.section\s+["']?\.(heap|stack)["']?/i.test(content)) continue;
      if (!/\.section\s+"\.heap"\s*,\s*"aw"\s*,\s*%nobits/.test(content))
        issues.push(`${f}: .heap section missing "aw",%nobits`);
      if (!/\.section\s+"\.stack"\s*,\s*"aw"\s*,\s*%nobits/.test(content))
        issues.push(`${f}: .stack section missing "aw",%nobits`);
    } catch {}
  }
  return issues;
}

/**
 * Async subprocess wrapper (replaces spawnSync).
 * opts.stdio controls I/O; opts.input pipes to stdin; opts.timeout kills after N ms.
 */
function spawnAsync(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve) => {
    const { input, timeout = 120_000, env, cwd, stdio = 'pipe' } = opts;
    const proc = spawn(cmd, cmdArgs, { cwd, env, stdio });

    let stdout = '';
    let stderr = '';
    if (proc.stdout) proc.stdout.on('data', d => { stdout += d; });
    if (proc.stderr) proc.stderr.on('data', d => { stderr += d; });

    if (input !== undefined && proc.stdin) {
      try { proc.stdin.write(input); proc.stdin.end(); } catch {}
    }

    let timedOut = false;
    const timer = timeout > 0 ? setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch {}
    }, timeout) : null;

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        status:  timedOut ? null : code,
        stdout:  stdout.slice(-2000),
        stderr:  stderr.slice(-2000),
        error:   timedOut ? new Error('ETIMEDOUT') : null,
      });
    });
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ status: -1, stdout, stderr, error: err });
    });
  });
}

/** 執行 make，回傳 { ok, stdout, stderr } */
async function runMake(cwd) {
  if (!DO_COMPILE) return { ok: true, skipped: true };
  if (!fs.existsSync(path.join(cwd, 'Makefile'))) {
    return { ok: false, stderr: 'Makefile not found' };
  }
  // arm-none-eabi-ar/objcopy 等工具需要在 PATH 裡
  const env = { ...process.env, PATH: GCC_BIN + ';' + (process.env.PATH || '') };
  const r = await spawnAsync(MAKE_EXE, ['-j', '--no-print-directory'], {
    cwd, env, stdio: 'pipe', timeout: 120_000,
  });
  return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr, error: r.error?.message };
}

// ── cmdEnv(cwd) ───────────────────────────────────────────────────────────────
// 問題：Node.js 在 Git Bash 下繼承 Git Bash 的 PATH，包含 /usr/bin/timeout 等
// 程式蓋過 Windows 原生工具，且 =X: per-drive 環境變數未設，導致 cmd.exe 裡的
// ..\..\.. 相對路徑解析失敗（C# 原生呼叫沒有這個問題）。
//
// 修法：
//  1. 剝除 PATH 中的 Git Bash / MSYS 路徑（含 \Git\, \mingw, \msys, \cygwin）
//  2. 設定 =X: 變數 → cmd.exe 知道磁碟機 X: 的當前目錄是 cwd，
//     讓 ..\..\..\gsar.e_x_e 等跨層相對路徑能正確解析
function cmdEnv(cwd) {
  const env = { ...process.env };

  // 1. 清除 Git Bash / MSYS PATH 污染
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
  if (env[pathKey]) {
    env[pathKey] = env[pathKey]
      .split(path.delimiter)
      .filter(p => !/[/\\](git|mingw|msys|cygwin)[/\\]/i.test(p))
      .join(path.delimiter);
  }

  // 2. 補設 =X: per-drive 當前目錄（cmd.exe 以此做相對路徑解析）
  const abs = path.resolve(cwd);
  const drive = abs.slice(0, 2).toUpperCase(); // e.g. "E:"
  env[`=${drive}`] = abs;

  // 3. 把 cwd 加到 PATH 最前面
  // 問題：在某些 Windows 11 環境下，cmd.exe 從 Node.js 生成的子程序中
  // 不會搜尋 CWD 來找 gsar.exe，需明確把 cwd 放到 PATH 讓它找得到。
  if (env[pathKey]) {
    env[pathKey] = abs + path.delimiter + env[pathKey];
  } else {
    env[pathKey] = abs;
  }

  return env;
}

// ── 4. 執行 _CreateProject.bat ───────────────────────────────────────────────
// 直接執行 example 目錄內現成的 _CreateProject.bat，讓 bat 自己處理：
//   - 偵測 Template / Template_USB
//   - 複製 _CreateProjectScript.bat 並執行
//   - 執行 _ProjectConfigM0p/M3/M4/M0pl.bat（核心配置，含 _RETARGET 設定）
//   - 執行 _ProjectConfigScript.bat
// 不在 JS 側複製 bat 的邏輯，避免漏掉任何步驟。
//
// 注意：bat 末尾有 "IF EXIST _CreateProjectConfScript.bat PAUSE"，
// 以 stdio:['pipe','ignore','ignore'] + input:'\r\n' 自動繞過。
// stdout/stderr 設為 'ignore'：_CreateProjectScript.bat 的 "REM @ECHO OFF"
// 導致大量 echo 輸出，若用 'pipe' 會塞滿 OS pipe buffer → 死鎖。
async function createProjects(exampleDir) {
  const mdk5Dir   = path.join(exampleDir, 'MDK_ARMv5');
  const createBat = path.join(exampleDir, '_CreateProject.bat');
  const hasUvprojx = () => fs.existsSync(mdk5Dir) &&
    fs.readdirSync(mdk5Dir).some(f => f.endsWith('.uvprojx'));

  if (!fs.existsSync(createBat)) {
    return { ok: false, error: `_CreateProject.bat not found: ${createBat}` };
  }

  // 清除舊 project 目錄 + bat/exe 暫存檔。
  // _CreateProjectScript.bat 也一併刪除，讓 _CreateProject.bat 從 template
  // 重新複製最新版，避免舊版或中途失敗的殘留。
  const PROJ_DIRS = ['MDK_ARMv5', 'MDK_ARMv537', 'MDK_ARM', 'HT32-IDE', 'GNU_ARM',
                     'SourceryG++Lite', 'EWARM', 'EWARMv8', 'emStudiov4'];
  for (const d of PROJ_DIRS) {
    try { fs.rmSync(path.join(exampleDir, d), { recursive: true, force: true }); } catch {}
  }
  // _CreateProjectScript.bat 由 _CreateProject.bat 從 template 重建，先刪確保新版
  // gsar.exe 可能殘留鎖定；其餘 .bat 是 example 輸入檔，不刪
  for (const f of ['_CreateProjectScript.bat', 'gsar.exe', 'dummyn.txt', 'Exclude.txt']) {
    try { fs.unlinkSync(path.join(exampleDir, f)); } catch {}
  }

  const r = await spawnAsync('cmd.exe', ['/c', '_CreateProject.bat'], {
    cwd:   exampleDir,
    env:   cmdEnv(exampleDir),
    // stdin pipe + input：PAUSE 需要 Enter，EOF 會中止 batch
    // stdout/stderr ignore：_CreateProjectScript.bat 使用 "REM @ECHO OFF"（非 ECHO OFF）
    // 導致每條命令都被 echo，輸出量極大；pipe 模式下大量輸出透過 Windows named pipe
    // 傳回 Node.js 速度極慢（比寫到 NUL 慢數十秒）。成功時不需要輸出，ignore 最快。
    input: '\r\n\r\n\r\n',
    stdio: ['pipe', 'ignore', 'ignore'],
    timeout: 120_000,
  });

  if (!hasUvprojx()) {
    return { ok: false, exitCode: r.status, error: r.error?.message || `bat exited with code ${r.status ?? '?'}` };
  }

  // JS 補漏——_ProjectConfigScript.bat 對某些 MCU（如 22366）有特殊建立邏輯，
  // 但不對應地從 _ProjectConfig.ini 刪除。此步驟直接比對 ini，確保 HT32-IDE 目錄中
  // 只保留 _ProjectConfig.ini 列出的 MCU 專案。
  const projConfigIni = path.join(exampleDir, '_ProjectConfig.ini');
  if (fs.existsSync(projConfigIni)) {
    const supported = new Set(
      fs.readFileSync(projConfigIni, 'utf8').split(/\r?\n/)
        .map(l => l.replace(/^REM\b.*$/i, '').trim())
        .filter(l => /^\w+$/.test(l))
        .map(l => l.toLowerCase())
    );
    if (supported.size > 0) {
      const ht32Dir = path.join(exampleDir, 'HT32-IDE');
      if (fs.existsSync(ht32Dir)) {
        for (const d of fs.readdirSync(ht32Dir)) {
          if (!d.startsWith('Project_')) continue;
          const code = d.replace(/^Project_/, '').toLowerCase();
          if (!supported.has(code)) {
            try { fs.rmSync(path.join(ht32Dir, d), { recursive: true, force: true }); } catch {}
          }
        }
      }
    }
  }

  return { ok: true };
}

// ── 5. 掃描可用的 MCU variants ────────────────────────────────────────────────
function findVariants(exampleDir) {
  const mdk5Dir  = path.join(exampleDir, 'MDK_ARMv5');
  const ht32Dir  = path.join(exampleDir, 'HT32-IDE');
  const uvFiles  = {};   // code (lowercase) → uvprojx path
  const ideFiles = {};   // code (lowercase) → HT32-IDE project dir

  try {
    for (const f of fs.readdirSync(mdk5Dir)) {
      if (f.endsWith('.uvprojx') && f.startsWith('Project_')) {
        const code = f.replace(/^Project_/, '').replace(/\.uvprojx$/, '').toLowerCase();
        uvFiles[code] = path.join(mdk5Dir, f);
      }
    }
  } catch {}

  try {
    for (const d of fs.readdirSync(ht32Dir)) {
      const proj     = path.join(ht32Dir, d, '.project');
      const cproject = path.join(ht32Dir, d, '.cproject');
      if (fs.existsSync(proj) && fs.existsSync(cproject)) {
        const code = d.replace(/^Project_/, '').toLowerCase();
        ideFiles[code] = path.join(ht32Dir, d);
      }
    }
  } catch {}

  return { uvFiles, ideFiles };
}

// ── 6. 測試 uVision 轉換 + 編譯 ──────────────────────────────────────────────
async function testUvision(exampleDir, uvprojxPath, code) {
  const bgId      = `uv-${code}`;
  const ht32VsDir = path.join(exampleDir, 'HT32_VSCode');
  const outDir    = path.join(ht32VsDir, `Project_${bgId}`);
  const gnuArmDir = path.join(ht32VsDir, 'GNU_ARM');
  try {
    const uvResult = await uv2make({
      uvprojx:        uvprojxPath,
      outDir,
      workspaceRoot:  ht32VsDir,
      extPath:        EXT_PATH,
      dfpStoragePath: DFP_STORAGE_PATH,
      cc:             GCC,
      extraCFlags:    DEFAULT_PROJECT_SETTINGS.extraCFlags || undefined,
    });
    if (uvResult.prebuiltWarnings?.length) {
      console.log(`  !! Prebuilt binaries skipped (Keil .o/.lib, not usable by GNU):`);
      for (const w of uvResult.prebuiltWarnings) console.log(`     ${w}`);
      return { convert: 'OK', compile: 'SKIP', makeOut: undefined, heapIssues: [] };
    }

    // 模擬 extension 的 convertUvision → writeProjectSettings（更新 fpu/floatAbi/includePaths/cDefs）
    if (uvResult.includes) {
      writeProjectSettings(outDir, {
        ...readProjectSettings(outDir),
        ...(uvResult.fpu      && uvResult.fpu !== 'none' ? { fpu:      uvResult.fpu      } : {}),
        ...(uvResult.floatAbi                             ? { floatAbi: uvResult.floatAbi } : {}),
        includePaths: ['../GNU_ARM', ...(uvResult.includes ?? [])],
        ...(uvResult.defines?.length ? { cDefs: uvResult.defines } : {}),
        ...(uvResult.hasCsrcs === false ? { useNano: false, useNosys: false } : {}),
      });
    }

    // 模擬 extension 的 generateTasksAndLaunchAndMakefile → regenAllMakefileFlags
    const s   = readProjectSettings(outDir);
    const fpu = (s.fpu && s.fpu !== 'none') ? s.fpu : undefined;
    regenerateMakefileFlags(
      outDir,
      { mcu: s.mcu, fpu, floatAbi: s.floatAbi || 'soft', targetName: s.targetName },
      {
        optimizationLevel: s.optimizationLevel,
        useNano:           s.useNano,
        useNosys:          s.useNosys,
        printfFloat:       s.printfFloat,
        scanfFloat:        s.scanfFloat,
        useLto:            s.useLto,
        extraCFlags:       s.extraCFlags,
        cDefs:             s.cDefs ?? [],
        aDefs:             s.aDefs ?? [],
        cc:                GCC,
      }
    );

    // Check LD + startup .s
    const uvLdName = (() => {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(outDir, 'project.meta.json'), 'utf8'));
        const ld = m.linkerScripts?.[0] ?? m.ldFile ?? null;
        return ld ? path.basename(ld) : 'linker_script.ld';
      } catch { return 'linker_script.ld'; }
    })();
    const uvStartupFiles = (() => { try { return fs.readdirSync(gnuArmDir).filter(f => /^startup_/i.test(f) && f.endsWith('.s')); } catch { return []; } })();
    const heapIssues = [
      ...checkLinkerHeapStack(path.join(gnuArmDir, uvLdName), gnuArmDir),
      ...(uvStartupFiles.length ? [...checkStartupDir(gnuArmDir), ...checkThumbLsbInDir(gnuArmDir)] : ['startup .s not found in GNU_ARM/']),
    ];
    const make = await runMake(outDir);
    // needs 3 (動態): 只有 startup .s 有 .equ Heap_Size / Stack_Size（keil2gnu 轉換後）才做此檢查；
    // 49x GCC startup 用 _estack（無 .section ".stack"），readStartupEquFromDir 回傳 null 時不觸發警告。
    if (make.ok && !make.skipped) {
      const ram     = parseRamFromMakeOutput(make.stdout, make.stderr);
      const heapSz  = readStartupEquFromDir(gnuArmDir, 'Heap_Size');
      const stackSz = readStartupEquFromDir(gnuArmDir, 'Stack_Size');
      if (heapSz !== null && stackSz !== null && ram !== null && ram < heapSz + stackSz)
        heapIssues.push(`RAM=${ram}B < heap(${heapSz})+stack(${stackSz})=${heapSz+stackSz}B — heap/stack not counted in RAM`);
    }
    return {
      convert: 'OK',
      compile: make.skipped ? 'SKIP' : make.ok ? 'OK' : 'FAIL',
      makeOut: make.ok ? undefined : (make.stdout || '') + (make.stderr || ''),
      heapIssues,
    };
  } catch (e) {
    return { convert: 'FAIL', compile: 'SKIP', error: e.message, heapIssues: [] };
  }
}

// ── 7. 測試 HT32-IDE 轉換 + 編譯 ─────────────────────────────────────────────
async function testHt32Ide(exampleDir, projectDir, code) {
  try {
    // 直接呼叫 extension 的轉換函式（與 ht32.convertHt32Ide command 完全相同的路徑）
    const r = await convertHt32IdeProject(projectDir, { extPath: EXT_PATH, gccPath: GCC });
    const { bgDir } = r;
    const gnuArmDir = path.join(path.dirname(bgDir), 'GNU_ARM');

    // 模擬 extension 的 generateTasksAndLaunchAndMakefile → regenAllMakefileFlags
    // 直接從 project.settings.json（convertHt32IdeProject 剛寫入）讀取，確保和 extension 一致
    const s = readProjectSettings(bgDir);
    const fpu      = (s.fpu && s.fpu !== 'none') ? s.fpu : undefined;
    const floatAbi = s.floatAbi || 'soft';
    regenerateMakefileFlags(
      bgDir,
      { mcu: s.mcu, fpu, floatAbi, targetName: s.targetName },
      {
        optimizationLevel: s.optimizationLevel,
        useNano:           s.useNano,
        useNosys:          s.useNosys,
        printfFloat:       s.printfFloat,
        scanfFloat:        s.scanfFloat,
        useLto:            s.useLto,
        extraCFlags:       s.extraCFlags,
        cDefs:             s.cDefs ?? [],
        aDefs:             s.aDefs ?? [],
        cc:                GCC,
      }
    );

    // Check LD + startup .s
    const ideLdName = r.meta.linkerScripts?.[0] ? path.basename(r.meta.linkerScripts[0]) : 'linker.ld';
    const ldIssues  = checkLinkerHeapStack(path.join(gnuArmDir, ideLdName), gnuArmDir);
    const ideStartupFiles = (() => { try { return fs.readdirSync(gnuArmDir).filter(f => /^startup_/i.test(f) && f.endsWith('.s')); } catch { return []; } })();
    const startupIssues = ideStartupFiles.length
      ? [...checkStartupDir(gnuArmDir), ...checkThumbLsbInDir(gnuArmDir)]
      : ['startup .s not found in GNU_ARM/'];
    const heapIssues = [...ldIssues, ...startupIssues];

    // Clean build/ before make（防止不同 example 共用同一 bgDir 時 .o 殘留）
    const buildOutDir = path.join(bgDir, 'build');
    if (fs.existsSync(buildOutDir)) fs.rmSync(buildOutDir, { recursive: true, force: true });
    fs.mkdirSync(buildOutDir, { recursive: true });

    const make = await runMake(bgDir);
    if (make.ok && !make.skipped) {
      const ram = parseRamFromMakeOutput(make.stdout, make.stderr);
      const { heap, stack } = readHeapStackSizes(gnuArmDir, path.join(gnuArmDir, ideLdName));
      if (ram !== null && ram < heap + stack)
        heapIssues.push(`RAM=${ram}B < heap(${heap})+stack(${stack})=${heap+stack}B — heap/stack not counted in RAM`);
    }
    return {
      convert: 'OK',
      compile: make.skipped ? 'SKIP' : make.ok ? 'OK' : 'FAIL',
      makeOut: make.ok ? undefined : (make.stdout || '') + (make.stderr || ''),
      heapIssues,
    };
  } catch (e) {
    return { convert: 'FAIL', compile: 'SKIP', error: e.message, heapIssues: [] };
  }
}

/** 掃描一個 library 底下所有含 _CreateProject.bat 的 example 目錄 */
function scanExamples(libRoot) {
  const result = [];
  const exampleRoot = path.join(libRoot, 'example');
  if (!fs.existsSync(exampleRoot)) return result;
  for (const cat of fs.readdirSync(exampleRoot)) {
    const catPath = path.join(exampleRoot, cat);
    try { if (!fs.statSync(catPath).isDirectory()) continue; } catch { continue; }
    for (const ex of fs.readdirSync(catPath)) {
      const exPath = path.join(catPath, ex);
      if (fs.existsSync(path.join(exPath, '_CreateProject.bat'))) result.push(exPath);
    }
  }
  return result.sort();
}

// ── 8. Per-example processors (return buffered output + counters) ─────────────

async function processStdExample({ exDir, libName, libRoot }, idx, total) {
  const lines = [];
  const itemResults = [];
  let nOK = 0, nFail = 0, nSkip = 0;
  const relPath = path.relative(libRoot, exDir).replace(/\\/g, '/');

  lines.push(`\n[${String(idx+1).padStart(3)}/${total}] ${relPath}`);

  // 刪除舊的 build 結果，確保測試環境乾淨
  try { fs.rmSync(path.join(exDir, 'HT32_VSCode'), { recursive: true, force: true }); } catch {}

  if (DO_CREATE) {
    const create = await createProjects(exDir);
    if (!create.ok) {
      lines.push('  CREATE FAIL');
      if (create.error) lines.push('  error: ' + create.error);
      itemResults.push({ lib: libName, example: relPath, step: 'create', status: 'FAIL', detail: create.stderr });
      nFail++;
      return { lines, results: itemResults, nOK, nFail, nSkip };
    }
    lines.push('  CREATE OK');
  }

  const { uvFiles, ideFiles } = findVariants(exDir);

  // 根據 _ProjectConfig.ini 過濾 uvFiles（HT32-IDE 在 createProjects() 已物理刪除）
  // _CreateProject.bat 會為整個 FWLib 所有 MCU 建立 uvprojx，但 _ProjectConfig.ini
  // 才是該 example 實際支援的 MCU 清單。
  {
    const projConfigIni = path.join(exDir, '_ProjectConfig.ini');
    if (fs.existsSync(projConfigIni)) {
      const supported = new Set(
        fs.readFileSync(projConfigIni, 'utf8').split(/\r?\n/)
          .map(l => l.replace(/^REM\b.*$/i, '').trim())
          .filter(l => /^\w+$/.test(l))
          .map(l => l.toLowerCase())
      );
      if (supported.size > 0) {
        for (const code of Object.keys(uvFiles)) {
          if (!supported.has(code)) delete uvFiles[code];
        }
      }
    }
  }

  // 若 _CreateProject.bat 成功建立了 uvprojx 但沒有建立 HT32-IDE 專案，顯示警告
  if (Object.keys(uvFiles).length > 0 && Object.keys(ideFiles).length === 0) {
    const ht32Dir = path.join(exDir, 'HT32-IDE');
    const ideExists = fs.existsSync(ht32Dir);
    lines.push(`  WARN  HT32-IDE: ${ideExists ? '目錄存在但無有效專案' : '目錄未建立'} — _CreateProject.bat 可能未產出 HT32-IDE 專案`);
    nFail++;
    itemResults.push({ lib: libName, example: relPath, step: 'create-ide', status: 'FAIL',
      detail: ideExists ? 'HT32-IDE dir exists but no valid .project/.cproject found' : 'HT32-IDE dir not created' });
  }

  const allCodes = [...new Set([...Object.keys(uvFiles), ...Object.keys(ideFiles)])];
  if (!allCodes.length) {
    lines.push('  (no variants found)');
    return { lines, results: itemResults, nOK, nFail, nSkip };
  }

  const filtered = MCU_RE ? allCodes.filter(matchMcu) : allCodes;
  if (MCU_RE && !filtered.length) {
    lines.push(`  (no MCU matches --mcu ${MCU_ARG})`);
    return { lines, results: itemResults, nOK, nFail, nSkip };
  }
  const picked = MCU_RE ? filtered : pickRandom(allCodes, VARIANTS);
  lines.push(`  MCUs: ${picked.join(', ')}  (pool=${allCodes.length})`);

  for (const code of picked) {
    if (uvFiles[code]) {
      const r = await testUvision(exDir, uvFiles[code], code);
      const status = r.convert === 'FAIL' ? 'FAIL' : r.compile === 'FAIL' ? 'FAIL' : r.compile === 'SKIP' ? 'SKIP' : 'OK';
      lines.push(`  UV  ${code.padEnd(12)} conv=${r.convert}  compile=${r.compile}${r.error ? '  !! '+r.error.slice(0,60) : ''}`);
      if (r.makeOut && status === 'FAIL') lines.push('    ' + r.makeOut.trim().split('\n').slice(-5).join('\n    '));
      for (const issue of r.heapIssues ?? []) lines.push(`       HEAP-WARN: ${issue}`);
      if (status === 'OK') nOK++; else if (status === 'FAIL') nFail++; else nSkip++;
      itemResults.push({ lib: libName, example: relPath, mcu: code, method: 'uVision', ...r, status });
    }
    if (ideFiles[code]) {
      const r = await testHt32Ide(exDir, ideFiles[code], code);
      const status = r.convert === 'FAIL' ? 'FAIL' : r.compile === 'FAIL' ? 'FAIL' : r.compile === 'SKIP' ? 'SKIP' : 'OK';
      lines.push(`  IDE ${code.padEnd(12)} conv=${r.convert}  compile=${r.compile}${r.error ? '  !! '+r.error.slice(0,60) : ''}`);
      if (r.makeOut && status === 'FAIL') lines.push('    ' + r.makeOut.trim().split('\n').slice(-5).join('\n    '));
      for (const issue of r.heapIssues ?? []) lines.push(`       HEAP-WARN: ${issue}`);
      if (status === 'OK') nOK++; else if (status === 'FAIL') nFail++; else nSkip++;
      itemResults.push({ lib: libName, example: relPath, mcu: code, method: 'HT32-IDE', ...r, status });
    }
  }

  return { lines, results: itemResults, nOK, nFail, nSkip };
}

async function process49xExample({ exPath, relPath, libName }, idx, total) {
  const lines = [];
  const itemResults = [];
  let nOK = 0, nFail = 0, nSkip = 0;

  lines.push(`\n[${String(idx+1).padStart(3)}/${total}] ${relPath}`);

  // 刪除舊的 build 結果，確保測試環境乾淨
  try { fs.rmSync(path.join(exPath, 'HT32_VSCode'), { recursive: true, force: true }); } catch {}

  const { uvFile, ideDir } = findVariants49x(exPath);
  const exName = path.basename(exPath);

  if (uvFile) {
    const r = await testUvision(exPath, uvFile, exName);
    const status = r.convert === 'FAIL' ? 'FAIL' : r.compile === 'FAIL' ? 'FAIL' : r.compile === 'SKIP' ? 'SKIP' : 'OK';
    lines.push(`  UV  ${exName.padEnd(20)} conv=${r.convert}  compile=${r.compile}${r.error ? '  !! '+r.error.slice(0,60) : ''}`);
    if (r.makeOut && status === 'FAIL') lines.push('    ' + r.makeOut.trim().split('\n').slice(-5).join('\n    '));
    for (const issue of r.heapIssues ?? []) lines.push(`       HEAP-WARN: ${issue}`);
    if (status === 'OK') nOK++; else if (status === 'FAIL') nFail++; else nSkip++;
    itemResults.push({ lib: libName, example: relPath, mcu: exName, method: 'uVision', ...r, status });
  }
  if (ideDir) {
    const r = await testHt32Ide(exPath, ideDir, exName);
    const status = r.convert === 'FAIL' ? 'FAIL' : r.compile === 'FAIL' ? 'FAIL' : r.compile === 'SKIP' ? 'SKIP' : 'OK';
    lines.push(`  IDE ${exName.padEnd(20)} conv=${r.convert}  compile=${r.compile}${r.error ? '  !! '+r.error.slice(0,60) : ''}`);
    if (r.makeOut && status === 'FAIL') lines.push('    ' + r.makeOut.trim().split('\n').slice(-5).join('\n    '));
    for (const issue of r.heapIssues ?? []) lines.push(`       HEAP-WARN: ${issue}`);
    if (status === 'OK') nOK++; else if (status === 'FAIL') nFail++; else nSkip++;
    itemResults.push({ lib: libName, example: relPath, mcu: exName, method: 'HT32-IDE', ...r, status });
  }

  return { lines, results: itemResults, nOK, nFail, nSkip };
}

// ── 9. Concurrent runner ──────────────────────────────────────────────────────
// Runs fn(item, idx, total) for all items with at most maxWorkers concurrent.
// Prints each item's buffered output atomically as soon as it finishes.
// JS single-threaded model makes the nextIdx++ increment race-free across awaits.
async function runConcurrent(items, fn, maxWorkers) {
  const results = new Array(items.length);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < items.length) {
      const i = nextIdx++;
      results[i] = await fn(items[i], i, items.length);
      process.stdout.write(results[i].lines.join('\n') + '\n');
    }
  }

  const n = Math.min(maxWorkers, items.length || 1);
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

// ── 10. Summary helper ────────────────────────────────────────────────────────
function printSummary(allResults, nOK, nFail, nSkip, reportPath) {
  const ts = new Date().toISOString().slice(0,16).replace(/[:T]/g,'-');
  const rp = reportPath || path.join(REPORT_DIR, `results-${ts}.json`);
  try {
    ensureDir(REPORT_DIR);
    fs.writeFileSync(rp, JSON.stringify(allResults, null, 2));
  } catch {}

  const fails = allResults.filter(r => r.status === 'FAIL');
  if (fails.length) {
    console.log('\n── FAILURES ──────────────────────────────────────────────────────────');
    for (const f of fails) {
      const methodStr = f.method ?? f.step ?? '?';
      const mcuStr    = f.mcu    ?? '-';
      console.log(`  FAIL  [${methodStr}] ${f.lib || ''}/${f.example}  MCU=${mcuStr}`);
      if (f.detail)  console.log(`        ${f.detail.slice(0, 120)}`);
      if (f.error)   console.log(`        convert err: ${f.error.slice(0, 120)}`);
      if (f.makeOut) console.log('        make: ' + f.makeOut.trim().split('\n').pop()?.slice(0, 120));
    }
  }

  const heapWarns = allResults.filter(r => r.heapIssues?.length);
  if (heapWarns.length) {
    console.log('\n── HEAP/STACK WARNINGS ───────────────────────────────────────────────');
    for (const r of heapWarns) {
      console.log(`  [${r.method}] ${r.lib || ''}/${r.example}  MCU=${r.mcu}`);
      for (const issue of r.heapIssues) console.log(`    ${issue}`);
    }
  }

  const nHeapWarn = heapWarns.length;
  console.log('\n' + '='.repeat(72));
  console.log(`Total: OK=${nOK}  FAIL=${nFail}  SKIP=${nSkip}  HEAP-WARN=${nHeapWarn}`);
  console.log(`Report: ${rp}`);
}

// ── 11. Main ──────────────────────────────────────────────────────────────────
async function main() {
  GCC = await locateArmGcc();
  if (!GCC) { console.error('[FATAL] arm-none-eabi-gcc not found. Install the GNU Arm toolchain or set ht32.gccPath.'); process.exit(1); }
  GCC_BIN = path.dirname(GCC);
  console.log(`[GCC] ${GCC}`);

  ensureDir(REPORT_DIR);

  const allResults = [];
  let nOK = 0, nFail = 0, nSkip = 0;
  const ts = new Date().toISOString().slice(0,16).replace(/[:T]/g,'-');
  const reportPath = path.join(REPORT_DIR, `results-${ts}.json`);
  _mainContext = { allResults, get nOK() { return nOK; }, get nFail() { return nFail; }, get nSkip() { return nSkip; }, reportPath };

  // ── STD series (example/ structure) ──────────────────────────────────────────
  const stdLibRoots = SCAN_ALL ? findAllLibs() : (LIB_ARG ? [LIB_ARG] : [DEFAULT_LIB]);

  for (const LIB_ROOT of stdLibRoots) {
    // Skip 49x libs that might be matched by LIB_ARG
    if (!fs.existsSync(path.join(LIB_ROOT, 'example'))) continue;

    let exampleDirs = scanExamples(LIB_ROOT);
    if (!exampleDirs.length) {
      console.log(`\n[SKIP] No examples found in ${LIB_ROOT}`);
      continue;
    }
    if (FILTER) exampleDirs = exampleDirs.filter(d => path.basename(d).toLowerCase() === FILTER.toLowerCase());
    if (LIMIT > 0) exampleDirs = exampleDirs.slice(0, LIMIT);

    const libName = path.basename(LIB_ROOT);
    console.log(`\n${'#'.repeat(72)}`);
    console.log(`# STD Library : ${libName}`);
    console.log(`# Examples: ${exampleDirs.length}${LIMIT ? ` (limited)` : ''}${FILTER ? ` (filter=${FILTER})` : ''}  Variants: ${MCU_ARG ? `all (--mcu ${MCU_ARG})` : VARIANTS}  Compile: ${DO_COMPILE ? 'YES' : 'NO'}  Workers: ${WORKERS}`);
    console.log('#'.repeat(72));

    const items = exampleDirs.map(exDir => ({ exDir, libName, libRoot: LIB_ROOT }));
    const exResults = await runConcurrent(items, processStdExample, WORKERS);

    for (const r of exResults) {
      nOK += r.nOK; nFail += r.nFail; nSkip += r.nSkip;
      allResults.push(...r.results);
    }
  }

  // ── 49x series (project/{board}/examples/ structure) ─────────────────────────
  // 49x 沒有 _CreateProject.bat，每個 example 只有一個 MCU，直接測轉換 + 編譯。
  const libs49x = SCAN_ALL ? findAll49xLibs()
    : LIB_ARG ? (fs.existsSync(path.join(LIB_ARG, 'project')) ? [LIB_ARG] : [])
              : findAll49xLibs();

  for (const LIB_ROOT of libs49x) {
    let examples = scan49xExamples(LIB_ROOT);
    if (!examples.length) {
      console.log(`\n[SKIP] No 49x examples found in ${LIB_ROOT}`);
      continue;
    }
    if (FILTER) examples = examples.filter(e => path.basename(e.relPath).toLowerCase() === FILTER.toLowerCase());
    if (LIMIT > 0) examples = examples.slice(0, LIMIT);

    const libName = path.basename(LIB_ROOT);
    console.log(`\n${'#'.repeat(72)}`);
    console.log(`# 49x Library : ${libName}`);
    console.log(`# Examples: ${examples.length}${LIMIT ? ` (limited)` : ''}${FILTER ? ` (filter=${FILTER})` : ''}  Compile: ${DO_COMPILE ? 'YES' : 'NO'}  Workers: ${WORKERS}`);
    console.log('#'.repeat(72));

    const items = examples.map(e => ({ ...e, libName }));
    const exResults = await runConcurrent(items, process49xExample, WORKERS);

    for (const r of exResults) {
      nOK += r.nOK; nFail += r.nFail; nSkip += r.nSkip;
      allResults.push(...r.results);
    }
  }

  // ── 結果報告 ──────────────────────────────────────────────────────────────────
  printSummary(allResults, nOK, nFail, nSkip, reportPath);
}

// Ctrl+C / SIGINT：印出已累積的統計再結束
let _mainContext = null;

process.on('SIGINT', () => {
  console.log('\n\n[INTERRUPTED]');
  if (_mainContext) {
    const { allResults, nOK, nFail, nSkip, reportPath } = _mainContext;
    printSummary(allResults, nOK, nFail, nSkip, reportPath);
  }
  process.exit(130);
});

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
