#!/usr/bin/env node
// test_scripts/create-prj.js
// 對 STD FWLib 每個 example 依序執行 _CreateProject.bat，建立所有 IDE project 檔案。
// Sequential 執行，避免多個 bat 並行競爭 FWLib root 的 gsar.e_x_e（race condition）。
// 完成後可用 test-compile.js（預設不帶 --create）直接測試轉換 + 編譯。
//
// Usage:
//   node test_scripts/create-prj.js --lib <path|關鍵字>
//   node test_scripts/create-prj.js --all
//   node test_scripts/create-prj.js --filter <name>   # 完全吻合 example 資料夾名稱
//   node test_scripts/create-prj.js --limit <n>

'use strict';

const path      = require('path');
const fs        = require('fs');
const { spawn } = require('child_process');

// ── Config ────────────────────────────────────────────────────────────────────
const INI_FILE = path.join(__dirname, 'fwlib-paths.ini');

function readLibsFromIni() {
  try {
    return fs.readFileSync(INI_FILE, 'utf8')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

const _allIniLibs = readLibsFromIni();
const DEFAULT_LIB = _allIniLibs.find(p => fs.existsSync(path.join(p, 'example')))
  || 'e:/HT32_STD_1xxxx_FWLib_V1.7.1_3596';

// ── CLI ───────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (!args.length) {
  console.log([
    'Usage:',
    '  node test_scripts/create-prj.js --lib <path|關鍵字>',
    '  node test_scripts/create-prj.js --all',
    '',
    'Options:',
    '  --filter <name>  只建資料夾名稱完全吻合 <name> 的 examples（大小寫不分）',
    '  --limit <n>      只建前 n 個',
    '',
    '執行完畢後，用 test-compile.js（無需 --create）進行轉換 + 編譯測試。',
  ].join('\n'));
  process.exit(0);
}

const SCAN_ALL = args.includes('--all');
const FILTER   = (() => { const i = args.indexOf('--filter'); return i >= 0 ? args[i+1] : null; })();
const LIMIT    = (() => { const i = args.indexOf('--limit');  return i >= 0 ? parseInt(args[i+1]) || 0 : 0; })();

function resolveLibArg(raw) {
  if (!raw) return null;
  if (fs.existsSync(raw)) return path.resolve(raw);
  const keyword = raw.toLowerCase();
  const matches = _allIniLibs.filter(p => p.toLowerCase().includes(keyword));
  if (!matches.length) { console.error(`[ERROR] --lib "${raw}": no match in ${INI_FILE}`); process.exit(1); }
  if (matches.length > 1) {
    console.error(`[ERROR] --lib "${raw}": ambiguous, matches:\n` + matches.map(m => '  ' + m).join('\n'));
    process.exit(1);
  }
  return matches[0];
}

const LIB_ARG = resolveLibArg((() => { const i = args.indexOf('--lib'); return i >= 0 ? args[i+1] : null; })());
if (SCAN_ALL && LIB_ARG) { console.error('[ERROR] --all 與 --lib 互斥，擇一使用'); process.exit(1); }

// ── Helpers ───────────────────────────────────────────────────────────────────
function findAllLibs() {
  return _allIniLibs.filter(p => fs.existsSync(path.join(p, 'example')));
}

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

function cmdEnv(cwd) {
  const env = { ...process.env };
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
  if (env[pathKey]) {
    env[pathKey] = env[pathKey]
      .split(path.delimiter)
      .filter(p => !/[/\\](git|mingw|msys|cygwin)[/\\]/i.test(p))
      .join(path.delimiter);
  }
  const abs = path.resolve(cwd);
  const drive = abs.slice(0, 2).toUpperCase();
  env[`=${drive}`] = abs;
  env[pathKey] = abs + path.delimiter + (env[pathKey] || '');
  return env;
}

function spawnAsync(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve) => {
    const { input, timeout = 180_000, env, cwd } = opts;
    const proc = spawn(cmd, cmdArgs, { cwd, env, stdio: ['pipe', 'ignore', 'ignore'] });
    if (input !== undefined && proc.stdin) {
      try { proc.stdin.write(input); proc.stdin.end(); } catch {}
    }
    let timedOut = false;
    const timer = timeout > 0 ? setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch {}
    }, timeout) : null;
    proc.on('close', code => {
      if (timer) clearTimeout(timer);
      resolve({ status: timedOut ? null : code, error: timedOut ? 'ETIMEDOUT' : null });
    });
    proc.on('error', err => {
      if (timer) clearTimeout(timer);
      resolve({ status: -1, error: err.message });
    });
  });
}

// ── createProject ─────────────────────────────────────────────────────────────
const PROJ_DIRS = ['MDK_ARMv5', 'MDK_ARMv537', 'MDK_ARM', 'HT32-IDE', 'GNU_ARM',
                   'SourceryG++Lite', 'EWARM', 'EWARMv8', 'emStudiov4'];

async function createProject(exampleDir) {
  const createBat  = path.join(exampleDir, '_CreateProject.bat');
  const mdk5Dir    = path.join(exampleDir, 'MDK_ARMv5');
  const hasUvprojx = () => fs.existsSync(mdk5Dir) &&
    fs.readdirSync(mdk5Dir).some(f => f.endsWith('.uvprojx'));

  if (!fs.existsSync(createBat)) {
    return { ok: false, error: '_CreateProject.bat not found' };
  }

  // 清除舊 project 目錄和暫存檔，確保 _CreateProject.bat 從乾淨狀態開始
  for (const d of PROJ_DIRS) {
    try { fs.rmSync(path.join(exampleDir, d), { recursive: true, force: true }); } catch {}
  }
  for (const f of ['_CreateProjectScript.bat', 'gsar.exe', 'dummyn.txt', 'Exclude.txt']) {
    try { fs.unlinkSync(path.join(exampleDir, f)); } catch {}
  }

  const r = await spawnAsync('cmd.exe', ['/c', '_CreateProject.bat'], {
    cwd:     exampleDir,
    env:     cmdEnv(exampleDir),
    input:   '\r\n\r\n\r\n',
    timeout: 180_000,
  });

  if (!hasUvprojx()) {
    return { ok: false, error: r.error || `bat exited ${r.status ?? '?'}` };
  }

  // _ProjectConfig.ini filter：HT32-IDE 只保留 ini 列出的 MCU（bat 有時清不乾淨）
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

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const libRoots = SCAN_ALL ? findAllLibs() : (LIB_ARG ? [LIB_ARG] : [DEFAULT_LIB]);
  let nOK = 0, nFail = 0;

  for (const LIB_ROOT of libRoots) {
    if (!fs.existsSync(path.join(LIB_ROOT, 'example'))) {
      console.log(`[SKIP] No example/ in ${LIB_ROOT}`);
      continue;
    }
    let examples = scanExamples(LIB_ROOT);
    if (!examples.length) { console.log(`[SKIP] No examples in ${LIB_ROOT}`); continue; }
    if (FILTER) examples = examples.filter(d => path.basename(d).toLowerCase() === FILTER.toLowerCase());
    if (LIMIT > 0) examples = examples.slice(0, LIMIT);

    const libName = path.basename(LIB_ROOT);
    console.log(`\n${'#'.repeat(60)}`);
    console.log(`# ${libName}  (${examples.length} examples)`);
    console.log('#'.repeat(60));

    for (let i = 0; i < examples.length; i++) {
      const exDir   = examples[i];
      const relPath = path.relative(LIB_ROOT, exDir).replace(/\\/g, '/');
      // 立刻顯示目前在處理哪個 example（不等結果）
      process.stdout.write(`  [${String(i+1).padStart(3)}/${examples.length}] ${relPath} ...`);
      const t0 = Date.now();
      const r  = await createProject(exDir);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      if (r.ok) {
        process.stdout.write(`  OK  (${dt}s)\n`);
        nOK++;
      } else {
        process.stdout.write(`  FAIL  (${dt}s)${r.error ? '  !! ' + r.error : ''}\n`);
        nFail++;
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Total: OK=${nOK}  FAIL=${nFail}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
