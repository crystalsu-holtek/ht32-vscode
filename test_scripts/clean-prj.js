#!/usr/bin/env node
// test_scripts/clean-prj.js
// 對 e:\ht32* 下所有 STD FWLib example 執行 _ClearProject.bat 還原乾淨狀態，
// 以便重新跑 test-compile.js 時從零建立 project。
//
// Usage:
//   node test_scripts/clean-prj.js                              # 預設 STD_1xxxx
//   node test_scripts/clean-prj.js --lib e:/HT32_STD_5xxxx_... # 指定 library
//   node test_scripts/clean-prj.js --all                        # 掃描 e:\ 所有 FWLib
//   node test_scripts/clean-prj.js --filter uart                # 只清含 "uart" 的 examples
//   node test_scripts/clean-prj.js --limit 5                    # 只清前 5 個

'use strict';

const path          = require('path');
const fs            = require('fs');
const { spawnSync } = require('child_process');

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

const args = process.argv.slice(2);

if (!args.length) {
  console.log([
    'Usage:',
    '  node test_scripts/clean-prj.js --lib <path|關鍵字>   # 指定 library 路徑或名稱關鍵字（例：4xxxx）',
    '  node test_scripts/clean-prj.js --all           # 清除所有 FWLib（來自 fwlib-paths.ini）',
    '',
    'Options:',
    '  --filter <name>  只清資料夾名稱完全吻合 <name> 的 examples（大小寫不分）',
    '  --limit <n>      只清前 n 個 examples',
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

/** 49x FWLib：有 project/ 但沒有 example/ */
function findAll49xLibs() {
  return _allIniLibs.filter(p =>
    fs.existsSync(path.join(p, 'project')) &&
    !fs.existsSync(path.join(p, 'example')));
}

/** 掃描 49x FWLib 的 project/{board}/examples/{cat}/{ex}/ 結構 */
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
          result.push({ exPath, relPath: `project/${board}/examples/${cat}/${ex}` });
        }
      }
    } catch {}
  }
  return result.sort((a, b) => a.exPath.localeCompare(b.exPath));
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
      try { if (!fs.statSync(exPath).isDirectory()) continue; } catch { continue; }
      result.push(exPath);
    }
  }
  return result.sort();
}

// Git Bash PATH 污染清除 + =X: per-drive 變數設定（同 test-compile.js）
function cmdEnv(cwd) {
  const env = { ...process.env };
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
  if (env[pathKey]) {
    env[pathKey] = env[pathKey]
      .split(path.delimiter)
      .filter(p => !/[/\\](git|mingw|msys|cygwin)[/\\]/i.test(p))
      .join(path.delimiter);
  }
  const abs   = path.resolve(cwd);
  const drive = abs.slice(0, 2).toUpperCase();
  env[`=${drive}`] = abs;
  env[pathKey] = abs + path.delimiter + (env[pathKey] || '');
  return env;
}

// ── 執行 _ClearProject.bat ────────────────────────────────────────────────────
// _ClearProject.bat 流程：
//   1. SET /p iscon=... → 等待輸入 "yes" 確認
//   2. 刪除所有 IDE 目錄（MDK_ARMv5, HT32-IDE 等）
//   3. 刪除 ht32??xxxx_conf.h、system_ht32??xxxx_??.c 等生成檔
//   4. 呼叫 template 的 _ClearProject.bat remove_self，把自己刪掉
//
// 注意：bat 執行後 _ClearProject.bat 會被刪除。下次執行此腳本時，
// 會自動從 project_template/Script/ 補一份再跑。
function clearExample(exampleDir) {
  const libRoot     = path.resolve(exampleDir, '..', '..', '..');
  const templateBat = path.join(libRoot, 'project_template', 'Script', '_ClearProject.bat');
  const batPath     = path.join(exampleDir, '_ClearProject.bat');

  // 若 _ClearProject.bat 已被前次清除刪掉，從 template 補一份
  if (!fs.existsSync(batPath)) {
    if (!fs.existsSync(templateBat)) {
      return { ok: false, error: `template _ClearProject.bat not found: ${templateBat}` };
    }
    fs.copyFileSync(templateBat, batPath);
  }

  // input: 'yes\r\n' → 繞過 "Are you sure?(yes)" 互動確認
  // stdio: ['pipe','ignore','ignore'] → stdout/stderr 丟棄，避免大量輸出塞 pipe
  const r = spawnSync('cmd.exe', ['/c', '_ClearProject.bat'], {
    cwd:     exampleDir,
    env:     cmdEnv(exampleDir),
    input:   'yes\r\n',
    stdio:   ['pipe', 'ignore', 'ignore'],
    timeout: 60_000,
  });

  // 刪除 extension 產出的目錄（_ClearProject.bat 不處理這兩個）
  for (const d of ['HT32_VSCode', '.vscode', '.clangd']) {
    try { fs.rmSync(path.join(exampleDir, d), { recursive: true, force: true }); } catch {}
  }

  return { ok: r.status === 0 || r.status === null, exitCode: r.status, error: r.error?.message };
}

/** 49x 清理：直接刪 HT32_VSCode/ .vscode/ .clangd/（沒有 _ClearProject.bat） */
function clear49xExample(exampleDir) {
  let ok = true;
  let error;
  for (const d of ['HT32_VSCode', '.vscode', '.clangd']) {
    try { fs.rmSync(path.join(exampleDir, d), { recursive: true, force: true }); } catch (e) { ok = false; error = e.message; }
  }
  return { ok, error };
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  let nOK = 0, nFail = 0;

  // ── STD series (example/ structure) ─────────────────────────────────────────
  let stdLibRoots;
  if (SCAN_ALL) {
    stdLibRoots = findAllLibs();
  } else if (LIB_ARG) {
    stdLibRoots = fs.existsSync(path.join(LIB_ARG, 'example')) ? [LIB_ARG] : [];
  } else {
    stdLibRoots = fs.existsSync(path.join(DEFAULT_LIB, 'example')) ? [DEFAULT_LIB] : [];
  }

  for (const LIB_ROOT of stdLibRoots) {
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
      const r       = clearExample(exDir);
      const tag     = r.ok ? 'OK  ' : 'FAIL';
      console.log(`  [${String(i+1).padStart(3)}/${examples.length}] ${tag} ${relPath}${r.error ? '  !! '+r.error : ''}`);
      if (r.ok) nOK++; else nFail++;
    }
  }

  // ── 49x series (project/{board}/examples/ structure) ────────────────────────
  const libs49x = SCAN_ALL ? findAll49xLibs()
    : (LIB_ARG && !fs.existsSync(path.join(LIB_ARG, 'example')) ? [LIB_ARG] : []);

  for (const LIB_ROOT of libs49x) {
    let examples = scan49xExamples(LIB_ROOT);
    if (!examples.length) { console.log(`[SKIP] No 49x examples in ${LIB_ROOT}`); continue; }
    if (FILTER) examples = examples.filter(({ exPath }) => path.basename(exPath).toLowerCase() === FILTER.toLowerCase());
    if (LIMIT > 0) examples = examples.slice(0, LIMIT);

    const libName = path.basename(LIB_ROOT);
    console.log(`\n${'#'.repeat(60)}`);
    console.log(`# ${libName} [49x]  (${examples.length} examples)`);
    console.log('#'.repeat(60));

    for (let i = 0; i < examples.length; i++) {
      const { exPath, relPath } = examples[i];
      const r   = clear49xExample(exPath);
      const tag = r.ok ? 'OK  ' : 'FAIL';
      console.log(`  [${String(i+1).padStart(3)}/${examples.length}] ${tag} ${relPath}${r.error ? '  !! '+r.error : ''}`);
      if (r.ok) nOK++; else nFail++;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Total: OK=${nOK}  FAIL=${nFail}`);
}

main();
