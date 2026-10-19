#!/usr/bin/env node
// batch-convert-htide.js
// 批次將指定目錄下所有 HT32-IDE example 轉換為 HT32_VSCode 專案。
// 輸出結構與 extension 的 "Convert HT32-IDE Project" 完全一致。
//
// Usage:
//   node test_scripts/batch-convert-htide.js <examples-dir> [gcc-path]
//
// Example:
//   node test_scripts/batch-convert-htide.js E:\HT32F493x5_FWLib_V1.2.1_172\project\ht32f49395_sk\examples
//   node test_scripts/batch-convert-htide.js E:\FWLib\examples "C:\gcc\bin\arm-none-eabi-gcc.exe"

'use strict';

// ── vscode mock（必須在 require 任何 extension 程式碼之前）──────────────────
const Module = require('module');
const _origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'vscode') return {
    window: {
      createOutputChannel: () => ({ appendLine: () => {}, show: () => {} }),
      showWarningMessage:     () => Promise.resolve(undefined),
      showInformationMessage: () => Promise.resolve(undefined),
    },
    workspace: { getConfiguration: () => ({ get: (_, d) => d }) },
  };
  return _origReq.apply(this, arguments);
};

const path = require('path');
const fs   = require('fs');

const EXT_ROOT = path.resolve(__dirname, '..');

const { convertHt32IdeProject } =
  require(path.join(EXT_ROOT, 'out/tools/ht32ide2make.js'));

// ── helpers ──────────────────────────────────────────────────────────────────

/** 在 dir 的直接子目錄中找含 .project + .cproject 的 HT32-IDE project dir */
function findIdeDir(dir) {
  try {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      try {
        if (fs.statSync(full).isDirectory() &&
            fs.existsSync(path.join(full, '.project')) &&
            fs.existsSync(path.join(full, '.cproject'))) {
          return full;
        }
      } catch {}
    }
  } catch {}
  return undefined;
}

/** 遞迴掃 rootDir，找出所有含 HT32-IDE project (.project+.cproject) 的 example 目錄 */
function scanExamples(rootDir) {
  let entries;
  try { entries = fs.readdirSync(rootDir); } catch (e) {
    console.error(`Cannot read directory: ${rootDir}\n${e.message}`);
    process.exit(1);
  }
  const result = [];
  for (const entry of entries) {
    const full = path.join(rootDir, entry);
    try { if (!fs.statSync(full).isDirectory()) continue; } catch { continue; }
    const ideDir = findIdeDir(full);
    if (ideDir) {
      // 這個目錄本身就是 example（HT32-IDE 在它的直接子目錄）
      result.push({ name: path.relative(rootDir, full).replace(/\\/g, '/'), ideDir });
    } else {
      // 往下一層找（例如 examples/ADC/ADC_OneShot/HT32-IDE）
      for (const sub of scanExamples(full)) {
        result.push(sub);
      }
    }
  }
  return result;
}

// ── main ─────────────────────────────────────────────────────────────────────

const targetDir = process.argv[2];
const gccPath   = process.argv[3] || 'arm-none-eabi-gcc';

if (!targetDir) {
  console.log('Usage: node test_scripts/batch-convert-htide.js <examples-dir> [gcc-path]');
  console.log('Example:');
  console.log('  node test_scripts/batch-convert-htide.js E:\\FWLib\\project\\ht32f49395_sk\\examples');
  process.exit(1);
}

const absTarget = path.resolve(targetDir);
const examples  = scanExamples(absTarget);

if (!examples.length) {
  console.error(`No HT32-IDE examples found under: ${absTarget}`);
  process.exit(1);
}

console.log(`Found ${examples.length} examples under ${absTarget}\n`);

let nOK = 0, nFail = 0;
for (let i = 0; i < examples.length; i++) {
  const { name, ideDir } = examples[i];
  const prefix = `[${String(i + 1).padStart(3)}/${examples.length}] ${name}`;
  try {
    const r = convertHt32IdeProject(ideDir, { extPath: EXT_ROOT, gccPath });
    if (r.warnings.length) {
      console.log(`  WARN ${prefix}`);
      for (const w of r.warnings) console.log(`       ! ${w.message}`);
    } else {
      console.log(`  OK   ${prefix}`);
    }
    nOK++;
  } catch (e) {
    console.log(`  FAIL ${prefix}`);
    console.log(`       ${String(e.message).slice(0, 120)}`);
    nFail++;
  }
}

console.log(`\nDone. OK=${nOK} FAIL=${nFail}`);
