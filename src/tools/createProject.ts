// src/tools/createProject.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { find49xGccDir, generateStackAnalysis, lookupSramFromSettings, lookupMemoryFromPdsc, detectFpuPresentFromHeader, patchLdStackSections, specsFlags, buildMakefileFromProjectSettings, writeCCDbFromLists, MIN_HEAP_SIZE, bundledGnuDirFromFwlRoot } from './uv2make';
import { locateArmGcc } from './toolchain';
import { readProjectSettings, writeProjectSettings } from './settingsWebview';
import { writeProjectLists } from './utils';

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export type FwlibSeries = 'std' | '49x';

export interface WizardResult {
  fwlibPath:    string;
  series:       FwlibSeries;
  chipSuffix:   string;   // "52352" (standard) or "HT32F49163" (49x)
  displayName:  string;   // "HT32F52352"
  projectName:  string;
  projectFolder: string;  // workspace root
  outputType:   'app' | 'lib';
  usePrintf:    boolean;
  useNano?:     boolean;
  useNosys?:    boolean;
}

export interface GenerateResult {
  elfPath:    string;   // relative to workspace root (.elf for app, .a for lib)
  deviceName: string;   // e.g. "HT32F52352"
  mcu:        string;   // e.g. "cortex-m0"
  ramOrigin:  string;
  ramLength:  string;
  outputType: 'app' | 'lib';
}

interface ParsedMk {
  armCore:       string;   // "cortex-m0" | "cortex-m3" | "cortex-m4"
  chipName:      string;   // "52352"
  startupName:   string;   // "startup_ht32f5xxxx_gcc_01"
  familyTag:     string;   // "f5xxxx" | "f4xxxx" | "f1xxxx"
  defines:       string[]; // without -D, e.g. ["USE_HT32_DRIVER", "USE_HT32F52352_SK"]
  htChipNum:     string;   // USE_HT32_CHIP value, e.g. "4"
  asmDefines:    string[]; // ASM-only defines (e.g. ["USE_HT32_CHIP=4"])
  systemFile:    string;   // e.g. "system_ht32f1xxxx_02.c" (from SOURCE_NAME_PATH)
  itFile:        string;   // e.g. "ht32f1xxxx_01_it.c"     (from SOURCE_NAME_PATH)
  libFiles:      string[]; // driver .c basenames from $(HT32_LIB_PATH)xxx.c lines
  usbFiles:      string[]; // USB .c basenames from $(HT32_USB_PATH)xxx.c lines (may be empty)
  usbAbsSrcDir:  string;   // absolute path to HT32_USBD_Library/src (empty if no USB)
  incsRel:       string[]; // FWLib-root-relative include paths parsed from INCLUDE_PATH lines
}

// ─────────────────────────────────────────────────────────
// FWLib detection
// ─────────────────────────────────────────────────────────

export function detectFwlibSeries(fwlibPath: string): FwlibSeries | undefined {
  // 方法一：目錄名稱（Holtek 命名慣例）
  const dirName = path.basename(fwlibPath);
  const byName: FwlibSeries | undefined =
    /HT32_STD_\w+_FWLib/i.test(dirName) ? 'std' :
    /HT32\w*49\w*_FWLib/i.test(dirName)  ? '49x' : undefined;

  // Step 2：內部結構（不依賴目錄名稱）
  // STD：library/ 下有 HT32*xxxx_Driver 目錄（與 Convert 判斷邏輯一致，project_template/ 有無不影響）
  // 49x：libraries/drivers/src/ 下有 ht32*49*.c
  let byContent: FwlibSeries | undefined;
  try {
    const libEntries = fs.readdirSync(path.join(fwlibPath, 'library'));
    if (libEntries.some(e => /^HT32[A-Za-z]+\d+xxxx_Driver$/i.test(e))) byContent = 'std';
  } catch { /* no library/ dir */ }
  if (!byContent) try {
    const files = fs.readdirSync(path.join(fwlibPath, 'libraries', 'drivers', 'src'));
    if (files.some(f => /^ht32\w*49/i.test(f))) byContent = '49x';
  } catch { /* not a 49x FWLib */ }

  // 兩者一致最理想；任一有結果也接受（互補：目錄改名靠內容、內容變動靠目錄名）
  return byName === byContent ? byName : (byName ?? byContent);
}

// ─────────────────────────────────────────────────────────
// FWLib family helpers
// ─────────────────────────────────────────────────────────

/** Derive chip name prefix (e.g. "HT32F" or "HT32L") from FWLib library/ directory. */
function fwlibFamilyPrefix(fwlibPath: string): string {
  try {
    const libDir = path.join(fwlibPath, 'library');
    const driverDir = fs.readdirSync(libDir).find(d => /^HT32\w+_Driver$/i.test(d));
    if (driverDir) return driverDir.replace(/_Driver$/i, '').replace(/\d*xxxx$/i, '');
  } catch { /* fall through */ }
  return 'HT32F';
}

/**
 * Resolve the exact MCU display name from a list of C defines.
 * USE_MEM_xxx (e.g. USE_MEM_HT50L3200U) is the authoritative chip name and takes priority
 * over the FWLib-prefix+suffix default, handling cases where the chip prefix differs from
 * the FWLib family (e.g. HT50L chips inside a HT32L FWLib).
 * Falls back to defaultPrefix + chipSuffix.toUpperCase() when USE_MEM_ is absent.
 */
function resolveStdDisplayName(defines: string[], chipSuffix: string, defaultPrefix: string): string {
  const mem = defines.find(d => d.startsWith('USE_MEM_'));
  return mem ? mem.replace('USE_MEM_', '') : `${defaultPrefix}${chipSuffix.toUpperCase()}`;
}

// ─────────────────────────────────────────────────────────
// MCU listing
// ─────────────────────────────────────────────────────────

export function listStdMcus(fwlibPath: string, extPath?: string): Array<{chipSuffix: string; displayName: string; mkPath: string}> {
  const fwlGnuDir     = path.join(fwlibPath, 'project_template', 'IP', 'Example', 'GNU_ARM');
  const bundledGnuDir = extPath ? bundledGnuDirFromFwlRoot(fwlibPath, extPath) : undefined;
  const gnuDir        = fs.existsSync(fwlGnuDir) ? fwlGnuDir : bundledGnuDir;
  const defaultPrefix = fwlibFamilyPrefix(fwlibPath);
  if (!gnuDir) return [];
  try {
    return fs.readdirSync(gnuDir)
      .filter(f => /^[\da-zA-Z]+\.mk$/.test(f))
      .map(f => {
        const mkPath = path.join(gnuDir, f);
        const chipSuffix = f.replace(/\.mk$/, '');
        const defines: string[] = [];
        try {
          for (const m of fs.readFileSync(mkPath, 'utf8').matchAll(/^C_OPTION\s*\+=\s*-D(\w+)/mg))
            defines.push(m[1]);
        } catch { /* keep default */ }
        return { chipSuffix, displayName: resolveStdDisplayName(defines, chipSuffix, defaultPrefix), mkPath };
      })
      .sort((a, b) => a.chipSuffix.localeCompare(b.chipSuffix));
  } catch { return []; }
}

export function list49xMcus(fwlibPath: string): Array<{chipSuffix: string; displayName: string; ldPath: string}> {
  const gccDir_         = find49xGccDir(fwlibPath) ?? path.join(fwlibPath, 'libraries', 'cmsis', 'cm4', 'device_support', 'startup', 'gcc');
  const linkerDir       = path.join(gccDir_, 'linker');
  const deviceSupportDir = path.join(fwlibPath, 'libraries', 'cmsis', 'cm4', 'device_support');
  try {
    // Chip models from linker scripts
    const ldFiles = fs.readdirSync(linkerDir).filter(f => f.endsWith('_FLASH.ld'));
    const ldMap: Record<string, string> = {};
    for (const f of ldFiles) ldMap[f.replace('_FLASH.ld', '')] = path.join(linkerDir, f);

    // Package variants from device headers: USE_HT32F49395_100LQFP, USE_HT32F49395_48QFN, etc.
    // Pattern: _<digits><LETTERS> (e.g. _100LQFP, _48QFN) — excludes non-package suffixes like _SK
    const seen = new Set<string>();
    const variants: Record<string, string[]> = {};
    for (const chipModel of Object.keys(ldMap)) variants[chipModel] = [];

    try {
      for (const hf of fs.readdirSync(deviceSupportDir).filter(f => f.endsWith('.h'))) {
        const text = fs.readFileSync(path.join(deviceSupportDir, hf), 'utf8');
        for (const m of text.matchAll(/USE_(HT32[A-Za-z]\d[\w]*_\d+[A-Z]+)/g)) {
          const fullName = m[1];   // e.g. "HT32F49395_100LQFP"
          if (seen.has(fullName)) continue;
          seen.add(fullName);
          for (const chipModel of Object.keys(ldMap)) {
            if (fullName.startsWith(chipModel + '_')) {
              variants[chipModel].push(fullName);
            }
          }
        }
      }
    } catch { /* no device header — fallback below */ }

    const result: Array<{chipSuffix: string; displayName: string; ldPath: string}> = [];
    for (const [chipModel, ldPath] of Object.entries(ldMap)) {
      const pkgs = variants[chipModel];
      if (pkgs.length > 0) {
        for (const displayName of pkgs) {
          result.push({ chipSuffix: chipModel, displayName, ldPath });
        }
      } else {
        // Fallback when no header found
        result.push({ chipSuffix: chipModel, displayName: `${chipModel}_100LQFP`, ldPath });
      }
    }
    return result.sort((a, b) => a.displayName.localeCompare(b.displayName));
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────
// .mk parsing (standard series)
// ─────────────────────────────────────────────────────────

function parseMkFile(mkPath: string): ParsedMk {
  const text = fs.readFileSync(mkPath, 'utf8');

  const armCore      = /^ARM_CORE\s*=\s*(\S+)/m.exec(text)?.[1]?.trim() ?? 'cortex-m0';
  const chipName     = /^CHIP_NAME\s*=\s*(\S+)/m.exec(text)?.[1]?.trim() ?? '';
  const startupName  = /^STARTUP\s*=\s*(\S+)/m.exec(text)?.[1]?.trim() ?? '';

  // "startup_ht32f5xxxx_gcc_01" → familyTag "f5xxxx"; "startup_ht32l5xxxx_gcc_01" → "l5xxxx"
  const familyTag = /startup_ht32([a-z]\d\w+)_gcc/i.exec(startupName)?.[1] ?? 'f5xxxx';

  const defines: string[] = [];
  for (const m of text.matchAll(/^C_OPTION\s*\+=\s*-D(\S+)/mg)) {
    defines.push(m[1]);
  }

  const htChipNum = /--defsym\s+USE_HT32_CHIP=(\d+)/.exec(text)?.[1] ?? '1';
  // USE_HT32_CHIP is assembler-only (--defsym), goes to adefines.list not defines.list
  const asmDefines = [`USE_HT32_CHIP=${htChipNum}`];

  // Extract exact filenames from SOURCE_NAME_PATH (../system_*.c and ../ht32*_it.c)
  // These may differ from startup suffix — e.g. HT32F12345 uses startup_01 but system_02.c
  const systemFileM = /SOURCE_NAME_PATH\s*\+=\s*\.\.\/(system_[\w]+\.c)/m.exec(text);
  const itFileM     = /SOURCE_NAME_PATH\s*\+=\s*\.\.\/(ht32[\w]+_it\.c)/m.exec(text);
  const systemFile  = systemFileM?.[1] ?? `system_ht32${familyTag}_01.c`;
  const itFile      = itFileM?.[1]     ?? `ht32${familyTag}_01_it.c`;

  // Extract per-MCU driver file list from $(HT32_LIB_PATH) and $(HT32_USB_PATH) lines.
  // This is critical: driver variants like ht32f1xxxx_adc_02.c exist alongside
  // ht32f1xxxx_adc.c; only the .mk knows which variant this MCU uses.
  const libFiles: string[] = [];
  for (const m of text.matchAll(/\$\(HT32_LIB_PATH\)([\w.]+\.c)/g)) { libFiles.push(m[1]); }

  const usbFiles: string[] = [];
  for (const m of text.matchAll(/\$\(HT32_USB_PATH\)([\w.]+\.c)/g)) { usbFiles.push(m[1]); }

  const mkDir = path.dirname(mkPath);
  const fwlibPath = path.resolve(mkDir, '..', '..', '..', '..');  // GNU_ARM → Template → IP → project_template → fwlib root
  const usbSrcRaw = /^HT32_USB_PATH\s*=\s*(.+)/m.exec(text)?.[1]?.trim() ?? '';
  const usbAbsSrcDir = usbSrcRaw ? path.resolve(mkDir, usbSrcRaw) : '';

  // Extract all INCLUDE_PATH entries and convert to fwlib-root-relative paths.
  // Skip entries pointing into project_template/ (e.g. -I./../ which is the example dir).
  const incsRel: string[] = [];
  for (const m of text.matchAll(/^INCLUDE_PATH\s*\+=\s*-I([^\s"]+)/mg)) {
    const abs = path.resolve(mkDir, m[1]);
    const rel = path.relative(fwlibPath, abs).replace(/\\/g, '/');
    if (!rel.startsWith('..') && !rel.startsWith('project_template')) incsRel.push(rel);
  }

  return { armCore, chipName, startupName, familyTag, defines, htChipNum, asmDefines, systemFile, itFile, libFiles, usbFiles, usbAbsSrcDir, incsRel };
}

/** 判斷要顯示哪個 usbdconf.h：讀 libcfg.h 看有無 LIBCFG_USBD_V2，找不到 libcfg 則 fallback 到 _01_ */
function resolveUsbdConfHeader(exampleDir: string, driverIncDir: string, chipName: string): string | undefined {
  const candidates = fs.readdirSync(exampleDir).filter(f => f.endsWith('_usbdconf.h'));
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  let isV2 = false;
  try {
    const libcfgName = fs.readdirSync(driverIncDir).find(f => new RegExp(`ht32\\w*${chipName}_libcfg\\.h`, 'i').test(f));
    if (libcfgName) isV2 = fs.readFileSync(path.join(driverIncDir, libcfgName), 'utf8').includes('LIBCFG_USBD_V2');
  } catch { /* 找不到 libcfg → fallback _01_ */ }
  return candidates.find(f => f.includes(isV2 ? '_02_' : '_01_')) ?? candidates[0];
}

// ─────────────────────────────────────────────────────────
// Linker script parsing (for RAM/FLASH info)
// ─────────────────────────────────────────────────────────

/** Set Heap_Size to minHeap in a GCC startup .s if it is currently 0 (does not touch non-zero values). */
function patchStartupHeap(sText: string, minHeap: number): string {
  // Match:  .equ  Heap_Size, 0   (decimal zero only)
  return sText.replace(
    /(\.\s*equ\s+Heap_Size\s*,\s*)0(\s*$)/m,
    `$1${minHeap}$2`
  );
}

/** Patch FLASH and RAM LENGTH fields in a linker script text. */
function patchLdMemory(
  ldText: string,
  flashLength: string | undefined,
  ramLength: string | undefined,
): string {
  let out = ldText;
  if (flashLength) {
    out = out.replace(
      /(FLASH\b[^\n:]*:\s*ORIGIN\s*=\s*0x[\da-fA-F]+\s*,\s*LENGTH\s*=\s*)[\w]+/,
      `$1${flashLength}`
    );
  }
  if (ramLength) {
    out = out.replace(
      /(\bRAM\b[^\n:]*:\s*ORIGIN\s*=\s*0x[\da-fA-F]+\s*,\s*LENGTH\s*=\s*)[\w]+/,
      `$1${ramLength}`
    );
  }
  // Add __StackTop, separate .heap/.stack sections, __HT_check_sp for Stack Usage Analysis.
  return patchLdStackSections(out);
}

function parseLinkerMemory(ldPath: string): { flashOrigin: string; flashLength: string; ramOrigin: string; ramLength: string } {
  const text = fs.readFileSync(ldPath, 'utf8');

  const parseLen = (s: string): string => {
    const m = /^(\d+)([KMkm]?)$/.exec(s.trim());
    if (!m) return s;
    const n = parseInt(m[1]);
    const bytes = m[2].toUpperCase() === 'K' ? n * 1024 : m[2].toUpperCase() === 'M' ? n * 1024 * 1024 : n;
    return '0x' + bytes.toString(16).toUpperCase().padStart(8, '0');
  };

  const flashM = /FLASH\b[^\n:]*:\s*ORIGIN\s*=\s*(0x[\da-fA-F]+)\s*,\s*LENGTH\s*=\s*([\w]+)/i.exec(text);
  const ramM   = /\bRAM\b[^\n:]*:\s*ORIGIN\s*=\s*(0x[\da-fA-F]+)\s*,\s*LENGTH\s*=\s*([\w]+)/i.exec(text);

  return {
    flashOrigin: flashM?.[1] ?? '0x00000000',
    flashLength: flashM ? parseLen(flashM[2]) : '0x00080000',
    ramOrigin:   ramM?.[1]  ?? '0x20000000',
    ramLength:   ramM  ? parseLen(ramM[2])  : '0x00008000',
  };
}

// ─────────────────────────────────────────────────────────
// Printf bridge file generation
// ─────────────────────────────────────────────────────────

function generatePutcharC(): string {
  return [
    '/* HT32 printf bridge — routes eyalroz/printf output through the HT32 retarget layer.',
    '   _write() is provided by ht32_retarget.c (standard series) or the board support',
    '   file (49x series). Both ultimately call SERIAL_PutChar() / UART output.',
    '   Source: https://github.com/eyalroz/printf  (MIT License) */',
    '',
    'extern int _write(int handle, const char *buffer, int size);',
    '',
    'void putchar_(char c)',
    '{',
    '    _write(1, &c, 1);',
    '}',
  ].join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────
// Makefile generation
// ─────────────────────────────────────────────────────────

interface ProjectListsParams {
  fwlibPath:   string;   // absolute, forward slashes
  bgDir:       string;   // absolute path to build-gen dir — all paths computed relative to this
  outputType:  'app' | 'lib';
  incsRel:     string[]; // FWLib-root-relative include paths (without leading /)
  defines:     string[];
  userSrcs:    string[]; // relative from Project e.g. "../../src/main.c"
  fwlibSrcs:   string[]; // relative from fwlib root
  startupFile: string;   // basename e.g. "startup_ht32f5xxxx_gcc_01.s" (unused for lib)
}

function computeProjectLists(p: ProjectListsParams): { allSrcs: string[]; incsStr: string; defsStr: string } {
  const isLib = p.outputType === 'lib';

  const toBgRel = (absPath: string): string => {
    const rel = path.relative(p.bgDir, absPath).replace(/\\/g, '/');
    if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
      throw new Error(
        `Cross-drive path not supported: "${absPath}" is on a different drive from ` +
        `build-gen "${p.bgDir}". Please place the project and FWLib on the same drive.`
      );
    }
    return rel;
  };

  const incsStr = [
    '-Isrc',
    '-IGNU_ARM',
    ...p.incsRel.map(r => `-I"${toBgRel(path.join(p.fwlibPath, r))}"`),
  ].join(' ');
  const defsStr = p.defines.map(d => `-D${d}`).join(' ');

  const allSrcs = [
    ...p.userSrcs.map(s => s.replace(/\\/g, '/')),
    ...p.fwlibSrcs.map(rel => toBgRel(path.join(p.fwlibPath, rel))),
    ...(!isLib ? [p.startupFile.replace(/\\/g, '/')] : []),
    ...(!isLib ? ['GNU_ARM/ht32_stack_analysis.c'] : []),
  ].filter(s => /\.(c|cpp|s|S)$/i.test(s));

  return { allSrcs, incsStr, defsStr };
}

// ─────────────────────────────────────────────────────────
// Series helpers
// ─────────────────────────────────────────────────────────

/** Return the family prefix used in file names for the series (e.g. "f5xxxx") */
/** Return library subdirectory names inside FWLib/library/ for a standard series */
function stdLibSubdirs(fwlibPath: string): { driverInc: string; driverSrc: string; deviceInc: string } {
  const libDir = path.join(fwlibPath, 'library');
  const driverDir = (() => { try { return fs.readdirSync(libDir).find(d => /^HT32\w+_Driver$/i.test(d)); } catch { return undefined; } })()
    ?? 'HT32F5xxxx_Driver';
  const familyName = driverDir.replace(/_Driver$/i, '');  // e.g. "HT32L5xxxx" or "HT32F5xxxx"
  return {
    driverInc: `${driverDir}/inc`,
    driverSrc: `${driverDir}/src`,
    deviceInc: `Device/Holtek/${familyName}/Include`,
  };
}

/** Scan a directory for .c files, return basenames (no directory prefix) */
function scanCFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.c'));
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────
// Wizard — Webview panel
// ─────────────────────────────────────────────────────────

const FWLIB_PATHS_KEY = 'ht32.fwlibPaths';

interface FwlibStoredEntry { fwlibPath: string; label: string; }

let createProjectPanel: vscode.WebviewPanel | undefined;

/** Open (or reveal) the Create HT32 Project webview panel.
 *  onGenerate is called with the validated WizardResult when the user clicks Generate.
 */
export function openCreateProjectPanel(
  ctx: vscode.ExtensionContext,
  defaultFolder: string | undefined,
  onGenerate: (result: WizardResult) => Promise<void>,
  lockedFolder?: string
): void {
  if (createProjectPanel) { createProjectPanel.reveal(); return; }

  createProjectPanel = vscode.window.createWebviewPanel(
    'ht32CreateProject', 'Create HT32 Project',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  const stored: FwlibStoredEntry[] = ctx.globalState.get<FwlibStoredEntry[]>(FWLIB_PATHS_KEY) ?? [];
  createProjectPanel.webview.html = buildCreateProjectHtml(stored, defaultFolder ?? '', lockedFolder);

  createProjectPanel.webview.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {

      case 'browseFwlib': {
        const currentFwlib = (msg.currentPath as string | undefined)?.trim();
        const defaultUri = (currentFwlib && fs.existsSync(currentFwlib))
          ? vscode.Uri.file(currentFwlib) : undefined;
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
          openLabel: 'Select FWLib Root', defaultUri,
        });
        if (!uris?.length) return;
        const p = uris[0].fsPath;
        createProjectPanel?.webview.postMessage({ type: 'fwlibResolved', path: p });
        await postMcuList(p);
        break;
      }

      case 'fwlibChanged': {
        const fwlibPath = msg.path as string;
        if (fwlibPath && !fs.existsSync(fwlibPath)) {
          createProjectPanel?.webview.postMessage({ type: 'fwlibError', message: `Directory not found: ${fwlibPath}` });
          const stored = ctx.globalState.get<FwlibStoredEntry[]>(FWLIB_PATHS_KEY) ?? [];
          await ctx.globalState.update(FWLIB_PATHS_KEY, stored.filter(e => e.fwlibPath !== fwlibPath));
          createProjectPanel?.webview.postMessage({ type: 'recentRemoved', path: fwlibPath });
        } else {
          await postMcuList(fwlibPath);
        }
        break;
      }

      case 'browseFolder': {
        if (lockedFolder) return;
        const currentFolder = (msg.currentFolder as string | undefined)?.trim();
        const defaultUri = (currentFolder && fs.existsSync(currentFolder))
          ? vscode.Uri.file(currentFolder)
          : defaultFolder ? vscode.Uri.file(defaultFolder) : vscode.workspace.workspaceFolders?.[0]?.uri;
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
          openLabel: 'Select Project Folder', defaultUri,
        });
        if (!uris?.length) return;
        createProjectPanel?.webview.postMessage({ type: 'folderResolved', path: uris[0].fsPath });
        break;
      }

      case 'generate': {
        const { fwlibPath, series, chipSuffix, displayName, projectName, projectFolder, outputType, usePrintf } = msg as any;
        try {
          const bgDirName = projectName as string;
          const existingBgDir = path.join(projectFolder, 'HT32_VSCode', bgDirName);
          if (fs.existsSync(existingBgDir)) {
            const answer = await vscode.window.showWarningMessage(
              `"${bgDirName}" already exists in this folder. Overwrite?`,
              { modal: true }, 'Overwrite'
            );
            if (answer !== 'Overwrite') {
              createProjectPanel?.webview.postMessage({ type: 'resetBtn' });
              break;
            }
          }
          const storedPaths = ctx.globalState.get<FwlibStoredEntry[]>(FWLIB_PATHS_KEY) ?? [];
          const lbl = `[${series}] ${path.basename(fwlibPath)}`;
          const filtered = storedPaths.filter(e => e.fwlibPath !== fwlibPath);
          await ctx.globalState.update(FWLIB_PATHS_KEY, [{ fwlibPath, label: lbl }, ...filtered].slice(0, 10));
          createProjectPanel?.dispose();
          await onGenerate({ fwlibPath, series, chipSuffix, displayName, projectName, projectFolder, outputType: outputType ?? 'app', usePrintf: !!usePrintf });
        } catch (e: any) {
          createProjectPanel?.webview.postMessage({ type: 'error', message: e?.message ?? String(e) });
        }
        break;
      }

      case 'cancel':
        createProjectPanel?.dispose();
        break;
    }
  });

  createProjectPanel.onDidDispose(() => { createProjectPanel = undefined; });

  async function postMcuList(fwlibPath: string) {
    if (!fwlibPath || !fs.existsSync(fwlibPath)) {
      createProjectPanel?.webview.postMessage({ type: 'mcuList', series: null, mcus: [] });
      return;
    }
    const series = detectFwlibSeries(fwlibPath);
    if (!series) {
      createProjectPanel?.webview.postMessage({
        type: 'mcuList', series: null, mcus: [],
        error: `Cannot detect FWLib series in "${path.basename(fwlibPath)}"`,
      });
      return;
    }
    const extPath = ctx.extensionUri.fsPath;
    const mcus = series === 'std'
      ? listStdMcus(fwlibPath, extPath).map(m => ({ chipSuffix: m.chipSuffix, displayName: m.displayName }))
      : list49xMcus(fwlibPath).map(m => ({ chipSuffix: m.chipSuffix, displayName: m.displayName }));
    createProjectPanel?.webview.postMessage({ type: 'mcuList', series, mcus, suggestFolder: fwlibPath });
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildCreateProjectHtml(stored: FwlibStoredEntry[], defaultFolder: string, lockedFolder?: string): string {
  const storedJson = JSON.stringify(stored.map(e => ({ path: e.fwlibPath, label: e.label })));
  const defaultFolderJson = JSON.stringify(defaultFolder);
  const lockedFolderJson  = JSON.stringify(lockedFolder ?? null);

  const recentRows = stored.map((e, i) => `
    <div class="recent-item" onclick="selectRecent(${i})" title="${escHtml(e.fwlibPath)}">
      <span class="recent-label">${escHtml(e.label)}</span>
      <span class="recent-path">${escHtml(e.fwlibPath)}</span>
    </div>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 20px 28px 40px;
    max-width: 660px;
  }
  h1 { font-size: 1.1em; margin: 0 0 4px; }
  h2 {
    font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--vscode-descriptionForeground);
    margin: 22px 0 8px;
    border-bottom: 1px solid var(--vscode-widget-border);
    padding-bottom: 3px;
  }
  .hint { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  .row { margin-bottom: 10px; }
  label.field { display: block; margin-bottom: 4px; font-weight: 500; }
  input[type=text], select {
    width: 100%; box-sizing: border-box;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 5px 8px; border-radius: 2px; font-size: inherit;
    font-family: inherit;
  }
  input[type=text]:focus, select:focus {
    outline: 1px solid var(--vscode-focusBorder);
    border-color: var(--vscode-focusBorder);
  }
  input.invalid { border-color: var(--vscode-inputValidation-errorBorder) !important; }
  .flex { display: flex; gap: 6px; align-items: stretch; }
  .flex input, .flex select { flex: 1; }
  button {
    padding: 5px 14px; border: none; border-radius: 2px; cursor: pointer;
    font-size: var(--vscode-font-size); font-family: var(--vscode-font-family);
    white-space: nowrap;
  }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .btn-primary:disabled { opacity: 0.45; cursor: default; }
  .btn-secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .badge {
    display: inline-block; padding: 1px 9px; border-radius: 10px;
    font-size: 0.8em; margin-top: 5px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .badge.err {
    background: var(--vscode-inputValidation-errorBackground);
    color: var(--vscode-inputValidation-errorForeground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
  }
  .recent-list { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
  .recent-item {
    display: flex; gap: 10px; align-items: baseline;
    padding: 3px 6px; border-radius: 2px; cursor: pointer;
    font-size: 0.85em;
  }
  .recent-item:hover { background: var(--vscode-list-hoverBackground); }
  .recent-label { color: var(--vscode-foreground); white-space: nowrap; }
  .recent-path { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .radio-group { display: flex; gap: 20px; margin-top: 2px; }
  .radio-group label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .footer { margin-top: 28px; display: flex; gap: 8px; }
  #errorBox {
    display: none; padding: 8px 12px; border-radius: 3px; margin-bottom: 14px;
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
    color: var(--vscode-inputValidation-errorForeground);
    font-size: 0.9em;
  }
  .mcu-combo { position: relative; }
  .mcu-dropdown {
    position: absolute; z-index: 200; width: 100%;
    max-height: 220px; overflow-y: auto;
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-focusBorder);
    border-top: none; border-radius: 0 0 2px 2px;
    box-shadow: 0 4px 8px rgba(0,0,0,0.3);
    display: none;
  }
  .mcu-item { padding: 4px 8px; cursor: pointer; }
  .mcu-item:hover, .mcu-item.active {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  .mcu-no-match { padding: 4px 8px; color: var(--vscode-descriptionForeground); font-style: italic; }
</style>
</head>
<body>
<h1>Create HT32 Project</h1>
<p class="hint" style="margin:0 0 4px">Generate a new HT32 project with Makefile and VS Code build/debug configuration.</p>

<div id="errorBox"></div>

<h2>FWLib</h2>
<div class="row">
  <label class="field">FWLib Root Path</label>
  <div class="flex">
    <input type="text" id="fwlibPath" placeholder="Path to HT32 FWLib root…" oninput="onFwlibInput()">
    <button class="btn-secondary" onclick="browseFwlib()">Browse…</button>
  </div>
  <div id="seriesBadge"></div>
  <div id="fwlibErrorMsg" style="display:none;color:var(--vscode-inputValidation-errorForeground);font-size:0.85em;margin-top:2px;"></div>
</div>
${stored.length > 0 ? `<div class="row">
  <span class="hint">Recent</span>
  <div id="recentList" class="recent-list">${recentRows}</div>
</div>` : ''}

<h2>MCU</h2>
<div class="row">
  <div class="mcu-combo">
    <input type="text" id="mcuInput" disabled autocomplete="off"
      placeholder="— Select FWLib first —"
      oninput="onMcuInput()" onfocus="onMcuFocus()" onblur="onMcuBlur()" onkeydown="onMcuKey(event)">
    <button type="button" id="mcuArrow" disabled tabindex="-1"
      onmousedown="event.preventDefault();document.getElementById('mcuInput').focus();onMcuFocus();"
      style="position:absolute;right:4px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;padding:2px 6px;color:var(--vscode-input-foreground);opacity:0.7">▾</button>
    <div id="mcuDropdown" class="mcu-dropdown"></div>
  </div>
</div>

<h2>Project</h2>
<div class="row">
  <label class="field">Output Type</label>
  <div class="radio-group">
    <label><input type="radio" name="outputType" value="app" checked onchange="checkReady()"> Executable (.elf)</label>
    <label><input type="radio" name="outputType" value="lib" onchange="checkReady()"> Library (.a)</label>
  </div>
</div>
<div class="row">
  <label class="field">Project Name</label>
  <input type="text" id="projectName" placeholder="e.g. HT32_52352" oninput="onNameInput(this)">
  <p class="hint" style="margin-top:3px">Used for ELF/HEX filename. Allowed: letters, digits, _ - .</p>
</div>
<div class="row">
  <label class="field">Project Folder</label>
  <div class="flex">
    <input type="text" id="projectFolder" placeholder="Select folder…" oninput="folderManuallyEdited=true;checkReady()">
    <button class="btn-secondary" id="browseFolderBtn" onclick="browseFolder()">Browse…</button>
  </div>
</div>

<div class="footer">
  <button class="btn-primary" id="generateBtn" onclick="generate()" disabled>Generate</button>
  <button class="btn-secondary" onclick="cancel()">Cancel</button>
</div>

<script>
const vscode = acquireVsCodeApi();
const STORED = ${storedJson};
const DEFAULT_FOLDER = ${defaultFolderJson};
const LOCKED_FOLDER  = ${lockedFolderJson};
let currentSeries = null;
let currentMcus   = [];
let mcuSelectedValue = '';
let pendingMcuSelection = null;
let mcuActiveIndex   = -1;
let nameManuallyEdited   = false;
let folderManuallyEdited = false;

// Pre-fill project folder; lock if in "Add New Project" mode
if (LOCKED_FOLDER) {
  const fi = document.getElementById('projectFolder');
  fi.value    = LOCKED_FOLDER;
  fi.readOnly = true;
  fi.style.opacity = '0.6';
  fi.style.cursor  = 'default';
  document.getElementById('browseFolderBtn').style.display = 'none';
} else if (DEFAULT_FOLDER) {
  document.getElementById('projectFolder').value = DEFAULT_FOLDER;
}

function e(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'); }

function renderRecentList() {
  const list = document.getElementById('recentList');
  if (!list) return;
  list.innerHTML = STORED.map((entry, i) =>
    '<div class="recent-item" onclick="selectRecent(' + i + ')" title="' + e(entry.path) + '">' +
    '<span class="recent-label">' + e(entry.label) + '</span>' +
    '<span class="recent-path">' + e(entry.path) + '</span>' +
    '</div>'
  ).join('');
}

function selectRecent(i) {
  const entry = STORED.splice(i, 1)[0];
  STORED.unshift(entry);
  renderRecentList();
  document.getElementById('fwlibPath').value = entry.path;
  vscode.postMessage({ type: 'fwlibChanged', path: entry.path });
}


let fwlibTimer = null;
function onFwlibInput() {
  clearTimeout(fwlibTimer);
  fwlibTimer = setTimeout(() => {
    const p = document.getElementById('fwlibPath').value.trim();
    if (p) vscode.postMessage({ type: 'fwlibChanged', path: p });
    else   updateMcuList(null, []);
  }, 500);
}

function browseFwlib()  { vscode.postMessage({ type: 'browseFwlib', currentPath: document.getElementById('fwlibPath').value.trim() }); }
function browseFolder() {
  folderManuallyEdited = true;
  const current = document.getElementById('projectFolder').value.trim();
  vscode.postMessage({ type: 'browseFolder', currentFolder: current });
}
function cancel()       { vscode.postMessage({ type: 'cancel' }); }

function onNameInput(el) {
  nameManuallyEdited = true;
  el.classList.toggle('invalid', el.value.length > 0 && !/^[\\w.-]+$/.test(el.value));
  checkReady();
}

function updateMcuList(series, mcus, error) {
  currentSeries = series;
  currentMcus   = mcus || [];
  const inp   = document.getElementById('mcuInput');
  const badge = document.getElementById('seriesBadge');

  if (error) {
    badge.innerHTML = '<span class="badge err">' + e(error) + '</span>';
    inp.placeholder = '— Error —';
    inp.value = ''; inp.disabled = true;
    document.getElementById('mcuArrow').disabled = true;
    mcuSelectedValue = '';
  } else if (!series) {
    badge.innerHTML = '';
    inp.placeholder = '— Select FWLib first —';
    inp.value = ''; inp.disabled = true;
    document.getElementById('mcuArrow').disabled = true;
    mcuSelectedValue = '';
  } else {
    badge.innerHTML = '<span class="badge">' + e(series) + '</span>';
    inp.disabled = false;
    document.getElementById('mcuArrow').disabled = false;
    inp.placeholder = 'Type to select…';
    if (currentMcus.length > 0) {
      setMcuValue(currentMcus[0].displayName);
    } else {
      inp.value = ''; mcuSelectedValue = '';
    }
  }
  checkReady();
}

function onMcuItemDown(idx) {
  const m = currentMcus[idx];
  if (!m) return;
  pendingMcuSelection = m.displayName;
  setMcuValue(m.displayName);
}

function setMcuValue(displayName) {
  mcuSelectedValue = displayName;
  document.getElementById('mcuInput').value = displayName;
  mcuActiveIndex = -1;
  closeMcuDropdown();
  onMcuChange();
}

function onMcuChange() {
  if (!nameManuallyEdited) {
    const m = currentMcus.find(x => x.displayName === mcuSelectedValue);
    if (m) {
      // Strip HT32F prefix to avoid "HT32_HT32F49395"; keep numeric suffix for standard series
      const suffix = m.chipSuffix.replace(/^HT32[A-Za-z]/i, '') || m.chipSuffix;
      document.getElementById('projectName').value = 'HT32_' + suffix;
    }
  }
  checkReady();
}

function onMcuInput() {
  const q = document.getElementById('mcuInput').value.toLowerCase();
  renderMcuDropdown(q);
  showMcuDropdown();
  checkReady();
}

function onMcuFocus() {
  renderMcuDropdown(document.getElementById('mcuInput').value.toLowerCase());
  showMcuDropdown();
}

function onMcuBlur() {
  setTimeout(() => {
    if (pendingMcuSelection !== null) {
      setMcuValue(pendingMcuSelection);
      pendingMcuSelection = null;
      return;
    }
    const inp = document.getElementById('mcuInput');
    if (!mcuSelectedValue) {
      const q = inp.value.toLowerCase();
      const m = currentMcus.find(x => x.displayName.toLowerCase() === q);
      if (m) { setMcuValue(m.displayName); return; }
    }
    inp.value = mcuSelectedValue;
    closeMcuDropdown();
    checkReady();
  }, 150);
}

function onMcuKey(e) {
  const dd = document.getElementById('mcuDropdown');
  const items = dd.querySelectorAll('.mcu-item');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    mcuActiveIndex = Math.min(mcuActiveIndex + 1, items.length - 1);
    updateMcuActive(items);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    mcuActiveIndex = Math.max(mcuActiveIndex - 1, 0);
    updateMcuActive(items);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (mcuActiveIndex >= 0 && items[mcuActiveIndex]) {
      items[mcuActiveIndex].dispatchEvent(new MouseEvent('mousedown'));
    }
  } else if (e.key === 'Escape') {
    document.getElementById('mcuInput').value = mcuSelectedValue;
    closeMcuDropdown();
  }
}

function updateMcuActive(items) {
  items.forEach((el, i) => el.classList.toggle('active', i === mcuActiveIndex));
  if (items[mcuActiveIndex]) { items[mcuActiveIndex].scrollIntoView({ block: 'nearest' }); }
}

function renderMcuDropdown(filter) {
  const dd = document.getElementById('mcuDropdown');
  dd.innerHTML = currentMcus.map((m, i) =>
    '<div class="mcu-item" onmousedown="onMcuItemDown(' + i + ')">' + e(m.displayName) + '</div>'
  ).join('');
  mcuActiveIndex = -1;
  mcuSelectedValue = '';
  if (filter) {
    // startsWith takes priority over contains
    let idx = currentMcus.findIndex(m => m.displayName.toLowerCase().startsWith(filter));
    if (idx < 0) { idx = currentMcus.findIndex(m => m.displayName.toLowerCase().includes(filter)); }
    if (idx >= 0) {
      mcuActiveIndex = idx;
      mcuSelectedValue = currentMcus[idx].displayName;
      updateMcuActive(dd.querySelectorAll('.mcu-item'));
      onMcuChange();
    }
  }
}

function showMcuDropdown() {
  if (currentMcus.length > 0) { document.getElementById('mcuDropdown').style.display = 'block'; }
}

function closeMcuDropdown() {
  document.getElementById('mcuDropdown').style.display = 'none';
}

function checkReady() {
  const fwlib  = document.getElementById('fwlibPath').value.trim();
  const name   = document.getElementById('projectName').value.trim();
  const folder = document.getElementById('projectFolder').value.trim();
  const ok = fwlib && currentSeries && mcuSelectedValue && /^[\\w.-]+$/.test(name) && folder;
  document.getElementById('generateBtn').disabled = !ok;
}

function generate() {
  const fwlibPath     = document.getElementById('fwlibPath').value.trim();
  const selectedDisplay = mcuSelectedValue;
  const mcu           = currentMcus.find(m => m.displayName === selectedDisplay) || {};
  const chipSuffix    = mcu.chipSuffix  || selectedDisplay;
  const displayName   = mcu.displayName || selectedDisplay;
  const projectName   = document.getElementById('projectName').value.trim();
  const projectFolder = document.getElementById('projectFolder').value.trim();
  const outputType    = document.querySelector('input[name="outputType"]:checked')?.value || 'app';
  const btn = document.getElementById('generateBtn');
  btn.disabled = true;
  btn.textContent = 'Generating…';
  document.getElementById('errorBox').style.display = 'none';
  vscode.postMessage({ type: 'generate', fwlibPath, series: currentSeries,
    chipSuffix, displayName, projectName, projectFolder, outputType, usePrintf: false });
}

function setFwlibError(msg) {
  const el = document.getElementById('fwlibErrorMsg');
  if (!el) return;
  if (msg) { el.textContent = msg; el.style.display = 'block'; }
  else      { el.textContent = ''; el.style.display = 'none'; }
}
window.addEventListener('message', ev => {
  const msg = ev.data;
  if (msg.type === 'fwlibResolved') {
    document.getElementById('fwlibPath').value = msg.path;
    setFwlibError(null);
  } else if (msg.type === 'fwlibError') {
    setFwlibError(msg.message);
    updateMcuList(null, [], null);
  } else if (msg.type === 'folderResolved') {
    document.getElementById('projectFolder').value = msg.path;
    checkReady();
  } else if (msg.type === 'mcuList') {
    setFwlibError(null);
    updateMcuList(msg.series, msg.mcus, msg.error);
    if (msg.suggestFolder && !folderManuallyEdited && !LOCKED_FOLDER) {
      document.getElementById('projectFolder').value = msg.suggestFolder;
      checkReady();
    }
  } else if (msg.type === 'recentRemoved') {
    const list = document.getElementById('recentList');
    if (list) {
      for (const item of Array.from(list.querySelectorAll('.recent-item'))) {
        if (item.title === msg.path) { item.remove(); break; }
      }
    }
  } else if (msg.type === 'resetBtn') {
    const btn = document.getElementById('generateBtn');
    btn.disabled = false;
    btn.textContent = 'Generate';
  } else if (msg.type === 'error') {
    const box = document.getElementById('errorBox');
    box.textContent = msg.message;
    box.style.display = 'block';
    const btn = document.getElementById('generateBtn');
    btn.disabled = false;
    btn.textContent = 'Generate';
  }
});
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────
// Project generation
// ─────────────────────────────────────────────────────────

export async function generateProjectFiles(
  result:  WizardResult,
  extPath: string,
): Promise<GenerateResult> {
  const { fwlibPath, series, chipSuffix, displayName, projectName, projectFolder, outputType } = result;

  const ht32VsDir  = path.join(projectFolder, 'HT32_VSCode');
  const bgDirName  = projectName;
  const bgDir      = path.join(ht32VsDir, bgDirName);
  const srcDir     = path.join(bgDir, 'src');
  const gnuArmDir  = path.join(bgDir, 'GNU_ARM');
  fs.mkdirSync(bgDir,     { recursive: true });
  fs.mkdirSync(srcDir,    { recursive: true });
  fs.mkdirSync(gnuArmDir, { recursive: true });

  const fwlib = fwlibPath.replace(/\\/g, '/');

  // ────────────────────────────────
  // Collect series-specific metadata
  // ────────────────────────────────
  let armCore      = 'cortex-m0';
  let htChipNum    = '1';
  let defines:    string[] = [];
  let asmDefines: string[] = [];
  let startupFile  = '';
  let incsRel:    string[] = [];
  let fwlibSrcs:  string[] = [];
  let ramOrigin    = '0x20000000';
  let ramLength    = '0x00008000';
  let familyTag    = 'f5xxxx';
  let confHFile        = '';   // conf.h filename in src/ (set in each branch)
  let usbdConfHFile    = '';   // usbdconf.h 要顯示在 TreeView 的那個（可能為空）
  let systemFileForMeta: string | undefined; // system_ht32*.c — goes to CMSIS/cmsis group
  let bspSrcsForMeta:   string[] = [];       // board .c — goes to bsp group (49x)
  let copiedUserSrcs: string[] = [];  // explicit .c list — avoids picking up stale files from old projects
  let ldFileNameFor49x: string | undefined; // linker script filename for 49x series

  if (series === 'std') {
    // ── Standard series ──
    const subdirs = stdLibSubdirs(fwlibPath);
    const gnuDir  = path.join(fwlibPath, 'project_template', 'IP', 'Example', 'GNU_ARM');

    // Find .mk for this MCU — it is the source of truth for file names
    const mkPath = path.join(gnuDir, `${chipSuffix}.mk`);
    const mk     = parseMkFile(mkPath);
    armCore      = mk.armCore;
    htChipNum    = mk.htChipNum;
    defines      = mk.defines;
    asmDefines   = mk.asmDefines;
    familyTag    = mk.familyTag;
    confHFile        = `ht32${mk.familyTag}_conf.h`;
    systemFileForMeta = mk.systemFile;
    startupFile  = `${mk.startupName}.s`;

    // Include paths parsed from .mk INCLUDE_PATH lines (fwlib-root-relative).
    incsRel = mk.incsRel;

    // Bundled template fallback dirs — used when FWLib's project_template is old/incomplete.
    // familyTag (e.g. 'f5xxxx') matches the bundled templates/ sub-directory name directly.
    const bundledGnuTemplDir = extPath ? path.join(extPath, 'templates', mk.familyTag, 'GNU_ARM') : undefined;
    const bundledExTemplDir  = extPath ? path.join(extPath, 'templates', mk.familyTag) : undefined;

    if (outputType === 'app') {
      // FWLib driver sources — use the exact list from .mk (avoids including
      // wrong variants like ht32f1xxxx_adc_02.c when the chip needs ht32f1xxxx_adc.c).
      // NOTE: ht32_retarget.c must be kept — it provides RETARGET_Configuration(), _write(), etc.
      // printf.c is kept — it has #if (PRINTF_USE_CLIB == 0) && (_RETARGET != 0) guard; no conflict.
      for (const f of mk.libFiles) {
        fwlibSrcs.push(`library/${subdirs.driverSrc}/${f}`);
      }
      if (mk.usbAbsSrcDir && mk.usbFiles.length > 0) {
        const usbRelDir = path.relative(fwlibPath, mk.usbAbsSrcDir).replace(/\\/g, '/');
        for (const f of mk.usbFiles) {
          fwlibSrcs.push(`${usbRelDir}/${f}`);
        }
      }
      // Board support (ht32_board.h/c are in utilities/ for all standard series)
      if (fs.existsSync(path.join(fwlibPath, 'utilities', 'ht32_board.c'))) {
        fwlibSrcs.push('utilities/ht32_board.c');
      }

      // Copy source template files — use exact names from .mk SOURCE_NAME_PATH
      // All files come from IP/Example/ (identical to IP/Template/; Example also has main.c & it.c)
      const exampleDir = path.join(fwlibPath, 'project_template', 'IP', 'Example');
      // Use FWLib exampleDir if present, otherwise fall back to bundled templates/
      const effectiveExDir = fs.existsSync(exampleDir) ? exampleDir : bundledExTemplDir;

      // Copy files from IP/Example/ (skipIfExists=true: protect user-modified files on re-run).
      // Skip system_*.c variants that don't match this MCU — only the exact mk.systemFile is needed.
      if (effectiveExDir) {
        for (const f of fs.readdirSync(effectiveExDir)) {
          if (!fs.statSync(path.join(effectiveExDir, f)).isFile()) continue;
          if (/^system_ht32.*\.c$/i.test(f) && f !== mk.systemFile) continue;
          copyFileIfExists(path.join(effectiveExDir, f), path.join(srcDir, f), true);
        }
      }
      // ht32_op.c: try FWLib GNU_ARM/, fallback to bundled
      const htOpSrc = [path.join(gnuDir, 'ht32_op.c'), bundledGnuTemplDir && path.join(bundledGnuTemplDir, 'ht32_op.c')]
        .find(p => p && fs.existsSync(p)) as string | undefined;
      if (htOpSrc) copyFileIfExists(htOpSrc, path.join(srcDir, 'ht32_op.c'), true);

      usbdConfHFile = (effectiveExDir ? resolveUsbdConfHeader(
        effectiveExDir,
        path.join(fwlibPath, 'library', subdirs.driverInc),
        mk.chipName,
      ) : undefined) ?? '';

      copiedUserSrcs = ['main.c', mk.itFile, mk.systemFile, 'ht32_op.c'];
    }

    // Copy startup .s and linker.ld into GNU_ARM/ (app only)
    if (outputType === 'app') {
      // startup .s: try FWLib GNU_ARM/, fallback to bundled
      const startupSrc = [path.join(gnuDir, `${mk.startupName}.s`), bundledGnuTemplDir && path.join(bundledGnuTemplDir, `${mk.startupName}.s`)]
        .find(p => p && fs.existsSync(p)) as string | undefined;
      if (startupSrc) copyFileIfExists(startupSrc, path.join(gnuArmDir, startupFile));
      // linker.ld: try FWLib GNU_ARM/, fallback to bundled
      const ldTemplateSrc = [path.join(gnuDir, 'linker.ld'), bundledGnuTemplDir && path.join(bundledGnuTemplDir, 'linker.ld')]
        .find(p => p && fs.existsSync(p)) as string | undefined;
      if (ldTemplateSrc) copyFileIfExists(ldTemplateSrc, path.join(gnuArmDir, 'linker.ld'));
      const startupPath = path.join(gnuArmDir, startupFile);
      if (fs.existsSync(startupPath)) {
        let s = fs.readFileSync(startupPath, 'utf8');
        s = patchStartupHeap(s, MIN_HEAP_SIZE);
        // "w" → "aw",%nobits: SHF_ALLOC is required for --print-memory-usage to count
        // the section toward RAM usage. %nobits keeps the section as NOBITS (no file bytes).
        s = s.replace(/\.section\s+"\.stack"\s*,\s*"w"(?:\s*,\s*%nobits)?/g, '.section ".stack","aw",%nobits');
        s = s.replace(/\.section\s+"\.heap"\s*,\s*"w"(?:\s*,\s*%nobits)?/g,  '.section ".heap","aw",%nobits');
        fs.writeFileSync(startupPath, s, 'utf8');
      }
    }

    // Parse memory from template linker.ld origin values (ORIGIN is always correct; LENGTH is 1024K placeholder)
    const ldForMem = [path.join(gnuDir, 'linker.ld'), bundledGnuTemplDir && path.join(bundledGnuTemplDir, 'linker.ld')]
      .find(p => p && fs.existsSync(p)) as string | undefined;
    const ldMem = ldForMem ? parseLinkerMemory(ldForMem) : { flashOrigin: '0x08000000', flashLength: '0x00100000', ramOrigin: '0x20000000', ramLength: '0x00100000' };
    ramOrigin = ldMem.ramOrigin;

    // Patch linker.ld with real per-MCU flash/RAM sizes.
    // Priority: Settings.ini [SRAM] (for RAM) → bundled PDSC (for both) → template placeholder.
    const lookupName  = resolveStdDisplayName(mk.defines, chipSuffix, fwlibFamilyPrefix(fwlibPath));
    const settingsRam = extPath ? lookupSramFromSettings(lookupName, extPath) : undefined;
    const pdscMem     = (!settingsRam && extPath) ? lookupMemoryFromPdsc(lookupName, extPath) : {};
    const patchRam    = settingsRam ?? pdscMem.ramLength;
    const patchFlash  = pdscMem.flashLength;

    // Always call patchLdMemory — even when patchRam/patchFlash are both undefined,
    // the function still adds KEEP(*(.heap)) / KEEP(*(.stack)) which is always needed.
    const ldScriptPath = path.join(gnuArmDir, 'linker.ld');
    if (fs.existsSync(ldScriptPath)) {
      const patched = patchLdMemory(
        fs.readFileSync(ldScriptPath, 'utf8'),
        patchFlash,
        patchRam,
      );
      fs.writeFileSync(ldScriptPath, patched, 'utf8');
    }
    ramLength = patchRam ?? ldMem.ramLength;

  } else {
    // ── 49x series ──
    armCore = 'cortex-m4';
    htChipNum = '1';

    // Detect 49x sub-series (e.g. "49163" from "HT32F49163")
    const chipNum = chipSuffix.replace(/^HT32[A-Za-z]/i, '');   // "49163"
    const seriesNum = chipNum.slice(0, 3);                // "491"

    // Get template dir: project/ht32f{chipNum}_sk/templates
    // e.g. project/ht32f49395_sk/templates
    // Fallback: some chips (e.g. HT32F49365) share the same family template directory.
    const chipLower = chipSuffix.toLowerCase();   // "ht32f49365"
    let templateDir = path.join(fwlibPath, 'project', `${chipLower}_sk`, 'templates');
    let skChipName = chipSuffix.toUpperCase();   // default: use selected chip (e.g. HT32F49365)
    if (!fs.existsSync(path.join(templateDir, 'src'))) {
      // Scan project/ for any *_sk directory that has templates/src
      try {
        const projectDir = path.join(fwlibPath, 'project');
        const found = fs.readdirSync(projectDir).find(d =>
          d.endsWith('_sk') && fs.existsSync(path.join(projectDir, d, 'templates', 'src'))
        );
        if (found) {
          templateDir = path.join(projectDir, found, 'templates');
          // Derive SK define from actual template dir (e.g. "ht32f49395_sk" → "HT32F49395")
          skChipName = found.replace(/_sk$/i, '').toUpperCase();
        } else {
          throw new Error(`No *_sk template directory found in ${projectDir}`);
        }
      } catch (e: any) {
        if (e.message?.startsWith('No *_sk')) throw e;
        throw new Error(`Cannot find template directory for ${chipSuffix}: ${e.message}`);
      }
    }
    const srcTemplateDir = path.join(templateDir, 'src');
    const incTemplateDir = path.join(templateDir, 'inc');

    // Detect family prefix from driver file names (e.g. "ht32f491x3")
    const driversDir = path.join(fwlibPath, 'libraries', 'drivers', 'src');
    const driverFiles = scanCFiles(driversDir);
    // Detect family tag e.g. "f491x3" from "ht32f491x3_gpio.c"
    const firstDriver = driverFiles.find(f => f.startsWith('ht32f'));
    const driverFamilyM = /^(ht32f\w+?)_/.exec(firstDriver ?? '');
    const driverFamily = driverFamilyM?.[1] ?? `ht32f${seriesNum}x`;
    confHFile = `${driverFamily}_conf.h`;

    // Board directory: project/ht32f493x5_board/
    const boardDirName = `${driverFamily}_board`;
    const boardDir49x  = path.join(fwlibPath, 'project', boardDirName);

    // Include paths
    incsRel = [
      'libraries/cmsis/cm4/core_support',   // core_cm4.h, cmsis_gcc.h, arm_math.h
      'libraries/cmsis/cm4/device_support', // device MCU headers (ht32f493x5.h)
      'libraries/drivers/inc',              // peripheral driver headers
      `project/${boardDirName}`,            // ht32_board.h, family board header
    ];

    // Defines — 49x device header requires package-qualified name (e.g. USE_HT32F49395_100LQFP).
    // displayName already carries the package suffix (e.g. "HT32F49395_100LQFP").
    // USE_HT32F49395_SK is required by ht32f493x5_board.h for LED/UART pin mappings.
    defines = [
      `USE_${displayName}`,         // device selection (e.g. USE_HT32F49365_100LQFP)
      `USE_${skChipName}_SK`,        // board support — derived from actual template dir (e.g. USE_HT32F49395_SK)
    ];

    const systemFile49x    = `system_${driverFamily}.c`;
    const systemFilePath49x = `libraries/cmsis/cm4/device_support/${systemFile49x}`;
    systemFileForMeta = systemFile49x;

    if (outputType === 'app') {
      // FWLib driver sources
      for (const f of driverFiles) {
        if (/usb/i.test(f)) continue;
        fwlibSrcs.push(`libraries/drivers/src/${f}`);
      }
      // System clock init file
      if (fs.existsSync(path.join(fwlibPath, systemFilePath49x))) {
        fwlibSrcs.push(systemFilePath49x);
      }
    }

    // Find startup .s
    const gccDir    = find49xGccDir(fwlibPath) ?? path.join(fwlibPath, 'libraries', 'cmsis', 'cm4', 'device_support', 'startup', 'gcc');
    const startupSrc = fs.readdirSync(gccDir).find(f => f.startsWith('startup_') && f.endsWith('.s'));
    if (!startupSrc) throw new Error(`No startup .s found in ${gccDir}`);
    startupFile = startupSrc;

    // Find linker .ld for this MCU (app only — lib doesn't need linker script)
    const linkerDir  = path.join(gccDir, 'linker');
    ldFileNameFor49x = 'linker.ld'; // fallback name
    if (outputType === 'app') {
      const ldFileName49x = `${chipSuffix}_FLASH.ld`;
      const ldSrc      = path.join(linkerDir, ldFileName49x);
      if (!fs.existsSync(ldSrc)) {
        // Fallback to first available .ld
        const anyLd = fs.readdirSync(linkerDir).find(f => f.endsWith('_FLASH.ld'));
        if (!anyLd) throw new Error(`No linker script found for ${chipSuffix} in ${linkerDir}`);
        ldFileNameFor49x = anyLd;
        copyFileIfExists(path.join(linkerDir, anyLd), path.join(gnuArmDir, anyLd));
        const mem = parseLinkerMemory(path.join(linkerDir, anyLd));
        ramOrigin = mem.ramOrigin; ramLength = mem.ramLength;
      } else {
        ldFileNameFor49x = ldFileName49x;
        copyFileIfExists(ldSrc, path.join(gnuArmDir, ldFileName49x));
        const mem = parseLinkerMemory(ldSrc);
        ramOrigin = mem.ramOrigin; ramLength = mem.ramLength;
      }
      // Patch KEEP(*(.heap)) / KEEP(*(.stack)) so --gc-sections doesn't discard them
      const ldOut49x = path.join(gnuArmDir, ldFileNameFor49x);
      if (fs.existsSync(ldOut49x)) {
        fs.writeFileSync(ldOut49x, patchLdMemory(fs.readFileSync(ldOut49x, 'utf8'), undefined, undefined), 'utf8');
      }
    } else {
      // For lib: still parse RAM values for project.settings.json, but don't copy the .ld file
      const ldFileName = `${chipSuffix}_FLASH.ld`;
      const ldSrc = path.join(linkerDir, ldFileName);
      const fallbackLd = fs.existsSync(ldSrc) ? ldSrc
        : (() => { const any = fs.readdirSync(linkerDir).find(f => f.endsWith('_FLASH.ld')); return any ? path.join(linkerDir, any) : undefined; })();
      if (fallbackLd) { const mem = parseLinkerMemory(fallbackLd); ramOrigin = mem.ramOrigin; ramLength = mem.ramLength; }
    }

    // Copy startup .s into GNU_ARM/ (app only)
    if (outputType === 'app') {
      copyFileIfExists(path.join(gccDir, startupSrc), path.join(gnuArmDir, startupFile));
      const startupPath49x = path.join(gnuArmDir, startupFile);
      if (fs.existsSync(startupPath49x)) {
        let s49x = fs.readFileSync(startupPath49x, 'utf8');
        s49x = patchStartupHeap(s49x, MIN_HEAP_SIZE);
        s49x = s49x.replace(/\.section\s+"\.stack"\s*,\s*"w"(?:\s*,\s*%nobits)?/g, '.section ".stack","aw",%nobits');
        s49x = s49x.replace(/\.section\s+"\.heap"\s*,\s*"w"(?:\s*,\s*%nobits)?/g,  '.section ".heap","aw",%nobits');
        fs.writeFileSync(startupPath49x, s49x, 'utf8');
      }
    }

    if (outputType === 'app') {
      // Copy template source files (main.c, *_int.c, *_clock.c, etc.)
      // skipIfExists=true: protect user-modified files on re-run
      for (const f of fs.readdirSync(srcTemplateDir).filter(f => f.endsWith('.c'))) {
        if (/usb/i.test(f)) continue;
        copyFileIfExists(path.join(srcTemplateDir, f), path.join(srcDir, f), true);
        copiedUserSrcs.push(f);
      }
      for (const f of fs.readdirSync(incTemplateDir).filter(f => f.endsWith('.h'))) {
        copyFileIfExists(path.join(incTemplateDir, f), path.join(srcDir, f), true);
      }

      // Copy board support files — provides fputc()/_write() retarget + uart_print_init()
      const boardC = `${driverFamily}_board.c`;
      const boardH = `${driverFamily}_board.h`;
      copyFileIfExists(path.join(boardDir49x, boardC),          path.join(srcDir, boardC),         true);
      copyFileIfExists(path.join(boardDir49x, boardH),          path.join(srcDir, boardH),         true);
      copyFileIfExists(path.join(boardDir49x, 'ht32_board.h'),  path.join(srcDir, 'ht32_board.h'), true);
      if (fs.existsSync(path.join(boardDir49x, boardC))) {
        copiedUserSrcs.push(boardC);
        bspSrcsForMeta.push(boardC);   // bsp group in project tree
      }

      // Patch conf.h to comment out USB_MODULE_ENABLED
      const confH = path.join(srcDir, `${driverFamily}_conf.h`);
      if (fs.existsSync(confH)) {
        const content = fs.readFileSync(confH, 'utf8');
        fs.writeFileSync(confH, content.replace(/^#define USB_MODULE_ENABLED/m, '//#define USB_MODULE_ENABLED'));
      }
    }
  }

  // ── Library: create one empty .c as starting point ──
  if (outputType === 'lib') {
    const emptyC = path.join(srcDir, `${projectName}.c`);
    if (!fs.existsSync(emptyC)) {
      fs.writeFileSync(emptyC, `// ${projectName}.c\n`);
    }
    copiedUserSrcs = [`${projectName}.c`];
  }

  // ── eyalroz/printf (app only) ──
  if (result.usePrintf && outputType === 'app') {
    defines.push('PRINTF_ALIAS_STANDARD_FUNCTION_NAMES_HARD=1');
    const printfDir = path.join(extPath, 'templates', 'printf');
    copyFileIfExists(path.join(printfDir, 'printf.c'), path.join(srcDir, 'printf.c'), true);
    copyFileIfExists(path.join(printfDir, 'printf.h'), path.join(srcDir, 'printf.h'), true);
    fs.writeFileSync(path.join(srcDir, 'ht32_putchar.c'), generatePutcharC());
    copiedUserSrcs.push('printf.c', 'ht32_putchar.c');
  }

  // ── ht32_stack_analysis.c (app only) → GNU_ARM/, vscode group ──
  // Goes to GNU_ARM/ alongside retarget — not a user-editable source.
  if (outputType === 'app') {
    generateStackAnalysis(gnuArmDir, extPath);
  }

  // ────────────────────────────────
  // Source lists
  // ────────────────────────────────
  // Use the explicit list of files we copied — avoids stale files from old projects in the same src/ folder.
  // Makefile uses paths relative from bgDir (src/xxx.c — src/ is now inside bgDir)
  const userSrcs = copiedUserSrcs.map(f => `src/${f}`);

  // ── TreeView (project.meta.json) — 依系列對齊 HT32-IDE group 結構 ──────────
  // FWLib paths: relative to projectFolder when same drive, absolute otherwise (cross-drive).
  const toProjectRel = (abs: string) => path.relative(projectFolder, abs).replace(/\\/g, '/');
  // Helpers for meta.json paths (TreeView resolves relative to projectFolder = fileBase)
  const srcRelFromProject    = path.relative(projectFolder, srcDir).replace(/\\/g, '/');
  const gnuArmRelFromProject = path.relative(projectFolder, gnuArmDir).replace(/\\/g, '/');
  const isSeries49x = series === '49x';

  let metaGroups: Record<string, string[]>;

  if (!isSeries49x) {
    // ── STD 系列：User / Config / GNU_ARM / CMSIS / Retarget / Library / Utilities ──
    const CONFIG_SET = new Set(['ht32_op.c']);
    const userMeta = copiedUserSrcs
      .filter(f => !CONFIG_SET.has(f) && f !== systemFileForMeta)
      .map(f => `${srcRelFromProject}/${f}`);
    const configMeta = [
      ...copiedUserSrcs.filter(f => CONFIG_SET.has(f)).map(f => `${srcRelFromProject}/${f}`),
      ...(confHFile     ? [`${srcRelFromProject}/${confHFile}`]     : []),
      ...(usbdConfHFile ? [`${srcRelFromProject}/${usbdConfHFile}`] : []),
      // ht32_board_config.h — present in FWLib IP/Example/, copied to src/
      ...(fs.existsSync(path.join(srcDir, 'ht32_board_config.h')) ? [`${srcRelFromProject}/ht32_board_config.h`] : []),
    ];
    // CMSIS: system_ht32*.c only
    const cmsisMeta: string[] = [
      ...(systemFileForMeta ? [`${srcRelFromProject}/${systemFileForMeta}`] : []),
    ];
    // GNU_ARM: startup.s
    const gnuArmMeta: string[] = outputType === 'app' ? [`${gnuArmRelFromProject}/${startupFile}`] : [];
    // Utilities: utilities/ht32_board.c
    const utilityRels = fwlibSrcs.filter(rel => /^utilities\//i.test(rel));
    const utilitiesMeta = utilityRels.map(rel => toProjectRel(path.join(fwlibPath, rel)));
    // Retarget: ht32_retarget*.c / ht32_serial.c / printf.c (from FWLib library)
    const RETARGET_RE = /^(ht32_retarget[^/\\]*|ht32_serial|printf)\.c$/i;
    const retargetRels = fwlibSrcs.filter(rel => !utilityRels.includes(rel) && RETARGET_RE.test(path.basename(rel)));
    const retargetMeta = retargetRels.map(rel => toProjectRel(path.join(fwlibPath, rel)));
    const libMeta = fwlibSrcs
      .filter(rel => !utilityRels.includes(rel) && !retargetRels.includes(rel))
      .map(rel => toProjectRel(path.join(fwlibPath, rel)));

    metaGroups = {
      User:      userMeta,
      Config:    configMeta,
      'GNU_ARM': gnuArmMeta,
      CMSIS:     cmsisMeta,
      ...(retargetMeta.length ? { Retarget: retargetMeta } : {}),
      Library:   libMeta,
      ...(utilitiesMeta.length ? { Utilities: utilitiesMeta } : {}),
    };
  } else {
    // ── 49x 系列：user / bsp / firmware / cmsis / gnu_arm ──
    const userMeta = copiedUserSrcs
      .filter(f => !bspSrcsForMeta.includes(f))
      .map(f => `${srcRelFromProject}/${f}`);
    const bspMeta = bspSrcsForMeta.map(f => `${srcRelFromProject}/${f}`);
    // cmsis: system（fwlib 絕對路徑）のみ
    const systemRel = systemFileForMeta
      ? fwlibSrcs.find(rel => rel.endsWith(systemFileForMeta!))
      : undefined;
    const cmsisMeta: string[] = [
      ...(systemRel ? [toProjectRel(path.join(fwlibPath, systemRel))] : []),
    ];
    // gnu_arm: startup.s
    const gnuArmMeta49x: string[] = outputType === 'app' ? [`${gnuArmRelFromProject}/${startupFile}`] : [];
    // firmware: FWLib drivers（排除 system）
    const firmwareMeta = fwlibSrcs
      .filter(rel => !systemRel || rel !== systemRel)
      .map(rel => toProjectRel(path.join(fwlibPath, rel)));

    metaGroups = {
      user:     userMeta,
      ...(bspMeta.length ? { bsp: bspMeta } : {}),
      firmware: firmwareMeta,
      cmsis:    cmsisMeta,
      ...(gnuArmMeta49x.length ? { gnu_arm: gnuArmMeta49x } : {}),
    };
  }

  // Library: override groups — single User group with the empty .c only
  if (outputType === 'lib') {
    metaGroups = { User: [`${srcRelFromProject}/${projectName}.c`] };
  }

  // ────────────────────────────────
  // Generate files
  // ────────────────────────────────

  // Resolve gcc path the same way uv2make does (user setting → auto-detect → bare name)
  const gccResolved = await locateArmGcc() ?? 'arm-none-eabi-gcc';

  // Makefile + list files
  // Startup is in GNU_ARM/ inside Project — pass bgDir-relative path to Makefile
  const startupFileForMakefile = outputType === 'app' ? `GNU_ARM/${startupFile}` : startupFile;
  // Linker script filename: std series uses 'linker.ld'; 49x uses chip-specific name
  const ldFileNameForMakefile = series === 'std' ? 'linker.ld' : (ldFileNameFor49x ?? 'linker.ld');
  // bgDir-relative path to the .ld file — used in Makefile and stored in meta.json.
  const ldRelPath = outputType === 'app'
    ? path.relative(bgDir, path.join(gnuArmDir, ldFileNameForMakefile)).replace(/\\/g, '/')
    : undefined;

  // .ld → Linker group; vscode group for stack analysis helper
  {
    const gnuRel = (name: string) =>
      path.relative(projectFolder, path.join(gnuArmDir, name)).replace(/\\/g, '/');
    if (ldRelPath) {
      (metaGroups['Linker'] ??= []).push(
        path.relative(projectFolder, path.resolve(bgDir, ldRelPath)).replace(/\\/g, '/')
      );
    }
    if (outputType === 'app') {
      metaGroups['vscode'] = [gnuRel('ht32_stack_analysis.c')];
    }
  }

  // Compute hasFpuHw once — shared by Makefile, compile_commands, and project.settings.
  const isM4 = armCore === 'cortex-m4';
  let hasFpuHw = isM4;
  if (isM4) {
    const fpuPresent = detectFpuPresentFromHeader(incsRel, fwlibPath);
    if (fpuPresent === false) { hasFpuHw = false; }
  }

  // bgDir-relative include paths for project.settings.json — used by regenerateMakefileFlags()
  // to write includes.list.  Relative paths allow FWLib to be moved as long as the
  // relative offset between projectFolder and fwlibPath stays the same.
  // path.relative() falls back to absolute when src and dest are on different drives.
  const absIncludePaths = [
    'src',
    'GNU_ARM',
    ...incsRel.map(r => path.relative(bgDir, path.join(fwlibPath, r)).replace(/\\/g, '/')),
  ];
  const _existingSettings = readProjectSettings(bgDir);
  const effectiveExtraCFlags = _existingSettings.extraCFlags || '-std=gnu11';
  writeProjectSettings(bgDir, {
    ..._existingSettings,
    extraCFlags:  effectiveExtraCFlags,
    mcu:          armCore,
    targetName:   projectName,
    ramOrigin,
    ramLength,
    deviceName:   displayName,
    outputType,
    fpu:          hasFpuHw ? 'fpv4-sp-d16' : 'none',
    floatAbi:     hasFpuHw ? 'hard' : 'soft',
    useNano:      result.useNano  ?? _existingSettings.useNano,
    useNosys:     result.useNosys ?? _existingSettings.useNosys,
    includePaths: absIncludePaths,
    ...(defines?.length ? { cDefs: defines } : {}),
    ...(asmDefines?.length ? { aDefs: asmDefines } : {}),
  });

  const { allSrcs, incsStr, defsStr } = computeProjectLists({
    fwlibPath:   fwlib,
    bgDir,
    outputType,
    incsRel,
    defines,
    userSrcs,
    fwlibSrcs,
    startupFile: startupFileForMakefile,
  });
  const isLib = outputType === 'lib';
  const ps = readProjectSettings(bgDir);
  fs.writeFileSync(path.join(bgDir, 'Makefile'), buildMakefileFromProjectSettings(ps, {
    cc:            gccResolved,
    srcs:          allSrcs,
    linkerScripts: isLib ? [] : [ldRelPath ?? 'GNU_ARM/linker.ld'],
    isLibrary:     isLib,
    comment:       'Created by HT32 VS Code Extension.',
  }));
  fs.writeFileSync(path.join(bgDir, 'sources.list'), allSrcs.join('\n'));
  writeProjectLists(bgDir, {
    includes: incsStr,
    defines:  defsStr,
    adefines: asmDefines.map(d => `-D${d}`).join(' '),
  });

  // compile_commands.json — read from .list files (written above) to stay in sync
  await writeCCDbFromLists(bgDir, {
    armCore,
    fpu:        hasFpuHw ? 'fpv4-sp-d16' : undefined,
    floatAbi:   hasFpuHw ? 'hard' : 'soft',
    optimization: 'Os',
    gcSections: ps.gcSections,
  });

  // project.meta.json — paths relative to workspace root (or absolute for FWLib)
  const meta = { projectName, groups: metaGroups, ...(ldRelPath ? { linkerScripts: [ldRelPath] } : {}), ...(outputType === 'lib' ? { isLibrary: true } : {}) };
  fs.writeFileSync(path.join(bgDir, 'project.meta.json'), JSON.stringify(meta, null, 2));

  // elfPath is relative to HT32_VSCode/ (VS Code workspace root)
  const elfPath = outputType === 'lib'
    ? `${bgDirName}/build/${projectName}.a`
    : `${bgDirName}/build/${projectName}.elf`;
  return { elfPath, deviceName: displayName, mcu: armCore, ramOrigin, ramLength, outputType };
}

// ─────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────

function copyFileIfExists(src: string, dst: string, skipIfExists = false): void {
  if (!fs.existsSync(src)) return;
  if (skipIfExists && fs.existsSync(dst)) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}


