'use strict';
// Shared validation helpers for test-compile.js and test-create-project.js.
// These check the correctness of generated output files (startup .s, linker scripts).
// They do NOT duplicate extension source — the extension generates these files;
// the tests independently verify the output content.

const fs   = require('fs');
const path = require('path');

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
  if (labelIdx < 0) return issues;
  const preceding = text.slice(Math.max(0, labelIdx - 300), labelIdx);
  const hasType      = /\.type\s+Reset_Handler\s*,\s*%function/.test(preceding);
  const hasThumbFunc = /\.thumb_func/.test(preceding.split('\n').slice(-5).join('\n'));
  if (!hasType && !hasThumbFunc)
    issues.push(`${path.basename(startupPath)}: Reset_Handler 缺 .type %function → Thumb LSB 未設 → HardFault`);
  return issues;
}

/** Check all startup_*.s files in a directory for Thumb LSB. */
function checkThumbLsbInDir(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^startup_/i.test(f) && f.toLowerCase().endsWith('.s')); }
  catch {}
  return files.flatMap(f => checkThumbLsbFile(path.join(dir, f)));
}

/**
 * Check startup_*.s files in dir have "aw",%nobits on .heap/.stack sections.
 * Heap_Size=0 is allowed (original Keil intent).
 * Returns array of issue strings (empty = OK).
 */
function checkStartupSections(startupPath, content = null) {
  const issues = [];
  let text;
  if (content !== null) {
    text = content;
  } else {
    try { text = fs.readFileSync(startupPath, 'utf8'); }
    catch { issues.push(`startup not found: ${startupPath}`); return issues; }
  }
  if (!/\.section\s+["']?\.(heap|stack)["']?/i.test(text)) return issues; // 49x startup has no .heap/.stack
  if (!/\.section\s+"\.heap"\s*,\s*"aw"\s*,\s*%nobits/.test(text))
    issues.push(`${path.basename(startupPath)}: .heap section 缺少 "aw",%nobits`);
  if (!/\.section\s+"\.stack"\s*,\s*"aw"\s*,\s*%nobits/.test(text))
    issues.push(`${path.basename(startupPath)}: .stack section 缺少 "aw",%nobits`);
  return issues;
}

/** Check all startup_*.s in dir for "aw",%nobits sections. */
function checkStartupSectionsInDir(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^startup_/i.test(f) && f.toLowerCase().endsWith('.s')); }
  catch {}
  return files.flatMap(f => checkStartupSections(path.join(dir, f)));
}

/**
 * Check linker script has heap/stack counted in RAM (STD series: KEEP(*(.heap/.stack)) pattern).
 * Returns array of issue strings (empty = OK).
 */
function checkLinkerStd(ldPath, startupDir) {
  const issues = [];
  let text;
  try { text = fs.readFileSync(ldPath, 'utf8'); }
  catch { issues.push(`linker script not found: ${ldPath}`); return issues; }

  if (!/KEEP\s*\(\s*\*\s*\(\s*\.heap\s*\)\s*\)/.test(text))  issues.push('linker script 缺少 KEEP(*(.heap))');
  if (!/KEEP\s*\(\s*\*\s*\(\s*\.stack\s*\)\s*\)/.test(text)) issues.push('linker script 缺少 KEEP(*(.stack))');

  const startupText = (() => {
    if (!startupDir) return '';
    try {
      const files = fs.readdirSync(startupDir).filter(f => /^startup_/i.test(f) && f.endsWith('.s'));
      return files.map(f => fs.readFileSync(path.join(startupDir, f), 'utf8')).join('\n');
    } catch { return ''; }
  })();
  if (!/__StackTop\s*[=:]/.test(text) && !/__StackTop\b/.test(startupText))
    issues.push('__StackTop 缺失');
  if (!/__HT_check_sp\s*[=:]/.test(text) && !/__HT_check_sp\b/.test(startupText))
    issues.push('__HT_check_sp 缺失');
  return issues;
}

/**
 * Check linker script for 49x series (._user_heap_stack pattern).
 * Returns array of issue strings (empty = OK).
 */
function checkLinker49x(ldPath) {
  const issues = [];
  let text;
  try { text = fs.readFileSync(ldPath, 'utf8'); }
  catch { issues.push(`linker script not found: ${ldPath}`); return issues; }

  if (!/\._user_heap_stack/.test(text))
    issues.push('linker script 缺少 ._user_heap_stack section（heap/stack 未計入 RAM）');
  if (!/__StackTop\s*=/.test(text))    issues.push('linker script 缺少 __StackTop');
  if (!/__HT_check_sp\s*=/.test(text)) issues.push('linker script 缺少 __HT_check_sp');
  return issues;
}

/**
 * Check _Min_Heap_Size / _Min_Stack_Size against MIN_HEAP_SIZE threshold.
 * minHeapSize = MIN_HEAP_SIZE from extension (pass 0 to skip).
 */
function checkLinker49xHeapSize(ldPath, minHeapSize) {
  const issues = [];
  let text;
  try { text = fs.readFileSync(ldPath, 'utf8'); }
  catch { issues.push(`linker script not found: ${ldPath}`); return issues; }
  const heapM = /_Min_Heap_Size\s*=\s*(0x[\da-fA-F]+|\d+)/i.exec(text);
  if (!heapM) { issues.push('linker script 缺少 _Min_Heap_Size'); return issues; }
  const sz = heapM[1].startsWith('0x') ? parseInt(heapM[1], 16) : parseInt(heapM[1]);
  if (minHeapSize > 0 && sz < minHeapSize)
    issues.push(`_Min_Heap_Size=${heapM[1]} < ${minHeapSize}（最小 heap 不足）`);
  return issues;
}

/** Read `sym = 0xVAL;` or `sym = VAL;` from LD file content. Returns null if not found. */
function readLdSym(ldContent, sym) {
  const m = new RegExp(`\\b${sym}\\s*=\\s*(0x[\\da-fA-F]+|\\d+)\\s*;`).exec(ldContent);
  if (!m) return null;
  return /^0x/i.test(m[1]) ? parseInt(m[1], 16) : parseInt(m[1]);
}

/** Read .equ SymName value from startup_*.s in dir. Returns null if not found. */
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
 * Read heap/stack sizes for RAM delta check.
 * STD: read Heap_Size/Stack_Size .equ from startup in dir.
 * 49x: read _Min_Heap_Size/_Min_Stack_Size from LD.
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

/** Parse --print-memory-usage RAM value (bytes) from make output. Returns null if not found. */
function parseRamFromMakeOutput(stdout, stderr) {
  const m = /^\s*RAM\s*:\s*(\d+)\s*B/m.exec((stdout || '') + (stderr || ''));
  return m ? parseInt(m[1]) : null;
}

module.exports = {
  checkThumbLsbFile,
  checkThumbLsbInDir,
  checkStartupSections,
  checkStartupSectionsInDir,
  checkLinkerStd,
  checkLinker49x,
  checkLinker49xHeapSize,
  readLdSym,
  readStartupEquFromDir,
  readHeapStackSizes,
  parseRamFromMakeOutput,
};
