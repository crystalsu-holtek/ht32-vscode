// src/tools/uv2make.ts
import * as vscode from 'vscode';
import * as fs from "fs";
import * as path from "path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { scatter2ld } from "./scatter2ld";
import { semverCmp, writeProjectLists, resolveInclude, parseIncludesList } from './utils';
import { readProjectSettings, writeProjectSettings, ProjectSettings } from "./settingsWebview";

/* ──────────────────────────────────────
 * 共用 OutputChannel / Log
 * ────────────────────────────────────── */
export const CHANNEL = vscode.window.createOutputChannel('HT32 uv2make');

/** Minimum heap for Create Project. 64 instead of original 256 — 256 was too large for
 *  small-RAM MCUs (e.g. 2KB RAM), causing significant RAM pressure on new projects. */
export const MIN_HEAP_SIZE = 0;
export function enforceMinHeap(heapSize: string | undefined): string | undefined {
  if (heapSize === undefined) return undefined;
  return parseInt(heapSize) < MIN_HEAP_SIZE
    ? `${MIN_HEAP_SIZE}`
    : heapSize;
}

export function logInfo(msg: string) {
  CHANNEL.appendLine(`[INFO] ${msg}`);
}
export function logWarn(msg: string) {
  CHANNEL.appendLine(`[WARN] ${msg}`);
}
export function logError(msg: string) {
  CHANNEL.appendLine(`[ERROR] ${msg}`);
}
function logFile(absPath: string) {
  const parts = absPath.replace(/\\/g, '/').split('/');
  logInfo(`Write → ${parts.slice(-2).join('/')}`);
}

export type Uv2MakeOptions = {
  uvprojx: string;        // 絕對路徑
  outDir: string;         // 輸出資料夾（相對或絕對）
  /** 若未指定，會自動從 .uvprojx 的 <Cpu> 解析 */
  mcu?: string;           // 例：cortex-m0plus / cortex-m4
  /** 若未指定，會從 uvproj 嘗試推得；對 M0/M0+ 預設不啟用 FPU */
  fpu?: string;           // 例：fpv4-sp-d16
  /** 若未指定，會根據 core 推得（M0/M0+ 一律 soft） */
  floatAbi?: "soft" | "softfp" | "hard";
  cc?: string;            // 例：arm-none-eabi-gcc
  /** GCC optimization level，例：O0 / O2 / Os / Og。預設 O2 */
  optimizationLevel?: string;
  /** --specs=nano.specs：使用 newlib-nano */
  useNano?: boolean;
  /** --specs=nosys.specs：不使用 syscalls */
  useNosys?: boolean;
  /** 附加到 CFLAGS 末尾的額外 flags */
  extraCFlags?: string;
  /** 附加到 LDFLAGS 末尾的額外 flags */
  extraLDFlags?: string;
  /** 連結時額外加入的 .a / .o 檔案路徑（追加在 LDFLAGS 之後） */
  extraLibs?: string[];
  /** -lName：library names (paired with extraLibPaths) */
  extraLibNames?: string[];
  /** -L"dir"：library search paths (paired with extraLibNames) */
  extraLibPaths?: string[];
  /** GCC debug info level：'g0'|'g1'|'g'|'g3'。預設 'g3' */
  debugInfo?:    string;
  /** -flto：加到 CFLAGS 與 LDFLAGS */
  useLto?:       boolean;
  /** -u _printf_float：newlib-nano float printf */
  printfFloat?:  boolean;
  /** -u _scanf_float：newlib-nano float scanf */
  scanfFloat?:   boolean;
  /** -ffunction-sections -fdata-sections -Wl,--gc-sections：dead code elimination */
  gcSections?:   boolean;
  /** VS Code extension root，用於查詢 bundled PDSC (dfp/) */
  extPath?: string;
  /** Additional PDSC paths (user-provided, searched before bundled DFP) */
  extraPdscPaths?: string[];
  /** Workspace root (parent of .vscode). If provided, elfPath is relative to this directory.
   *  Defaults to path.dirname(outDir) for backward compatibility. */
  workspaceRoot?: string;
  /** 全部 -I include paths（Settings Webview 管理，包含所有 converter 產出路徑 + 使用者新增路徑） */
  includePaths?: string[];
};

export type FileRomOption = { origin: string; length: string };
export type FileOption    = { exclude?: true; xo?: true; rom?: FileRomOption };

/** Return true if the file is a Holtek misc.c whose StackUsageAnalysisInit GCC path
 *  is broken (date <= 2025-12-02) and needs to be patched to weak. */
export function miscCNeedsRedefine(absPath: string): boolean {
  if (!/ht32_cm[0-9a-z+]*_misc\.c$/i.test(absPath)) { return false; }
  try {
    const head = fs.readFileSync(absPath, { encoding: 'utf8', flag: 'r' }).slice(0, 1024);
    const m = head.match(/@date\s+\$Date::\s*(\d{4}-\d{2}-\d{2})/);
    return !!m && m[1] <= '2025-12-02';
  } catch { return false; }
}

/** Patch old misc.c: add weak to StackUsageAnalysisInit in the GCC branch (idempotent). */
export function patchMiscCWeak(absPath: string): void {
  try {
    const content = fs.readFileSync(absPath, 'utf8');
    if (/\battribute__\s*\(\s*\(\s*weak/.test(content)) { return; }
    const patched = content.replace(
      /(__attribute__\s*\(\s*\(\s*)(noinline\s*\)\s*\)\s*void\s+StackUsageAnalysisInit)/,
      '$1weak, $2'
    );
    if (patched !== content) { fs.writeFileSync(absPath, patched, 'utf8'); }
  } catch { /* read-only or missing — skip silently */ }
}

/** Ensure ht32_stack_analysis.c has NO weak on StackUsageAnalysisInit (idempotent). */
export function ensureStackAnalysisStrong(absPath: string): void {
  try {
    const content = fs.readFileSync(absPath, 'utf8');
    const patched = content.replace(
      /(__attribute__\s*\(\s*\(\s*)weak,\s*(noinline\s*\)\s*\)\s*void\s+StackUsageAnalysisInit)/,
      '$1$2'
    );
    if (patched !== content) { fs.writeFileSync(absPath, patched, 'utf8'); }
  } catch { }
}

/** Ensure ht32_stack_analysis.c has weak on StackUsageAnalysisInit (idempotent). */
export function ensureStackAnalysisWeak(absPath: string): void {
  try {
    const content = fs.readFileSync(absPath, 'utf8');
    if (/\battribute__\s*\(\s*\(\s*weak/.test(content)) { return; }
    const patched = content.replace(
      /(__attribute__\s*\(\s*\(\s*)(noinline\s*\)\s*\)\s*void\s+StackUsageAnalysisInit)/,
      '$1weak, $2'
    );
    if (patched !== content) { fs.writeFileSync(absPath, patched, 'utf8'); }
  } catch { }
}

type Extracted = {
  projectName: string;
  targetName: string;
  sources: string[];
  includes: string[];
  defines: string[];
  asmDefines?: string[];   // ASM-only defines (Aads.Define minus Cads.Define)
  scatter?: string;
  isLibrary?: boolean;     // CreateLib=1 → 產出 .a 而非 .elf
  isArmGnu?: boolean;      // ToolsetName=ARM-GNU → startup/linker 已是 GCC 格式，直接複製
  groups: Record<string, string[]>;
  fileOptions?: Record<string, FileOption>;  // sparse: only files with non-default settings

  // ★ 新增：從 uvproj 抓到的記憶體資訊（如果有的話）
  romOrigin?: string;   // 例如 "0x00000000"
  romLength?: string;   // 例如 "0x0007FE00"
  ramOrigin?: string;   // 例如 "0x20000010" (DataAddressRange 調整後，linker 用)
  ramLength?: string;   // 例如 "0x3FF0"     (DataAddressRange 調整後，linker 用)
  prebuiltWarnings?: string[];  // .o/.lib/.a 檔案（Keil 編出，GNU 無法使用）
  gnuArmTemplate?: string;      // resolveGnuArmDir() 的結果（FWLib gcc 或 GNU_ARM 目錄）
  fwlibRoot?: string;           // FWLib 根目錄絕對路徑
  symdefsOutputFile?: string;   // from --symdefs=xxx.o in <LDads><Misc>
};



function remapInfoToOutDir(info: Extracted, projDir: string, outDirAbs: string, warnings?: ConversionWarning[], uvprojxPath?: string): Extracted {
  // 將原本以 uvprojx 目錄為基準的相對路徑，轉成以 outDir 為基準
  const remapRel = (rel: string): string => {
    const abs = path.resolve(projDir, rel);          // 先變成絕對
    return normalize(path.relative(outDirAbs, abs)); // 再轉成以 build-gen 為基準
  };

  // Lazy-read raw uvprojx lines for line-number lookup (only when a bad path is found)
  let rawLines: string[] | undefined;
  const findToken = (segment: string): { line: number; col: number } | undefined => {
    if (!uvprojxPath) return undefined;
    if (!rawLines) {
      try { rawLines = fs.readFileSync(uvprojxPath, 'utf8').split('\n'); } catch { rawLines = []; }
    }
    // Keil XML uses backslashes; try both forms so ../spim matches ..\spim
    const segBs = segment.replace(/\//g, '\\');
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      let col = line.indexOf(segBs);
      if (col < 0) col = line.indexOf(segment);
      if (col >= 0) return { line: i, col };
    }
    return undefined;
  };

  const sources  = info.sources.map(remapRel);
  const includes = info.includes.map(rel => {
    const abs = path.resolve(projDir, rel);
    if (!fs.existsSync(abs)) {
      logWarn(`Include path does not exist (check project depth): ${abs}`);
      const pos = findToken(rel);
      warnings?.push({ message: `Include path does not exist: ${abs}`, line: pos?.line, col: pos?.col, len: rel.length });
    }
    return normalize(path.relative(outDirAbs, abs));
  });
  const groups: Record<string, string[]> = {};
  for (const [g, files] of Object.entries(info.groups)) {
    groups[g] = files.map(remapRel);
  }

  return {
    ...info,
    sources,
    includes,
    groups
  };
}

/** A warning generated during conversion, suitable for display in the Problems panel. */
export interface ConversionWarning {
  message: string;
  file?: string;   // absolute path of the file to attach the diagnostic to
  line?: number;   // 0-based line index within that file
  col?:  number;   // 0-based column of the highlighted token start
  len?:  number;   // length of the highlighted token
}

export interface Uv2MakeResult {
  elfPath?: string;      // 例如 build-gen/build/app.elf
  deviceName?: string;   // 例如 "HT32F52352"
  mcu?: string;          // 例如 "cortex-m0"
  fpu?: string;          // 例如 "fpv4-sp-d16"  (auto-detected from uvprojx)
  floatAbi?: string;     // 例如 "hard" | "soft" (auto-detected from uvprojx)
  ramOrigin?: string;    // 例如 "0x20000000"
  ramLength?: string;    // 例如 "0x8000"
  spimFlm?: string;      // SPIM FLM filename from uvoptx, e.g. "HT32F493x5_EXT_TYPE2_REAMP1_GENERAL.FLM"
  includes?: string[];   // include paths parsed from uvprojx (with rvds→GCC substitution applied)
  defines?:  string[];   // C defines without -D prefix
  prebuiltWarnings?: string[]; // .o/.lib/.a 檔案（Keil 編出，GNU 無法使用）
  conversionWarnings?: ConversionWarning[]; // other warnings to show in Problems panel
  fwlibRoot?: string;         // FWLib 根目錄絕對路徑（用於寫入 FWLib root .clangd）
  hasCsrcs?: boolean;        // false → 純組語專案，caller 應將 useNano/useNosys 寫 false 進 settings
}

/**
 * Parse the sibling .uvoptx file to find the SPIM flash algorithm FLM filename.
 * Keil stores all flash algorithms in the <Name> element of the debug option block,
 * encoded as "-FN{count} -FF0{algo0} ... -FP0(...) -FF1{algo1} ... -FP1(...)".
 * Index 0 = internal flash; index ≥ 1 = additional regions (typically SPIM).
 * Returns the FLM basename of the first non-internal algorithm, or undefined.
 */
export function parseUvoptxSpimFlm(uvprojxPath: string): string | undefined {
  const uvoptxPath = uvprojxPath.replace(/\.uvprojx$/i, '.uvoptx');
  try {
    if (!fs.existsSync(uvoptxPath)) return undefined;
    const text = fs.readFileSync(uvoptxPath, 'utf8');
    // Find a <Name> block that contains -FN2 or higher (more than one flash region)
    const nameM = /<Name>([^<]+-FN([2-9]|\d{2,})[^<]*)<\/Name>/i.exec(text);
    if (!nameM) return undefined;
    // Extract filename from -FP1($$Device:...$Flash\filename.FLM)
    const fpM = /-FP1\([^)]*[/\\]([^)/\\]+\.FLM)\)/i.exec(nameM[1]);
    return fpM ? fpM[1] : undefined;
  } catch { return undefined; }
}

/** 轉換時儲存的最小建置資訊，供日後重新產生 Makefile flags 使用 */
export interface BuildMeta {
  targetName: string;
  mcu: string;
  fpu?: string;
  floatAbi?: "soft" | "softfp" | "hard";
  ramOrigin?: string;   // 例如 "0x20000000"
  ramLength?: string;   // 例如 "0x4000"
  deviceName?: string;  // 例如 "HT32F5828"
}

export function relocateBatToWsRoot(batAbs: string, srcRoot: string, wsRoot: string): string {
  if (!batAbs.toLowerCase().endsWith('.bat')) return batAbs;
  // Only copy if bat is inside the source project directory (e.g. MDK_ARMv5/ or HT32-IDE/)
  const relFromSrc = path.relative(path.resolve(srcRoot), path.resolve(path.dirname(batAbs)));
  if (relFromSrc.startsWith('..')) return batAbs;
  const dest = path.join(path.resolve(wsRoot), path.basename(batAbs));
  if (fs.existsSync(batAbs) && dest.toLowerCase() !== path.resolve(batAbs).toLowerCase())
    try { fs.copyFileSync(batAbs, dest); } catch { /* ignore */ }
  return dest;
}

/**
 * Extract and translate the AfterMake post-build command from a uvprojx document.
 * Skips fromelf commands (GCC Makefile already produces .bin via objcopy).
 * Translates Keil variables: !L (full elf path), @L (elf without extension), $J (projDir absolute).
 * Resolves the bat/exe path from projDir-relative to wsRoot-relative.
 */
function extractUvAfterMakeCmd(
  doc:        any,
  projDir:    string,   // absolute path to uvprojx directory
  wsRoot:     string,   // HT32_VSCode/ — post-build working directory
  outDirAbs:  string,   // HT32_VSCode/Project_xxx/
  targetName: string,
  deviceName: string,   // resolved device name for substituting Keil $D variable
  warnings?:  ConversionWarning[],
): string {
  const t = doc?.Project?.Targets?.Target;
  const first = Array.isArray(t) ? t[0] : t;
  const commonOpt = Array.isArray(first?.TargetOption?.TargetCommonOption)
    ? first.TargetOption.TargetCommonOption[0]
    : first?.TargetOption?.TargetCommonOption;
  const afterMake = commonOpt?.AfterMake;
  if (!afterMake) return '';

  const results: string[] = [];
  for (let i = 1; i <= 2; i++) {
    const run  = String(afterMake[`RunUserProg${i}`] ?? '0').trim();
    const name = String(afterMake[`UserProg${i}Name`] ?? '').trim();
    if (run !== '1' || !name) continue;
    if (/\bfromelf\b/i.test(name)) continue;  // GCC Makefile already produces .bin via objcopy
    const translated = translateKeilPostBuildCmd(name, projDir, wsRoot, outDirAbs, targetName, deviceName, warnings);
    if (translated) results.push(translated);
  }
  return results.join(' && ');
}

/**
 * Translate a single Keil after-build command to VSCode (vsc) mode.
 * The .bat is called with: <bat> vsc <OUTPUT_NAME> <IC_NAME>
 * - Resolves the bat path (first token) from projDir-relative to wsRoot-relative
 * - IC_NAME is the 4th token of the original Keil command (passed as-is)
 * - OUTPUT_NAME is just targetName (basename), not the full elf path
 */
function translateKeilPostBuildCmd(
  cmd:        string,
  projDir:    string,
  wsRoot:     string,
  _outDirAbs: string,
  targetName: string,
  deviceName: string,
  warnings?:  ConversionWarning[],
): string {
  // Handle "cmd[.exe] /Q /C copy /Y "!L.bin" <dst>" — translate paths for VS Code.
  // !L.bin = Keil output .bin; in VS Code it is at Project_xxx/build/TARGET.bin.
  // Destination is relative to projDir (Keil's MDK_ARMv5/) → make it wsRoot-relative.
  const cmdCopyM = /^cmd(?:\.exe)?\s+(?:\/[Qq]\s+)?\/[Cc]\s+copy\s+(?:\/[Yy]\s+)?("(?:[^"\\]|\\.)*"|[^\s">]+)\s+("(?:[^"\\]|\\.)*"|[^\s">]+)/i.exec(cmd.trim());
  if (cmdCopyM) {
    const keilSrc = cmdCopyM[1].replace(/^"|"$/g, '');
    const keilDst = cmdCopyM[2].replace(/^"|"$/g, '');
    if (/^[!#]L\.bin$/i.test(keilSrc)) {
      const binAbs  = path.join(_outDirAbs, 'build', targetName + '.bin');
      const binRel  = path.relative(wsRoot, binAbs);
      const dstAbs  = path.resolve(projDir, keilDst.replace(/\//g, path.sep));
      const dstRel  = path.relative(wsRoot, dstAbs);
      const binTok  = binRel.includes(' ') ? `"${binRel}"` : binRel;
      const dstTok  = dstRel.includes(' ') ? `"${dstRel}"` : dstRel;
      if (!fs.existsSync(path.dirname(dstAbs))) {
        warnings?.push({ message: `Post-build copy: destination directory does not exist: ${path.dirname(dstAbs)} — please verify the path in Settings (postBuildCmd).` });
      }
      return `cmd /C copy /Y ${binTok} ${dstTok}`;
    }
    return '';  // unrecognized cmd /C pattern — skip
  }

  const m = /^("(?:[^"\\]|\\.)*"|[^\s"]+)([\s\S]*)$/.exec(cmd.trim());
  if (!m) return cmd;
  const rawPathToken = m[1];
  const rawPath = rawPathToken.startsWith('"') ? rawPathToken.slice(1, -1) : rawPathToken;
  // Skip bare system commands (no directory component) — e.g. "cmd.exe /C someOtherCmd ..."
  if (!rawPath.includes('/') && !rawPath.includes('\\')) return '';
  const absPath    = path.resolve(projDir, rawPath.replace(/\//g, path.sep));
  const batDestAbs = relocateBatToWsRoot(absPath, projDir, wsRoot);
  const relPath    = path.relative(wsRoot, batDestAbs);  // keep backslashes — cmd.exe needs them
  const pathToken = relPath.includes(' ') ? `"${relPath}"` : relPath;

  // Extract IC_NAME: 4th token of original command (after bat, mode, @L)
  const tokens = m[2].trim().split(/\s+/);
  // tokens: [mode, @L, IC_NAME, ...]  — $D is Keil device-name variable, substitute with actual name
  const rawIcName = tokens[2] ?? '';
  const icName = rawIcName.replace(/^\$D$/i, deviceName);

  return `${pathToken} vsc ${targetName} ${icName}`;
}

export async function uv2make(opts: Uv2MakeOptions): Promise<Uv2MakeResult> {

  const projDir = path.dirname(opts.uvprojx);  		// uvprojx 所在 MDK_ARMv5
  const outDirAbs = path.isAbsolute(opts.outDir) ? opts.outDir : path.join(projDir, opts.outDir);
  const projFolderName = path.basename(projDir);  // 例如 "MDK_ARMv5"
  ensureDir(outDirAbs);
  const convWarnings: ConversionWarning[] = [];

  // Validate XML before tolerant parsing so malformed files produce a visible warning.
  // Apply the same <HTGSARCONT> fix first (same as readUvprojx) to avoid false positives.
  try {
    const rawXml = fs.readFileSync(opts.uvprojx, 'utf8').replace(/<HTGSARCONT>/g, '<HTGSARCONT/>');
    const xmlResult = XMLValidator.validate(rawXml);
    if (xmlResult !== true) {
      convWarnings.push({
        message: `XML malformed (line ${xmlResult.err.line}): ${xmlResult.err.msg} — some source groups may be missing; fix the file and convert again`,
        file: opts.uvprojx,
      });
      logWarn(`XML validation failed: ${xmlResult.err.msg} at line ${xmlResult.err.line}`);
    }
  } catch { /* ignore read errors — readUvprojx will handle them */ }

  const doc = readUvprojx(opts.uvprojx);
  const fallbackName = path.basename(opts.uvprojx, '.uvprojx');
  // GNU_ARM/ is a sibling of Project/ inside HT32_VSCode/ — startup .s files go here
  const gnuArmRoot = path.join(path.dirname(outDirAbs), 'GNU_ARM');
  const infoRaw = extractProjectInfo(doc, projDir, fallbackName, outDirAbs, opts.extPath, gnuArmRoot);
  const info = remapInfoToOutDir(infoRaw, projDir, outDirAbs, convWarnings, opts.uvprojx);

  if (infoRaw.symdefsOutputFile) {
    const symsLdName = path.basename(infoRaw.symdefsOutputFile, '.o') + '.ld';
    convWarnings.push({
      message: `--symdefs detected: "gen_syms_ld.bat" (post-build) will produce "${symsLdName}". Dependent projects should include this file as a linker script.`,
      file: opts.uvprojx,
    });
  }

  // Warn if toolset is neither ARM-ADS (standard Keil armcc/armclang) nor ARM-GNU (GCC)
  const toolsetName: string = (() => {
    const t = doc.Project?.Targets?.Target;
    const ft = Array.isArray(t) ? t[0] : t;
    return ft?.ToolsetName ?? '';
  })();
  if (toolsetName && toolsetName !== 'ARM-ADS' && toolsetName !== 'ARM-GNU') {
    convWarnings.push({ message: `Toolset "${toolsetName}" is not supported. Only AC6 (ARM-ADS) and GCC (ARM-GNU) projects can be converted.`, file: opts.uvprojx });
    logWarn(`Unsupported toolset: ${toolsetName}`);
  }

  // App projects must resolve a FWLib GNU_ARM template directory (startup .s + linker.ld source).
  // Library projects (.a output) have no FWLib driver sources, so gnuArmTemplate is expected to
  // be undefined — that is fine.  Only throw for app projects with no template found.
  // Exception: pure-assembly projects (all .s sources + scatter file) are self-contained and
  // do not need FWLib at all — scatter2ld generates the linker script and no C startup is needed.
  const hasCsrcs = infoRaw.sources.some(s => /\.(c|cpp)$/i.test(s));
  if (!infoRaw.isLibrary && !infoRaw.isArmGnu && !infoRaw.gnuArmTemplate && (hasCsrcs || !infoRaw.scatter)) {
    const mcu49x = (opts.mcu && is49xDevice(opts.mcu)) ||
      infoRaw.sources.some(s => /[/\\]libraries[/\\]/i.test(s));
    throw new Error(
      'Cannot locate FWLib template directory.\n' +
      (mcu49x
        ? '49x series: make sure sources include a file from libraries/ or utilities/.'
        : 'Standard series: make sure sources include a file from library/HT32xxxx_Driver/src/ or utilities/.')
    );
  }

  // ★ 從 uvproj 自動推 CPU / FPU / float-abi（flag 類設定由 project.settings.json 統一管理）
  const tc = extractToolchainFromUvproj(doc);
  logInfo('after extractToolchainFromUvproj');
  const effectiveOpts = {
    mcu:      opts.mcu      ?? tc.mcu,
    fpu:      opts.fpu      ?? tc.fpu,
    floatAbi: opts.floatAbi ?? tc.floatAbi,
    cc:       opts.cc,
  };

  // 以裝置標頭 __FPU_PRESENT 驗證 FPU 設定：
  // 部分 Holtek 的 uvprojx 雖然寫 FPU2（Keil 裝置能力欄位），
  // 但 device header 宣告 __FPU_PRESENT=0（例如 HT32F490x1 系列 M4 無 FPU）。
  // 若 blindly 用 FPU2→-mfpu=fpv4-sp-d16 -mfloat-abi=hard，
  // core_cm4.h 的編譯時檢查就會觸發 #error。
  if (effectiveOpts.fpu) {
    const fpuPresent = detectFpuPresentFromHeader(info.includes, outDirAbs);
    if (fpuPresent === false) {
      effectiveOpts.fpu = undefined;
      effectiveOpts.floatAbi = 'soft';
      logInfo(`FPU override: device header __FPU_PRESENT=0 → -mfloat-abi=soft (no -mfpu flag)`);
    }
  }

  if (!effectiveOpts.mcu) {
    // 極端狀況：uvproj 中完全沒有 Cpu，給一個保守預設避免 TS 抱怨
    effectiveOpts.mcu = "cortex-m0plus";
    logInfo('------------no mcu------------');
  }else 
  {
    const mcu = effectiveOpts.mcu;
    logInfo(mcu);
  }

  const deviceName = extractDeviceNameFromUvproj(doc);
  if (deviceName) {
    logInfo(`Device from uvprojx: ${deviceName}`);
  } else {
    logWarn('Device name not found in .uvprojx; will fall back to default in launch.json');
    convWarnings.push({ message: 'Device name not found in .uvprojx — will fall back to default in launch.json', file: opts.uvprojx });
  }

  const t2 = doc.Project?.Targets?.Target;
  const firstTarget = Array.isArray(t2) ? t2[0] : t2;
  const memInfoForResult = extractRomRamFromUvproj(firstTarget, opts.extPath, opts.extraPdscPaths);

  // 從 Keil startup .s 解析 heap/stack 大小（轉換前原始檔）
  // 靠 AREA STACK/HEAP + SPACE 解析，不依賴固定符號名稱（Heap_Size/Stack_Size）。
  // info.sources 裡的 startup 已是轉換後的 _gcc.s，
  // 必須直接從 uvprojx XML 找原始 .s 路徑才能讀到值。
  let parsedHeapSize: string | undefined;
  let parsedStackSize: string | undefined;
  try {
    // 掃描所有 FilePath，找第一個 startup_*.s
    const allFilePaths: string[] = [];
    const collectFilePaths = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (node.FilePath) allFilePaths.push(String(node.FilePath));
      for (const v of Object.values(node)) {
        if (Array.isArray(v)) v.forEach(collectFilePaths);
        else collectFilePaths(v);
      }
    };
    collectFilePaths(doc);
    const startupFP = allFilePaths.find(p => /startup_.*\.s$/i.test(p));
    if (startupFP) {
      const startupAbs = path.isAbsolute(startupFP) ? startupFP : path.resolve(projDir, startupFP);
      if (fs.existsSync(startupAbs)) {
        const sText = fs.readFileSync(startupAbs, 'utf8');
        const { stackSize: ps, heapSize: ph } = parseAsmStackHeap(sText);
        if (ph) parsedHeapSize  = ph;
        if (ps) parsedStackSize = ps;
        logInfo(`scatter2ld: heapSize=${parsedHeapSize}, stackSize=${parsedStackSize} from ${path.basename(startupAbs)}`);
      }
    }
  } catch (e: any) {
    logWarn(`Failed to parse heap/stack size from startup .s: ${e?.message ?? e}; linker script will use template defaults`);
  }

  // conf/Settings.ini [SRAM]：
  // - WORKAREASIZE（OpenOCD flash 燒錄）由 buildHlmPreConfigCmds 獨立查詢。
  // - _estack / __StackTop：若 Settings.ini 值小於 uvprojx 的 ramLength，用 Settings.ini
  //   作為 SP 上限，避免 _estack 超出實際內部 SRAM（例：HT32F493x5 預設 96K，可配置 224K）。
  //   RAM MEMORY region 仍保留 uvprojx 完整大小，讓 linker 不因 section 過大而報錯。
  if (info.ramLength) {
    logInfo(`scatter2ld: RAM from uvprojx/scatter for ${deviceName}: ${info.ramLength}`);
  }
  const sramIniStr = (opts.extPath && deviceName) ? lookupSramFromSettings(deviceName, opts.extPath) : undefined;
  const stackSafeLength = (() => {
    if (!sramIniStr || !info.ramLength) return undefined;
    const ini  = parseInt(sramIniStr,   16);
    const full = parseInt(info.ramLength, 16);
    return (!isNaN(ini) && !isNaN(full) && ini < full) ? sramIniStr : undefined;
  })();
  if (stackSafeLength) {
    logInfo(`Stack SP limited to Settings.ini SRAM ${stackSafeLength} (uvprojx: ${info.ramLength})`);
  }

  // GNU_ARM/ is a sibling of Project/ inside HT32_VSCode/ — all generated .c/.s/.ld go here.
  const gnuArmDir = path.join(path.dirname(outDirAbs), 'GNU_ARM');
  fs.mkdirSync(gnuArmDir, { recursive: true });

  // Library projects (.a output) do not need a linker script.
  const ldFileName = infoRaw.isLibrary ? '' : generateLinkerScript(gnuArmDir, projDir, info, deviceName ?? effectiveOpts.mcu, parsedHeapSize, parsedStackSize, info.ramLength, infoRaw.gnuArmTemplate, convWarnings, stackSafeLength, opts.extPath);
  // bgDir-relative path to the .ld file — stored in meta.json and passed to makefileText.
  const ldRelPath = ldFileName ? path.relative(outDirAbs, path.join(gnuArmDir, ldFileName)).replace(/\\/g, '/') : '';

  // 儲存建置元資料至 project.settings.json（合併，保留使用者設定）
  const buildMeta: BuildMeta = {
    targetName: infoRaw.targetName || 'app',
    mcu: effectiveOpts.mcu!,
    fpu: effectiveOpts.fpu,
    floatAbi: effectiveOpts.floatAbi,
    ramOrigin:  infoRaw.ramOrigin,
    ramLength:  infoRaw.ramLength,
    deviceName: deviceName,
  };
  // Extract AfterMake post-build command: wsRoot = HT32_VSCode/ (parent of outDirAbs)
  const uvPostBuildCmd = extractUvAfterMakeCmd(
    doc, projDir, path.dirname(outDirAbs), outDirAbs, buildMeta.targetName, deviceName ?? '', convWarnings,
  );

  // --symdefs detected: generate gen_syms_ld.bat in outDirAbs, set as post-build cmd.
  // The bat uses %~dp0 (its own directory) so it always finds the correct ELF/output paths.
  let symdefsPostBuildCmd = '';
  if (infoRaw.symdefsOutputFile) {
    const symsBase    = path.basename(infoRaw.symdefsOutputFile, '.o');
    const symsLdName  = symsBase + '.ld';
    const batContent  = [
      '@echo off',
      `set "ELF=%~dp0build\\${buildMeta.targetName}.elf"`,
      `set "OUT=%~dp0build\\${symsLdName}"`,
      `echo Generating symbol linker script "%OUT%" from "%ELF%" ...`,
      `powershell -NoProfile -Command "$out = (& 'arm-none-eabi-nm' '--defined-only' '--extern-only' '-n' '%ELF%') | ForEach-Object { $f=$_.Trim() -split '\\s+'; if($f.Count -eq 3){$f[2]+' = 0x'+$f[0]+';'} }; [IO.File]::WriteAllLines('%OUT%', $out, [Text.Encoding]::ASCII)"`,
    ].join('\r\n');
    const batAbs = path.join(outDirAbs, 'gen_syms_ld.bat');
    fs.writeFileSync(batAbs, batContent, 'utf8');
    // Use backslash path in cmd /c "..." so PowerShell→cmd.exe path parsing is unambiguous
    const batRel = path.relative(path.dirname(outDirAbs), batAbs);  // natural backslashes
    symdefsPostBuildCmd = `cmd /c "${batRel}"`;
  }

  const finalPostBuildCmd = [uvPostBuildCmd, symdefsPostBuildCmd].filter(Boolean).join(' && ');
  // project.settings.json 是 source of truth：先寫定所有旗標，再從它生成 Makefile。
  const _existingSettings = readProjectSettings(outDirAbs);
  writeProjectSettings(outDirAbs, {
    ..._existingSettings,
    extraCFlags: _existingSettings.extraCFlags || '-std=gnu11',
    mcu:        buildMeta.mcu,
    fpu:        buildMeta.fpu || 'none',
    floatAbi:   buildMeta.floatAbi ?? 'soft',
    targetName: buildMeta.targetName,
    ramOrigin:  buildMeta.ramOrigin,
    ramLength:  buildMeta.ramLength,
    deviceName: buildMeta.deviceName,
    ...(info.defines?.length ? { cDefs: info.defines } : {}),
    ...(info.asmDefines?.length ? { aDefs: info.asmDefines } : {}),
    ...(finalPostBuildCmd ? { postBuildCmd: finalPostBuildCmd } : {}),
  });

  // Collect implicitly-added sources (not from .uvprojx groups) to be added to the startup
  // group in meta.groups so they appear in the tree view alongside the startup .s file.
  const implicitSourcesRel: string[] = [];   // outDirAbs-relative paths

  // 從 uVision 專案已引用的 FWLib 中直接取用 syscalls.c（不複製，不產生）。
  // FWLib 的 syscalls.c 提供正確的 _sbrk()（含 __HeapLimit 上限檢查）。
  // Fallback：若 FWLib 路徑找不到，從 bundled templates/GNU_ARM/syscalls.c 複製到 bgDir。
  // 49x 系列的 ht32f4xxx_board.c 已自帶 _close/_fstat/_isatty/_lseek 等 syscall symbols，
  // 若重複加 syscalls.c 會造成 multiple definition；偵測到此類 board file 時跳過。
  const hasBoardSyscalls = info.sources.some(s => /ht32f4[0-9].*_board\.c$/i.test(s));
  if (!infoRaw.isLibrary && hasCsrcs && !info.sources.some(s => /syscalls\.c$/i.test(s)) && !hasBoardSyscalls) {
    const libSrcRel = info.sources.find(s => /library[/\\]HT32\w+_Driver[/\\]src[/\\]/i.test(s));
    let added = false;
    if (libSrcRel) {
      const driverSrcDir = path.dirname(path.resolve(outDirAbs, libSrcRel));
      const syscallsAbs  = path.join(driverSrcDir, 'syscalls.c');
      if (fs.existsSync(syscallsAbs)) {
        const syscallsRel = path.relative(outDirAbs, syscallsAbs).replace(/\\/g, '/');
        info.sources.push(syscallsRel);
        implicitSourcesRel.push(syscallsRel);
        logInfo(`uv2make: syscalls.c from lib: ${syscallsAbs}`);
        added = true;
      }
    }
    if (!added) {
      const tpl = opts.extPath
        ? path.join(opts.extPath, 'templates', 'GNU_ARM', 'syscalls.c')
        : path.join(__dirname, '..', '..', 'templates', 'GNU_ARM', 'syscalls.c');
      fs.copyFileSync(tpl, path.join(gnuArmDir, 'syscalls.c'));
      info.sources.push('../GNU_ARM/syscalls.c');
      implicitSourcesRel.push('../GNU_ARM/syscalls.c');
      logInfo(`uv2make: syscalls.c copied from template to GNU_ARM/ (lib not found)`);
    }
  }

  // MDK uvprojx 不列 printf.c（ARMCC 有自己的 printf），但 GCC 用 newlib printf 體積大很多。
  // 若 FWLib 的 ht32_serial.c 已在 sources（代表 retarget 啟用），補加同目錄的 printf.c。
  // 不補加時 GCC 會 link newlib printf，size 比 HT32-IDE convert 大 ~3KB。
  if (!infoRaw.isLibrary && hasCsrcs && !info.sources.some(s => /\bprintf\.c$/i.test(s))) {
    const serialSrcRel = info.sources.find(s => /library[/\\]HT32\w+_Driver[/\\]src[/\\]ht32_serial\.c$/i.test(s));
    if (serialSrcRel) {
      const driverSrcDir = path.dirname(path.resolve(outDirAbs, serialSrcRel));
      const printfAbs    = path.join(driverSrcDir, 'printf.c');
      if (fs.existsSync(printfAbs)) {
        const printfRel = path.relative(outDirAbs, printfAbs).replace(/\\/g, '/');
        info.sources.push(printfRel);
        implicitSourcesRel.push(printfRel);
        logInfo(`uv2make: printf.c from lib: ${printfAbs}`);
      }
    }
  }

  // 產生 ht32_stack_analysis.c（app only）：補上 GCC 版 StackUsageAnalysisInit()（FWLib 只有 Keil 實作）
  // Library projects produce .a output and have no startup/linker, so stack analysis is irrelevant.
  // Pure-assembly projects (hasCsrcs=false) have no FWLib includes; skip to avoid ht32.h not found.
  if (!infoRaw.isLibrary && hasCsrcs) {
    generateStackAnalysis(gnuArmDir, opts.extPath);
    if (!info.sources.some(s => /ht32_stack_analysis\.c$/i.test(s))) {
      info.sources.push('../GNU_ARM/ht32_stack_analysis.c');
      implicitSourcesRel.push('../GNU_ARM/ht32_stack_analysis.c');
    }
  }

  writeLists(outDirAbs, info);
  // Makefile 從已寫入的 project.settings.json 生成，確保兩者完全一致。
  writeMakefile(outDirAbs, buildMakefileFromProjectSettings(readProjectSettings(outDirAbs), {
    cc:            effectiveOpts.cc || 'arm-none-eabi-gcc',
    srcs:          info.sources,
    linkerScripts: ldRelPath ? [ldRelPath] : [],
    isLibrary:     !!infoRaw.isLibrary,
    comment:       'Converted from Keil uVision.',
  }));
  await writeCompileCommands(outDirAbs, effectiveOpts, info);

  const metaGroups: Record<string, string[]> = {};
  if (infoRaw.groups) {
    for (const [g, files] of Object.entries(infoRaw.groups)) {
      metaGroups[g] = files.map(rel =>
        normalize(path.join(projFolderName, rel))
      );
    }
  }

  const projectRoot = path.dirname(path.dirname(outDirAbs));

  // Add .ld to Linker group (app only).
  if (ldRelPath) {
    const ldAbsPath = path.resolve(outDirAbs, ldRelPath);
    (metaGroups['Linker'] ??= []).push(normalize(path.relative(projectRoot, ldAbsPath)));
  }
  // Extension-added sources (syscalls, retarget, stack_analysis) go into a visible 'vscode'
  // group — these files are added for GNU/VS Code toolchain and were not in the original project.
  if (implicitSourcesRel.length > 0) {
    metaGroups['vscode'] = implicitSourcesRel.map(rel =>
      normalize(path.relative(projectRoot, path.resolve(outDirAbs, rel)))
    );
  }

  const metaFileOptions: Record<string, FileOption> = {};
  if (infoRaw.fileOptions) {
    for (const [rel, opt] of Object.entries(infoRaw.fileOptions)) {
      const metaKey = normalize(path.join(projFolderName, rel));
      metaFileOptions[metaKey] = opt;
      if (opt.exclude) {
        logInfo(`File excluded from build: ${path.basename(rel)}`);
      }
      if (opt.xo)  logInfo(`File set to execute-only (-mpure-code): ${path.basename(rel)}`);
      if (opt.rom) logInfo(`File assigned to ROM region ${opt.rom.origin}: ${path.basename(rel)}`);
    }
  }

  const meta = {
    projectName: infoRaw.projectName || infoRaw.targetName || "Project",
    groups: metaGroups,
    ...(ldRelPath ? { linkerScripts: [ldRelPath] } : {}),
    ...(infoRaw.isLibrary ? { isLibrary: true } : {}),
    ...(Object.keys(metaFileOptions).length ? { fileOptions: metaFileOptions } : {}),
  };

  logFile(path.join(outDirAbs, 'project.meta.json'));
  fs.writeFileSync(
    path.join(outDirAbs, "project.meta.json"),
    JSON.stringify(meta, null, 2)
  );

  // Library 模式輸出 .a；否則輸出 .elf
  const outExt     = infoRaw.isLibrary ? '.a' : '.elf';
  const outputName = (infoRaw.targetName || 'app') + outExt;
  const workspaceRoot = opts.workspaceRoot
    ? (path.isAbsolute(opts.workspaceRoot) ? opts.workspaceRoot : path.resolve(opts.workspaceRoot))
    : path.dirname(outDirAbs);
  const elfRelPath = normalize(path.relative(workspaceRoot, path.join(outDirAbs, 'build', outputName)));

  return {
    elfPath: infoRaw.isLibrary ? undefined : elfRelPath,   // library 不產生 launch.json 目標
    deviceName,
    mcu:      effectiveOpts.mcu,
    fpu:      effectiveOpts.fpu,
    floatAbi: effectiveOpts.floatAbi,
    ramOrigin: memInfoForResult.ramOrigin,
    ramLength: memInfoForResult.ramLength,
    spimFlm: parseUvoptxSpimFlm(opts.uvprojx),
    includes: info.includes,
    defines:  info.defines,
    prebuiltWarnings: infoRaw.prebuiltWarnings,
    conversionWarnings: convWarnings.length ? convWarnings : undefined,
    fwlibRoot: infoRaw.fwlibRoot,
    hasCsrcs,
  };
}

/* ---------------- internals ---------------- */

function ensureDir(p: string) { fs.mkdirSync(p, { recursive: true }); }
function normalize(p: string) { return p.replace(/\\/g, "/"); }
function uniq<T>(a: T[]) { return Array.from(new Set(a)); }

function resolveRel(projDir: string, p: string) {
  const abs = path.isAbsolute(p) ? p : path.join(projDir, p);
  return path.relative(projDir, abs).replace(/\\/g, "/");
}

/** Resolve an assembly symbol to its numeric value via EQU (Keil) or .equ (GCC) lookup. */
function resolveAsmSymbol(text: string, symbol: string): string | undefined {
  const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keilM = new RegExp(`^\\s*${esc}\\s+EQU\\s+(0x[\\da-fA-F]+|\\d+)`, 'im').exec(text);
  if (keilM) return keilM[1];
  const gccM  = new RegExp(`\\.equ\\s+${esc}\\s*,\\s*(0x[\\da-fA-F]+|\\d+)`, 'i').exec(text);
  if (gccM)  return gccM[1];
  return undefined;
}

/**
 * Parse stack and heap sizes from an ARM startup .s without relying on fixed symbol names.
 * Works for Keil ARM (AREA STACK/HEAP + SPACE) and GCC (.section ".stack"/".heap" + .space).
 * If the SPACE/.space argument is a symbol name, it is resolved via EQU/.equ in the full text.
 */
function parseAsmStackHeap(text: string): { stackSize?: string; heapSize?: string } {
  function sectionBody(pat: RegExp): string | undefined {
    const m = pat.exec(text);
    if (!m) return undefined;
    const after = text.slice(m.index + m[0].length);
    const next = /(\bAREA\b|^\s*\.section\b)/im.exec(after);
    return next ? after.slice(0, next.index) : after;
  }
  function spaceVal(body: string | undefined, pat: RegExp): string | undefined {
    if (!body) return undefined;
    const m = pat.exec(body);
    if (!m) return undefined;
    const expr = m[1].trim();
    if (/^(0x[\da-fA-F]+|\d+)$/i.test(expr)) return expr;   // literal
    return resolveAsmSymbol(text, expr);                       // symbol → look up in full text
  }
  function toHex(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    const n = parseInt(raw, raw.toLowerCase().startsWith('0x') ? 16 : 10);
    return isNaN(n) ? undefined : `0x${n.toString(16).toUpperCase()}`;
  }
  return {
    stackSize: toHex(
      spaceVal(sectionBody(/\bAREA\b[^;\n]*\bSTACK\b/i), /\bSPACE\s+(\S+)/i) ??
      spaceVal(sectionBody(/\.section\s+"\.stack"/i),     /\.space\s+(\S+)/i)
    ),
    heapSize: toHex(
      spaceVal(sectionBody(/\bAREA\b[^;\n]*\bHEAP\b/i),  /\bSPACE\s+(\S+)/i) ??
      spaceVal(sectionBody(/\.section\s+"\.heap"/i),      /\.space\s+(\S+)/i)
    ),
  };
}

function patchStartupFromKeil(keilPath: string, gccTemplatePath: string, outPath: string, buildGenRoot: string) {
  const keilText = fs.readFileSync(keilPath, "utf8");

  // 靠 AREA STACK/HEAP + SPACE 解析，不依賴固定符號名稱
  const { stackSize: rawStack, heapSize: rawHeap } = parseAsmStackHeap(keilText);
  // 統一轉成 decimal（GCC .equ 語法兩種都支援，但保持一致）
  const toDecStr = (s: string | undefined) =>
    s ? String(parseInt(s, s.toLowerCase().startsWith('0x') ? 16 : 10)) : undefined;
  let stackSize = toDecStr(rawStack);
  let heapSize  = toDecStr(rawHeap);

  const enforcedHeap = enforceMinHeap(heapSize);
  if (enforcedHeap !== heapSize) {
    logWarn(`Heap_Size=${heapSize} in ${path.basename(keilPath)} enforced to ${enforcedHeap} (GCC newlib-nano requires heap for printf)`);
  }
  heapSize = enforcedHeap;

  let gccText = fs.readFileSync(gccTemplatePath, "utf8");

  if (stackSize) {
    // GCC 語法: `.equ    Stack_Size, 512`
    gccText = gccText.replace(
      /(\.equ\s+Stack_Size,\s*)\d+/,
      `$1${stackSize}`
    );
  }
  if (heapSize) {
    gccText = gccText.replace(
      /(\.equ\s+Heap_Size,\s*)\d+/,
      `$1${heapSize}`
    );
  }

  // .section ".stack","w" / .section ".heap","w" 預設是 SHT_PROGBITS，
  // linker 會在 FLASH 幫它分配 LMA，導致浪費 FLASH 且 --print-memory-usage
  // 把 heap/stack 算在 FLASH 而非 RAM。改成 "aw",%nobits 讓它等同 BSS：
  // "a" = SHF_ALLOC（必須，linker 才會分配 RAM）；%nobits = SHT_NOBITS（不佔 FLASH）。
  gccText = gccText.replace(
    /\.section\s+"\.stack"\s*,\s*"w"(?:\s*,\s*%nobits)?/g,
    '.section ".stack","aw",%nobits'
  );
  gccText = gccText.replace(
    /\.section\s+"\.heap"\s*,\s*"w"(?:\s*,\s*%nobits)?/g,
    '.section ".heap","aw",%nobits'
  );

  fs.mkdirSync(buildGenRoot, { recursive: true });
  fs.writeFileSync(outPath, gccText);
  logInfo(`Synced Stack_Size=${stackSize ?? "?"}, Heap_Size=${heapSize ?? "?"} from ${keilPath} to ${outPath}`);
}

/**
 * 把 Keil 的 .s 檔轉成實際要用的 GCC 檔案。
 * - startup_xxxxxxxx_nn.s → startup_xxxxxxxx_gcc_nn.s (from templates/M3_GNU_ARM or M0_GNU_ARM → build-gen)
 * - ht32_op*.s            → ht32_op*.c             (from templates/M3_GNU_ARM or M0_GNU_ARM → build-gen)
 *
 * @param relPath  uvproj 裡的相對路徑（相對於 MDK_ARMv5 專案根目錄）
 * @param projectRoot MDK_ARMv5 專案根 (也就是有 uvprojx 的那層)
 * @param templateRoot template 目錄，例如: path.join(extRoot, 'templates', 'M3_GNU_ARM')
 * @param buildGenRoot build-gen 目錄，例如: path.join(projectRoot, 'build-gen')
 * @returns 若需要替換，回傳「替換後要放進 source.list/makefile 的相對路徑」，否則回傳 null
 */
/**
 * INCBIN smart path resolution:
 * When a Keil .axf.bin is referenced (e.g. IAP.axf.bin), look for a sibling build-gen-*
 * directory whose project.settings.json has a matching targetName, and return the relative path
 * to its GCC output .bin (e.g. ../build-gen-iap/build/IAP.bin).
 */
function resolveGccBinFromSiblingBuildGen(
  targetName: string,   // e.g. "IAP"
  bgParentDir: string,  // parent of outDir, i.e. .vscode/
  outDir:      string   // current build-gen-xxx dir (for relative path calculation)
): string | undefined {
  try {
    const dirs = fs.readdirSync(bgParentDir);
    for (const d of dirs) {
      const sibDir = path.join(bgParentDir, d);
      if (!fs.statSync(sibDir).isDirectory()) continue;
      if (!fs.existsSync(path.join(sibDir, 'project.meta.json'))) continue;
      const settingsPath = path.join(sibDir, 'project.settings.json');
      if (!fs.existsSync(settingsPath)) continue;
      const meta = readProjectSettings(sibDir);
      if ((meta.targetName ?? '').toLowerCase() === targetName.toLowerCase()) {
        const binAbs = path.join(bgParentDir, d, 'build', `${meta.targetName}.bin`);
        return normalize(path.relative(outDir, binAbs));
      }
    }
  } catch { /* ignore */ }
  return undefined;
}

/**
 * keil2gnu — 將 Keil armasm 語法的 .s 檔轉換為 GNU assembler 語法
 *
 * 轉換規則詳見 ARCHITECTURE.md「Keil armasm → GNU assembler 語法轉換表」
 *
 * @param keilText   Keil .s 原始文字
 * @param srcDir     原始 .s 檔所在目錄（用於解析 INCLUDE 相對路徑）
 * @param outDir     輸出目錄（INCLUDE 的檔案也會轉換後輸出到這裡）
 * @param visited    防止遞迴 INCLUDE 循環（呼叫者不需傳入）
 * @returns GNU assembler 語法文字
 */
function keil2gnu(
  keilText: string,
  srcDir: string,
  outDir: string,
  visited: Set<string> = new Set()
): string {
  // Pre-process: join Keil line continuations（\ 在行尾表示接下一行）
  const joined = keilText.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/\\\n[ \t]*/g, ' ');
  const lines = joined.split('\n');
  const out: string[] = [
    '\t.syntax unified',   // 啟用 Thumb2 UAL 語法（LSLS 3-operand 等需要）
  ];

  // Pre-scan: find symbols used as SPACE values (e.g. "SPACE Heap_Size", "SPACE Stack_Size").
  // For these symbols we must NOT emit #define — only .equ.
  // Reason: when compiled with -x assembler-with-cpp, the C preprocessor runs first and expands
  // "#define Heap_Size 0" in ".if Heap_Size > 0" / ".space Heap_Size", so even if the user later
  // changes ".equ Heap_Size, 512" in the .s file, the old #define still wins → 0 bytes allocated.
  // Using only .equ lets GAS evaluate the symbol from the symbol table after preprocessing.
  const spaceSymbols = new Set<string>();
  for (const l of lines) {
    const sm = /^\s*(?:[\w$]+\s+)?SPACE\s+([\w$]+)/i.exec(l);
    if (sm) spaceSymbols.add(sm[1]);
  }

  // AREA 屬性 → section 指令對應
  // .text / .data / .bss 是 GNU as 獨立 pseudo-op；.rodata 不是，必須加 .section
  const areaToSection = (name: string, attrs: string): string => {
    const a = attrs.toUpperCase();
    const n = name.toUpperCase().replace(/^\||\|$/g, ''); // strip Keil |pipes|
    // Keil vector table AREA: "AREA RESET, CODE/DATA, READONLY" → must go into .isr_vector
    // HT32F5xxxx uses DATA,READONLY；HT32F1xxxx uses CODE,READONLY — both are the vector table
    if (n === 'RESET' && a.includes('READONLY')) return '.section .isr_vector,"a",%progbits';
    if (a.includes('NOINIT') && n === 'STACK')       return '.section ".stack","aw",%nobits';
    if (a.includes('NOINIT') && n === 'HEAP')        return '.section ".heap","aw",%nobits';
    if (a.includes('NOINIT'))                        return '.bss';
    // CODE READONLY with simple alphanumeric name (not RESET) → named executable section.
    // Needed for flash-image builder projects (e.g. maker.s) where each AREA (LOADER, LAYOUT,
    // AREA1…) must land at a distinct address as directed by the scatter/linker script.
    // |..| Keil-quoted names contain non-word chars so /^\w+$/ excludes them → fall through to .text.
    if (a.includes('CODE') && a.includes('READONLY') && /^\w+$/.test(n) && n !== 'RESET')
                                                     return `.section .${n.toLowerCase()},"ax",%progbits`;
    if (a.includes('CODE'))                          return '.text';
    // DATA READONLY with a simple alphanumeric AREA name → named section for independent linker placement
    // (e.g. AREA IAP → .section .iap; AREA BOOT → .section .boot)
    // Only applies to simple \w+ names; Keil quoted names like |.ARM.Collect$$| fall back to .rodata.
    if (a.includes('DATA') && a.includes('READONLY') && /^\w+$/.test(n))
                                                     return `.section .${n.toLowerCase()},"a",%progbits`;
    if (a.includes('DATA') && a.includes('READONLY')) return '.section .rodata';
    if (a.includes('DATA'))                          return '.data';
    return '.text';
  };

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // ── 1. 行尾 ; 注解 → @ ──────────────────────────────────────────────
    // 注意：字串內的 ; 不處理（HT32 組語幾乎沒有字串，這裡簡化處理）
    line = line.replace(/;(.*)$/, (_, comment) => `@ ${comment.trimStart()}`);

    const trimmed = line.trim();
    const upper   = trimmed.toUpperCase();

    // ── 2. 空行 / 純注解行 → 直接保留 ──────────────────────────────────
    if (trimmed === '' || trimmed.startsWith('@')) {
      out.push(line);
      continue;
    }

    // ── 3. END（檔案結尾）→ 移除 ────────────────────────────────────────
    if (/^\s*END\s*$/.test(line)) {
      continue;
    }

    // ── 4. PRESERVE8 → .balign 8 ────────────────────────────────────────
    if (/^\s*PRESERVE8\s*$/.test(line)) {
      out.push('\t.balign 8');
      continue;
    }

    // ── 5. THUMB → .thumb ────────────────────────────────────────────────
    if (/^\s*THUMB\s*$/.test(line)) {
      out.push('\t.thumb');
      continue;
    }

    // ── 6. AREA name, attrs... ────────────────────────────────────────────
    // 區域名稱可能是普通識別字或 Keil 的 |.text| 管道括住形式
    const areaM = /^\s*AREA\s+(\|[^|]*\||\w[\w$]*)\s*,\s*(.+)$/i.exec(line);
    if (areaM) {
      const areaName = areaM[1];
      const attrs    = areaM[2];
      const sect     = areaToSection(areaName, attrs);
      // ALIGN=n → .balign 2^n
      const alignM = /ALIGN\s*=\s*(\d+)/i.exec(attrs);
      const balign  = alignM ? (1 << parseInt(alignM[1])) : null;
      out.push(`\t${sect}`);
      if (balign) out.push(`\t.balign ${balign}`);
      continue;
    }

    // ── 7. EQU：「name EQU value」(name 可能在同一行前面) ────────────────
    const equM = /^(\s*)([\w$]+)\s+EQU\s+(.+)$/i.exec(line);
    if (equM) {
      const name = equM[2];
      let   val  = equM[3].trim();
      // 去掉行末注解（已被上面轉成 @，所以抓 @ 後面的部分）
      val = val.replace(/\s*@.*$/, '').trim();
      // Keil ARMASM treats single-char double-quoted strings as ASCII values: EQU "V" = 86.
      // GAS/C-preprocessor require single quotes for char constants: 'V' = 86.
      // Replace "X" (exactly one char) → 'X' so GAS and cpp evaluate it as an integer.
      val = val.replace(/"(.)"/g, "'$1'");
      // 運算子轉換
      val = keilOperators(val);
      // Emit .equ BEFORE #define: preprocessor expands macros top-down, so .equ must appear
      // before #define to avoid the macro name being replaced in the .equ symbol field itself.
      // Symbols used in SPACE directives (e.g. Heap_Size, Stack_Size) get .equ ONLY — no #define.
      // This allows users to change the .equ value in the .s file and have it take effect correctly.
      out.push(`${equM[1]}.equ ${name}, ${val}`);
      if (!spaceSymbols.has(name)) {
        out.push(`#define ${name} ${val}`);
      }
      continue;
    }

    // ── 8. [label] DCD / DCW / DCB / SPACE ──────────────────────────────
    // 支援「label SPACE val」與「        SPACE val」兩種形式
    const dataM = /^(\s*)([\w$]+\s+)?(DCD|DCW|DCB|SPACE)\s+(.*)$/i.exec(line);
    if (dataM) {
      const labelPart = dataM[2]?.trim();   // 有 label → 輸出 "label:"
      const dir       = dataM[3].toUpperCase();
      const val       = keilOperators(dataM[4].replace(/\s*@.*$/, '').trim());
      const gnuDir: Record<string, string> = {
        DCD: '.word', DCW: '.hword', DCB: '.byte', SPACE: '.space'
      };
      if (labelPart) out.push(`${labelPart}:`);
      // SPACE 0 → GNU assembler 警告 "repeat count is zero"；用 .if guard 消除
      if (dir === 'SPACE') {
        out.push(`\t.if ${val} > 0`);
        out.push(`\t.space ${val}`);
        out.push(`\t.endif`);
      } else {
        out.push(`\t${gnuDir[dir]} ${val}`);
      }
      continue;
    }

    // ── 9. ALIGN（無參數 or 有參數）──────────────────────────────────────
    const alignM2 = /^\s*ALIGN\s*(\d*)\s*$/i.exec(line);
    if (alignM2) {
      const n = alignM2[1] ? parseInt(alignM2[1]) : 4;
      out.push(`\t.balign ${n}`);
      continue;
    }

    // ── 10. EXPORT sym [WEAK] ─────────────────────────────────────────────
    const exportM = /^\s*EXPORT\s+([\w$]+)\s*(\[WEAK\])?/i.exec(line);
    if (exportM) {
      const sym  = exportM[1];
      const weak = !!exportM[2];
      if (weak) out.push(`\t.weak ${sym}`);
      out.push(`\t.global ${sym}`);
      continue;
    }

    // ── 11. IMPORT sym ────────────────────────────────────────────────────
    const importM = /^\s*IMPORT\s+([\w$]+)/i.exec(line);
    if (importM) {
      out.push(`\t.extern ${importM[1]}`);
      continue;
    }

    // ── 12. PROC / ENDP → 移除（保留前面的 label 行） ────────────────────
    if (/^\s*[\w$]+\s+PROC\b/i.test(line)) {
      // "Label PROC ..." → 只保留 "Label:"
      const labelM = /^\s*([\w$]+)\s+PROC/i.exec(line);
      if (labelM) out.push(`${labelM[1]}:`);
      continue;
    }
    if (/^\s*ENDP\s*$/.test(line)) {
      continue;
    }

    // ── 13. IF / ELSE / ENDIF ────────────────────────────────────────────
    //  IF :DEF:sym      → .ifdef sym
    //  IF :LNOT::DEF:x  → .ifndef sym
    //  IF sym=val       → .if sym == val
    //  IF (expr)        → .if (expr)
    const ifM = /^\s*IF\s+(.+)$/i.exec(line);
    if (ifM) {
      const cond = ifM[1].trim().replace(/\s*@.*$/, '');
      const defM  = /^:DEF:\s*([\w$]+)$/i.exec(cond);
      const ndefM = /^:LNOT::DEF:\s*([\w$]+)$/i.exec(cond);
      // 使用 C preprocessor 指令（#ifdef/#if），而非 GNU as 指令（.ifdef/.if）
      // 原因：ASFLAGS 的 -D 定義的是 C preprocessor 符號，不是 GNU as 符號；
      //       用 .ifdef 會永遠找不到 -D 定義的 macro，必須用 #ifdef 才能正確解析。
      if (defM)       out.push(`#ifdef ${defM[1]}`);
      else if (ndefM) out.push(`#ifndef ${ndefM[1]}`);
      else            out.push(`#if ${keilIfCond(cond)}`);
      continue;
    }
    const elifM = /^\s*ELIF\s+(.+)$/i.exec(line);
    if (elifM) {
      const cond = elifM[1].trim().replace(/\s*@.*$/, '');
      out.push(`#elif ${keilIfCond(cond)}`);
      continue;
    }
    if (/^\s*ELSE\s*$/i.test(line)) {
      out.push('#else');
      continue;
    }
    if (/^\s*ENDIF\s*$/i.test(line)) {
      out.push('#endif');
      continue;
    }

    // ── 14. INCLUDE file → .include + 遞迴轉換 ───────────────────────────
    const incM = /^\s*INCLUDE\s+(.+)$/i.exec(line);
    if (incM) {
      const incFile = incM[1].trim().replace(/\s*@.*$/, '').trim();
      const incAbs  = path.resolve(srcDir, incFile);
      const incBase = path.basename(incFile, '.s') + '_gcc.s';
      const incDst  = path.join(outDir, incBase);

      if (!visited.has(incAbs) && fs.existsSync(incAbs)) {
        visited.add(incAbs);
        try {
          const incText = fs.readFileSync(incAbs, 'utf8');
          const converted = keil2gnu(incText, path.dirname(incAbs), outDir, visited);
          fs.mkdirSync(outDir, { recursive: true });
          fs.writeFileSync(incDst, converted, 'utf8');
          logInfo(`keil2gnu: converted include ${incFile} → ${incBase}`);
        } catch (e: any) {
          logWarn(`keil2gnu: failed to convert include ${incFile}: ${e?.message}`);
        }
      } else if (!fs.existsSync(incAbs)) {
        logWarn(`keil2gnu: INCLUDE file not found: ${incAbs}`);
      }
      out.push(`\t.include "${incBase}"`);
      continue;
    }

    // ── 15. INCBIN file → .incbin "file" ─────────────────────────────────
    // 路徑以 srcDir 為基準解析後，轉成相對於 outDir 的路徑（避免 build-gen/ 找不到檔案）
    // 若檔名是 *.axf.bin（Keil 輸出），嘗試自動對應到 sibling build-gen-* 的 GCC 輸出
    const incbinM = /^\s*INCBIN\s+(.+)$/i.exec(line);
    if (incbinM) {
      const rawBin = incbinM[1].trim().replace(/\s*@.*$/, '').trim();
      const binAbs = path.resolve(srcDir, rawBin);
      const axfMatch = /^(.+)\.axf\.bin$/i.exec(path.basename(rawBin));
      let binRel: string;
      if (axfMatch) {
        // *.axf.bin — Keil build output; try to map to sibling GCC build-gen
        const resolved = resolveGccBinFromSiblingBuildGen(axfMatch[1], path.dirname(outDir), outDir);
        if (resolved) {
          out.push(`@ [keil2gnu] INCBIN: ${path.basename(rawBin)} → GCC output ${resolved}`);
          binRel = resolved;
        } else {
          binRel = normalize(path.relative(outDir, binAbs));
        }
      } else {
        // Plain .bin (e.g. IAP.bin) — also try sibling build-gen resolution first.
        // If the IAP project was converted with the extension, its GCC output will be at
        // sibling build-gen-xxx/build/IAP.bin, which is more reliable than the Keil-built
        // binary at the original path.
        const plainBinMatch = /^(.+)\.bin$/i.exec(path.basename(rawBin));
        const siblingResolved = plainBinMatch
          ? resolveGccBinFromSiblingBuildGen(plainBinMatch[1], path.dirname(outDir), outDir)
          : undefined;
        if (siblingResolved) {
          out.push(`@ [keil2gnu] INCBIN: ${path.basename(rawBin)} → sibling GCC build ${siblingResolved}`);
          binRel = siblingResolved;
        } else {
          binRel = normalize(path.relative(outDir, binAbs));
        }
      }
      out.push(`\t.incbin "${binRel}"`);
      continue;
    }

    // ── 16. __main → main ────────────────────────────────────────────────
    line = line.replace(/\b__main\b/g, 'main');

    // ── 17. 已知但尚未支援的 Keil 專用指令 → 警告 + 保留原行 ─────────────
    // ARM 指令（UAL）與 labels 不在此列，直接透通即可
    const KEIL_ONLY_DIRECTIVES = new Set([
      'REQUIRE8', 'LTORG', 'ROUT',
      'MACRO', 'MEND', 'MEXIT',
      'WHILE', 'WEND',
      'GBLA', 'GBLL', 'GBLS',
      'LCLA', 'LCLL', 'LCLS',
      'SETA', 'SETL', 'SETS',
      'MAP', 'FIELD', 'RECORD',
      'ASSERT', 'INFO', 'OPT', 'SUBT', 'TTL',
    ]);
    // 取行首第一個 token（指令或標籤後的指令）
    const tokens = trimmed.split(/\s+/);
    const firstToken = tokens[0].toUpperCase().replace(/[[\]{}]/, '');
    const secondToken = tokens[1]?.toUpperCase().replace(/[[\]{}]/, '') ?? '';
    const directive = KEIL_ONLY_DIRECTIVES.has(firstToken) ? firstToken
                    : KEIL_ONLY_DIRECTIVES.has(secondToken) ? secondToken
                    : null;
    if (directive) {
      logWarn(`keil2gnu: unsupported Keil directive "${directive}", line kept as-is: ${trimmed}`);
      out.push(`@ [keil2gnu WARNING] unrecognized Keil directive: ${directive}`);
    }

    // ── 18. label 行（armasm 規定 label 必須從第 0 欄開始）→ 加 ":" ──
    // 到這裡已處理完所有 Keil 指令；行首無空白且第一個 token 是 identifier → label
    if (!/^\s/.test(line) && /^[\w$]/.test(trimmed)) {
      const pureLabel = /^[\w$]+\s*$/.test(trimmed);
      const inlineM   = /^([\w$]+)([ \t]+)(\S.*)$/.exec(trimmed);
      if (pureLabel) {
        // 純 label 行：BP1\n → BP1:
        out.push(`${trimmed}:`);
        continue;
      } else if (inlineM) {
        // label + 指令同行：BP1   LDR R0,... → BP1:   LDR R0,...
        out.push(`${inlineM[1]}:${inlineM[2]}${inlineM[3]}`);
        continue;
      }
    }

    // ── 19. 其他行（ARM 指令、labels 等）→ 直接保留 ──────────────────────
    out.push(line);
  }

  return out.join('\n') + '\n';
}

/** Keil 條件運算子 → GNU 條件運算子 */
function keilIfCond(cond: string): string {
  // :DEF:sym → .ifdef 要在外層處理，這裡只處理內嵌 :DEF:
  if (/^:DEF:\s*([\w$]+)$/i.test(cond)) {
    return cond.replace(/:DEF:\s*([\w$]+)/i, 'defined($1)');
  }
  if (/^:LNOT::DEF:\s*([\w$]+)$/i.test(cond)) {
    return cond.replace(/:LNOT::DEF:\s*([\w$]+)/i, '!defined($1)');
  }
  // sym=val → sym == val（避免 ==val 被重複處理）
  cond = cond.replace(/([^=!<>])=([^=])/g, '$1 == $2');
  return keilOperators(cond);
}

/** Keil 算術/位元運算子 → GNU 運算子 */
function keilOperators(expr: string): string {
  return expr
    .replace(/<>/g,     ' != ')   // Keil 不等於 → C 不等於
    .replace(/:SHL:/gi, ' << ')
    .replace(/:SHR:/gi, ' >> ')
    .replace(/:OR:/gi,  ' | ')
    .replace(/:AND:/gi, ' & ')
    .replace(/:EOR:/gi, ' ^ ')
    .replace(/:NOT:/gi, '~');
}

/**
 * keil2gnu() 轉出的 startup Reset_Handler 通常只呼叫 SystemInit → main，
 * 缺少 GNU toolchain 必要的 .data copy、.bss 清零、__libc_init_array。
 * 此函式做 post-process：偵測缺漏並注入標準 ARM Cortex-M 啟動序列。
 */
function injectStartupInit(gnuText: string): string {
  // 只處理 startup 檔（有 .isr_vector section）
  if (!gnuText.includes('.isr_vector')) return gnuText;
  // 已有 _sdata → 不重複注入
  if (gnuText.includes('_sdata')) return gnuText;

  // ── Step 1: 移除 Keil 的 Stack/Heap .bss block ──────────────────────────
  // Keil startup 在 .bss 定義 Stack_Mem / Heap_Mem，佔用 RAM；
  // GNU 工具鏈用 linker script 的 _estack / ._user_heap_stack 管理，不需要這些。
  // 移除的 label: Stack_Mem, __initial_sp, __heap_base, Heap_Mem, __heap_limit
  // .space Stack_Size / .space Heap_Size 保留：keil2gnu 將 AREA STACK/HEAP 轉成
  // .section ".stack/.heap",%nobits，讓 --print-memory-usage 能看到 stack 佔用，
  // 使用者只需在 startup 改 Stack_Size 即可，無需動 linker script。
  const STACK_HEAP_LABELS = new Set([
    'Stack_Mem', '__initial_sp', '__heap_base', 'Heap_Mem', '__heap_limit',
  ]);

  // ── Step 2: 向量表第一項 __initial_sp → _estack，並移除 Keil SystemInit 呼叫 ──
  // Keil startup 在 Reset_Handler 最前面就呼叫 SystemInit，比 data/bss 初始化早。
  // GNU 慣例（HT32-IDE 參考）：data copy → bss zero → SystemInit → __libc_init_array。
  // 所以這裡偵測並移除原本的 LDR Rx,=SystemInit + BLX Rx，稍後在正確位置重新插入。
  const lines = gnuText.split('\n');
  const filtered: string[] = [];
  let hadSystemInit = false;
  let skipNextBLX = false;
  for (const line of lines) {
    const trimmed = line.trim();
    // 移除 label 行
    const labelName = trimmed.replace(/:$/, '');
    if (STACK_HEAP_LABELS.has(labelName)) continue;
    // 偵測 LDR Rx, =SystemInit → 下一行的 BLX 也要移除
    if (/^\s*LDR\s+\w+\s*,\s*=SystemInit\s*(@.*)?$/i.test(line)) {
      hadSystemInit = true;
      skipNextBLX = true;
      continue; // 移除這行
    }
    if (skipNextBLX) {
      skipNextBLX = false;
      if (/^\s*BLX?\s+\w+\s*(@.*)?$/i.test(line)) continue; // 移除配對的 BLX Rx
      filtered.push(line.replace(/\b__initial_sp\b/g, '_estack'));
      continue;
    }
    // 向量表：__initial_sp → _estack
    filtered.push(line.replace(/\b__initial_sp\b/g, '_estack'));
  }

  // ── Step 3: 注入 .data/.bss 初始化 + SystemInit（正確順序）+ __libc_init_array ──
  // 順序比照 HT32-IDE GNU startup：data copy → bss zero → SystemInit → __libc_init_array
  const initCode = [
    '\t.syntax unified',            // 切換 UAL 語法，ADDS 3-operand 才能組譯
    '\t@ Copy .data section from Flash to SRAM',
    '\tLDR\tR1, =_sidata',
    '\tLDR\tR2, =_sdata',
    '\tLDR\tR3, =_edata',
    '\tB\tLoopCopyDataInit',
    'CopyDataInit:',
    '\tLDR\tR0, [R1]',
    '\tADDS\tR1, R1, #4',
    '\tSTR\tR0, [R2]',
    '\tADDS\tR2, R2, #4',
    'LoopCopyDataInit:',
    '\tCMP\tR2, R3',
    '\tBCC\tCopyDataInit',
    '\t@ Zero fill .bss section',
    '\tLDR\tR2, =_sbss',
    '\tLDR\tR4, =_ebss',
    '\tMOVS\tR3, #0',
    '\tB\tLoopFillZerobss',
    'FillZerobss:',
    '\tSTR\tR3, [R2]',
    '\tADDS\tR2, R2, #4',
    'LoopFillZerobss:',
    '\tCMP\tR2, R4',
    '\tBCC\tFillZerobss',
    ...(hadSystemInit ? [
      '\t@ Call the clock system initialization function',
      '\tBL\tSystemInit',
    ] : []),
    '\t@ Call C++ static constructors',
    '\tBL\t__libc_init_array',
  ];

  // ── Step 4: 移除 __MICROLIB 條件 block ─────────────────────────────────
  // 此 block 包含 Keil RTLib 專用的 __user_initial_stackheap，
  // 在 GNU toolchain 中不存在且會參考已移除的 Stack_Mem/Heap_Mem 符號。
  // 支援兩種語法：舊版 keil2gnu 產生 .ifdef/.endif；新版產生 #ifdef/#endif
  // 用計數方式找對應的 #endif，避免 block 內有巢狀 #if 時 regex 非貪婪中途截斷。
  let text = filtered.join('\n');
  {
    const lines = text.split('\n');
    const startIdx = lines.findIndex(l => /^[ \t]*[.#]ifdef\s+__MICROLIB\b/i.test(l));
    if (startIdx >= 0) {
      let depth = 0;
      let endIdx = -1;
      for (let i = startIdx; i < lines.length; i++) {
        const t = lines[i].trim();
        if (/^[.#](ifdef|ifndef|if)\b/i.test(t)) depth++;
        else if (/^[.#]endif\b/i.test(t)) { depth--; if (depth === 0) { endIdx = i; break; } }
      }
      if (endIdx >= 0) {
        lines.splice(startIdx, endIdx - startIdx + 1,
          '\t@ [keil2gnu] Keil __MICROLIB block removed (GNU toolchain uses _estack/_end)');
        text = lines.join('\n');
      }
    }
  }

  // ── Step 5: 注入 .data/.bss 初始化 + __libc_init_array ──────────────────
  const out: string[] = [];
  let injected = false;
  for (const line of text.split('\n')) {
    if (!injected && /LDR\s+\w+\s*,\s*=main\b/.test(line)) {
      out.push(...initCode);
      injected = true;
    }
    out.push(line);
  }
  if (!injected) {
    logWarn('injectStartupInit: "LDR Rx, =main" not found — .data/.bss init not injected');
  }

  // ── Step 6: 在 .text section 的每個 function label 前插入 .type + .thumb_func ──
  // 問題：.thumb_func 只放 $t mapping symbol，不設 STT_FUNC，symbol type 為 NOTYPE。
  // GNU linker 對 R_ARM_ABS32（vector table .word）只在 STT_FUNC 時才自動加 bit 0。
  // 結果：.word Reset_Handler 產生偶數位址，Cortex-M 讀 reset vector 時 T=0 → HardFault。
  // 修正：同時插入 .type label, %function（設 STT_FUNC + st_value bit 0）。
  let inTextSection = false;
  const final: string[] = [];
  for (const line of out) {
    const t = line.trim();
    // 追蹤目前所在的 section
    // .isr_vector 也需要追蹤：Keil AREA RESET 同時含 vector table 和 Reset_Handler 程式碼
    if (t === '.bss' || t === '.data') {
      inTextSection = false;
    } else if (t === '.text' || /^\.section\s+\.text/.test(t)
            || /^\.section\s+\.isr_vector/.test(t)) {
      inTextSection = true;
    }
    // 在 .text/.isr_vector section 中的純 label 行（格式：identifier:）前插入
    // .type 設 STT_FUNC（linker 才會在 .word 引用時加 Thumb bit），
    // .thumb_func 放 $t mapping symbol（正確反組譯）。
    if (inTextSection && /^\w[\w$]*:$/.test(t)) {
      const labelName = t.slice(0, -1); // remove trailing ':'
      final.push(`\t.type\t${labelName}, %function`);
      final.push('\t.thumb_func');
    }
    final.push(line);
  }
  return final.join('\n');
}

/**
 * 從 sources 中找 FWLib 路徑，回傳 startup .s / ht32_op.c 所在的目錄。
 *
 * 標準系列（1xxxx/4xxxx/5xxxx）：
 *   sources 含 library/HT32Fxxxx_Driver/src/*.c
 *   → FWLib root / project_template/IP/Example/GNU_ARM/
 *
 * 49x 系列（490/491/493）：
 *   sources 含 libraries/drivers/src/*.c（不同路徑結構）
 *   → FWLib root / libraries/cmsis/cm4/device_support/startup/gcc/
 *   注意：49x 沒有 project_template/IP/Example/GNU_ARM/；
 *         startup .s 為單一 startup_ht32f4xxxx.s（無數字 suffix），由 keil2gnu() 轉換（Rule 3）；
 *         49x Keil 專案不含 ht32_op.s，Rule 2 不會被觸發。
 *
 * 找不到時 throw，因為缺少 FWLib 的話編譯本來就無法進行。
 */

/**
 * Given an FWLib root, returns the bundled templates GNU_ARM dir path for the matching
 * STD series by scanning library/HT32*_Driver.
 * Returns undefined if family cannot be determined or extPath is falsy.
 */
export function bundledGnuDirFromFwlRoot(fwlRoot: string, extPath: string): string | undefined {
  try {
    for (const e of fs.readdirSync(path.join(fwlRoot, 'library'))) {
      // HT32F5xxxx_Driver → m[1]='F5', m[2]='5' is embedded → familyTag 'f5xxxx'
      // HT32L5xxxx_Driver → familyTag 'l5xxxx'; future HT32E5xxxx_Driver → 'e5xxxx'
      const m = /^HT32([A-Za-z]+\d)xxxx_/i.exec(e);
      if (m) return path.join(extPath, 'templates', `${m[1].toLowerCase()}xxxx`, 'GNU_ARM');
    }
  } catch { /* FWLib has no library/ or unreadable */ }
  return undefined;
}

/**
 * 判斷 MCU 型號是否為 49x 系列（HT32F49xxx）。
 * 所有需要區分 49x / STD 的地方都應呼叫此函式，不可再用路徑特徵判斷。
 */
export function is49xDevice(name: string): boolean {
  return /^HT32[A-Za-z]+49/i.test(name.replace(/[_\s].*/, ''));
}

/**
 * 從任意 FWLib source/include 絕對路徑反推 FWLib 根目錄。
 * 兩個系列的 FWLib 共用此函式：
 *   STD：{fwlRoot}/library/HT32Fxxxx_Driver/src/xxx.c  → 匹配 /library/
 *   49x：{fwlRoot}/libraries/drivers/src/xxx.c          → 匹配 /libraries/
 *        {fwlRoot}/utilities/common/yyy.c                → 匹配 /utilities/
 * 回傳 fwlRoot 字串，找不到時回傳 undefined。
 */
export function fwlRootFromSourcePath(absPath: string): string | undefined {
  const m = /^(.*?)(?:[/\\])(?:library|libraries|utilities)[/\\]/i.exec(absPath);
  return m ? m[1] : undefined;
}

/**
 * 從 FWLib root 取得 49x GCC startup 目錄（存在時才回傳）。
 *   {fwlRoot}/libraries/cmsis/cm4/device_support/startup/gcc/
 */
export function find49xGccDir(fwlRoot: string): string | undefined {
  const d = path.join(fwlRoot, 'libraries', 'cmsis', 'cm4', 'device_support', 'startup', 'gcc');
  return fs.existsSync(d) ? d : undefined;
}

/**
 * 從 resolveGnuArmDir() 的回傳值反推 FWLib 根目錄。
 * STD：{FWLib}/project_template/IP/Example/GNU_ARM/ → 上 4 層
 * 49x：{FWLib}/libraries/cmsis/cm4/device_support/startup/gcc/ → 上 6 層
 */
export function fwlRootFromTemplate(gnuArmTemplate: string): string {
  const t = gnuArmTemplate.replace(/[/\\]+$/, '');
  const base = path.basename(t).toLowerCase();
  let p = t;
  const levels = base === 'gcc' ? 6 : 4;
  for (let i = 0; i < levels; i++) p = path.dirname(p);
  return p;
}

function resolveGnuArmDir(
  sources:  string[],
  projDir:  string,
  mcu:      string | undefined,
  extPath:  string | undefined
): string | undefined {
  // 49x 系列：以 MCU 型號判斷（HT32F49x），不依賴特定原始碼目錄是否存在。
  // FWLib root 從任何 libraries/ 或 utilities/ 路徑反推（共用 fwlRootFromSourcePath）。
  if (mcu && is49xDevice(mcu)) {
    for (const s of sources) {
      const abs     = path.isAbsolute(s) ? s : path.resolve(projDir, s);
      const fwlRoot = fwlRootFromSourcePath(abs);
      if (!fwlRoot) continue;
      const gccDir  = find49xGccDir(fwlRoot);
      if (gccDir) {
        logInfo(`resolveGnuArmDir: 49x (MCU=${mcu}) FWLib gcc dir at ${gccDir}`);
        return gccDir;
      }
    }
    logInfo(`resolveGnuArmDir: 49x MCU detected but no libraries/utilities source found`);
    return undefined;
  }

  // 標準系列：library/HT32Fxxxx_Driver/src/
  for (const s of sources) {
    if (!/library[/\\]HT32\w+_Driver[/\\]src[/\\]/i.test(s)) continue;
    const abs     = path.isAbsolute(s) ? s : path.resolve(projDir, s);
    const fwlRoot = fwlRootFromSourcePath(abs);
    if (!fwlRoot) continue;
    const gnuDir  = path.join(fwlRoot, 'project_template', 'IP', 'Example', 'GNU_ARM');
    if (fs.existsSync(gnuDir)) {
      logInfo(`resolveGnuArmDir: std FWLib GNU_ARM at ${gnuDir}`);
      return gnuDir;
    }
    // FWLib root 找到但無 project_template/ → fallback 到 bundled templates
    if (extPath) {
      const bundled = bundledGnuDirFromFwlRoot(fwlRoot, extPath);
      if (bundled && fs.existsSync(bundled)) {
        logInfo(`resolveGnuArmDir: std FWLib has no project_template/, using bundled ${bundled}`);
        return bundled;
      }
    }
  }

  // Fallback：MCU 未知時仍用路徑識別 49x（libraries/drivers/src/ 存在）
  for (const s of sources) {
    const abs     = path.isAbsolute(s) ? s : path.resolve(projDir, s);
    if (!/libraries[/\\]drivers[/\\]src[/\\]/i.test(abs)) continue;
    const fwlRoot = fwlRootFromSourcePath(abs);
    if (!fwlRoot) continue;
    const gccDir  = find49xGccDir(fwlRoot);
    if (gccDir) {
      logInfo(`resolveGnuArmDir: 49x (path-based fallback) FWLib gcc dir at ${gccDir}`);
      return gccDir;
    }
  }

  return undefined;
}

/** Derives bundled GNU_ARM dir from a GCC startup name (e.g. startup_ht32f5xxxx_gcc_01.s → templates/f5xxxx/GNU_ARM). */
function bundledGnuDirFromStartupName(gccName: string, extPath: string): string | undefined {
  // Extract familyTag directly: 'startup_ht32f5xxxx_gcc_01' → capture 'f5xxxx'
  // [a-z]+\d handles any letter prefix (f/l/e/…), not just f and l
  const m = /^startup_ht32([a-z]+\dxxxx)_gcc/i.exec(gccName);
  return m ? path.join(extPath, 'templates', m[1].toLowerCase(), 'GNU_ARM') : undefined;
}

function handleKeilAsm(
  relPath: string,
  projectRoot: string,
  templateRoot: string | undefined,
  buildGenRoot: string,
  gnuArmRoot?: string,   // 新版: .s 寫到 GNU_ARM/；未提供時 fallback 到 buildGenRoot
  extPath?: string       // extension root for bundled template fallback
): string | null {
  const normRel = relPath.replace(/\\/g, '/');
  const base    = path.basename(normRel).toLowerCase();
  const keilAbs = path.join(projectRoot, normRel);
  // .s 輸出目錄: 新版用 GNU_ARM/，舊版 fallback 到 build-gen/
  const gnuRoot = gnuArmRoot ?? buildGenRoot;

  // 規則 1: startup_xxxxxxxx_nn[_suffix].s
  //   → 優先用 template 的 GCC 版（已驗證 + Stack/Heap sync）
  //   → 找不到 template 時 fallback 到 keil2gnu()
  const startupMatch = /^startup_(.+)_(\d+)(_\w+)?\.s$/i.exec(base);
  if (startupMatch) {
    const chipPart  = startupMatch[1];
    const indexPart = startupMatch[2];
    const suffix    = startupMatch[3] || '';                // e.g. '_iap' or ''
    const gccName   = `startup_${chipPart}_gcc_${indexPart}${suffix}.s`;
    const gccNameFb = `startup_${chipPart}_gcc_${indexPart}.s`; // fallback（去掉 suffix）

    const gccSrc   = templateRoot ? path.join(templateRoot, gccName)   : '';
    const gccSrcFb = templateRoot ? path.join(templateRoot, gccNameFb) : '';
    const gccDst   = path.join(gnuRoot, gccName);

    fs.mkdirSync(gnuRoot, { recursive: true });

    // 優先用 FWLib template；找不到時 fallback 到 bundled template；最後才 keil2gnu()
    const bundledDir  = extPath ? bundledGnuDirFromStartupName(gccName, extPath) : undefined;
    const templateSrc =
      (gccSrc   && fs.existsSync(gccSrc))                          ? gccSrc   :
      (gccSrcFb && fs.existsSync(gccSrcFb) && suffix)              ? gccSrcFb :
      (bundledDir && fs.existsSync(path.join(bundledDir, gccName))) ? path.join(bundledDir, gccName) :
      (bundledDir && fs.existsSync(path.join(bundledDir, gccNameFb)) && suffix) ? path.join(bundledDir, gccNameFb) :
      null;

    if (templateSrc) {
      // Template 存在：用 syncStackHeap 複製並同步 Keil 的 Stack/Heap 大小
      if (fs.existsSync(keilAbs)) {
        patchStartupFromKeil(keilAbs, templateSrc, gccDst, gnuRoot);
        logInfo(`handleKeilAsm: template ${path.basename(templateSrc)} + syncStackHeap from ${base}`);
      } else {
        fs.copyFileSync(templateSrc, gccDst);
        logInfo(`handleKeilAsm: template ${path.basename(templateSrc)} (no Keil source)`);
      }
    } else if (fs.existsSync(keilAbs)) {
      // Fallback：找不到對應 template，才退回 keil2gnu() 轉換
      logInfo(`handleKeilAsm: keil2gnu() ${base} (no template available)`);
      let converted = injectStartupInit(
        keil2gnu(fs.readFileSync(keilAbs, 'utf8'), path.dirname(keilAbs), gnuRoot)
      );
      fs.writeFileSync(gccDst, converted, 'utf8');
    } else {
      throw new Error(`Startup file not found: ${keilAbs} — no matching template either`);
    }

    return path.relative(projectRoot, gccDst).replace(/\\/g, '/');
  }

  // 規則 2: ht32_op*.s → 同名 .c（template，C file → 放 GNU_ARM/）
  if (/^ht32_op.*\.s$/i.test(base)) {
    const cName = base.replace(/\.s$/i, '.c');
    if (!templateRoot) { logWarn(`handleKeilAsm: ${base} skipped — no templateRoot`); return null; }
    const src = path.join(templateRoot, cName);
    const dst = path.join(gnuRoot, cName);
    let effectiveSrc: string | undefined = fs.existsSync(src) ? src : undefined;
    if (!effectiveSrc && extPath) {
      // templateRoot = {FWLib}/project_template/IP/Example/GNU_ARM → fwlRoot is 4 levels up
      const fwlRoot = path.resolve(templateRoot, '..', '..', '..', '..');
      const bundledDir = bundledGnuDirFromFwlRoot(fwlRoot, extPath);
      const cand = bundledDir ? path.join(bundledDir, cName) : undefined;
      if (cand && fs.existsSync(cand)) { effectiveSrc = cand; logInfo(`handleKeilAsm: ${cName} from bundled templates (FWLib missing)`); }
    }
    if (!effectiveSrc) throw new Error(`${cName} template not found: ${src}`);
    fs.mkdirSync(gnuRoot, { recursive: true });
    fs.copyFileSync(effectiveSrc, dst);
    return path.relative(projectRoot, dst).replace(/\\/g, '/');
  }

  // 規則 3: 其他 .s（含沒有數字 suffix 的 startup_xxx.s，e.g. 49x 的 startup_ht32f491x3.s）
  if (fs.existsSync(keilAbs)) {
    fs.mkdirSync(gnuRoot, { recursive: true });

    // 49x FWLib gcc/ 目錄直接提供同名 GCC startup，lib 有提供就直接用，不走 keil2gnu
    // 也嘗試 startup_NAME_gcc.S（49x 命名慣例：無數字 suffix + _gcc.S）
    if (/^startup_/i.test(base) && templateRoot) {
      const sameNameSrc  = path.join(templateRoot, base);
      const gccVariant   = path.join(templateRoot, path.basename(base, '.s') + '_gcc.S');
      const libSrc = fs.existsSync(sameNameSrc) ? sameNameSrc
                   : fs.existsSync(gccVariant)  ? gccVariant
                   : null;
      if (libSrc) {
        const gccDst = path.join(gnuRoot, path.basename(libSrc));
        patchStartupFromKeil(keilAbs, libSrc, gccDst, gnuRoot);
        logInfo(`handleKeilAsm: FWLib GCC startup ${path.basename(libSrc)} + syncStackHeap`);
        return path.relative(projectRoot, gccDst).replace(/\\/g, '/');
      }
    }

    const gccName = path.basename(normRel, '.s') + '_gcc.s';
    const gccDst  = path.join(gnuRoot, gccName);
    logInfo(`handleKeilAsm: keil2gnu() ${base} → ${gccName}`);
    // Keil armasm resolves INCBIN/INCLUDE paths relative to the source file's own directory.
    // GAS .incbin is relative to make CWD (Project_xxx/); since GNU_ARM/ and Project_xxx/ are
    // sibling directories at the same depth, path.relative(gnuRoot, binAbs) produces a path
    // that is equally valid from the make CWD. Pass the .s file's directory as srcDir so that
    // INCBIN paths (e.g. images\Loader.bin next to maker.s) resolve to the correct absolute path.
    let converted = keil2gnu(fs.readFileSync(keilAbs, 'utf8'), path.dirname(keilAbs), gnuRoot);
    // startup_xxx.s（無數字 suffix）同樣需要注入 .data/.bss 初始化
    if (/^startup_/i.test(base)) {
      converted = injectStartupInit(converted);
    }
    fs.writeFileSync(gccDst, converted, 'utf8');
    return path.relative(projectRoot, gccDst).replace(/\\/g, '/');
  }

  logWarn(`handleKeilAsm: ${keilAbs} not found — skipped`);
  return null;
}

function extractFromMiscControls(mc: string) {
  const incs: string[] = [];
  const defs: string[] = [];
  const incRe = /(^|\s)-I\s*"?([^"\s]+)"?/g;
  const defRe = /(^|\s)-D\s*"?([^"\s]+)"?/g;
  let m: RegExpExecArray | null;
  while ((m = incRe.exec(mc)) !== null) incs.push(m[2]);
  while ((m = defRe.exec(mc)) !== null) defs.push(m[2]);
  return { incs, defs };
}

// 遞迴收集任意層級的 <IncludePath> 或 <Define>
function collectAll(node: any, tag: "IncludePath" | "Define", out: string[] = []): string[] {
  if (!node || typeof node !== "object") return out;
  for (const [k, v] of Object.entries(node)) {
    if (k === tag && typeof v === "string") out.push(v);
    else if (v && typeof v === "object") collectAll(v, tag, out);
  }
  return out;
}

function readUvprojx(file: string): any {
  let xml = fs.readFileSync(file, "utf8");
  // Fix Holtek proprietary empty tag that Keil writes without proper XML self-closing syntax.
  // <HTGSARCONT> (no closing tag) causes fast-xml-parser to nest all subsequent <Group> elements
  // as children of the first Group instead of siblings, breaking group parsing entirely.
  xml = xml.replace(/<HTGSARCONT>/g, '<HTGSARCONT/>');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
  return parser.parse(xml);
}

/**
 * 從 .uvprojx 解析 CPU / FPU / float-abi
 * 目前以第一個 <Target> 為主，之後需要可以再擴充 target 選擇邏輯
 */
function extractToolchainFromUvproj(doc: any): {
  mcu: string;
  fpu?: string;
  floatAbi?: "soft" | "softfp" | "hard";
} {
  const t = doc?.Project?.Targets?.Target;
  const targets = Array.isArray(t) ? t : [t];
  const first = targets[0];

  // ---- 正確抓 Cpu 的位置：TargetOption.TargetCommonOption.Cpu ----
  const targetOption = first?.TargetOption;
  const commonOpt = Array.isArray(targetOption?.TargetCommonOption)
    ? targetOption.TargetCommonOption[0]
    : targetOption?.TargetCommonOption;

  const cpuRaw: string | undefined = commonOpt?.Cpu;

  let mcu: string = "cortex-m0plus";  // 安全預設
  let fpu: string | undefined;
  let floatAbi: "soft" | "softfp" | "hard" | undefined;

  if (cpuRaw) {
    const upper = cpuRaw.toUpperCase();

    // 你的 Project_0006.uvprojx 寫的是 CPUTYPE("Cortex-M0+")
    if (upper.includes('CORTEX-M0+')) {
      mcu = 'cortex-m0plus';
      floatAbi = 'soft';          // M0+ 沒有 FPU
    } else if (upper.includes('CORTEX-M0')) {
      mcu = 'cortex-m0';
      floatAbi = 'soft';
    } else if (upper.includes('CORTEX-M3')) {
      mcu = 'cortex-m3';
      floatAbi = 'soft';
    } else if (upper.includes('CORTEX-M4')) {
      mcu = 'cortex-m4';
      if (upper.includes('FPU2')) {
        fpu = 'fpv4-sp-d16';
        floatAbi = 'hard';
      } else {
        floatAbi = 'soft';
      }
    } else if (upper.includes('CORTEX-M7')) {
      mcu = 'cortex-m7';
      if (upper.includes('FPU3')) {
        fpu = 'fpv5-d16';
        floatAbi = 'hard';
      } else if (upper.includes('FPU2')) {
        fpu = 'fpv5-sp-d16';
        floatAbi = 'hard';
      } else {
        floatAbi = 'soft';
      }
    }
  }

  return { mcu, fpu, floatAbi };
}

function extractDeviceNameFromUvproj(doc: any): string | undefined {
  const t = doc?.Project?.Targets?.Target;
  const targets = Array.isArray(t) ? t : [t];
  const first = targets[0];

  // Keil 常見位置：<Project><Targets><Target><TargetOption><Device>HT32F52352</Device>
  const dev =
    first?.TargetOption?.Device ??
    first?.TargetOption?.TargetCommonOption?.Device;

  if (typeof dev === 'string' && dev.trim()) {
    return dev.trim();
  }
  return undefined;
}

function extractRomRamFromUvproj(first: any, extPath?: string, extraPdscPaths?: string[]): {
  romOrigin?: string;
  romLength?: string;
  ramOrigin?: string;
  ramLength?: string;
} {
  const toHex = (v: any): string | undefined => {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return "0x" + v.toString(16);
    return undefined;
  };

  let romOrigin: string | undefined;
  let romLength: string | undefined;
  let ramOrigin: string | undefined;
  let ramLength: string | undefined;

  const isZeroSize = (v: string | undefined) => !v || parseInt(v, 16) === 0;

  // 1) <TargetCommonOption><Cpu> string — two formats used by different Keil versions:
  //    comma: "IRAM(0x20000000,0x4000) IROM(0x00000000,0x1FC00)"  → (origin, size)
  //    dash:  "IROM(0x00000000-0x0000FFFF) IRAM(0x20000000-0x20001FFF)" → (start-end)
  //    Most reliable — always present in Keil projects, directly reflects the project setting.
  const cpuStr: string | undefined = first?.TargetOption?.TargetCommonOption?.Cpu;
  if (typeof cpuStr === 'string') {
    // comma format: IRAM(start, size)
    const iramM = /\bIRAM\(\s*([^,)\s]+)\s*,\s*([^,)\s]+)\s*\)/i.exec(cpuStr);
    const iromM = /\bIROM\(\s*([^,)\s]+)\s*,\s*([^,)\s]+)\s*\)/i.exec(cpuStr);
    if (iramM) { ramOrigin = iramM[1]; ramLength = iramM[2]; }
    if (iromM) { romOrigin = iromM[1]; romLength = iromM[2]; }
    // dash format: IRAM(start-end) — compute size from end-start+1
    if (!iramM) {
      const m = /\bIRAM\(\s*(0x[0-9a-f]+)\s*-\s*(0x[0-9a-f]+)\s*\)/i.exec(cpuStr);
      if (m) { ramOrigin = m[1]; ramLength = '0x' + (parseInt(m[2], 16) - parseInt(m[1], 16) + 1).toString(16); }
    }
    if (!iromM) {
      const m = /\bIROM\(\s*(0x[0-9a-f]+)\s*-\s*(0x[0-9a-f]+)\s*\)/i.exec(cpuStr);
      if (m) { romOrigin = m[1]; romLength = '0x' + (parseInt(m[2], 16) - parseInt(m[1], 16) + 1).toString(16); }
    }
  }

  // 2) <OnChipMemories> — covers projects where Cpu string is absent
  //    Skip size=0x0 values (project deliberately left blank); let PDSC fill them in step 3.
  if (!ramOrigin || isZeroSize(ramLength) || !romOrigin || isZeroSize(romLength)) {
    const mem = first?.TargetOption?.TargetArmAds?.OnChipMemories;
    if (mem) {
      const irom1 = mem.IROM1 || mem.IROM || mem.ROM || mem.ROM1;
      const iram1 = mem.IRAM1 || mem.IRAM || mem.RAM || mem.RAM1;
      if (irom1 && (!romOrigin || isZeroSize(romLength))) {
        const o = toHex(irom1.StartAddress ?? irom1.Start ?? irom1.Base);
        const l = toHex(irom1.Size);
        if (o && !isZeroSize(l)) { romOrigin = o; romLength = l; }
      }
      if (iram1 && (!ramOrigin || isZeroSize(ramLength))) {
        const o = toHex(iram1.StartAddress ?? iram1.Start ?? iram1.Base);
        const l = toHex(iram1.Size);
        if (o && !isZeroSize(l)) { ramOrigin = o; ramLength = l; }
      }
    }
  }

  // 3) Bundled PDSC lookup — authoritative device database, last resort
  if ((!ramOrigin || isZeroSize(ramLength) || !romOrigin || isZeroSize(romLength)) && extPath) {
    const deviceName: string | undefined =
      first?.TargetOption?.TargetCommonOption?.Device ??
      first?.TargetOption?.Device;
    if (deviceName) {
      const escaped  = deviceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const devRe    = new RegExp(`<device\\s+Dname="${escaped}[^"]*"[^>]*>([\\s\\S]*?)</device>`, 'i');
      const familyRe = new RegExp(`<subFamily\\s+DsubFamily="${escaped}[^"]*"[^>]*>([\\s\\S]*?)</subFamily>`, 'i');
      for (const pdscPath of getAllPdscPaths(extPath, extraPdscPaths)) {
        try {
          const pdsc  = fs.readFileSync(pdscPath, 'utf8');
          const block = devRe.exec(pdsc)?.[1] ?? familyRe.exec(pdsc)?.[1];
          if (!block) continue;
          if (!romOrigin || isZeroSize(romLength)) {
            const rom = /<memory[^>]+id="IROM1"[^>]*start="([^"]+)"[^>]*size="([^"]+)"/i.exec(block);
            if (rom) { romOrigin = rom[1]; romLength = rom[2]; }
          }
          if (!ramOrigin || isZeroSize(ramLength)) {
            const ram = /<memory[^>]+(?:id|name)="IRAM1"[^>]*start="([^"]+)"[^>]*size="([^"]+)"/i.exec(block);
            if (ram) { ramOrigin = ram[1]; ramLength = ram[2]; }
          }
          break; // found in this PDSC, stop searching
        } catch { /* PDSC not readable, try next */ }
      }
    }
  }

  // 4) <LDads><DataAddressRange> — Keil reserves bytes at the start of RAM for shared variables
  //    (e.g. IAP projects leave 0x10 bytes at 0x20000000 for BOOT_MODE/IAP_RESULT).
  //    Only applied when there is no scatter file (scatter files encode this directly).
  const scatterFile: string = first?.TargetOption?.TargetArmAds?.LDads?.ScatterFile ?? '';
  if (!scatterFile.trim()) {
    const dataAddrRaw = first?.TargetOption?.TargetArmAds?.LDads?.DataAddressRange;
    if (dataAddrRaw !== undefined && dataAddrRaw !== null && dataAddrRaw !== '') {
      const dataStart = Number(dataAddrRaw);   // works for both hex-string "0x20000010" and number
      const ramStart  = ramOrigin ? parseInt(ramOrigin, 16) : undefined;
      const ramLen    = ramLength ? parseInt(ramLength, 16) : undefined;
      if (dataStart > 0 && ramStart !== undefined && dataStart > ramStart) {
        const reserved = dataStart - ramStart;
        ramOrigin = '0x' + dataStart.toString(16);
        if (ramLen !== undefined) {
          ramLength = '0x' + (ramLen - reserved).toString(16);
        }
        logInfo(`extractRomRam: DataAddressRange=${toHex(dataAddrRaw)} → RAM ORIGIN adjusted from 0x${ramStart.toString(16)} to ${ramOrigin} (reserved ${reserved} bytes)`);
      }
    }
  }

  return { romOrigin, romLength, ramOrigin, ramLength };
}

function extractOcrRvctMap(firstTarget: any): Map<number, FileRomOption> {
  const map = new Map<number, FileRomOption>();
  const ocm = firstTarget?.TargetOption?.TargetArmAds?.ArmAdsMisc?.OnChipMemories;
  if (!ocm) return map;
  for (let i = 1; i <= 10; i++) {
    const entry = ocm[`OCR_RVCT${i}`];
    if (!entry) continue;
    const origin = String(entry.StartAddress ?? '0x0');
    const length = String(entry.Size ?? '0x0');
    const lengthNum = length.startsWith('0x') || length.startsWith('0X')
      ? parseInt(length, 16) : parseInt(length, 10);
    if (origin === '0x0' || isNaN(lengthNum) || lengthNum === 0) continue;
    map.set(i, { origin, length });
  }
  return map;
}

function extractProjectInfo(doc: any, projDir: string, fallbackName: string, buildGenRoot: string, extPath?: string, gnuArmRoot?: string): Extracted {
  const projectName =
    doc?.Project?.TargetCommonOption?.CommonProperty?.ProjectName ??
    doc?.Project?.Information?.Name ??
    fallbackName;

  const t = doc.Project?.Targets?.Target;
  const targets = Array.isArray(t) ? t : [t];
  const first = targets[0];

  // Prefer <OutputName> (Keil's actual output filename) over <TargetName> (tree label)
  const targetName = first?.TargetOption?.TargetCommonOption?.OutputName
                  ?? first?.TargetName
                  ?? "app";
  const memInfo = extractRomRamFromUvproj(first, extPath);

  // ===== sources & groups =====
  const groupsNode = first?.Groups?.Group || [];
  const gArray = Array.isArray(groupsNode) ? groupsNode : [groupsNode];

  const sources: string[] = [];
  const groups: Record<string, string[]> = {};
  const prebuiltWarnings: string[] = [];

  const toolsetName: string = first?.ToolsetName ?? '';
  const isArmGnu = toolsetName === 'ARM-GNU';

  const { mcu: detectedMcu } = extractToolchainFromUvproj(doc);
  // extractToolchainFromUvproj 回傳 CPU 架構（'cortex-m4'），不是 MCU 型號。
  // resolveGnuArmDir 需要 MCU 型號（'HT32F49395'）才能正確判斷 49x 系列。
  const detectedDeviceName = extractDeviceNameFromUvproj(doc);

  // sources loop 尚未執行，先從 XML 預掃路徑以找到 FWLib GNU_ARM 目錄
  // templateRoot 優先讀 FWLib 的 project_template/IP/Example/GNU_ARM/，
  // 找不到才 fallback 到 bundled M0/M3_GNU_ARM（支援 M4 無需另建 bundled 目錄）
  const rawFilePaths = gArray.flatMap(g => {
    const files = g?.Files?.File || [];
    return (Array.isArray(files) ? files : [files]).map((f: any) => f?.FilePath || f?.FileName || '');
  });
  const templateRoot = resolveGnuArmDir(rawFilePaths, projDir, detectedDeviceName, extPath);
  const ocrRvctMap = extractOcrRvctMap(first);
  const fileOptionsMap: Record<string, FileOption> = {};

  for (const g of gArray) {
    const gName: string = g?.GroupName || "Ungrouped";
    const files = g?.Files?.File || [];
    const fArray = Array.isArray(files) ? files : [files];

    for (const f of fArray) {
      const name = f?.FilePath || f?.FileName;
      if (!name) continue;

      const abs = path.isAbsolute(name) ? name : path.join(projDir, name);
      const rel = normalize(path.relative(projDir, abs));

      // ★ 偵測 Keil 預編譯二進位（.o/.lib/.a）— GNU toolchain 無法使用
      const ext = path.extname(rel).toLowerCase();
      if (ext === '.o' || ext === '.lib' || ext === '.a') {
        logWarn(`Prebuilt binary skipped (Keil-compiled, not usable by GNU toolchain): ${rel}`);
        prebuiltWarnings.push(abs);  // 存絕對路徑，供 DiagnosticCollection 使用
        continue;
      }
      // Keil linker scripts / configuration files — not source, skip entirely
      if (ext === '.lin' || ext === '.sct' || ext === '.ini') continue;

      let finalRel = rel;

      if (ext === ".s") {
        if (isArmGnu && gnuArmRoot) {
          // ARM-GNU 專案的 startup 已是 GCC 格式，直接複製到 GNU_ARM/，不過 keil2gnu
          ensureDir(gnuArmRoot);
          const destAbs = path.join(gnuArmRoot, path.basename(abs));
          fs.copyFileSync(abs, destAbs);
          finalRel = normalize(path.relative(buildGenRoot, destAbs));
        } else {
          // FWLib GNU_ARM template → GNU_ARM/；找不到時 fallback 到 bundled templates/{familyTag}/GNU_ARM/
          const replaced = handleKeilAsm(rel, projDir, templateRoot, buildGenRoot, gnuArmRoot, extPath);
          if (replaced) {
            finalRel = replaced;
          }
        }
      }

      // FreeRTOS RVDS port.c → GCC port.c（與下方 include path 替換對稱）
      if (ext === '.c') {
        finalRel = finalRel.replace(
          /(portable)[/\\](rvds)[/\\](ARM_CM\w+)/i,
          (_, p, __, arch) => `${p}/GCC/${arch}`
        );
      }

      // ── Per-file options (IncludeInBuild / useXO / RVCTCodeConst) ──────────
      const commonProp    = f?.FileOption?.CommonProperty;
      const fileCads      = f?.FileOption?.FileArmAds?.Cads;
      const includeInBuild = Number(commonProp?.IncludeInBuild ?? 2);
      const useXO         = Number(fileCads?.useXO ?? 2);
      const rvctCodeConst = Number(commonProp?.RVCTCodeConst ?? 0);

      const isExcluded = includeInBuild === 0;
      const isXO       = useXO === 1;
      // Index 4 = IROM1 (primary flash, same as default); 0 = no override
      const romRegion  = (rvctCodeConst > 0 && rvctCodeConst !== 4)
                         ? ocrRvctMap.get(rvctCodeConst) : undefined;

      const fo: FileOption = {};
      if (isExcluded) fo.exclude = true;
      if (isXO)       fo.xo = true;
      if (romRegion)  fo.rom = romRegion;
      if (Object.keys(fo).length) fileOptionsMap[finalRel] = fo;

      // ★ groups always includes all files (for UI display);
      //   sources skips excluded files (not compiled)
      if (!isExcluded) sources.push(finalRel);
      (groups[gName] ||= []).push(finalRel);
    }
    
  }

  // ===== include / define / misc =====
  const includePathStrings = collectAll(first || {}, "IncludePath");
  const cDefStrings = collectAll(first?.TargetOption?.TargetArmAds?.Cads ?? {}, "Define");
  const aDefStrings = collectAll(first?.TargetOption?.TargetArmAds?.Aads ?? {}, "Define");
  const defineStrings = cDefStrings;

  const miscControls: string =
    first?.TargetOption?.TargetArmAds?.Cads?.MiscControls ??
    first?.TargetOption?.TargetArmAds?.Aads?.MiscControls ?? "";
  const extra = extractFromMiscControls(miscControls);

  // Includes：展開所有 IncludePath（; 分隔）+ 併入 MiscControls 的 -I
  const includes: string[] = [];
  for (const s of includePathStrings) {
    s.split(";").forEach((seg: string) => {
      const v = seg.trim();
      if (!v) return;
      includes.push(resolveRel(projDir, v));
    });
  }
  for (const i of extra.incs) includes.push(resolveRel(projDir, i));

  // FreeRTOS RVDS port → GCC port（source 路徑已在 sources loop 中處理）：
  // portmacro.h 含 ARMCC 專屬語法（__forceinline / __asm msr…），GCC 無法解析，
  // 故 include path 也須同步替換 portable/rvds/ARM_CMxx → portable/GCC/ARM_CMxx。
  for (let i = 0; i < includes.length; i++) {
    includes[i] = includes[i].replace(
      /(portable)[/\\](rvds)[/\\](ARM_CM\w+)/i,
      (_, p, __, arch) => `${p}/GCC/${arch}`
    );
  }

  // Defines：展開所有 Define + 併入 MiscControls 的 -D
  const defines: string[] = [];
  for (const ds of defineStrings) {
    ds.split(/[,; ]+/).forEach((d: string) => {
      const v = d.trim();
      if (!v) return;
      defines.push(v);
    });
  }
  for (const d of extra.defs) defines.push(d);

  // ASM-only defines (Aads.Define not already in C defines)
  const cDefSet = new Set(defines);
  const asmDefines: string[] = [];
  for (const ds of aDefStrings) {
    ds.split(/[,; ]+/).forEach((d: string) => {
      const v = d.trim();
      if (!v || cDefSet.has(v)) return;
      asmDefines.push(v);
    });
  }

  // ===== scatter =====
  const scatterRaw: string | undefined =
    first?.TargetOption?.TargetArmAds?.Linker?.ScatterFile ??
    first?.TargetOption?.TargetArmAds?.LDads?.ScatterFile ??   // HT32F49x / M4 系列用 LDads（大寫 D）
    first?.TargetOption?.TargetArmAds?.Ldads?.ScatterFile ??   // 其他系列備用
    undefined;
  const scatter = scatterRaw ? resolveRel(projDir, scatterRaw) : undefined;

  // ===== --symdefs detection (L0 of FLASH Partial Lock) =====
  const ldMisc: string =
    first?.TargetOption?.TargetArmAds?.LDads?.Misc ??
    first?.TargetOption?.TargetArmAds?.Ldads?.Misc ?? '';
  const symdefsMatch = ldMisc.match(/--symdefs=(\S+)/);
  const symdefsOutputFile = symdefsMatch ? symdefsMatch[1] : undefined;

  // CreateLib=1 → 產出靜態函式庫 (.a)
  const createLib = first?.TargetOption?.TargetCommonOption?.CreateLib;
  const isLibrary = createLib === 1 || createLib === '1';

  return {
    projectName,
    targetName,
    sources: uniq(sources),
    includes: uniq(includes),
    defines: uniq(defines),
    ...(asmDefines.length ? { asmDefines: uniq(asmDefines) } : {}),
    scatter,
    isLibrary,
    ...(isArmGnu ? { isArmGnu: true } : {}),
    groups,
    ...(Object.keys(fileOptionsMap).length ? { fileOptions: fileOptionsMap } : {}),
    ...memInfo,
    prebuiltWarnings: prebuiltWarnings.length ? prebuiltWarnings : undefined,
    gnuArmTemplate: templateRoot,
    fwlibRoot: templateRoot ? fwlRootFromTemplate(templateRoot) : undefined,
    ...(symdefsOutputFile ? { symdefsOutputFile } : {}),
  };
}

function writeLists(outDir: string, info: Extracted) {
  const dir2 = path.basename(outDir);
  logInfo(`Write → ${dir2}/sources.list, ${dir2}/includes.list, ${dir2}/defines.list, ${dir2}/adefines.list`);
  fs.writeFileSync(path.join(outDir, "sources.list"), info.sources.join("\n"));
  writeProjectLists(outDir, {
    includes: ['-I../GNU_ARM', ...info.includes.map(i => `-I"${i}"`)].join(" "),
    defines:  info.defines.map(d => `-D${d}`).join(" "),
    adefines: (info.asmDefines ?? []).map(d => `-D${d}`).join(" "),
  });
}

function guessLinkerFlags(linkerScripts: string[] = ['../GNU_ARM/linker.ld']): string {
  const tFlags = linkerScripts.map(s => `-T "${s}"`).join(' ');
  return `-Wl,--gc-sections,--print-memory-usage$(LD_NO_WARN),-Map,$(BUILD)/$(TARGET).map ${tFlags}`;
}

/**
 * 搜尋 include 目錄（以 outDirAbs 為基準）和 projDir，
 * 找到第一個符合 ht32f*_conf.h 命名格式的檔案，回傳絕對路徑。
 */
/**
 * Search include paths for a device header (ht32*.h, excluding *_conf* and *_template*)
 * that defines __FPU_PRESENT. Returns true/false, or undefined if not found.
 * Used to cross-check uvprojx FPU2 flag against actual hardware capability.
 */
/**
 * 掃描 include paths，找到 device header（ht32*.h，排除 _conf/_template），
 * 讀取 __FPU_PRESENT 定義值，作為 FPU 使用的權威依據。
 *
 * @param includes  include 路徑陣列，可為 absolute 或相對於 baseDir 的路徑
 * @param baseDir   相對路徑的基準目錄（若 includes 已是 absolute 可傳 ''）
 * @returns true=有 FPU, false=無 FPU, undefined=找不到 device header
 *
 * 設計目的：統一 uv2make / ht32ide2make / createProject 三條路徑的 FPU 判斷，
 * 避免 uvprojx FPU2 欄位或 .cproject fpu.abi 欄位與實際硬體能力不符。
 */
export function detectFpuPresentFromHeader(includes: string[], baseDir: string): boolean | undefined {
  const deviceHeaderRe = /^ht32[^.]*\.h$/i;
  const excludeRe = /_conf|_template/i;
  const fpuPresentRe = /__FPU_PRESENT\s+(\d+)/;
  for (const inc of includes) {
    const incAbs = path.isAbsolute(inc) ? inc : path.resolve(baseDir, inc);
    if (!fs.existsSync(incAbs)) { continue; }
    try {
      const files = fs.readdirSync(incAbs).filter(f => deviceHeaderRe.test(f) && !excludeRe.test(f));
      for (const file of files) {
        const content = fs.readFileSync(path.join(incAbs, file), 'utf8');
        const m = fpuPresentRe.exec(content);
        if (m) { return parseInt(m[1]) !== 0; }
      }
    } catch { /* skip */ }
  }
  return undefined;
}


export function specsFlags(useNano?: boolean, useNosys?: boolean): string {
  if (useNano && useNosys) return ' --specs=nano.specs --specs=nosys.specs -Wl,--start-group,-lm,-lc,-lgcc,-lnosys -Wl,--end-group';
  if (useNano)             return ' --specs=nano.specs';
  if (useNosys)            return ' --specs=nosys.specs';
  return '';
}

/** Per-source explicit compile rule (avoids VPATH). Shared by ht32ide2make and createProject. */
export function makeSrcRule(src: string): string {
  const obj    = `$(BUILD)/${src.replace(/\.\.\//g, 'up/').replace(/\.(c|cpp|s|S)$/i, '.o')}`;
  const isAsm  = /\.(s|S)$/.test(src);
  const isCpp  = src.endsWith('.cpp');
  const recipe = isAsm
    ? `\t@"$(CC)" $(ASFLAGS) -c "${src}" -o "$@"`
    : isCpp
      ? `\t@"$(CC)" $(CFLAGS) -std=c++17 -fno-exceptions -fno-rtti -MMD -MP -MF "$(@:.o=.d)" -c "${src}" -o "$@"`
      : `\t@"$(CC)" $(CFLAGS) -MMD -MP -MF "$(@:.o=.d)" -c "${src}" -o "$@"`;
  const tag = isAsm ? 'AS ' : isCpp ? 'CXX' : 'CC ';
  return `${obj}: ${src} | prepdir\n\t-@$(call MKDIR_P,$(dir $@))\n\t@echo ${tag} ${src}\n${recipe}`;
}

/** Compile rule for a source with spaces in its path. Shared by ht32ide2make and createProject. */
export function makeSpacedSrcRule(src: string): string {
  const base    = src.split('/').pop()!.replace(/\.(c|cpp|s|S)$/i, '.o');
  const obj     = `$(BUILD)/spaced/${base}`;
  const escaped = src.replace(/ /g, '\\ ');
  const isAsm   = /\.(s|S)$/.test(src);
  const isCpp   = src.endsWith('.cpp');
  const recipe  = isAsm
    ? `\t@"$(CC)" $(ASFLAGS) -c "${src}" -o "$@"`
    : isCpp
      ? `\t@"$(CC)" $(CFLAGS) -std=c++17 -fno-exceptions -fno-rtti -MMD -MP -MF "$(@:.o=.d)" -c "${src}" -o "$@"`
      : `\t@"$(CC)" $(CFLAGS) -MMD -MP -MF "$(@:.o=.d)" -c "${src}" -o "$@"`;
  const tag     = isAsm ? 'AS ' : isCpp ? 'CXX' : 'CC ';
  return `${obj}: ${escaped} | prepdir\n\t-@$(call MKDIR_P,$(dir $@))\n\t@echo ${tag} "${src}"\n${recipe}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified Makefile generator — shared by uv2make, ht32ide2make, createProject
// ─────────────────────────────────────────────────────────────────────────────

export interface UnifiedMakefileParams {
  target:        string;
  cc:            string;
  mcu:           string;
  srcs:          string[];        // bgDir-relative source paths (all, including startup .s)
  linkerScripts: string[];        // bgDir-relative .ld paths
  isLibrary:     boolean;
  fpu?:          string;
  floatAbi?:     string;
  optimizationLevel?: string;
  debugInfo?:    string;
  useNano?:      boolean;
  useNosys?:     boolean;
  useLto?:       boolean;
  printfFloat?:  boolean;
  scanfFloat?:   boolean;
  gcSections?:   boolean;
  extraCFlags?:  string;
  extraLDFlags?: string;
  extraLibs?:    string[];
  extraLibNames?: string[];
  extraLibPaths?: string[];
  comment?:      string;     // header comment appended after the standard first line
}

export function buildMakefileText(p: UnifiedMakefileParams): string {
  const gcc      = p.cc.replace(/\\/g, '/');
  const tcPrefix = gcc.replace(/gcc(\.exe)?$/i, '');

  const isM0       = /cortex-m0/i.test(p.mcu);
  const hasFpu     = !!p.fpu && p.fpu !== 'none';
  const fpuFlags   = isM0 ? '' : (hasFpu ? ` -mfpu=${p.fpu}` : '');
  const floatAbi   = isM0 ? ' -mfloat-abi=soft' : (p.floatAbi ? ` -mfloat-abi=${p.floatAbi}` : '');
  const opt        = p.optimizationLevel ? `-${p.optimizationLevel}` : '-Os';
  const dbgFlag    = `-${p.debugInfo ?? 'g3'}`;
  const ltoFlag    = p.useLto ? ' -flto' : '';
  const extraCF    = p.extraCFlags ? ` ${p.extraCFlags.trim()}` : '';
  const printfF    = p.printfFloat ? ' -u _printf_float' : '';
  const scanfF     = p.scanfFloat  ? ' -u _scanf_float'  : '';
  const libPaths   = (p.extraLibPaths ?? []).filter(Boolean).map(lp => `-L"${lp.replace(/\\/g, '/')}"`).join(' ');
  const libNames   = (p.extraLibNames ?? []).filter(Boolean).map(n => `-l${n}`).join(' ');
  const extraLibsStr = [...(p.extraLibs ?? []).filter(Boolean).map(l => `"${l.replace(/\\/g, '/')}"`), libPaths, libNames].filter(Boolean).join(' ');
  const extraLDF   = [p.extraLDFlags?.trim(), extraLibsStr].filter(Boolean).join(' ');
  const extraLDFStr = extraLDF ? ` ${extraLDF}` : '';

  // Assembler-only defines read from adefines.list at build time (empty file → no effect)
  const adefsLine    = `ADEFS := $(file <adefines.list)\n`;
  const adefsInFlags = ' $(ADEFS)';

  const gcSections = p.gcSections !== false;
  const gcCFlags   = gcSections ? ' -ffunction-sections -fdata-sections' : '';
  const gcLDFlags  = gcSections ? '--gc-sections,' : '';
  const ldTFlags   = p.linkerScripts.map(s => `-T "${s}"`).join(' ');
  const ldDepList  = p.linkerScripts.join(' ');
  const ldFlags    = `-Wl,${gcLDFlags}--print-memory-usage$(LD_NO_WARN),-Map,$(BUILD)/$(TARGET).map ${ldTFlags}${specsFlags(p.useNano ?? true, p.useNosys ?? true)}${extraLDFStr}${ltoFlag}${printfF}${scanfF}`;

  const cleanSrcs  = p.srcs.filter(s => !s.includes(' '));
  const spacedSrcs = p.srcs.filter(s =>  s.includes(' '));
  const spacedObjs = spacedSrcs
    .filter(s => /\.(c|cpp|s|S)$/i.test(s))
    .map(s => `$(BUILD)/spaced/${s.split('/').pop()!.replace(/\.(c|cpp|s|S)$/i, '.o')}`);

  const srcsLine      = cleanSrcs.join(' ');
  const objSpacedLine = spacedObjs.length ? `OBJ_SPACED := ${spacedObjs.join(' ')}\n` : '';
  const objLine       = `OBJ := $(OBJ_C) $(OBJ_CPP) $(OBJ_S) $(OBJ_S2)${spacedObjs.length ? ' $(OBJ_SPACED)' : ''}`;

  const cRules   = cleanSrcs.filter(s => s.endsWith('.c')).map(makeSrcRule).join('\n\n');
  const cppRules = cleanSrcs.filter(s => s.endsWith('.cpp')).map(makeSrcRule).join('\n\n');
  const asmRules = cleanSrcs.filter(s => /\.(s|S)$/.test(s)).map(makeSrcRule).join('\n\n');
  const spacedRulesBlock = spacedSrcs.length
    ? `# ---- Space-path files ----\n${spacedSrcs.map(makeSpacedSrcRule).join('\n\n')}`
    : '';
  const allRules = [cRules, cppRules, asmRules, spacedRulesBlock].filter(Boolean).join('\n\n');

  const commentLine = p.comment ? `\n# ${p.comment}` : '';

  return `# Auto-generated by Holtek HT32 VS Code Extension.${commentLine}
TARGET := ${p.target}
BUILD  := build

# ---- Cross-platform helpers ----
comma := ,
ifeq ($(OS),Windows_NT)
  SHELL := cmd.exe
  .SHELLFLAGS := /C
  RMDIR := rmdir /S /Q
  MKDIR_P = if not exist "$(subst /,\\\\,$1)" mkdir "$(subst /,\\\\,$1)" 2>NUL & ver>NUL
  LD_NO_WARN = $(if $(shell "$(dir $(CC))$(subst gcc,ld,$(notdir $(CC)))" --no-warn-rwx-segments 2>&1 | findstr /C:"unrecognized"),,$(comma)--no-warn-rwx-segments)
else
  SHELL := /bin/sh
  .SHELLFLAGS := -c
  RMDIR := rm -rf
  MKDIR_P = mkdir -p "$1"
  LD_NO_WARN = $(if $(shell "$(dir $(CC))$(subst gcc,ld,$(notdir $(CC)))" --no-warn-rwx-segments 2>&1 | grep unrecognized),,$(comma)--no-warn-rwx-segments)
endif

# ---- Toolchain ----
CC      := ${gcc}
AR      := ${tcPrefix}ar
OBJCOPY := ${tcPrefix}objcopy
OBJDUMP := ${tcPrefix}objdump
SIZE    := ${tcPrefix}size

# ---- Flags (edit includes.list / defines.list to change) ----
INCS := $(file <includes.list)
DEFS := $(file <defines.list)
${adefsLine}
CFLAGS  := -mcpu=${p.mcu} -mthumb${fpuFlags}${floatAbi} ${opt} ${dbgFlag}${gcCFlags} "-ffile-prefix-map=$(CURDIR)=." $(INCS) $(DEFS)${extraCF}${ltoFlag}
ASFLAGS := -mcpu=${p.mcu} -mthumb${fpuFlags}${floatAbi} -x assembler-with-cpp "-ffile-prefix-map=$(CURDIR)=." $(INCS) $(DEFS)${adefsInFlags}
${p.isLibrary ? '' : `LDFLAGS := ${ldFlags}\n`}
# ---- Sources (managed by project tree via meta.groups) ----
SRCS := ${srcsLine}
LIBS :=

SRCS_RAW := $(SRCS)
define src_to_obj
$(BUILD)/$(subst ../,up/,$(1:.c=.o))
endef
OBJ_C   := $(foreach src,$(filter %.c,$(SRCS_RAW)),$(call src_to_obj,$(src)))
OBJ_CPP := $(foreach src,$(filter %.cpp,$(SRCS_RAW)),$(BUILD)/$(subst ../,up/,$(src:.cpp=.o)))
OBJ_S   := $(foreach src,$(filter %.s,$(SRCS_RAW)),$(BUILD)/$(subst ../,up/,$(src:.s=.o)))
OBJ_S2  := $(foreach src,$(filter %.S,$(SRCS_RAW)),$(BUILD)/$(subst ../,up/,$(src:.S=.o)))
${objSpacedLine}${objLine}

.PHONY: all clean

${p.isLibrary ? `\
all: $(BUILD)/$(TARGET).a

$(BUILD)/$(TARGET).a: $(OBJ) | $(BUILD)
\t@echo AR  $@
\t@"$(AR)" rcs "$@" $(OBJ)
\t@"$(SIZE)" "$@" 2>/dev/null || exit 0` : `\
all: $(BUILD)/$(TARGET).elf $(BUILD)/$(TARGET).bin $(BUILD)/$(TARGET).hex $(BUILD)/$(TARGET).text
\t@"$(SIZE)" "$(BUILD)/$(TARGET).elf"

$(BUILD)/$(TARGET).elf: $(OBJ) $(LIBS) ${ldDepList} | $(BUILD)
\t@echo Linking $@
\t@"$(CC)" $(CFLAGS) $(OBJ) $(LIBS) -o "$@" $(LDFLAGS)

$(BUILD)/$(TARGET).bin: $(BUILD)/$(TARGET).elf
\t@"$(OBJCOPY)" -O binary "$<" "$@"

$(BUILD)/$(TARGET).hex: $(BUILD)/$(TARGET).elf
\t@"$(OBJCOPY)" -O ihex "$<" "$@"

$(BUILD)/$(TARGET).text: $(BUILD)/$(TARGET).elf
\t@"$(OBJDUMP)" -S "$<" > "$@"`}

# ---- Per-source explicit rules (avoids VPATH) ----
${allRules}
# ---- Dirs ----
prepdir: | $(BUILD)

$(BUILD):
\t-@$(call MKDIR_P,$(BUILD))

# ---- Auto-generated header dependency files ----
-include $(OBJ_C:.o=.d) $(OBJ_CPP:.o=.d)

# ---- Clean ----
clean:
\t@echo Cleaning $(BUILD)/
ifeq ($(OS),Windows_NT)
\t-@if exist "$(BUILD)" $(RMDIR) "$(BUILD)"
else
\t-@$(RMDIR) "$(BUILD)"
endif
`.trimStart();
}

/** 從已寫入磁碟的 project.settings.json 生成 Makefile 文字。
 *  project.settings.json 是 source of truth；呼叫前必須先完成 writeProjectSettings。 */
export function buildMakefileFromProjectSettings(
  settings: ProjectSettings,
  extras: {
    cc:            string;
    srcs:          string[];
    linkerScripts: string[];
    isLibrary?:    boolean;
    comment?:      string;
  }
): string {
  return buildMakefileText({
    target:            settings.targetName || 'firmware',
    cc:                extras.cc,
    mcu:               settings.mcu || 'cortex-m0plus',
    srcs:              extras.srcs,
    linkerScripts:     extras.linkerScripts,
    isLibrary:         extras.isLibrary ?? false,
    comment:           extras.comment,
    fpu:               (settings.fpu && settings.fpu !== 'none') ? settings.fpu : undefined,
    floatAbi:          settings.floatAbi as 'soft' | 'softfp' | 'hard' | undefined,
    optimizationLevel: settings.optimizationLevel || undefined,
    debugInfo:         settings.debugInfo || undefined,
    useNano:           settings.useNano,
    useNosys:          settings.useNosys,
    useLto:            settings.useLto,
    printfFloat:       settings.printfFloat,
    scanfFloat:        settings.scanfFloat,
    gcSections:        settings.gcSections,
    extraCFlags:       settings.extraCFlags || undefined,
    extraLDFlags:      settings.extraLDFlags || undefined,
    extraLibs:         (settings.extraLibs   ?? []).filter(Boolean),
    extraLibNames:     (settings.extraLibNames ?? []).filter(Boolean),
    extraLibPaths:     (settings.extraLibPaths ?? []).filter(Boolean),
  });
}

function writeMakefile(outDir: string, text: string) {
  logFile(path.join(outDir, 'Makefile'));
  fs.writeFileSync(path.join(outDir, "Makefile"), text);
}

// ─── Shared compile_commands.json builder (used by all three conversion paths) ───

export function computeIsystemPaths(gccFull: string): string[] {
  const paths: string[] = [];
  const toolchainRoot = path.dirname(path.dirname(gccFull));
  const newlibInc = path.join(toolchainRoot, 'arm-none-eabi', 'include').replace(/\\/g, '/');
  if (fs.existsSync(newlibInc)) { paths.push(newlibInc); }
  const gccLibBase = path.join(toolchainRoot, 'lib', 'gcc', 'arm-none-eabi');
  if (fs.existsSync(gccLibBase)) {
    try {
      const versions = fs.readdirSync(gccLibBase).sort();
      const ver = versions[versions.length - 1];
      if (ver) {
        const gccInc = path.join(gccLibBase, ver, 'include').replace(/\\/g, '/');
        if (fs.existsSync(gccInc)) { paths.push(gccInc); }
        const gccIncFixed = path.join(gccLibBase, ver, 'include-fixed').replace(/\\/g, '/');
        if (fs.existsSync(gccIncFixed)) { paths.push(gccIncFixed); }
      }
    } catch { /* skip */ }
  }
  return paths;
}

export interface CCEntry {
  directory: string;
  file:      string;
  arguments: string[];
}

/**
 * Build a compile_commands.json array in the standard clangd format.
 * - "arguments" array (not "command" string)
 * - No "output" field
 * - All paths normalised to forward slashes
 * - Only .c / .cpp sources (skip .s / .h)
 */
export async function buildCCDb(opts: {
  bgDir:        string;
  compiler?:    string;    // default 'arm-none-eabi-gcc'
  armCore:      string;
  fpu?:         string;    // undefined or 'none' → no -mfpu flag
  floatAbi?:    string;    // 'hard' | 'softfp' | 'soft'
  optimization: string;    // 'Os', 'O2', … (without leading -)
  debugInfo?:   string;    // 'g3', 'g', … (without leading -), default 'g3'
  defines:      string[];
  includes:     string[];  // bgDir-relative or absolute paths (forward or back slash)
  absSources:   string[];  // absolute paths — filtered to .c/.cpp internally
  isystemPaths?: string[]; // prepended as -isystem flags after --target=arm-none-eabi
  gcSections?:  boolean;
}): Promise<CCEntry[]> {
  const compiler = opts.compiler || 'arm-none-eabi-gcc';
  const fwdDir   = opts.bgDir.replace(/\\/g, '/');
  const hasFpu   = opts.fpu && opts.fpu !== 'none';
  const fpuFlags = hasFpu
    ? [`-mfpu=${opts.fpu}`, `-mfloat-abi=${opts.floatAbi || 'hard'}`]
    : [`-mfloat-abi=${opts.floatAbi || 'soft'}`];
  const baseFlags = [
    `-mcpu=${opts.armCore}`, '-mthumb',
    ...fpuFlags,
    `-${opts.optimization}`,
    `-${opts.debugInfo ?? 'g3'}`,
    ...(opts.gcSections !== false ? ['-ffunction-sections', '-fdata-sections'] : []),
  ];
  const defFlags = opts.defines.map(d => `-D${d}`);
  const incFlags = opts.includes.map(p => `-I${p.replace(/\\/g, '/')}`);
  const flags    = [...baseFlags, ...defFlags, ...incFlags];

  const allSources = await expandIncludedCFiles(opts.absSources.filter(s => /\.(c|cpp)$/i.test(s)), opts.includes);

  return allSources.map(s => {
    const fwdFile = s.replace(/\\/g, '/');
    const isystemFlags = (opts.isystemPaths ?? []).map(p => `-isystem${p}`);
    return { directory: fwdDir, file: fwdFile, arguments: [compiler, '--target=arm-none-eabi', ...isystemFlags, ...flags, '-c', fwdFile] };
  });
}

async function expandIncludedCFiles(sources: string[], searchPaths: string[] = []): Promise<string[]> {
  const seen = new Set(sources.map(s => s.replace(/\\/g, '/').toLowerCase()));
  const result = [...sources];
  let frontier = [...sources];
  while (frontier.length) {
    const contents = await Promise.all(frontier.map(src =>
      fs.promises.readFile(src, 'utf8').catch(() => '')
    ));
    const next: string[] = [];
    for (const [i, content] of contents.entries()) {
      if (!content) continue;
      for (const m of content.matchAll(/#include\s+"([^"]+\.c)"/gi)) {
        const abs = resolveInclude(m[1], path.dirname(frontier[i]), searchPaths);
        if (!abs) continue;
        const key = abs.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          result.push(abs);
          next.push(abs);
        }
      }
    }
    frontier = next;
  }
  return result;
}

/**
 * Generate compile_commands.json by reading includes.list / defines.list / sources.list.
 * Single source of truth: all conversion paths write .list files first, then call this.
 * The Settings Webview regeneration command uses the same function.
 */
export async function writeCCDbFromLists(bgDir: string, opts: {
  compiler?:    string;
  armCore:      string;
  fpu?:         string;
  floatAbi?:    string;
  optimization?: string;
  debugInfo?:   string;
  gccFullPath?: string;
  gcSections?:  boolean;
}): Promise<void> {
  const gccFull = opts.gccFullPath?.replace(/\\/g, '/');
  const compiler = gccFull ?? opts.compiler;
  const isystemPaths = gccFull ? computeIsystemPaths(gccFull) : undefined;
  const read = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

  const includes = parseIncludesList(bgDir, read(path.join(bgDir, 'includes.list')));
  const defines  = [
    ...[...read(path.join(bgDir, 'defines.list')).matchAll(/-D([^\s]+)/g)].map(m => m[1]),
    ...[...read(path.join(bgDir, 'adefines.list')).matchAll(/-D([^\s]+)/g)].map(m => m[1]),
  ];
  const absSources = read(path.join(bgDir, 'sources.list'))
    .split('\n').map(l => l.trim()).filter(Boolean)
    .map(rel => path.resolve(bgDir, rel));

  const ccdb = await buildCCDb({
    bgDir, compiler,
    armCore:      opts.armCore,
    fpu:          opts.fpu,
    floatAbi:     opts.floatAbi,
    optimization: opts.optimization || 'Os',
    debugInfo:    opts.debugInfo    || 'g3',
    gcSections:   opts.gcSections,
    defines, includes, absSources,
    isystemPaths,
  });
  logFile(path.join(bgDir, 'compile_commands.json'));
  fs.writeFileSync(path.join(bgDir, 'compile_commands.json'), JSON.stringify(ccdb, null, 2));
}

async function writeCompileCommands(outDir: string, opts: { cc?: string; mcu?: string; fpu?: string; floatAbi?: string }, _info?: Extracted) {
  const s = readProjectSettings(outDir);
  await writeCCDbFromLists(outDir, {
    compiler:     opts.cc,
    armCore:      opts.mcu ?? 'cortex-m0plus',
    fpu:          (opts.fpu && opts.fpu !== 'none') ? opts.fpu : undefined,
    floatAbi:     opts.floatAbi,
    optimization: s.optimizationLevel || 'Os',
    debugInfo:    s.debugInfo || 'g3',
    gcSections:   s.gcSections,
  });
}

/**
 * 從 conf/Settings.ini 的 [SRAM] 區段查找 deviceName 對應的 RAM 大小。
 * key 格式為 {DeviceName}_{Package}，以 deviceName 為前綴進行匹配（忽略大小寫）。
 * 目的：Keil scatter 可能包含外部 SRAM，Settings.ini 記錄晶片實際內部 SRAM 大小。
 */
/**
 * Return all PDSC paths to search: extra (user-provided) first, then all bundled DFP packs
 * (device-specific packs first, HT32_DFP generic last), each sorted newest-first.
 * Device-specific packs contain correct flash addresses and SPIM algorithms;
 * HT32_DFP acts as a fallback for devices not covered by any device-specific pack.
 */
export function getAllPdscPaths(extPath: string, extraPdscPaths: string[] = []): string[] {
  const results: string[] = [];
  for (const p2 of extraPdscPaths) {
    if (p2 && fs.existsSync(p2)) results.push(p2);
  }
  const holtek = path.join(extPath, 'dfp', 'Holtek');
  try {
    // Device-specific packs first (have correct algorithm addresses + SPIM entries)
    for (const packName of fs.readdirSync(holtek).sort()) {
      if (packName === 'HT32_DFP') continue;  // handled last
      const packDir = path.join(holtek, packName);
      try {
        const versions = fs.readdirSync(packDir).filter(d => /^\d/.test(d)).sort((a, b) => semverCmp(b, a));
        for (const v of versions) {
          const vdir = path.join(packDir, v);
          const pdscs = fs.readdirSync(vdir).filter(f => f.toLowerCase().endsWith('.pdsc'));
          for (const f of pdscs) results.push(path.join(vdir, f));
        }
      } catch { /* skip this pack */ }
    }
  } catch { /* dfp/Holtek missing */ }
  try {
    // HT32_DFP generic pack last (fallback; uses placeholder flash addresses)
    const base = path.join(holtek, 'HT32_DFP');
    const versions = fs.readdirSync(base).filter(d => /^\d/.test(d)).sort((a, b) => semverCmp(b, a));
    for (const v of versions) {
      const vdir = path.join(base, v);
      const pdscs = fs.readdirSync(vdir).filter(f => f.toLowerCase().endsWith('.pdsc'));
      for (const f of pdscs) results.push(path.join(vdir, f));
    }
  } catch { /* bundled DFP missing */ }
  return results;
}

/**
 * 從 bundled PDSC (HT32_DFP) 查找 deviceName 對應的 IROM1/IRAM1 起始與大小。
 * deviceName 可以是不含 package 的短名（如 "HT32F52352"）或含 package 的完整名。
 */
export function lookupMemoryFromPdsc(deviceName: string, extPath: string, extraPdscPaths?: string[]): {
  flashOrigin?: string; flashLength?: string;
  ramOrigin?: string;   ramLength?: string;
} {
  const escaped  = deviceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const devRe    = new RegExp(`<device\\s+Dname="${escaped}[^"]*"[^>]*>([\\s\\S]*?)</device>`, 'i');
  const familyRe = new RegExp(`<subFamily\\s+DsubFamily="${escaped}[^"]*"[^>]*>([\\s\\S]*?)</subFamily>`, 'i');
  for (const pdscPath of getAllPdscPaths(extPath, extraPdscPaths)) {
    try {
      const pdsc  = fs.readFileSync(pdscPath, 'utf8');
      const block = devRe.exec(pdsc)?.[1] ?? familyRe.exec(pdsc)?.[1];
      if (!block) continue;
      const rom = /<memory[^>]+(?:id|name)="IROM1"[^>]*start="([^"]+)"[^>]*size="([^"]+)"/i.exec(block);
      const ram = /<memory[^>]+(?:id|name)="IRAM1"[^>]*start="([^"]+)"[^>]*size="([^"]+)"/i.exec(block);
      return {
        flashOrigin: rom?.[1], flashLength: rom?.[2],
        ramOrigin:   ram?.[1], ramLength:   ram?.[2],
      };
    } catch { /* try next */ }
  }
  return {};
}

/**
 * Patch a GNU LD linker script to add/remove per-file ROM region assignments.
 * For each file with a `rom` FileOption:
 *   - If the target ORIGIN already exists as a named MEMORY region, reuses that name.
 *   - Otherwise adds `HT32ROM_<name> (rx) : ORIGIN = 0x..., LENGTH = 0x...` before RAM.
 *   - Adds `.ht32rom_<name> : { *file.o(.text* .rodata*) } > <region>` before .text.
 * Calling with empty/undefined fileOptions removes all previously-added HT32ROM_ entries.
 */
export function patchLinkerScriptRom(
  ldPath: string,
  fileOptions: Record<string, { rom?: FileRomOption }> | undefined
): void {
  if (!fs.existsSync(ldPath)) {
    logWarn(`patchLinkerScriptRom: linker script not found: ${ldPath}`);
    return;
  }

  let ld = fs.readFileSync(ldPath, 'utf8');

  // ── Step 1: Remove all existing HT32ROM_ entries ─────────────────────────
  ld = ld.replace(/^[ \t]*HT32ROM_\w+[ \t]*\([^)]*\)[ \t]*:[^\n]*\n/gm, '');
  ld = ld.replace(/\n[ \t]*\.ht32rom_\w+[ \t]*:[ \t]*\{[^}]*\}[ \t]*>[ \t]*\w+[^\n]*/g, '');

  // ── Step 2: Collect files with rom settings ───────────────────────────────
  type RomFile = { objName: string; safeName: string; rom: FileRomOption };
  const romFiles: RomFile[] = [];
  if (fileOptions) {
    for (const [metaPath, fo] of Object.entries(fileOptions)) {
      if (!fo.rom) continue;
      const baseName = path.basename(metaPath, path.extname(metaPath));
      const safeName = baseName.replace(/[^a-zA-Z0-9_]/g, '_');
      const objName  = baseName + '.o';
      romFiles.push({ objName, safeName, rom: fo.rom });
    }
  }

  if (romFiles.length === 0) {
    fs.writeFileSync(ldPath, ld, 'utf8');
    logInfo(`patchLinkerScriptRom: removed stale HT32ROM_ entries from ${path.basename(ldPath)}`);
    return;
  }

  // ── Step 3: Parse existing MEMORY regions (name → origin as number) ───────
  const existingRegions = new Map<number, string>(); // origin → region name
  const memRegionRe = /^\s*(\w+)\s*\([^)]*\)\s*:\s*ORIGIN\s*=\s*(0x[0-9a-fA-F]+|\d+)/gm;
  let m: RegExpExecArray | null;
  while ((m = memRegionRe.exec(ld)) !== null) {
    const name   = m[1];
    const origin = m[2].startsWith('0x') || m[2].startsWith('0X')
      ? parseInt(m[2], 16) : parseInt(m[2], 10);
    existingRegions.set(origin, name);
  }

  const toHex = (val: string): string => {
    if (/^0x/i.test(val)) return val.toLowerCase();
    const n = parseInt(val, 10);
    return isNaN(n) ? val : `0x${n.toString(16)}`;
  };

  // ── Step 4: Insert new MEMORY regions (only when origin not already present)
  const newMemLines: string[] = [];
  for (const { safeName, rom } of romFiles) {
    const origin = /^0x/i.test(rom.origin)
      ? parseInt(rom.origin, 16) : parseInt(rom.origin, 10);
    if (!existingRegions.has(origin)) {
      newMemLines.push(
        `HT32ROM_${safeName} (rx) : ORIGIN = ${toHex(rom.origin)}, LENGTH = ${toHex(rom.length)}`
      );
      existingRegions.set(origin, `HT32ROM_${safeName}`);
    }
  }

  if (newMemLines.length > 0) {
    const memBlock = newMemLines.join('\n') + '\n';
    if (/^[ \t]*RAM[ \t]*\(/m.test(ld)) {
      ld = ld.replace(/^([ \t]*RAM[ \t]*\()/m, `${memBlock}$1`);
    } else {
      logWarn(`patchLinkerScriptRom: RAM region not found in ${path.basename(ldPath)}; MEMORY entries skipped`);
    }
  }

  // ── Step 5: Insert SECTIONS output sections before .text ─────────────────
  // Use existing region name when the origin matches, else HT32ROM_xxx
  const sectionBlocks = romFiles.map(({ objName, safeName, rom }) => {
    const origin = /^0x/i.test(rom.origin)
      ? parseInt(rom.origin, 16) : parseInt(rom.origin, 10);
    const regionName = existingRegions.get(origin) ?? `HT32ROM_${safeName}`;
    return `\n  .ht32rom_${safeName} :\n  {\n    *${objName}(.text* .rodata*)\n  } > ${regionName}`;
  }).join('\n');

  if (/^[ \t]*\.text[ \t]*:/m.test(ld)) {
    ld = ld.replace(/^([ \t]*\.text[ \t]*:)/m, `${sectionBlocks}\n\n$1`);
  } else {
    logWarn(`patchLinkerScriptRom: .text section not found in ${path.basename(ldPath)}; SECTIONS entries skipped`);
  }

  fs.writeFileSync(ldPath, ld, 'utf8');
  logInfo(`patchLinkerScriptRom: applied ${romFiles.length} ROM region(s) in ${path.basename(ldPath)}`);
}

export function lookupSramFromSettings(deviceName: string, extPath: string): string | undefined {
  const iniPath = path.join(extPath, 'conf', 'Settings.ini');
  if (!fs.existsSync(iniPath)) return undefined;
  try {
    const text = fs.readFileSync(iniPath, 'utf8');
    const sramM = /\[SRAM\]([\s\S]*?)(?:\[|$)/i.exec(text);
    if (!sramM) return undefined;
    const prefix = deviceName.toUpperCase();
    for (const line of sramM[1].split('\n')) {
      const m = /^\s*([\w]+)\s*=\s*(0x[\da-fA-F]+|\d+)\s*(?:;.*)?$/i.exec(line);
      if (!m) continue;
      const key = m[1].toUpperCase();
      // 完全匹配或 {DeviceName}_{Package} 前綴匹配
      if (key === prefix || key.startsWith(prefix + '_')) {
        return m[2];
      }
    }
  } catch { /* non-critical */ }
  return undefined;
}

function convertSctToLd(sctText: string, _templateRoot: string, deviceName?: string, heapSize?: string, stackSize?: string, ramLength?: string, sctFile?: string, warnings?: ConversionWarning[], romOrigin?: string, romLength?: string, templateLd?: string): { ld: string; codeRegionName: string } {
  const result = scatter2ld(sctText, { deviceName, heapSize, stackSize, ramLength, romOrigin, romLength, templateLd });
  for (const w of result.warnings) {
    logWarn(`scatter2ld: ${w}`);
    // "Verify section names" = informational (conversion succeeded, user should check) → output channel only.
    // Everything else (patch failures, LENGTH=0, unrecognized content, can't-convert) → Problems panel.
    if (!/Verify section names match actual/.test(w)) {
      warnings?.push({ message: `scatter2ld: ${w}`, file: sctFile ?? '' });
    }
  }
  return { ld: result.ld, codeRegionName: result.codeRegionName };
}

function generateLinkerScript(outDir: string, projDir: string, info: Extracted, mcu?: string, heapSize?: string, stackSize?: string, ramLength?: string, templateRoot?: string, warnings?: ConversionWarning[], stackSafeLength?: string, extPath?: string): string {
  // 有 scatter.sct：優先用它來產生 ld（scatter 路徑是相對於 projDir）
  // Keep original scatter filename (basename with .sct/.lin → .ld) so -T flag matches.
  const scatterAbs = info.scatter ? path.resolve(projDir, info.scatter) : undefined;
  if (scatterAbs && fs.existsSync(scatterAbs)) {
    const scatterExt = path.extname(info.scatter!).toLowerCase();
    const scatterLdName = scatterExt === '.ld'
      ? path.basename(info.scatter!)
      : path.basename(info.scatter!).replace(/\.(sct|lin)$/i, '.ld');
    const outLd = path.join(outDir, scatterLdName);
    // ARM-GNU 專案的 linker script 已是 GCC 格式，直接複製，不過 scatter2ld
    if (scatterExt === '.ld') {
      fs.copyFileSync(scatterAbs, outLd);
      logInfo(`Copied linker script (already GCC format): ${scatterAbs}`);
      return scatterLdName;
    }
    try {
      const sctText = fs.readFileSync(scatterAbs, "utf8");
      const is49xGccTemplate = !!templateRoot && /device_support[/\\]startup[/\\]gcc/i.test(templateRoot);
      const scatter49xHeap  = is49xGccTemplate ? heapSize  : undefined;
      const scatter49xStack = is49xGccTemplate ? stackSize : undefined;

      // Find template linker.ld to use as base (template-based scatter conversion).
      // Same search logic as the non-scatter path below.
      let sctTemplateLd: string | undefined;
      if (templateRoot) {
        const linkerDir49x = path.join(templateRoot, 'linker');
        if (fs.existsSync(linkerDir49x)) {
          const ldFiles = fs.readdirSync(linkerDir49x).filter(f => f.endsWith('_FLASH.ld'));
          if (ldFiles.length) {
            const mcuU = (mcu ?? '').toUpperCase().replace(/\s/g, '');
            const matchLd = ldFiles.find(f => f.toUpperCase() === `${mcuU}_FLASH.LD`)
                         ?? ldFiles.find(f => mcuU && f.toUpperCase().startsWith(mcuU.substring(0, 9)))
                         ?? ldFiles[0];
            sctTemplateLd = fs.readFileSync(path.join(linkerDir49x, matchLd), 'utf8');
          }
        } else {
          const fwlLd = path.join(templateRoot, 'linker.ld');
          if (fs.existsSync(fwlLd)) {
            sctTemplateLd = fs.readFileSync(fwlLd, 'utf8');
          } else if (extPath) {
            const fwlRoot    = path.resolve(templateRoot, '..', '..', '..', '..');
            const bundledDir = bundledGnuDirFromFwlRoot(fwlRoot, extPath);
            const cand       = bundledDir ? path.join(bundledDir, 'linker.ld') : undefined;
            if (cand && fs.existsSync(cand)) sctTemplateLd = fs.readFileSync(cand, 'utf8');
          }
        }
      }

      const sctResult = convertSctToLd(sctText, '', info.projectName ?? undefined, scatter49xHeap, scatter49xStack, ramLength, scatterAbs, warnings, info.romOrigin, info.romLength, sctTemplateLd);
      let ldText = sctResult.ld;

      if (sctTemplateLd) {
        // Template-based path: apply same post-patches as non-scatter template path.
        if (is49xGccTemplate) {
          ldText = ldText.replace(
            /(_estack\s*=\s*)0x[\da-fA-F]+\s*;([^\n]*)/,
            '$1ORIGIN(RAM) + LENGTH(RAM); /* end of RAM */'
          );
          if (heapSize) {
            const enfH = enforceMinHeap(heapSize);
            if (enfH !== heapSize) {
              warnings?.push({ message: `_Min_Heap_Size=${heapSize} enforced to ${enfH} (GCC newlib-nano requires heap for printf)`, file: '' });
              heapSize = enfH;
            }
            ldText = ldText.replace(/(_Min_Heap_Size\s*=\s*)[^;]+;/, `$1${heapSize};`);
          }
          if (stackSize) ldText = ldText.replace(/(_Min_Stack_Size\s*=\s*)[^;]+;/, `$1${stackSize};`);
        }
        if (stackSafeLength) ldText = patchLdStackTop(ldText, stackSafeLength);
        ldText = patchLdStackSections(ldText);
      } else {
        // Old fallback path (no template found): patch LENGTH=0 and stackSafeLength only.
        if (info.romLength && sctResult.codeRegionName) {
          const regionPat = sctResult.codeRegionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          ldText = ldText.replace(
            new RegExp(`(${regionPat}\\s*\\([^)]*\\)\\s*:\\s*ORIGIN\\s*=\\s*[^,]+,\\s*LENGTH\\s*=\\s*)0x00000000\\b`),
            `$1${info.romLength}`
          );
        }
        if (stackSafeLength) ldText = patchLdStackTop(ldText, stackSafeLength);
      }

      fs.writeFileSync(outLd, ldText);
      logInfo(`Generated ${scatterLdName} from scatter: ${scatterAbs}`);
      return scatterLdName;
    } catch (e: any) {
      logWarn(`convertSctToLd failed (${e?.message}), fallback to FWLib linker.ld`);
      warnings?.push({ message: `Linker script conversion failed (${e?.message}); falling back to FWLib linker.ld` });
    }
  }

  // 無 scatter（或轉換失敗）：用 templateRoot（resolveGnuArmDir 的輸出）找 FWLib linker.ld。
  // templateRoot 對 49x = {FWLib}/libraries/cmsis/cm4/device_support/startup/gcc/
  // templateRoot 對 STD  = {FWLib}/project_template/IP/Example/GNU_ARM/
  if (!templateRoot)
    throw new Error('generateLinkerScript: templateRoot not provided');

  const infoForTpl = ramLength ? { ...info, ramLength } : info;

  // ── 49x：linker/ 是 templateRoot 的子目錄 ───────────────────────────────
  const linkerDir = path.join(templateRoot, 'linker');
  if (fs.existsSync(linkerDir)) {
    const ldFiles = fs.readdirSync(linkerDir).filter(f => f.endsWith('_FLASH.ld'));
    if (!ldFiles.length)
      throw new Error(`No *_FLASH.ld in ${linkerDir}`);
    const mcuUpper = (mcu ?? '').toUpperCase().replace(/\s/g, '');
    const matchLd  = ldFiles.find(f => f.toUpperCase() === `${mcuUpper}_FLASH.LD`)
                  ?? ldFiles.find(f => mcuUpper && f.toUpperCase().startsWith(mcuUpper.substring(0, 9)))
                  ?? ldFiles[0];
    let ld49 = fs.readFileSync(path.join(linkerDir, matchLd), 'utf8');
    // FWLib .ld 用硬編碼地址 `_estack = 0x2xxxxxxx`；改成 expression form
    ld49 = ld49.replace(
      /(_estack\s*=\s*)0x[\da-fA-F]+\s*;([^\n]*)/,
      '$1ORIGIN(RAM) + LENGTH(RAM); /* end of RAM */'
    );
    ld49 = patchLdMemoryFromInfo(ld49, infoForTpl);
    if (stackSafeLength) ld49 = patchLdStackTop(ld49, stackSafeLength);
    // 從 Keil startup EQU 同步 heap/stack 大小（不 zero out，49x 用算術分配）
    if (heapSize) {
      const enfH = enforceMinHeap(heapSize);
      if (enfH !== heapSize) {
        warnings?.push({ message: `_Min_Heap_Size=${heapSize} enforced to ${enfH} (GCC newlib-nano requires heap for printf)`, file: '' });
        heapSize = enfH;
      }
      ld49 = ld49.replace(/(_Min_Heap_Size\s*=\s*)[^;]+;/, `$1${heapSize};`);
    }
    if (stackSize) ld49 = ld49.replace(/(_Min_Stack_Size\s*=\s*)[^;]+;/, `$1${stackSize};`);
    ld49 = patchLdStackSections(ld49);
    fs.writeFileSync(path.join(outDir, matchLd), ld49);
    logInfo(`generateLinkerScript: 49x FWLib ${matchLd} (heap=${heapSize ?? '?'}, stack=${stackSize ?? '?'})`);
    return matchLd;
  }

  // ── STD：linker.ld 在 templateRoot 內 ────────────────────────────────────
  const fwlLd = path.join(templateRoot, 'linker.ld');
  let effectiveLd: string | undefined = fs.existsSync(fwlLd) ? fwlLd : undefined;
  if (!effectiveLd && extPath) {
    // templateRoot = {FWLib}/project_template/IP/Example/GNU_ARM → fwlRoot is 4 levels up
    const fwlRoot  = path.resolve(templateRoot, '..', '..', '..', '..');
    const bundledDir = bundledGnuDirFromFwlRoot(fwlRoot, extPath);
    const cand = bundledDir ? path.join(bundledDir, 'linker.ld') : undefined;
    if (cand && fs.existsSync(cand)) { effectiveLd = cand; logInfo(`generateLinkerScript: linker.ld from bundled templates (FWLib missing)`); }
  }
  if (!effectiveLd)
    throw new Error(`FWLib linker.ld not found at ${fwlLd}`);
  let ldStd = fs.readFileSync(effectiveLd, 'utf8');
  ldStd = patchLdMemoryFromInfo(ldStd, infoForTpl);
  if (stackSafeLength) ldStd = patchLdStackTop(ldStd, stackSafeLength);
  // FWLib STD linker.ld: ._user_heap_stack { *(.heap) *(.stack) }（無 KEEP，無算術）
  // patchLdForStackUsage STD path 改成 KEEP sections；__StackTop/__HT_check_sp 由 startup .s 提供。
  ldStd = patchLdStackSections(ldStd);
  fs.writeFileSync(path.join(outDir, 'linker.ld'), ldStd);
  logInfo(`generateLinkerScript: STD FWLib linker.ld from ${templateRoot}`);
  return 'linker.ld';
}

/**
 * Patch a FWLib linker script to support Stack Usage Analysis.
 *
 * Adds:
 *   - __StackTop = ORIGIN(RAM)+LENGTH(RAM)   (strong symbol, read from ELF .symtab by stackAnalysisProvider)
 *   - Replaces ._user_heap_stack with separate .heap / .stack output sections
 *   - __HT_check_sp = __StackTop - SIZEOF(.stack)  (stack bottom for watermark scan)
 *   - KEEP() around any remaining *(.heap) / *(.stack) collectors
 *
 * Safe to call on already-patched content (idempotent).
 */
export function patchLdStackSections(content: string): string {
  let out = content;

  const userHeapStackRe = /[ \t]*\._user_heap_stack\b[^{]*\{[\s\S]*?\}[ \t]*>[ \t]*\w+[^\n]*/;
  const userHsMatch = userHeapStackRe.exec(out);

  if (userHsMatch) {
    const is49xStyle = /\.\s*=\s*\.\s*\+\s*_Min_(?:Heap|Stack)_Size/.test(userHsMatch[0]);
    if (!is49xStyle) {
      // STD: startup .s normally provides __StackTop / __HT_check_sp as strong globals.
      // Replace ._user_heap_stack with KEEP-wrapped sections (prevents --gc-sections).
      // PROVIDE inside the output section acts as fallback when .s does not export them:
      //   - If .s defines the symbol → PROVIDE is ignored (strong .o symbol wins)
      //   - If .s does NOT define it  → PROVIDE supplies the value from the location counter
      // Symbols defined inside a SECTIONS block appear in ELF symtab regardless of references,
      // which is required since the VS Code panel reads them directly from .symtab.
      out = out.replace(userHeapStackRe,
        `  .heap  : { . = ALIGN(8); KEEP(*(.heap))  KEEP(*(.heap*))  . = ALIGN(8); } >RAM\n` +
        `  .stack : { . = ALIGN(8); PROVIDE(__HT_check_sp = .); KEEP(*(.stack)) KEEP(*(.stack*)) . = ALIGN(8); PROVIDE(__StackTop = .); PROVIDE(_estack = .); } >RAM`
      );
    } else {
      // 49x: startup .s has NO __StackTop / __HT_check_sp; LD must supply them.
      // Use plain assignment (not PROVIDE) so symbols always appear in ELF symtab —
      // PROVIDE only emits a symbol when referenced by an object file, but __StackTop
      // is only read by the VS Code panel (not by ht32_stack_analysis.c), so PROVIDE
      // would silently omit it and the panel would show incomplete data.
      if (!/\b__StackTop\b/.test(out)) {
        out = out.replace(/(_estack\s*=[^;\n]+;[^\n]*\n)/, '$1__StackTop = _estack;\n');
      }
      if (!/\b__HT_check_sp\b/.test(out)) {
        out = out.replace(
          /(_Min_Stack_Size\s*=[^;\n]+;[^\n]*\n)/,
          '$1__HT_check_sp = _estack - _Min_Stack_Size;\n'
        );
      }
    }
  } else {
    // No ._user_heap_stack (e.g. scatter2ld output): startup .s has symbols.
    // Only ensure KEEP() is present on existing *(.stack) / *(.heap) collectors.
    out = out.replace(/(?<!KEEP\()\*\(\.stack\)/g, 'KEEP(*(.stack))');
    out = out.replace(/(?<!KEEP\()\*\(\.heap\)/g,  'KEEP(*(.heap))');
    if (!/KEEP\(\*\(\.stack\)\)/.test(out)) {
      out = out.replace(
        /([ \t]*\/DISCARD\/[ \t]*:)/,
        `  .heap  : { . = ALIGN(8); KEEP(*(.heap))  KEEP(*(.heap*))  . = ALIGN(8); } >RAM\n` +
        `  .stack : { . = ALIGN(8); KEEP(*(.stack)) KEEP(*(.stack*)) . = ALIGN(8); } >RAM\n\n  $1`
      );
    }
  }

  // Inject 'end' symbol AFTER ._user_heap_stack replacement.
  // Must be done here (not before) because ._user_heap_stack often contains
  // PROVIDE(end = .) — which satisfies /\bend\s*=/ — but is then removed above,
  // leaving 'end' undefined. Checking after replacement gives the correct result.
  if (!/\bend\s*=/.test(out)) {
    out = out.replace(
      /(_ebss\s*=\s*[^;]*;[^\n]*\n)/,
      '$1    end = _ebss;         /* heap start for _sbrk (libnosys) */\n'
    );
  }

  return out;
}

export function generateStackAnalysis(outDir: string, extPath?: string): void {
  const dst = path.join(outDir, 'ht32_stack_analysis.c');
  const tplDir = extPath ? path.join(extPath, 'templates', 'GNU_ARM') : path.join(__dirname, '..', '..', 'templates', 'GNU_ARM');
  const tpl = path.join(tplDir, 'ht32_stack_analysis.c');
  fs.copyFileSync(tpl, dst);
  logInfo(`generateStackAnalysis: copied from template to ${dst}`);
}

/**
 * 將 _estack / __StackTop 的 LENGTH(RAM) 替換為指定的 stackSafeLength。
 * RAM MEMORY region 保持不變（仍用完整大小），讓 linker 不因 section 超出而報錯。
 * 用途：HT32F493x5 等可變 RAM 大小的 MCU，Settings.ini 存的是安全 SP 上限，
 *       uvprojx 存的是最大可用 RAM，兩者分開處理。
 */
function patchLdStackTop(ldText: string, stackSafeLength: string): string {
  return ldText
    .replace(
      /(_estack\s*=\s*ORIGIN\s*\(\s*\w+\s*\)\s*\+\s*)LENGTH\s*\(\s*\w+\s*\)(\s*-\s*16)?\s*;/,
      `$1${stackSafeLength}$2;   /* safe SP limit from Settings.ini */`
    )
    .replace(
      /(__StackTop\s*=\s*ORIGIN\s*\(\s*\w+\s*\)\s*\+\s*)LENGTH\s*\(\s*\w+\s*\)(\s*-\s*16)?\s*;/,
      `$1${stackSafeLength}$2;`
    );
}

function patchLdMemoryFromInfo(ldText: string, info: Extracted): string {
  let out = ldText;

  if (info.romOrigin && info.romLength) {
    out = out.replace(
      /FLASH\s*\([^)]*\)\s*:\s*ORIGIN\s*=\s*[^,]+,\s*LENGTH\s*=\s*[^\r\n]+/,
      `FLASH (rx)     : ORIGIN = ${info.romOrigin}, LENGTH = ${info.romLength}`
    );
  }
  if (info.ramOrigin && info.ramLength) {
    out = out.replace(
      /RAM\s*\([^)]*\)\s*:\s*ORIGIN\s*=\s*[^,]+,\s*LENGTH\s*=\s*[^\r\n]+/,
      `RAM (xrw)      : ORIGIN = ${info.ramOrigin}, LENGTH = ${info.ramLength}`
    );
  }
  return out;
}

/**
 * 重新產生 Makefile 的 CFLAGS / ASFLAGS / LDFLAGS 三行。
 * 取得 mcu/fpu/floatAbi（由呼叫者從 project.settings.json 讀取後傳入），與目前的 ht32.* 設定合併後寫回。
 * 不影響 sources / includes / defines / build rules 等其他內容。
 */
export function regenerateMakefileFlags(
  outDir: string,
  meta: BuildMeta,
  opts: Pick<Uv2MakeOptions, 'optimizationLevel' | 'debugInfo' | 'useNano' | 'useNosys' | 'extraCFlags' | 'extraLDFlags' | 'extraLibs' | 'extraLibNames' | 'extraLibPaths' | 'fpu' | 'floatAbi'
    | 'useLto' | 'printfFloat' | 'scanfFloat' | 'gcSections' | 'includePaths'> & { outputName?: string; cDefs?: string[]; aDefs?: string[]; cc?: string }
): void {
  const makefilePath = path.join(outDir, 'Makefile');
  if (!fs.existsSync(makefilePath)) {
    throw new Error(`Makefile not found: ${makefilePath}`);
  }

  const mcu = meta.mcu;
  const isM0 = /cortex-m0/i.test(mcu);
  const fpu      = opts.fpu      ?? meta.fpu;
  const floatAbi = opts.floatAbi ?? meta.floatAbi;

  const fpuFlags     = isM0 ? "" : (fpu && fpu !== 'none' ? ` -mfpu=${fpu}` : "");
  const floatAbiFlag = isM0 ? " -mfloat-abi=soft" : (floatAbi ? ` -mfloat-abi=${floatAbi}` : "");
  const opt          = opts.optimizationLevel ? `-${opts.optimizationLevel}` : '-Os';
  const dbgFlag      = `-${opts.debugInfo ?? 'g3'}`;
  const extraCF      = opts.extraCFlags  ? ` ${opts.extraCFlags.trim()}`  : '';
  const ltoFlag      = opts.useLto ? ' -flto' : '';
  const extraLibsStr = (opts.extraLibs ?? []).filter(Boolean).map(p => {
    const fwd = p.replace(/\\/g, '/');          // backslash → forward slash for sh/GCC
    return /[ ()\[\]{}&|;`'"<>*?#~!$]/.test(fwd) ? `"${fwd}"` : fwd;  // quote if special chars
  }).join(' ');
  const libPathsStr  = (opts.extraLibPaths ?? []).filter(Boolean).map(p => `-L"${p.replace(/\\/g, '/')}"`).join(' ');
  const libNamesStr  = (opts.extraLibNames ?? []).filter(Boolean).map(n => `-l${n}`).join(' ');
  const printfF      = opts.printfFloat ? ' -u _printf_float' : '';
  const scanfF       = opts.scanfFloat  ? ' -u _scanf_float'  : '';
  const extraLDFParts = [opts.extraLDFlags?.trim(), extraLibsStr, libPathsStr, libNamesStr].filter(Boolean).join(' ');
  const extraLDF = extraLDFParts ? ` ${extraLDFParts}` : '';

  const gcSections  = opts.gcSections !== false;
  const gcCFlags    = gcSections ? ' -ffunction-sections -fdata-sections' : '';
  const gcLDFlags   = gcSections ? '--gc-sections,' : '';
  const newCFlags   = `-mcpu=${mcu} -mthumb${fpuFlags}${floatAbiFlag} ${opt} ${dbgFlag}${gcCFlags} "-ffile-prefix-map=$(CURDIR)=." $(INCS) $(DEFS)${extraCF}${ltoFlag}`;

  let content = fs.readFileSync(makefilePath, 'utf8');

  // linkerScripts[] is the single source of truth — always read from meta.json.
  let linkerScripts: string[] = [];
  try {
    const metaJson = JSON.parse(fs.readFileSync(path.join(outDir, 'project.meta.json'), 'utf8'));
    linkerScripts = metaJson.linkerScripts ?? [];
  } catch (e: any) {
    logWarn(`regenerateMakefileFlags: failed to read project.meta.json: ${e?.message ?? e}; falling back to -T linker_script.ld (linker flags may be incorrect)`);
  }
  const ldTFlags = linkerScripts.length > 0
    ? linkerScripts.map(s => `-T "${s}"`).join(' ')
    : '-T "linker_script.ld"';

  const newLDFlags = `-Wl,${gcLDFlags}--print-memory-usage$(LD_NO_WARN),-Map,$(BUILD)/$(TARGET).map ${ldTFlags}${specsFlags(opts.useNano, opts.useNosys)}${extraLDF}${ltoFlag}${printfF}${scanfF}`;

  // Upgrade old Makefiles that predate LD_NO_WARN dynamic detection, or that have the
  // old formula "$(subst gcc,ld,$(CC))" which breaks when CC contains a path prefix.
  // Note: in the template, LD_NO_WARN is indented inside ifeq — must not anchor to ^.
  const ldNoWarnBlock = [
    `comma := ,`,
    `ifeq ($(OS),Windows_NT)`,
    `  LD_NO_WARN = $(if $(shell "$(dir $(CC))$(subst gcc,ld,$(notdir $(CC)))" --no-warn-rwx-segments 2>&1 | findstr /C:"unrecognized"),,$(comma)--no-warn-rwx-segments)`,
    `else`,
    `  LD_NO_WARN = $(if $(shell "$(dir $(CC))$(subst gcc,ld,$(notdir $(CC)))" --no-warn-rwx-segments 2>&1 | grep unrecognized),,$(comma)--no-warn-rwx-segments)`,
    `endif`,
  ].join('\n');
  if (!/LD_NO_WARN\s*[=:]/.test(content)) {
    content = content.replace(/^(LDFLAGS\s*:=)/m, `${ldNoWarnBlock}\n$1`);
  } else if (/\$\(subst gcc,ld,\$\(CC\)\)/.test(content)) {
    // Replace the old 3-line ifeq block (comma + ifeq + Windows line + else + Linux line + endif)
    // The old block may or may not include the "comma :=" line, so match broadly.
    content = content.replace(
      /(?:comma\s*:=\s*,\s*\r?\n)?ifeq\s*\(\$\(OS\),Windows_NT\)\s*\r?\n\s*LD_NO_WARN[^\r\n]*\$\(subst gcc,ld,\$\(CC\)\)[^\r\n]*\r?\n\s*else\s*\r?\n\s*LD_NO_WARN[^\r\n]*\$\(subst gcc,ld,\$\(CC\)\)[^\r\n]*\r?\n\s*endif/,
      ldNoWarnBlock,
    );
  }

  // Update CC / AR / OBJCOPY / OBJDUMP / SIZE when gcc path changed.
  if (opts.cc) {
    const gcc      = opts.cc.replace(/\\/g, '/');
    const tcPrefix = gcc.replace(/gcc(\.exe)?$/i, '');
    content = content.replace(/^CC\s*:=.*$/m,      `CC      := ${gcc}`);
    content = content.replace(/^AR\s*:=.*$/m,      `AR      := ${tcPrefix}ar`);
    content = content.replace(/^OBJCOPY\s*:=.*$/m, `OBJCOPY := ${tcPrefix}objcopy`);
    content = content.replace(/^OBJDUMP\s*:=.*$/m, `OBJDUMP := ${tcPrefix}objdump`);
    content = content.replace(/^SIZE\s*:=.*$/m,    `SIZE    := ${tcPrefix}size`);
  }

  // Write aDefs to adefines.list if provided by caller (Settings WebView save).
  if (opts.aDefs !== undefined) {
    fs.writeFileSync(path.join(outDir, 'adefines.list'), opts.aDefs.map(d => `-D${d}`).join(' '), 'utf8');
  }
  // Ensure ADEFS line exists in Makefile (upgrade old projects that predate adefines.list).
  const hasAdefs = /^ADEFS\s*:=/m.test(content);
  if (!hasAdefs) {
    content = content.replace(/^(DEFS\s*:=.*$)/m, `$1\nADEFS := $(file <adefines.list)`);
    // Ensure the new adefines.list file exists so make doesn't warn (empty = no effect).
    const adefPath = path.join(outDir, 'adefines.list');
    if (!fs.existsSync(adefPath)) {
      fs.writeFileSync(adefPath, '', 'utf8');
    }
  }
  const newASFlags = `-mcpu=${mcu} -mthumb${fpuFlags}${floatAbiFlag} -x assembler-with-cpp "-ffile-prefix-map=$(CURDIR)=." $(INCS) $(DEFS) $(ADEFS)`;
  const effectiveTarget = (opts.outputName as string | undefined)?.trim() || meta.targetName;
  if (effectiveTarget) {
    content = content.replace(/^TARGET\s*:=.*$/m, `TARGET := ${effectiveTarget}`);
  }
  // includePaths / cDefs / aDefs managed by Settings Webview; rewrite their .list files.
  if (opts.includePaths !== undefined) {
    const newIncs = opts.includePaths
      .filter(Boolean)
      .map(p => `-I"${p.replace(/\\/g, '/')}"`)
      .join(' ');
    fs.writeFileSync(path.join(outDir, 'includes.list'), newIncs, 'utf8');
  }
  if (opts.cDefs !== undefined) {
    fs.writeFileSync(path.join(outDir, 'defines.list'), opts.cDefs.map(d => `-D${d}`).join(' '), 'utf8');
  }
  const oldCFlags  = (content.match(/^CFLAGS\s*:=.*$/m)  ?? [''])[0];
  const oldASFlags = (content.match(/^ASFLAGS\s*:=.*$/m) ?? [''])[0];
  content = content.replace(/^CFLAGS\s*:=.*$/m,  `CFLAGS  := ${newCFlags}`);
  content = content.replace(/^ASFLAGS\s*:=.*$/m, `ASFLAGS := ${newASFlags}`);
  content = content.replace(/^LDFLAGS\s*:=.*$/m, `LDFLAGS := ${newLDFlags}`);

  // Update elf target prerequisites: replace all .ld entries with current linkerScripts[].
  const ldDepList = linkerScripts.join(' ') || 'linker_script.ld';
  content = content.replace(
    /^(\$\(BUILD\)\/\$\(TARGET\)\.elf:)(.*?)(\|\s*\$\(BUILD\))/m,
    (_, prefix, middle, suffix) => {
      const nonLd = middle.trim().split(/\s+/).filter((t: string) => Boolean(t) && !t.endsWith('.ld')).join(' ');
      return `${prefix} ${nonLd} ${ldDepList} ${suffix}`;
    }
  );
  fs.writeFileSync(makefilePath, content, 'utf8');

  // CFLAGS/ASFLAGS 改變時寫 marker，讓使用者按 Build 時才清除 stale .o
  const flagsChanged = oldCFlags !== `CFLAGS  := ${newCFlags}` ||
                       oldASFlags !== `ASFLAGS := ${newASFlags}`;
  if (flagsChanged) {
    try {
      fs.writeFileSync(path.join(outDir, '.needs-rebuild'), '', 'utf8');
      logInfo(`Compiler flags changed → marked for clean rebuild on next build`);
    } catch (e) {
      logWarn(`Could not write .needs-rebuild marker: ${e}`);
    }
  }

  logInfo(`Makefile flags updated: ${opt} floatAbi=${floatAbi ?? 'auto'} useNano=${opts.useNano ?? true} useNosys=${opts.useNosys ?? true}`);
}

/**
 * Generate the SRCS/OBJ_SPACED/OBJ variable block and the per-file explicit compile
 * rules section from a list of build-gen-relative source paths.
 * Used by refreshDerivedFiles() to fully regenerate the dynamic parts of the Makefile
 * whenever the user adds/removes files via the TreeView.
 */
export function generateCompileRuleSection(
  buildRelPaths: string[],
  extraFlagsMap?: Map<string, string>,
): {
  srcsClean: string;
  objVarBlock: string;  // "# Space-path ...\nOBJ_SPACED := ...\n" + "OBJ := ..."  or just "OBJ := ..."
  rulesBlock: string;   // text between "# ---- Per-source explicit rules" and "# ---- Dirs ----"
} {
  const compilable = buildRelPaths.filter(s => /\.(c|cpp|s|S)$/i.test(s));
  const spacedSrcs = compilable.filter(s => s.replace(/\\/g, '/').includes(' '));
  const cleanSrcs  = compilable.filter(s => !s.replace(/\\/g, '/').includes(' '));
  const spacedObjs = spacedSrcs.map(s => {
    const base = s.replace(/\\/g, '/').split('/').pop()!.replace(/\.(c|cpp|s|S)$/i, '.o');
    return `$(BUILD)/spaced/${base}`;
  });

  const srcsClean = cleanSrcs.join(' ');

  const objSpacedPrefix = spacedObjs.length
    ? `# Space-path files cannot appear in SRCS (Make splits on spaces); listed explicitly.\nOBJ_SPACED := ${spacedObjs.join(' ')}\n`
    : '';
  const objLine = `OBJ := $(OBJ_C) $(OBJ_CPP) $(OBJ_S) $(OBJ_S2)${spacedObjs.length ? ' $(OBJ_SPACED)' : ''}`;
  const objVarBlock = objSpacedPrefix + objLine;

  const cRules = cleanSrcs.filter(s => s.endsWith('.c')).map(src => {
    const norm    = src.replace(/\\/g, '/');
    const obj     = `$(BUILD)/${norm.replace(/\.\.\//g, 'up/').replace(/\.c$/, '.o')}`;
    const extra   = extraFlagsMap?.get(norm) ? ` ${extraFlagsMap.get(norm)}` : '';
    return `\n${obj}: ${norm} | prepdir\n\t-@$(call MKDIR_P,$(dir $@))\n\t@echo CC  ${norm}\n\t@"$(CC)" $(CFLAGS)${extra} -MMD -MP -MF "$(@:.o=.d)" -c "${norm}" -o "$@"`;
  }).join('\n');

  const cppRules = cleanSrcs.filter(s => s.endsWith('.cpp')).map(src => {
    const norm  = src.replace(/\\/g, '/');
    const obj   = `$(BUILD)/${norm.replace(/\.\.\//g, 'up/').replace(/\.cpp$/, '.o')}`;
    const extra = extraFlagsMap?.get(norm) ? ` ${extraFlagsMap.get(norm)}` : '';
    return `\n${obj}: ${norm} | prepdir\n\t-@$(call MKDIR_P,$(dir $@))\n\t@echo CXX ${norm}\n\t@"$(CC)" $(CFLAGS)${extra} -std=c++17 -fno-exceptions -fno-rtti -MMD -MP -MF "$(@:.o=.d)" -c "${norm}" -o "$@"`;
  }).join('\n');

  const asmRules = cleanSrcs.filter(s => /\.(s|S)$/i.test(s)).map(src => {
    const norm = src.replace(/\\/g, '/');
    const obj  = `$(BUILD)/${norm.replace(/\.\.\//g, 'up/').replace(/\.(s|S)$/i, '.o')}`;
    return `\n${obj}: ${norm} | prepdir\n\t-@$(call MKDIR_P,$(dir $@))\n\t@echo AS  ${norm}\n\t@"$(CC)" $(ASFLAGS) -c "${norm}" -o "$@"`;
  }).join('\n');

  const spacedRules = spacedSrcs.length
    ? `# ---- Space-path files (paths with spaces \u2014 cannot appear in SRCS word list) ----\n` +
      spacedSrcs.map(src => {
        const norm    = src.replace(/\\/g, '/');
        const base    = norm.split('/').pop()!.replace(/\.(c|cpp|s|S)$/i, '.o');
        const escaped = norm.replace(/ /g, '\\ ');
        const isCpp   = src.endsWith('.cpp');
        const isAsm   = /\.(s|S)$/i.test(src);
        const extra   = (!isAsm && extraFlagsMap?.get(norm)) ? ` ${extraFlagsMap.get(norm)}` : '';
        const recipe  = isAsm
          ? `\t@"$(CC)" $(ASFLAGS) -c "${norm}" -o "$@"`
          : isCpp
            ? `\t@"$(CC)" $(CFLAGS)${extra} -std=c++17 -fno-exceptions -fno-rtti -MMD -MP -MF "$(@:.o=.d)" -c "${norm}" -o "$@"`
            : `\t@"$(CC)" $(CFLAGS)${extra} -MMD -MP -MF "$(@:.o=.d)" -c "${norm}" -o "$@"`;
        const tag = isAsm ? 'AS ' : isCpp ? 'CXX' : 'CC ';
        return `\n$(BUILD)/spaced/${base}: ${escaped} | prepdir\n\t-@$(call MKDIR_P,$(dir $@))\n\t@echo ${tag} "${norm}"\n${recipe}`;
      }).join('\n') + '\n'
    : '';

  const rulesBlock = `${cRules}\n${cppRules}\n\n${asmRules}\n\n${spacedRules}`;
  return { srcsClean, objVarBlock, rulesBlock };
}

/**
 * Lightweight helper: extract device name + RAM/ROM info from a .uvprojx
 * without running the full uv2make conversion. Used by generateTasksAndLaunchAndMakefile
 * as a last-resort fallback when project.settings.json is missing or incomplete.
 */
export function extractDeviceInfoFromUvprojx(
  uvprojxPath: string,
  extPath?: string
): { deviceName?: string; ramOrigin?: string; ramLength?: string; romOrigin?: string; romLength?: string } {
  try {
    const doc = readUvprojx(uvprojxPath);
    const deviceName = extractDeviceNameFromUvproj(doc);
    const t = doc?.Project?.Targets?.Target;
    const first = Array.isArray(t) ? t[0] : t;
    const mem = extractRomRamFromUvproj(first, extPath);
    return { deviceName, ...mem };
  } catch (e: any) {
    logWarn(`extractDeviceInfoFromUvprojx(${path.basename(uvprojxPath)}): ${e?.message ?? e}`);
    return {};
  }
}

/** ─────────────────────────────────────────────────
 *  parseUvmpw — 解析 Keil multi-project workspace
 *  返回 workspace 內所有 sub-project 的路徑（相對於 .uvmpw）
 *  ───────────────────────────────────────────────── */
export interface UvmpwProject {
  /** 相對於 .uvmpw 的路徑，例如 "./Project_52367_AP.uvprojx" */
  relativePath: string;
  /** NodeIsActive === 1 的 project */
  isActive: boolean;
}

// ── SVD lookup via PDSC <debug svd="..."/> ──────────────────────────────────
const _svdPdscRawCache  = new Map<string, string>();
const _svdDeviceCache   = new Map<string, string | undefined>();
let   _svdBundledExtPath = '';

/**
 * Find the SVD file for a device by reading the PDSC <debug svd="..."/> attribute.
 * Inherits svd path from subFamily → family as per CMSIS-Pack spec.
 * Search order: ht32.dfpPath setting → extraPdscPaths → bundled dfp
 */
export function findSvdFile(dfpPath: string, deviceName: string, extPath: string, extraPdscPaths: string[] = []): string | undefined {
  const stripped = deviceName.replace(/_[^_]+$/, '');
  // deviceName and PDSC Dname both use Holtek's uppercase convention; case-sensitive compare is intentional
  const matches  = (name: string) => name === deviceName || name === stripped || name.replace(/_[^_]+$/, '') === stripped;
  const parser   = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '',
    isArray: (name: string) => ['family', 'subFamily', 'device'].includes(name),
  });

  function searchPdsc(pdscPath: string): string | undefined {
    try {
      if (!_svdPdscRawCache.has(pdscPath)) _svdPdscRawCache.set(pdscPath, fs.readFileSync(pdscPath, 'utf8'));
      const doc: any = parser.parse(_svdPdscRawCache.get(pdscPath)!);
      for (const fam of (doc?.package?.devices?.family ?? []) as any[]) {
        const famSvd: string | undefined = fam.debug?.svd;
        for (const subfam of [fam, ...(fam.subFamily ?? [])] as any[]) {
          const subfamSvd: string | undefined = subfam.debug?.svd ?? famSvd;
          for (const dev of (subfam.device ?? []) as any[]) {
            if (!matches(dev.Dname ?? '')) continue;
            const svdRel: string | undefined = dev.debug?.svd ?? subfamSvd;
            if (!svdRel) continue;
            const svdAbs = path.join(path.dirname(pdscPath), svdRel).replace(/\\/g, '/');
            return fs.existsSync(svdAbs) ? svdAbs : undefined;
          }
        }
      }
    } catch { /* malformed PDSC — try next */ }
    return undefined;
  }

  // User-provided dfpPath / extraPdscPaths — skip _svdDeviceCache, always re-evaluate
  if (dfpPath || extraPdscPaths.length > 0) {
    const pdscPaths: string[] = [];
    if (dfpPath) {
      try {
        for (const f of fs.readdirSync(dfpPath))
          if (f.toLowerCase().endsWith('.pdsc')) pdscPaths.push(path.join(dfpPath, f));
      } catch {}
    }
    for (const p of extraPdscPaths) { if (p && fs.existsSync(p)) pdscPaths.push(p); }
    for (const p of pdscPaths) {
      const hit = searchPdsc(p);
      if (hit) return hit;
    }
  }

  // Bundled DFP — build cache on first call, O(1) thereafter
  if (_svdBundledExtPath !== extPath) {
    _svdDeviceCache.clear();
    _svdPdscRawCache.clear();
    _svdBundledExtPath = extPath;
  }
  if (!_svdDeviceCache.has(deviceName)) {
    let found: string | undefined;
    for (const pdscPath of getAllPdscPaths(extPath)) {
      found = searchPdsc(pdscPath);
      if (found) break;
    }
    _svdDeviceCache.set(deviceName, found);
  }
  return _svdDeviceCache.get(deviceName);
}

export function clearSvdCache(): void {
  _svdPdscRawCache.clear();
  _svdDeviceCache.clear();
  _svdBundledExtPath = '';
}

export function parseUvmpw(uvmpwPath: string): UvmpwProject[] {
  const xml = fs.readFileSync(uvmpwPath, 'utf8');
  const parser = new XMLParser({
    isArray: (name: string) => name === 'project'
  });
  const doc = parser.parse(xml);
  const raw: any[] = doc?.ProjectWorkspace?.project;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(p => !!p?.PathAndName)
    .map(p => ({
      relativePath: String(p.PathAndName).replace(/\\/g, '/'),
      isActive: p.NodeIsActive === 1 || p.NodeIsActive === '1'
    }));
}

// ── Project meta (project.meta.json) ─────────────────────────────────────────

export type Meta = {
  projectName: string;
  targetName?: string;
  groups: Record<string, string[]>;
  linkerScripts?: string[];
  isLibrary?: boolean;
  metaVersion?: string;
  fileOptions?: Record<string, FileOption>;
};

export function readProjectMeta(buildGenDir: string): Meta | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(buildGenDir, 'project.meta.json'), 'utf8')) as Meta;
  } catch { return null; }
}

/**
 * Update SRCS, per-file compile rules, flags, and compile_commands.json from meta.
 * VS Code dependencies are injected via opts so this function can run outside the extension.
 */
export async function refreshDerivedFiles(
  buildGenDir: string,
  meta: Meta,
  opts?: {
    skipElfInvalidation?: boolean;
    gccPath?: string;
    onWarn?: (msg: string) => void;
  }
): Promise<void> {
  const buildGenName = path.basename(buildGenDir);
  const wsRoot      = path.dirname(path.dirname(buildGenDir));
  const bgParentDir = path.dirname(buildGenDir);
  const relUp  = path.relative(buildGenDir, wsRoot).replace(/\\/g, '/');
  const allFiles: string[] = Object.values(meta.groups || {}).flat()
    .filter(f => !meta.fileOptions?.[f]?.exclude);
  const buildRelPaths = allFiles.flatMap(f => {
    const n = f.replace(/\\/g, '/');
    if (path.isAbsolute(f) || /^[A-Za-z]:\//.test(n)) {
      return [path.relative(buildGenDir, f.replace(/\//g, path.sep)).replace(/\\/g, '/')];
    }
    const absResolved = path.resolve(wsRoot, f);
    if (absResolved.startsWith(buildGenDir + path.sep) || absResolved === buildGenDir) {
      const relToBg = path.relative(buildGenDir, absResolved).replace(/\\/g, '/');
      return /\.(c|cpp|s|S)$/i.test(relToBg) ? [relToBg] : [];
    }
    if (absResolved.startsWith(bgParentDir + path.sep)) {
      const relPath = path.relative(buildGenDir, absResolved).replace(/\\/g, '/');
      return /\.(c|cpp|s|S|a)$/i.test(relPath) ? [relPath] : [];
    }
    return [relUp + '/' + n];
  });

  fs.writeFileSync(path.join(buildGenDir, 'sources.list'), buildRelPaths.join('\n'));

  const makefilePath = path.join(buildGenDir, 'Makefile');
  if (!fs.existsSync(makefilePath)) return;

  const extraFlagsMap = new Map<string, string>();
  const xoAbsPaths = new Set<string>();
  if (meta.fileOptions) {
    for (const [metaPath, fo] of Object.entries(meta.fileOptions)) {
      if (!fo.xo) continue;
      xoAbsPaths.add(path.resolve(wsRoot, metaPath.replace(/\\/g, path.sep)));
    }
  }
  let stackAnalysisAbsPath: string | undefined;
  let hasMiscOld = false;
  for (const bp of buildRelPaths) {
    const absPath = path.resolve(buildGenDir, bp);
    if (xoAbsPaths.has(absPath)) extraFlagsMap.set(bp, '-mpure-code');
    if (miscCNeedsRedefine(absPath)) { hasMiscOld = true; patchMiscCWeak(absPath); }
    if (/ht32_stack_analysis\.c$/i.test(bp)) { stackAnalysisAbsPath = absPath; }
  }
  if (stackAnalysisAbsPath) {
    if (hasMiscOld) ensureStackAnalysisStrong(stackAnalysisAbsPath);
    else            ensureStackAnalysisWeak(stackAnalysisAbsPath);
  }
  const { srcsClean, objVarBlock, rulesBlock } = generateCompileRuleSection(buildRelPaths, extraFlagsMap);

  let mk = fs.readFileSync(makefilePath, 'utf8');

  mk = mk.replace(/^SRCS\s*:=.*$/m, `SRCS := ${srcsClean}`);

  const libFiles = buildRelPaths.filter(s => /\.(a|o)$/i.test(s));
  const libsLine = `LIBS := ${libFiles.join(' ')}`;
  if (/^LIBS\s*:=/m.test(mk)) {
    mk = mk.replace(/^LIBS\s*:=.*$/m, libsLine);
  } else {
    mk = mk.replace(/^(SRCS\s*:=.*)$/m, `$1\n${libsLine}`);
    mk = mk.replace(
      /^(\$\(BUILD\)\/\$\(TARGET\)\.elf:\s*\$\(OBJ\))\s*\|\s*\$\(BUILD\)\s*$/m,
      '$(BUILD)/$(TARGET).elf: $(OBJ) $(LIBS) linker_script.ld | $(BUILD)'
    );
    mk = mk.replace(
      /@"(\$\(LD\))" \$\(CFLAGS\) \$\(OBJ\) -o/,
      '@"$1" $(CFLAGS) $(OBJ) $(LIBS) -o'
    );
  }

  mk = mk.replace(/^# Space-path files[^\n]*\nOBJ_SPACED\s*:=[^\n]*\n/m, '');
  mk = mk.replace(/^OBJ\s*:=.*$/m, objVarBlock);

  const oldRulesMatch = mk.match(/(?:# ---- 為每個源文件生成專屬規則（避免 VPATH） ----|# ---- Per-source explicit rules \(avoids VPATH\) ----)[\s\S]*?(?=# ---- Dirs ----)/);
  const newRulesSection = `# ---- Per-source explicit rules (avoids VPATH) ----\n${rulesBlock}\n`;
  mk = mk.replace(
    /(?:# ---- 為每個源文件生成專屬規則（避免 VPATH） ----|# ---- Per-source explicit rules \(avoids VPATH\) ----)[\s\S]*?(?=# ---- Dirs ----)/,
    newRulesSection
  );

  if (!mk.includes('# ---- Dirs ----')) {
    const warnMsg = `Makefile in "${buildGenName}" is outdated — compile rules may be incorrect. ` +
      `Run "HT32: Regenerate Makefile" from the Command Palette.`;
    (opts?.onWarn ?? logWarn)(warnMsg);
    return;
  }

  fs.writeFileSync(makefilePath, mk);

  if (oldRulesMatch && oldRulesMatch[0] !== newRulesSection) {
    try { fs.writeFileSync(path.join(buildGenDir, '.needs-rebuild'), '', 'utf8'); } catch {}
  }

  const bgProjSettings = readProjectSettings(buildGenDir);
  if (bgProjSettings.mcu) {
    const bgBuildMeta = { mcu: bgProjSettings.mcu!, targetName: bgProjSettings.targetName ?? 'firmware' };
    try {
      regenerateMakefileFlags(buildGenDir, bgBuildMeta, {
        optimizationLevel: bgProjSettings.optimizationLevel || undefined,
        debugInfo:         bgProjSettings.debugInfo         || undefined,
        useNano:           bgProjSettings.useNano,
        useNosys:          bgProjSettings.useNosys,
        fpu:               (bgProjSettings.fpu && bgProjSettings.fpu !== 'none') ? bgProjSettings.fpu : undefined,
        floatAbi:          bgProjSettings.floatAbi as any   || undefined,
        extraCFlags:       bgProjSettings.extraCFlags        || undefined,
        extraLDFlags:      bgProjSettings.extraLDFlags       || undefined,
        extraLibs:         (bgProjSettings.extraLibs         ?? []).filter(Boolean),
        extraLibNames:     (bgProjSettings.extraLibNames     ?? []).filter(Boolean),
        extraLibPaths:     (bgProjSettings.extraLibPaths     ?? []).filter(Boolean),
        useLto:            bgProjSettings.useLto             ?? false,
        printfFloat:       bgProjSettings.printfFloat        ?? false,
        scanfFloat:        bgProjSettings.scanfFloat         ?? false,
        gcSections:        bgProjSettings.gcSections,
        includePaths:      bgProjSettings.includePaths       ?? [],
        cDefs:             bgProjSettings.cDefs              ?? [],
        aDefs:             bgProjSettings.aDefs              ?? [],
        outputName:        bgProjSettings.outputName?.trim() || undefined,
        cc:                opts?.gccPath || undefined,
      });
    } catch { /* Makefile might not exist for new projects mid-creation */ }
  }

  try {
    await writeCCDbFromLists(buildGenDir, {
      armCore:     bgProjSettings.mcu || 'cortex-m0plus',
      fpu:         (bgProjSettings.fpu && bgProjSettings.fpu !== 'none') ? bgProjSettings.fpu : undefined,
      floatAbi:    bgProjSettings.floatAbi as any || undefined,
      optimization: bgProjSettings.optimizationLevel || undefined,
      debugInfo:   bgProjSettings.debugInfo || undefined,
      gccFullPath: opts?.gccPath ?? undefined,
      gcSections:  bgProjSettings.gcSections,
    });
  } catch (e) {
    (opts?.onWarn ?? logWarn)(`refreshDerivedFiles: compile_commands.json update failed: ${e}`);
  }

  if (meta.linkerScripts?.[0]) {
    const ldPath = path.resolve(buildGenDir, meta.linkerScripts[0]);
    try {
      patchLinkerScriptRom(ldPath, meta.fileOptions);
    } catch (e: any) {
      (opts?.onWarn ?? logWarn)(`refreshDerivedFiles: linker script ROM patch failed: ${e?.message ?? e}`);
    }
  }

  if (!opts?.skipElfInvalidation) {
    try {
      const buildDir = path.join(buildGenDir, 'build');
      if (fs.existsSync(buildDir)) {
        for (const f of fs.readdirSync(buildDir)) {
          if (/\.(elf|bin|hex|map)$/i.test(f)) {
            fs.unlinkSync(path.join(buildDir, f));
          }
        }
      }
    } catch (e) {
      (opts?.onWarn ?? logWarn)(`refreshDerivedFiles: stale ELF cleanup failed: ${e}`);
    }
  }
}
