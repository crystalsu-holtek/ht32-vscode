// src/tools/ht32ide2make.ts
// Converts HT32-IDE (.project / .cproject) to Makefile + VS Code project files.
import * as fs   from 'fs';
import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';
import { detectFpuPresentFromHeader, find49xGccDir, fwlRootFromSourcePath, fwlRootFromTemplate, is49xDevice, patchLdStackSections, specsFlags, makeSrcRule, makeSpacedSrcRule, buildMakefileText, enforceMinHeap, generateStackAnalysis, writeCCDbFromLists, logInfo, logWarn, bundledGnuDirFromFwlRoot, FileOption, relocateBatToWsRoot } from './uv2make';
import { readProjectSettings, writeProjectSettings } from './settingsWebview';
import { writeProjectLists } from './utils';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Ht32IdeSource {
  group:        string;    // Eclipse group name (e.g. "User", "Library", "CMSIS")
  absPath:      string;    // resolved absolute path, forward slashes
  headerOnly?:  boolean;   // true = .h file (project tree only, not compiled)
  missing?:     boolean;   // true = file not found on disk; kept in meta.json but excluded from build
  excluded?:    boolean;   // true = "Exclude from build" in HT32-IDE (sourceEntries excluding=)
  executeOnly?: boolean;   // true = -mpure-code per-file flag (HT32-IDE fileInfo with -mpure-code)
}

export interface Ht32IdeResult {
  projectName:  string;
  outputName:   string;    // artifactName from .cproject (e.g. "IAP"); falls back to projectName
  deviceName:   string;    // e.g. "HT32F52341" (from IC_NAME macro)
  armCore:      string;    // e.g. "cortex-m0plus"
  defines:      string[];  // without -D (C compiler)
  asmDefines:   string[];  // without -D (Assembler tool — may differ from C defines)
  includePaths: string[];  // resolved absolute paths, forward slashes
  linkerScript: string;         // resolved absolute path, forward slashes (may be empty)
  extraLinkerScripts: string[]; // additional -T scripts (e.g. calculate_symbol_GNU.ld)
  sources:      Ht32IdeSource[];
  ramOrigin:    string;    // e.g. "0x20000000"
  ramLength:    string;    // e.g. "0x00002000"
  flashOrigin:  string;
  flashLength:  string;
  optimization: string;   // "Os" | "Og" | "O0" | "O1" | "O2" | "O3"
  fpuName:       string;   // e.g. "fpv4-sp-d16", or "" if no FPU unit
  hardFloat:     boolean;  // true → -mfloat-abi=hard; false → -mfloat-abi=soft
  useNano:       boolean;
  useNosys:      boolean;
  hasCsrcs:      boolean;   // false → pure assembly; caller should write useNano/useNosys=false to settings
  printfFloat:   boolean;  // -u _printf_float
  scanfFloat:    boolean;  // -u _scanf_float
  useLto:        boolean;  // -flto (detected from toolchain lto option or other flags)
  extraLibNames: string[]; // from linker.libs  → -lName
  extraLibPaths: string[]; // from linker.paths → -L"path" (resolved absolute)
  extraLibFiles: string[]; // from linker.otherobjs (.a) → direct paths (resolved absolute)
  isLibrary:     boolean;  // artifactType=staticLib → ar rcs lib$(TARGET).a
  warnings:      { message: string; file: string }[];
  fwlibRoot?:    string;    // FWLib 根目錄絕對路徑（用於寫入 FWLib root .clangd）
  postBuildCmd?: string;    // post-build command; bat path is absolute (call resolveHt32IdePostBuildPath to relativize)
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve PARENT-N-PROJECT_LOC/rel → absolute path */
function resolveEclipseUri(uri: string, projectDir: string): string {
  const m = /^PARENT-(\d+)-PROJECT_LOC\/(.+)$/.exec(uri);
  if (!m) {
    // Could be PROJECT_LOC/rel or a plain path
    const plain = uri.replace(/^PROJECT_LOC\//, '');
    return path.resolve(projectDir, plain);
  }
  const levels = parseInt(m[1], 10);
  let base = projectDir;
  for (let i = 0; i < levels; i++) base = path.dirname(base);
  return path.join(base, m[2]);
}

const OPT_MAP: Record<string, string> = {
  size:     'Os',
  debug:    'Og',
  none:     'O0',
  optimize: 'O1',
  more:     'O2',
  most:     'O3',
};

function mapOptimization(value: string): string {
  const m = /\.optimization\.level\.(\w+)$/.exec(value ?? '');
  return m ? (OPT_MAP[m[1]] ?? 'Os') : 'Os';
}

function mapArmCore(value: string): string {
  // "...arm.target.mcpu.cortex-m0plus" → "cortex-m0plus"
  const m = /\.target\.(?:mcpu|family)\.([\w-]+)$/.exec(value ?? '');
  return m ? m[1] : 'cortex-m0';
}

function listValues(opt: any): string[] {
  if (!opt) return [];
  const list = opt.listOptionValue;
  if (!list) return [];
  return (Array.isArray(list) ? list : [list])
    .map((v: any) => String(v.value ?? '')).filter(Boolean);
}

function findOpt(opts: any[], superClassSuffix: string): any {
  return opts.find((o: any) => String(o.superClass ?? '').includes(superClassSuffix));
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-file settings parser (.cproject)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse HT32-IDE per-file settings from .cproject:
 *   - Excluded from build: <entry excluding="file.c" name="folder"/> in <sourceEntries>
 *   - Execute-only:        <fileInfo resourcePath="folder/file.c"> with -mpure-code compiler flag
 *
 * Returns Sets of "folder/filename" keys (both lowercased) for fast lookup.
 */
function parsePerFileSettings(cprojectPath: string): {
  executeOnlyPaths: Set<string>;
  excludedPaths:    Set<string>;
} {
  const parser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '',
    isArray: (name) => ['storageModule', 'cconfiguration', 'fileInfo', 'entry', 'tool', 'option'].includes(name),
  });
  const doc = parser.parse(fs.readFileSync(cprojectPath, 'utf8'));

  const topModules: any[] = doc?.cproject?.storageModule ?? [];
  const settingsMod = topModules.find((m: any) => m.moduleId === 'org.eclipse.cdt.core.settings');
  const ccfg = (settingsMod?.cconfiguration ?? [])[0] ?? {};
  const innerMods: any[] = ccfg?.storageModule ?? [];
  const cdtBuild = innerMods.find((m: any) => m.moduleId === 'cdtBuildSystem');
  const cfg = cdtBuild?.configuration ?? {};

  // Execute-only: fileInfo with -mpure-code in compiler other flags
  const executeOnlyPaths = new Set<string>();
  for (const fi of (cfg.fileInfo ?? []) as any[]) {
    const rp: string = String(fi.resourcePath ?? '').toLowerCase().replace(/\\/g, '/');
    if (!rp) continue;
    for (const t of (fi.tool ?? []) as any[]) {
      const hasXO = ((t.option ?? []) as any[]).some((o: any) =>
        String(o.superClass ?? '').includes('compiler.other') &&
        String(o.value ?? '').includes('-mpure-code')
      );
      if (hasXO) { executeOnlyPaths.add(rp); break; }
    }
  }

  // Excluded: sourceEntries entry with excluding="..." attribute
  const excludedPaths = new Set<string>();
  for (const entry of (cfg.sourceEntries?.entry ?? []) as any[]) {
    const folder = String(entry.name ?? '').toLowerCase();
    const excl   = String(entry.excluding ?? '');
    if (!excl) continue;
    for (const fname of excl.split('|')) {
      const trimmed = fname.trim();
      if (trimmed) excludedPaths.add(`${folder}/${trimmed.toLowerCase()}`);
    }
  }

  return { executeOnlyPaths, excludedPaths };
}

// ─────────────────────────────────────────────────────────────────────────────
// .project parser
// ─────────────────────────────────────────────────────────────────────────────

function parseProjectFile(projectPath: string): { projectName: string; sources: Ht32IdeSource[]; warnings: { message: string; file: string }[] } {
  const projectDir = path.dirname(projectPath);
  const parser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '',
    isArray: (name) => ['link'].includes(name),
  });
  const doc = parser.parse(fs.readFileSync(projectPath, 'utf8'));
  const projectName: string = doc?.projectDescription?.name ?? path.basename(projectDir);
  const links: any[] = doc?.projectDescription?.linkedResources?.link ?? [];
  const sources: Ht32IdeSource[] = [];
  const warnings: { message: string; file: string }[] = [];

  for (const link of links) {
    const name: string = String(link.name ?? '');
    const type: string = String(link.type ?? '0');
    const uri:  string = String(link.locationURI ?? '');
    if (type !== '1') continue;                         // 1 = file
    const isCompilable = /\.(c|cpp|s|S)$/i.test(name);
    const isHeader     = /\.h$/i.test(name);
    if (!isCompilable && !isHeader) continue;           // skip other files
    const group   = name.includes('/') ? name.split('/')[0] : '(root)';
    const absPath = resolveEclipseUri(uri, projectDir).replace(/\\/g, '/');
    // Skip Keil/MDK startup files — some 49x .project files include both
    // startup/gcc/ and startup/mdk/ variants; only the gcc one is GCC-compatible.
    if (/\/startup\/mdk\//i.test(absPath)) continue;
    // If a compilable file cannot be found, still record it (shown in TreeView with warning icon)
    // but mark as missing so it is excluded from sources.list / Makefile.
    const isMissing = isCompilable && !fs.existsSync(absPath.replace(/\//g, path.sep));
    if (isMissing) {
      warnings.push({ message: `Source file not found: ${absPath}\n(from .project entry: ${uri})`, file: projectPath });
    }
    sources.push({ group, absPath, headerOnly: isHeader || undefined, missing: isMissing || undefined });
  }
  // Deduplicate by absPath (some 49x .project files list the same file twice)
  const seen = new Set<string>();
  const deduped = sources.filter(s => { if (seen.has(s.absPath)) return false; seen.add(s.absPath); return true; });
  return { projectName, sources: deduped, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Device name resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the full device name (including package suffix) from .cproject data.
 *
 * Priority:
 *   1. cmsis.device.name  — always includes package (e.g. "HT32F49395_100LQFP").
 *                           Required for OpenOCD MCU cfg lookup (MCU/{name}.cfg).
 *   2. IC_NAME macro      — usually lacks package (e.g. "HT32F49395"). Used as
 *                           fallback when cmsis.device.name is absent.
 *   3. USE_{MCU}_SK define — lowest-confidence source; strips _SK suffix but
 *                           still yields no package info.
 *
 * Add new sources here (not inline) when future .cproject variants are found.
 */
function resolveDeviceName(
  icName:          string,
  cmsisDeviceName: string,
  defines:         string[],
): string {
  if (cmsisDeviceName) return cmsisDeviceName;
  if (icName)          return icName;
  const useDef = defines.find(d => /^USE_(HT32[A-Z0-9]+)_SK$/i.test(d));
  if (useDef) {
    const m = /^USE_(HT32[A-Z0-9]+)_SK$/i.exec(useDef);
    if (m) return m[1];
  }
  return '';
}

// ─────────────────────────────────────────────────────────────────────────────
// .cproject parser
// ─────────────────────────────────────────────────────────────────────────────

function parseCProjectFile(cprojectPath: string, buildDir: string): Omit<Ht32IdeResult, 'projectName' | 'outputName' | 'sources' | 'warnings' | 'postBuildCmd'> & { artifactName: string; postbuildStep: string; icName: string } {
  const parser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '',
    isArray: (name) => [
      'storageModule', 'cconfiguration', 'option', 'listOptionValue',
      'tool', 'memory', 'stringMacro',
    ].includes(name),
  });
  const doc = parser.parse(fs.readFileSync(cprojectPath, 'utf8'));

  // ── Navigate to the first cconfiguration ──────────────────────────────────
  const topModules: any[] = doc?.cproject?.storageModule ?? [];
  const settingsMod  = topModules.find((m: any) => m.moduleId === 'org.eclipse.cdt.core.settings');
  const ccfgs: any[] = settingsMod?.cconfiguration ?? [];
  const ccfg         = ccfgs[0] ?? {};
  const innerMods: any[] = ccfg?.storageModule ?? [];

  // ── IC_NAME (short, may lack package suffix) ─────────────────────────────
  const innerSettings = innerMods.find((m: any) => m.moduleId === 'org.eclipse.cdt.core.settings');
  const macroList: any[] = innerSettings?.macros?.stringMacro ?? [];
  const icMacro  = macroList.find((m: any) => m.name === 'IC_NAME');
  const icName   = String(icMacro?.value ?? '');

  // ── cdtBuildSystem → toolChain ────────────────────────────────────────────
  const cdtBuild    = innerMods.find((m: any) => m.moduleId === 'cdtBuildSystem');
  const artifactName: string = (cdtBuild?.configuration?.artifactName ?? '').trim();
  const postbuildStep: string = String(cdtBuild?.configuration?.postbuildStep ?? '').trim();
  const isLibrary = String(cdtBuild?.configuration?.buildArtefactType ?? '').includes('staticLib');
  const toolChain   = cdtBuild?.configuration?.folderInfo?.toolChain ?? {};
  const tcOptions:  any[] = toolChain.option ?? [];
  const tools:      any[] = toolChain.tool   ?? [];

  // toolChain-level options (architecture, optimization, etc.)
  const armCore    = mapArmCore(findOpt(tcOptions, 'arm.target.family')?.value ?? '');
  const optLevel   = mapOptimization(findOpt(tcOptions, 'optimization.level')?.value ?? '');

  // FPU detection — arm.target.fpu.name: e.g. "fpv4-sp-d16" or absent/empty → no FPU
  //                 arm.target.fpu.abi:  e.g. "...fpu.abi.hard" or "...fpu.abi.default" → soft
  const fpuNameRaw = findOpt(tcOptions, 'arm.target.fpu.name')?.value ?? '';
  const fpuAbiRaw  = findOpt(tcOptions, 'arm.target.fpu.abi')?.value  ?? '';
  // Extract the last segment of the superClass-style enum value (e.g. "fpv4-sp-d16")
  const fpuName    = /none|default/i.test(fpuNameRaw) ? '' : (fpuNameRaw.split('.').pop() ?? '').replace(/['"]/g, '').trim();
  const hardFloat  = !!fpuName && /\.hard$/.test(fpuAbiRaw);

  // ── Assembler tool ────────────────────────────────────────────────────────
  // Assembler defines (e.g. USE_HT32_CHIP=33) can differ from C compiler defines.
  // They are needed in ASFLAGS for .S files (cpp-preprocessed assembly).
  const asmTool    = tools.find((t: any) => String(t.superClass ?? '').includes('tool.assembler'));
  const asmOpts: any[] = asmTool?.option ?? [];
  const asmDefines = listValues(findOpt(asmOpts, 'assembler.defs'));

  // ── C / C++ Compiler tools ────────────────────────────────────────────────
  // Merge both tools so neither is silently ignored when one is absent or empty.
  const cCompiler    = tools.find((t: any) => String(t.superClass ?? '').includes('tool.c.compiler') && !String(t.superClass ?? '').includes('cpp'));
  const cppCompiler  = tools.find((t: any) => String(t.superClass ?? '').includes('tool.cpp.compiler'));
  const cOpts: any[]   = cCompiler?.option   ?? [];
  const cppOpts: any[] = cppCompiler?.option ?? [];
  const allCOpts = [...cOpts, ...cppOpts];
  const defines     = [...new Set(allCOpts
    .filter((o: any) => String(o.superClass ?? '').includes('compiler.defs'))
    .flatMap((o: any) => listValues(o)))];
  const rawIncludes = [...new Set(allCOpts
    .filter((o: any) => String(o.superClass ?? '').includes('compiler.include.paths'))
    .flatMap((o: any) => listValues(o)))];

  // ── C Linker tool ─────────────────────────────────────────────────────────
  const cLinker     = tools.find((t: any) =>
    String(t.superClass ?? '').includes('tool.c.linker') &&
    !String(t.superClass ?? '').includes('cpp')
  );
  const ldOpts: any[] = cLinker?.option ?? [];

  // cpp.linker options (HT32-IDE stores usenewlibnano / scriptfile / printf/scanf float here)
  const cppLinker  = tools.find((t: any) =>
    String(t.superClass ?? '').includes('tool.cpp.linker')
  );
  const cppLdOpts: any[] = cppLinker?.option ?? [];
  const allLdOpts  = [...ldOpts, ...cppLdOpts];   // search both c.linker + cpp.linker

  // HT32-IDE places these options in cpp.linker, not c.linker.
  // Use find() so we can distinguish "option absent" (→ default true) from "option explicitly false".
  const nanoOpt  = allLdOpts.find((o: any) => String(o.superClass ?? '').includes('linker.usenewlibnano'));
  const nosysOpt = allLdOpts.find((o: any) => String(o.superClass ?? '').includes('linker.usenewlibnosys'));
  const useNano  = nanoOpt  ? nanoOpt.value  === 'true' : true;  // default true when absent (same as convert-uV / create-project)
  const useNosys = nosysOpt ? nosysOpt.value === 'true' : true;
  // 收集所有 scriptfile 選項（c.linker 和 cpp.linker 各自可能有不同的清單）
  const allScriptOpts = allLdOpts.filter((o: any) =>
    String(o.superClass ?? o.id ?? '').includes('linker.scriptfile'));
  const ldScripts = [...new Set(allScriptOpts.flatMap((o: any) => listValues(o)))];

  // HT32-IDE 有時把額外 .ld / .a 放在 linker.otherobjs（Other objects）而非 scriptfile
  const allOtherObjOpts = allLdOpts.filter((o: any) =>
    String(o.superClass ?? o.id ?? '').includes('linker.otherobjs'));
  const otherObjsAll = [...new Set(allOtherObjOpts.flatMap((o: any) => listValues(o)))];
  const stripQ = (s: string) => s.replace(/^"|"$/g, '').trim();
  const otherLdScripts = otherObjsAll.filter(s => stripQ(s).toLowerCase().endsWith('.ld'));
  const otherLibFiles  = otherObjsAll
    .filter(s => stripQ(s).toLowerCase().endsWith('.a'))
    .map(s => path.resolve(buildDir, stripQ(s)).replace(/\\/g, '/'));

  const printfFloat = allLdOpts.some((o: any) => String(o.superClass ?? '').includes('linker.useprintffloat') && o.value === 'true');
  const scanfFloat  = allLdOpts.some((o: any) => String(o.superClass ?? '').includes('linker.usescanffloat')  && o.value === 'true');

  // Detect -flto: check toolchain-level boolean option first, fall back to "other flags" strings.
  // Collect "other flags" from all compiler and linker tools to avoid missing any.
  const ltoFromTc    = findOpt(tcOptions, 'optimization.lto')?.value === 'true';
  const cOtherFlags  = allCOpts
    .filter((o: any) => String(o.superClass ?? '').includes('compiler.other'))
    .map((o: any) => o.value ?? '').filter(Boolean).join(' ');
  const ldOtherFlags = allLdOpts
    .filter((o: any) => String(o.superClass ?? '').includes('linker.other'))
    .map((o: any) => o.value ?? '').filter(Boolean).join(' ');
  const useLto = ltoFromTc || /\bflto\b/.test(cOtherFlags) || /\bflto\b/.test(ldOtherFlags);

  // Extract library names (-l) and search paths (-L).
  // Use filter+flatMap (not findOpt) to collect from both c.linker and cpp.linker.
  const extraLibNames = [...new Set(allLdOpts
    .filter((o: any) => String(o.superClass ?? '').includes('linker.libs'))
    .flatMap((o: any) => listValues(o)))];
  const rawLibPaths = [...new Set(allLdOpts
    .filter((o: any) => String(o.superClass ?? '').includes('linker.paths'))
    .flatMap((o: any) => listValues(o)))];
  const extraLibPaths = rawLibPaths
    .map(p => stripQ(p))                                               // strip surrounding quotes
    .map(p => path.resolve(buildDir, p).replace(/\\/g, '/'));          // resolve to absolute

  // ── Memory (packs module) ─────────────────────────────────────────────────
  const packsMod  = innerMods.find((m: any) => m.moduleId?.includes('packs'));
  const memories: any[] = packsMod?.memory ?? [];
  const iram1 = memories.find((m: any) => m.section === 'IRAM1');
  const irom1 = memories.find((m: any) => m.section === 'IROM1');
  // cmsis.device.name in packs module options contains full name incl. package (e.g. "HT32F49395_100LQFP")
  const packsOptions: any[] = packsMod?.option ?? [];
  const cmsisDeviceName: string = packsOptions.find((o: any) => o.id === 'cmsis.device.name')?.value ?? '';

  // ── Resolve paths from Eclipse build dir ─────────────────────────────────
  const includePaths = rawIncludes
    .filter(Boolean)
    .map(p => path.resolve(buildDir, p).replace(/\\/g, '/'));

  const stripQuotes = (s: string) => s.replace(/^"|"$/g, '').replace(/\\/g, '/');
  const linkerScript = ldScripts[0]
    ? path.resolve(buildDir, stripQuotes(ldScripts[0])).replace(/\\/g, '/')
    : '';
  const extraLinkerScripts = [
    ...ldScripts.slice(1),
    ...otherLdScripts,
  ].map(s => path.resolve(buildDir, stripQuotes(s)).replace(/\\/g, '/'));

  const deviceName = resolveDeviceName(icName, cmsisDeviceName, defines);

  // ── FPU 最終確認：以 device header __FPU_PRESENT 為權威 ───────────────────
  // .cproject 的 fpu.abi/fpu.name 欄位有時與實際硬體能力不符（尤其 49x 系列）。
  // includePaths 已是 absolute，直接傳入 detectFpuPresentFromHeader。
  let resolvedFpuName = fpuName;
  let resolvedHardFloat = hardFloat;
  if (resolvedFpuName) {
    const fpuPresent = detectFpuPresentFromHeader(includePaths, '');
    if (fpuPresent === false) {
      resolvedFpuName = '';
      resolvedHardFloat = false;
      // logInfo would require vscode import; silently override is fine here
    }
  }

  return {
    artifactName,
    isLibrary,
    deviceName,
    armCore,
    defines,
    asmDefines,
    includePaths,
    linkerScript,
    extraLinkerScripts,
    ramOrigin:   String(iram1?.start  ?? '0x20000000'),
    ramLength:   String(iram1?.size   ?? '0x00002000'),
    flashOrigin: String(irom1?.start  ?? '0x00000000'),
    flashLength: String(irom1?.size   ?? '0x00010000'),
    optimization: optLevel,
    fpuName:   resolvedFpuName,
    hardFloat: resolvedHardFloat,
    useNano,
    useNosys,
    hasCsrcs: false,   // placeholder; overridden in parseHt32IdeProject after finalSources is known
    printfFloat,
    scanfFloat,
    useLto,
    extraLibNames,
    extraLibPaths,
    extraLibFiles: otherLibFiles,
    postbuildStep,
    icName,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: parse both files
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a HT32-IDE project folder (.project + .cproject) and return all
 * information needed to generate a Makefile-based VS Code project.
 *
 * @param projectDir  Absolute path to the folder containing .project / .cproject.
 */
export function parseHt32IdeProject(projectDir: string): Ht32IdeResult {
  // .project is the user's current project file; original.project is a backup created by
  // _CreateProjectScript.bat. Always prefer .project — it reflects the current project state.
  const dotProject      = path.join(projectDir, '.project');
  const originalProject = path.join(projectDir, 'original.project');
  const projectPath     = fs.existsSync(dotProject) ? dotProject : originalProject;
  const cprojectPath = path.join(projectDir, '.cproject');

  // HT32-IDE build output dir is always "<project>/HT32" — used to resolve
  // include/linker paths stored as relative values in .cproject.
  const buildDir = path.join(projectDir, 'HT32');

  const { projectName, sources: rawSources, warnings: projWarnings } = parseProjectFile(projectPath);
  const { artifactName, postbuildStep, icName, ...rest } = parseCProjectFile(cprojectPath, buildDir);
  const { executeOnlyPaths, excludedPaths } = parsePerFileSettings(cprojectPath);

  // Apply per-file settings from .cproject to sources
  const extraWarnings: { message: string; file: string }[] = [];
  const sources = rawSources.map(s => {
    const key = `${s.group.toLowerCase()}/${path.basename(s.absPath).toLowerCase()}`;
    const isExcluded    = excludedPaths.has(key);
    const isExecuteOnly = executeOnlyPaths.has(key);
    if (isExcluded) {
      logInfo(`File excluded from build: ${path.basename(s.absPath)}`);
    }
    if (isExecuteOnly) {
      logInfo(`File set to execute-only (-mpure-code): ${path.basename(s.absPath)}`);
    }
    if (!isExcluded && !isExecuteOnly) return s;
    const updated: Ht32IdeSource = { ...s };
    if (isExcluded)    updated.excluded    = true;
    if (isExecuteOnly) updated.executeOnly = true;
    return updated;
  });
  const warnings = [...projWarnings, ...extraWarnings];
  // ${ProjName} 是 Eclipse CDT 變數，需替換成實際專案名稱
  const outputName = (artifactName || projectName).replace(/\$\{ProjName\}/g, projectName);

  // 推算 FWLib root：共用 fwlRootFromSourcePath，STD 和 49x 皆適用。
  // 任何在 library/ / libraries/ / utilities/ 下的 source 皆可反推 FWLib root。
  let fwlibRoot: string | undefined;
  for (const src of sources) {
    const r = fwlRootFromSourcePath(src.absPath);
    if (r) { fwlibRoot = r; break; }
  }

  // Translate HT32-IDE post-build variables; bat path → absolute (caller calls resolveHt32IdePostBuildPath)
  // postbuildStep path is relative to the HT32-IDE build output dir (Project_xxx/HT32/), not projectDir.
  const postBuildCmd = postbuildStep
    ? buildHt32IdePostBuildCmd(postbuildStep, buildDir, outputName, icName, projectName)
    : undefined;

  // Mirror HT32-IDE's PARENT-n-PROJECT_LOC mechanism: for each -l library whose search
  // path is absent or stale (doesn't exist on this machine), search upward from projectDir
  // for lib<Name>.a and add the containing directory to extraLibPaths.
  const extraLibPaths = [...rest.extraLibPaths];
  for (const libName of rest.extraLibNames) {
    const libFile = `lib${libName}.a`;
    // Check if any existing extraLibPath already covers this library.
    const alreadyCovered = extraLibPaths.some(
      p => fs.existsSync(path.join(p.replace(/\//g, path.sep), libFile))
    );
    if (alreadyCovered) continue;
    // Search parent dirs (up to 6 levels = PARENT-6-PROJECT_LOC)
    let dir = projectDir;
    for (let n = 0; n < 6; n++) {
      if (fs.existsSync(path.join(dir, libFile))) {
        extraLibPaths.push(dir.replace(/\\/g, '/'));
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  return { projectName, outputName, sources, warnings, fwlibRoot, postBuildCmd, ...rest, extraLibPaths };
}

/**
 * Translate HT32-IDE post-build variables and resolve the bat path to absolute.
 * The caller must call resolveHt32IdePostBuildPath() once wsRoot is known.
 */
function buildHt32IdePostBuildCmd(
  raw:        string,
  projectDir: string,
  outputName: string,
  icName:     string,
  projectName: string,
): string {
  // Substitute Eclipse CDT variables
  let cmd = raw
    .replace(/\$\{BuildArtifactFileBaseName\}/g, outputName)
    .replace(/\$\{IC_NAME\}/g, icName)
    .replace(/\$\{ProjName\}/g, projectName);

  // Resolve first token (bat/exe path) from projectDir-relative to absolute.
  // If rawPath has no separator (bare command name like "arm-none-eabi-objcopy.exe"),
  // keep it as-is — path.resolve would wrongly anchor it to buildDir.
  const m = /^("(?:[^"\\]|\\.)*"|[^\s"]+)([\s\S]*)$/.exec(cmd.trim());
  if (!m) return cmd;
  const rawPathToken = m[1];
  const restArgs     = m[2];
  const rawPath = rawPathToken.startsWith('"') ? rawPathToken.slice(1, -1) : rawPathToken;
  // Replace ht32ide mode with vsc so the bat uses HT32_VSCode\ cwd-relative paths
  const newArgs = restArgs.trimStart().replace(/^ht32ide\b/, 'vsc');
  const isPathLike = rawPath.includes('/') || rawPath.includes('\\') || rawPath.startsWith('.');
  if (!isPathLike) {
    return newArgs ? `${rawPath} ${newArgs}` : rawPath;
  }
  const absPath = path.resolve(projectDir, rawPath.replace(/\//g, path.sep));
  // keep backslashes — cmd.exe needs them; resolveHt32IdePostBuildPath will relativize
  const pathToken = absPath.includes(' ') ? `"${absPath}"` : absPath;
  return `${pathToken} ${newArgs}`;
}

/**
 * Convert the absolute bat path in an HT32-IDE post-build command to a path
 * relative to wsRoot (= HT32_VSCode/, the post-build working directory).
 */
export function resolveHt32IdePostBuildPath(cmd: string, wsRoot: string, srcRoot?: string): string {
  if (!cmd) return '';
  const m = /^("(?:[^"\\]|\\.)*"|[^\s"]+)([\s\S]*)$/.exec(cmd.trim());
  if (!m) return cmd;
  const rawPathToken = m[1];
  const restArgs     = m[2];
  const rawPath = rawPathToken.startsWith('"') ? rawPathToken.slice(1, -1) : rawPathToken;
  // Bare command (no path separator) — already a system command, nothing to relativize
  if (!rawPath.includes('/') && !rawPath.includes('\\') && !rawPath.startsWith('.')) {
    return cmd.trim();
  }
  const batAbs     = rawPath.replace(/\//g, path.sep);
  const batDestAbs = srcRoot ? relocateBatToWsRoot(batAbs, srcRoot, wsRoot) : batAbs;
  const relPath    = path.relative(wsRoot, batDestAbs);  // keep backslashes
  const pathToken = relPath.includes(' ') ? `"${relPath}"` : relPath;
  return `${pathToken}${restArgs}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Makefile generation
// ─────────────────────────────────────────────────────────────────────────────

export function generateMakefile(result: Ht32IdeResult, bgDir: string, gccPath: string, extraCFlags?: string, gcSections?: boolean): string {
  // ── Cross-drive check ──────────────────────────────────────────────────────
  const bgDrive = path.parse(bgDir).root.toUpperCase();
  for (const s of result.sources) {
    const d = path.parse(s.absPath.replace(/\//g, path.sep)).root.toUpperCase();
    if (d && bgDrive && d !== bgDrive) {
      throw new Error(
        `Cross-drive path not supported: source "${s.absPath}" is on drive ${d} but ` +
        `build-gen is on ${bgDrive}. Please place the project and library on the same drive.`
      );
    }
  }
  for (const inc of result.includePaths) {
    const d = path.parse(inc.replace(/\//g, path.sep)).root.toUpperCase();
    if (d && bgDrive && d !== bgDrive) {
      throw new Error(
        `Cross-drive path not supported: include "${inc}" is on drive ${d} but ` +
        `build-gen is on ${bgDrive}.`
      );
    }
  }

  const toBgRel = (absPath: string): string =>
    path.relative(bgDir, absPath.replace(/\//g, path.sep)).replace(/\\/g, '/');

  // Sources: compilable files only (exclude missing/excluded), converted to bgDir-relative
  const compilable = result.sources.filter(s => /\.(c|cpp|s|S)$/i.test(s.absPath) && !s.headerOnly && !s.missing && !s.excluded);
  const bgRelSrcs  = compilable.map(s => toBgRel(s.absPath));

  // Linker scripts: bgDir-relative paths
  const ldBasename = result.linkerScript ? path.basename(result.linkerScript) : '';
  const allLdPaths = [
    ldBasename ? `../GNU_ARM/${ldBasename}` : '',
    ...(result.extraLinkerScripts ?? []).map(s => `../GNU_ARM/${path.basename(s)}`),
  ].filter(Boolean);

  const fpu      = result.fpuName || undefined;
  const floatAbi = result.fpuName ? (result.hardFloat ? 'hard' : 'softfp') : 'soft';

  return buildMakefileText({
    target:            result.outputName,
    cc:                gccPath,
    mcu:               result.armCore,
    srcs:              bgRelSrcs,
    linkerScripts:     allLdPaths,
    isLibrary:         !!result.isLibrary,
    fpu,
    floatAbi,
    optimizationLevel: result.optimization,
    useNano:           result.useNano,
    useNosys:          result.useNosys,
    useLto:            result.useLto,
    printfFloat:       result.printfFloat,
    scanfFloat:        result.scanfFloat,
    extraLibPaths:     (result.extraLibPaths ?? []).map(toBgRel),
    extraLibNames:     result.extraLibNames,
    gcSections:        gcSections !== false,
    extraCFlags:       extraCFlags || '-std=gnu11',
    comment:           'Converted from HT32-IDE.',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// project.meta.json helper
// ─────────────────────────────────────────────────────────────────────────────

export function buildProjectMeta(result: Ht32IdeResult, wsRoot: string): {
  projectName: string; groups: Record<string, string[]>; fileOptions?: Record<string, FileOption>; rtos?: string;
} {
  const groups: Record<string, string[]> = {};
  const fileOptions: Record<string, FileOption> = {};
  for (const src of result.sources) {
    const rel = path.relative(wsRoot, src.absPath.replace(/\//g, path.sep));
    const p = path.isAbsolute(rel) ? src.absPath : rel.replace(/\\/g, '/');
    (groups[src.group] ||= []).push(p);
    const fo: FileOption = {};
    if (src.excluded)    fo.exclude = true;
    if (src.executeOnly) fo.xo = true;
    if (Object.keys(fo).length) fileOptions[p] = fo;
  }
  // Direct .a files from linker.otherobjs — same path normalisation as sources above.
  for (const absPath of result.extraLibFiles ?? []) {
    const rel = path.relative(wsRoot, absPath.replace(/\//g, path.sep));
    const p = path.isAbsolute(rel) ? absPath : rel.replace(/\\/g, '/');
    (groups['Libraries'] ||= []).push(p);
  }
  return {
    projectName: result.projectName,
    groups,
    ...(Object.keys(fileOptions).length ? { fileOptions } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Linker script generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate the content of the linker script to be placed in the bgDir (retains original filename).
 *
 * If the .cproject referenced a linker.ld, read it and patch the MEMORY block
 * with the correct IROM1/IRAM1 sizes from the .cproject (the source file has
 * placeholder 1024K values).  If no source linker script exists, generate a
 * minimal self-contained script.
 */
export function generateLinkerScript(result: Ht32IdeResult, extPath?: string): string {
  const fOrigin = result.flashOrigin || '0x00000000';
  const fLen    = result.flashLength || '0x00020000';
  const rOrigin = result.ramOrigin   || '0x20000000';
  const rLen    = result.ramLength   || '0x00002000';

  if (result.linkerScript && fs.existsSync(result.linkerScript.replace(/\//g, path.sep))) {
    let content = fs.readFileSync(result.linkerScript.replace(/\//g, path.sep), 'utf8');
    // Patch FLASH LENGTH only when the source .ld has a placeholder value (≥ 1MB).
    // FLASH ORIGIN is intentionally left unchanged — project-specific scripts may use a
    // non-zero origin (e.g. 0x00002800 for AP-after-IAP) or an IAP+AP combined layout
    // where FLASH starts at 0x0 to include the embedded IAP binary via .incbin.
    // Patching ORIGIN would break the LMA layout and cause section overlap errors.
    const flashRe = /(FLASH\b[^\n:]*:\s*ORIGIN\s*=\s*)(0x[0-9a-fA-F]+|\d+)(\s*,\s*LENGTH\s*=\s*)(0x[0-9a-fA-F]+|\d+[KkMm]?)/;
    const flashMatch = flashRe.exec(content);
    if (flashMatch) {
      const rawLen    = flashMatch[4];
      const numericLen = rawLen.endsWith('M') || rawLen.endsWith('m')
        ? parseInt(rawLen) * 1024 * 1024
        : rawLen.endsWith('K') || rawLen.endsWith('k')
          ? parseInt(rawLen) * 1024
          : parseInt(rawLen, rawLen.startsWith('0x') || rawLen.startsWith('0X') ? 16 : 10);
      // Placeholder LENGTH ≥ 1MB — replace with device-specific flash size from .cproject.
      // Preserve original ORIGIN (use $1$2 to keep the matched ORIGIN value).
      if (numericLen >= 1024 * 1024) {
        content = content.replace(flashRe, `$1$2$3${fLen}`);
      }
    }
    // Patch RAM LENGTH only when the source .ld has a placeholder value (≥ 1MB).
    // RAM ORIGIN is intentionally left unchanged — project-specific scripts may reserve
    // bytes at the start of RAM (e.g. 0x20000010 for IAP bootloader communication area).
    // When ORIGIN is offset from 0x20000000, subtract the offset from the device RAM size
    // so that __StackTop = ORIGIN(RAM)+LENGTH(RAM) does not point outside real RAM.
    const ramRe = /(RAM\b[^\n:]*:\s*ORIGIN\s*=\s*)(0x[0-9a-fA-F]+|\d+)(\s*,\s*LENGTH\s*=\s*)(0x[0-9a-fA-F]+|\d+[KkMm]?)/;
    const ramMatch = ramRe.exec(content);
    if (ramMatch) {
      const rawRamLen = ramMatch[4];
      const numericRamLen = rawRamLen.endsWith('M') || rawRamLen.endsWith('m')
        ? parseInt(rawRamLen) * 1024 * 1024
        : rawRamLen.endsWith('K') || rawRamLen.endsWith('k')
          ? parseInt(rawRamLen) * 1024
          : parseInt(rawRamLen, rawRamLen.startsWith('0x') || rawRamLen.startsWith('0X') ? 16 : 10);
      if (numericRamLen >= 1024 * 1024) {
        const originInLd = parseInt(ramMatch[2], ramMatch[2].startsWith('0x') || ramMatch[2].startsWith('0X') ? 16 : 10);
        const sramBase = 0x20000000;
        const offset = originInLd > sramBase ? originInLd - sramBase : 0;
        const deviceLen = parseInt(rLen, 16);
        const adjustedLen = '0x' + Math.max(0, deviceLen - offset).toString(16);
        content = content.replace(ramRe, `$1$2$3${adjustedLen}`);
      }
    }
    // 49x FWLib .ld 有硬編碼 `_estack = 0x2xxxxxxx`；改成 expression form
    content = content.replace(
      /(_estack\s*=\s*)0x[\da-fA-F]+\s*;([^\n]*)/,
      '$1ORIGIN(RAM) + LENGTH(RAM); /* end of RAM */'
    );
    // Add __StackTop, separate .heap/.stack sections, __HT_check_sp for Stack Usage Analysis.
    content = patchLdStackSections(content);
    return content;
  }

  // No .cproject scriptfile — locate FWLib linker script from project sources.
  // STD: library/ → project_template/IP/Example/GNU_ARM/linker.ld
  // 49x: libraries/ or utilities/ → startup/gcc/linker/<chip>_FLASH.ld
  // FWLib root 由 fwlRootFromSourcePath 反推（共用，不依賴特定子目錄存在）。
  const patchFlashRam = (c: string) =>
    c.replace(
      /(FLASH\b[^\n:]*:\s*ORIGIN\s*=\s*)(?:0x[0-9a-fA-F]+|\d+)(\s*,\s*LENGTH\s*=\s*)(?:0x[0-9a-fA-F]+|\d+[KkMm]?)/,
      `$1${fOrigin}$2${fLen}`
    ).replace(
      /(RAM\b[^\n:]*:\s*ORIGIN\s*=\s*)(?:0x[0-9a-fA-F]+|\d+)(\s*,\s*LENGTH\s*=\s*)(?:0x[0-9a-fA-F]+|\d+[KkMm]?)/,
      `$1${rOrigin}$2${rLen}`
    );
  // STD series
  const stdSrc = result.sources.find(s => /library[/\\]HT32\w+_Driver[/\\]src[/\\]/i.test(s.absPath));
  if (stdSrc) {
    const srcDir  = path.dirname(stdSrc.absPath);    // .../src
    const drvDir  = path.dirname(srcDir);             // .../HT32Fxxxx_Driver
    const libDir  = path.dirname(drvDir);             // .../library
    const fwlRoot = path.dirname(libDir);             // FWLib root
    const fwlLd = path.join(fwlRoot, 'project_template', 'IP', 'Example', 'GNU_ARM', 'linker.ld');
    let effectiveLd: string | undefined = fs.existsSync(fwlLd) ? fwlLd : undefined;
    if (!effectiveLd && extPath) {
      const bundledDir = bundledGnuDirFromFwlRoot(fwlRoot, extPath);
      const cand = bundledDir ? path.join(bundledDir, 'linker.ld') : undefined;
      if (cand && fs.existsSync(cand)) { effectiveLd = cand; logInfo(`generateLinkerScript: linker.ld from bundled templates (HT32-IDE FWLib missing)`); }
    }
    if (!effectiveLd)
      throw new Error(`HT32-IDE: no scriptfile in .cproject and STD FWLib linker.ld not found: ${fwlLd}`);
    let content = fs.readFileSync(effectiveLd, 'utf8');
    content = patchFlashRam(content);
    content = patchLdStackSections(content);
    return content;
  }

  // 49x 系列：以 MCU 型號判斷，FWLib root 從任何 libraries/ 或 utilities/ source 反推。
  if (is49xDevice(result.deviceName ?? '')) {
    let fwlRoot: string | undefined;
    for (const src of result.sources) {
      fwlRoot = fwlRootFromSourcePath(src.absPath);
      if (fwlRoot) break;
    }
    if (!fwlRoot)
      throw new Error(`HT32-IDE: 49x MCU (${result.deviceName}) but no libraries/utilities source found to locate FWLib root.`);
    const gccDir    = find49xGccDir(fwlRoot);
    if (!gccDir)
      throw new Error(`HT32-IDE: 49x FWLib gcc startup dir not found under ${fwlRoot}`);
    const linkerDir = path.join(gccDir, 'linker');
    if (!fs.existsSync(linkerDir))
      throw new Error(`HT32-IDE: no scriptfile in .cproject and 49x linker dir not found: ${linkerDir}`);
    const ldFiles = fs.readdirSync(linkerDir).filter(f => f.endsWith('_FLASH.ld'));
    if (!ldFiles.length)
      throw new Error(`HT32-IDE: no scriptfile in .cproject and no *_FLASH.ld in ${linkerDir}`);
    const chipRaw = (result.deviceName ?? '').toUpperCase().replace(/[_\s].*/, '');
    const matchLd = ldFiles.find(f => f.toUpperCase() === `${chipRaw}_FLASH.LD`)
                 ?? ldFiles.find(f => chipRaw && f.toUpperCase().startsWith(chipRaw.substring(0, 9)))
                 ?? ldFiles[0];
    let content = fs.readFileSync(path.join(linkerDir, matchLd), 'utf8');
    content = content.replace(
      /(_estack\s*=\s*)0x[\da-fA-F]+\s*;([^\n]*)/,
      '$1ORIGIN(RAM) + LENGTH(RAM); /* end of RAM */'
    );
    content = patchFlashRam(content);
    content = patchLdStackSections(content);
    return content;
  }

  throw new Error(
    'HT32-IDE: no linker script in .cproject and unable to locate FWLib from project sources.\n' +
    'STD: need a file from library/HT32xxxx_Driver/src/.\n' +
    '49x: need a file from libraries/ or utilities/ (MCU must be HT32x49x).'
  );
}

/**
 * Copy startup .s files to bgDir and patch:
 *   .section ".stack","w"  →  .section ".stack","aw",%nobits
 *   .section ".heap","w"   →  .section ".heap","aw",%nobits
 *
 * Missing SHF_ALLOC ("a") causes the section to have no VMA contribution,
 * so --print-memory-usage shows wrong (too small) RAM usage.
 * Missing %nobits causes the section to appear as SHT_PROGBITS, which wastes
 * Flash (linker places an LMA copy in Flash even though it's BSS-like data).
 *
 * Returns a copy of result with patched startup absPath values pointing to bgDir.
 */
/** Write sources.list / includes.list / defines.list / adefines.list for a converted HT32-IDE project. */
export function writeHt32IdeLists(bgDir: string, result: Ht32IdeResult): void {
  const toBgRel = (absPath: string): string =>
    path.relative(bgDir, absPath.replace(/\//g, path.sep)).replace(/\\/g, '/');

  const compilable = result.sources.filter(s => /\.(c|cpp|s|S)$/i.test(s.absPath) && !s.headerOnly && !s.missing && !s.excluded);
  const srcs    = compilable.map(s => toBgRel(s.absPath));
  const incsStr = ['-I../GNU_ARM', ...result.includePaths.map(p => `-I"${toBgRel(p)}"`)].join(' ');
  const defsStr = result.defines.map(d => `-D${d}`).join(' ');
  // ASM-only defines: asmDefines entries not already in C defines
  const cDefSet = new Set(result.defines);
  const asmOnlyDefs = (result.asmDefines ?? []).filter(d => !cDefSet.has(d));
  const aDefsStr = asmOnlyDefs.map(d => `-D${d}`).join(' ');

  fs.writeFileSync(path.join(bgDir, 'sources.list'), srcs.join('\n'));
  writeProjectLists(bgDir, { includes: incsStr, defines: defsStr, adefines: aDefsStr });
}

export function patchStartupFiles(result: Ht32IdeResult, bgDir: string, gnuArmDir?: string): Ht32IdeResult {
  // Patched .s files go to gnuArmDir (GNU_ARM/) if provided, otherwise bgDir (backward compat)
  const dstDir = gnuArmDir ?? bgDir;

  // GNU assembler resolves .include relative to CWD (where make runs = bgDir).
  // Compute the relative path from bgDir to dstDir for rewriting .include paths.
  // e.g. bgDir=ht32_vscode/Project_AP/, dstDir=ht32_vscode/GNU_ARM/ → "../GNU_ARM"
  const relToDst = path.relative(bgDir, dstDir).replace(/\\/g, '/');

  // Build basename→source map so we can resolve .include references
  const sourcesByBasename = new Map<string, Ht32IdeSource>();
  for (const s of result.sources) {
    sourcesByBasename.set(path.basename(s.absPath).toLowerCase(), s);
  }

  // Track source files that are .include'd by a startup (must not be compiled standalone)
  const includedAbsPaths = new Set<string>();
  const extraWarnings: { message: string; file: string }[] = [];

  const INCLUDE_RE = /(\.include\s+)"([^"]+\.s)"/gi;

  const patchedSources = result.sources.map(s => {
    if (!/^startup_/i.test(path.basename(s.absPath)) || !/\.s$/i.test(s.absPath)) return s;
    if (!fs.existsSync(s.absPath.replace(/\//g, path.sep))) return s;
    let text = fs.readFileSync(s.absPath.replace(/\//g, path.sep), 'utf8');

    // Patch stack/heap section attributes; enforce minimum Heap_Size for GCC newlib-nano.
    text = text
      .replace(/\.section\s+"\.stack"\s*,\s*"w"(?:\s*,\s*%nobits)?/g, '.section ".stack","aw",%nobits')
      .replace(/\.section\s+"\.heap"\s*,\s*"w"(?:\s*,\s*%nobits)?/g,  '.section ".heap","aw",%nobits');
    text = text.replace(/(\.equ\s+Heap_Size\s*,\s*)(0x[0-9a-fA-F]+|\d+)/i, (_, prefix, val) => {
      const enforced = enforceMinHeap(val)!;
      if (enforced !== val) {
        extraWarnings.push({
          message: `Heap_Size=${val} enforced to ${enforced} (GCC newlib-nano requires heap for printf)`,
          file: s.absPath,
        });
      }
      return prefix + enforced;
    });

    // Resolve .include "..." paths: copy referenced .s files to dstDir and rewrite the path.
    // Files found in project sources are marked headerOnly to prevent standalone compilation.
    // Fallback: if not in project sources, look for the file by basename adjacent to the startup
    // (e.g. image_info.s lives beside startup.s in HT32-IDE/ but isn't listed in .project).
    INCLUDE_RE.lastIndex = 0;
    text = text.replace(INCLUDE_RE, (_match, prefix, incPath) => {
      const basename = path.basename(incPath).toLowerCase();
      const incSource = sourcesByBasename.get(basename);
      let incSrcAbs: string | undefined;
      if (incSource) {
        const p = incSource.absPath.replace(/\//g, path.sep);
        if (fs.existsSync(p)) {
          incSrcAbs = p;
          includedAbsPaths.add(incSource.absPath);
        }
      }
      if (!incSrcAbs) {
        // Not in project sources — check if copyIdeLocalFiles already placed it in dstDir
        const inDst = path.join(dstDir, path.basename(incPath));
        if (fs.existsSync(inDst)) {
          return `${prefix}"${relToDst}/${path.basename(incPath)}"`;
        }
      }
      if (incSrcAbs) {
        const dstFile = path.join(dstDir, path.basename(incPath));
        if (path.resolve(incSrcAbs) !== path.resolve(dstFile)) {
          fs.copyFileSync(incSrcAbs, dstFile);
        }
        return `${prefix}"${relToDst}/${path.basename(incPath)}"`;
      }
      return _match; // can't resolve — leave as-is
    });

    // Always copy to dstDir — never modify the original FWLib source.
    // Normalize extension to lowercase .s (FWLib may use uppercase .S).
    const dstBase = path.basename(s.absPath).replace(/\.S$/, '.s');
    const dst = path.join(dstDir, dstBase);
    if (path.resolve(s.absPath) === path.resolve(dst)) return s; // source is already in dstDir
    fs.writeFileSync(dst, text, 'utf8');
    return { ...s, absPath: dst.replace(/\\/g, '/') };
  });

  // Mark .include'd files as headerOnly so they are not compiled as standalone objects
  const finalSources = patchedSources.map(s =>
    includedAbsPaths.has(s.absPath) ? { ...s, headerOnly: true } : s
  );

  const warnings = extraWarnings.length
    ? [...result.warnings, ...extraWarnings]
    : result.warnings;
  const hasCsrcs = finalSources.some(s => /\.(c|cpp)$/i.test(s.absPath));
  return { ...result, sources: finalSources, warnings, hasCsrcs };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI-accessible core conversion (no VS Code APIs)
// ─────────────────────────────────────────────────────────────────────────────

const HT32_VSCODE_DIRNAME = 'HT32_VSCode';

function bgParentIde(wsRoot: string): string {
  if (path.basename(wsRoot).toLowerCase() === HT32_VSCODE_DIRNAME.toLowerCase()) return wsRoot;
  return path.join(wsRoot, HT32_VSCODE_DIRNAME);
}

const LOCAL_IDE_EXTS = /\.(c|cpp|s|h|a|o)$/i;  // .S covered by i flag; .o for pre-compiled objects

/**
 * Copy all local project files (not from FWLib) from the HT32-IDE root directory
 * to gnuArmDir.  Returns a map of normalised-slash old-abs → new-abs for updating
 * result.sources / result.extraLibFiles after the call.
 * Only scans maxdepth 1 (files directly in ht32IdeRoot, not sub-project subdirs).
 */
function copyIdeLocalFiles(ht32IdeRoot: string, gnuArmDir: string): Map<string, string> {
  const moved = new Map<string, string>();
  let entries: string[];
  try { entries = fs.readdirSync(ht32IdeRoot); } catch { return moved; }
  for (const name of entries) {
    if (!LOCAL_IDE_EXTS.test(name)) continue;
    const src = path.join(ht32IdeRoot, name);
    try { if (!fs.statSync(src).isFile()) continue; } catch { continue; }
    const dst = path.join(gnuArmDir, name);
    if (path.resolve(src) === path.resolve(dst)) continue;  // already in gnuArmDir
    fs.copyFileSync(src, dst);
    moved.set(src.replace(/\\/g, '/'), dst.replace(/\\/g, '/'));
    logInfo(`HT32-IDE convert: copied local file to GNU_ARM/: ${name}`);
  }
  return moved;
}

export interface Ht32IdeConvertProjectResult {
  wsRoot:      string;
  dirName:     string;
  bgDir:       string;
  projectName: string;
  deviceName?: string;
  armCore?:    string;
  ramOrigin?:  string;
  ramLength?:  string;
  fpuName?:    string;
  hardFloat?:  boolean;
  meta:        ReturnType<typeof buildProjectMeta> & { linkerScripts?: string[]; isLibrary?: boolean };
  warnings:    { message: string; file: string }[];
  cancelled?:  true;
}

/**
 * Compute the HT32_VSCode workspace root from a HT32-IDE project directory.
 *   49x layout: .../calibration/HT32-IDE          → wsRoot = calibration/
 *   STD layout: .../exDir/HT32-IDE/Project_xxx    → wsRoot = exDir/
 */
export function computeHt32IdeWsRoot(projectDir: string): string {
  return /^ht32-?ide$/i.test(path.basename(projectDir))
    ? path.dirname(projectDir)
    : path.dirname(path.dirname(projectDir));
}

/** Returns the HT32_VSCode directory that convertHt32IdeProject will create for a given projectDir. */
export function computeHt32IdeVsDir(projectDir: string): string {
  return bgParentIde(computeHt32IdeWsRoot(projectDir));
}

/**
 * Core HT32-IDE → HT32_VSCode conversion for a single project directory.
 * Does not call VS Code APIs — usable from CLI scripts.
 * Writes project.meta.json internally. Caller should call persistMeta(bgDir, result.meta)
 * to additionally refresh all derived build files (sources.list, Makefile SRCS, compile_commands.json).
 *
 * If confirmOverwrite is provided and HT32_VSCode already exists, it is called with the
 * directory path. Return false to cancel; the function returns { cancelled: true }.
 */
export async function convertHt32IdeProject(
  projectDir: string,
  opts: { extPath: string; gccPath: string; confirmOverwrite?: (dir: string) => Promise<boolean> }
): Promise<Ht32IdeConvertProjectResult> {
  const { extPath, gccPath } = opts;
  const warnings: { message: string; file: string }[] = [];

  const result = parseHt32IdeProject(projectDir);
  warnings.push(...result.warnings);

  const wsRoot = computeHt32IdeWsRoot(projectDir);
  logInfo(`HT32-IDE convert: ${result.projectName}, device=${result.deviceName}, core=${result.armCore}, wsRoot=${wsRoot}`);

  const ht32VsDir = bgParentIde(wsRoot);
  if (opts.confirmOverwrite && fs.existsSync(ht32VsDir)) {
    const confirmed = await opts.confirmOverwrite(ht32VsDir);
    if (!confirmed) return { wsRoot, dirName: '', bgDir: '', projectName: result.projectName, meta: {} as any, warnings: [], cancelled: true };
    fs.rmSync(ht32VsDir, { recursive: true, force: true });
  }

  const dirName   = /^ht32-?ide$/i.test(path.basename(projectDir))
    ? 'Project'
    : path.basename(projectDir);
  const bgDir     = path.join(ht32VsDir, dirName);
  const gnuArmDir = path.join(ht32VsDir, 'GNU_ARM');

  fs.mkdirSync(bgDir, { recursive: true });
  fs.mkdirSync(gnuArmDir, { recursive: true });

  const ldFileName = result.isLibrary ? '' : (result.linkerScript ? path.basename(result.linkerScript) : 'linker.ld');
  if (!result.isLibrary) {
    fs.writeFileSync(path.join(gnuArmDir, ldFileName), generateLinkerScript(result, extPath));
    for (const eld of result.extraLinkerScripts ?? []) {
      if (fs.existsSync(eld)) {
        fs.copyFileSync(eld, path.join(gnuArmDir, path.basename(eld)));
        logInfo(`HT32-IDE convert: copied extra ld script to GNU_ARM/: ${path.basename(eld)}`);
      } else {
        logWarn(`HT32-IDE convert: extra ld script not found: ${eld}`);
        warnings.push({ message: `Extra linker script not found: ${eld}`, file: path.join(projectDir, '.project') });
      }
    }
  }

  // Copy all local project files (non-FWLib) from the HT32-IDE root directory to GNU_ARM/.
  // STD: local files sit in path.dirname(projectDir) (= the HT32-IDE/ dir itself).
  // 49x: projectDir IS the HT32-IDE/ dir — local files sit directly in it.
  const ht32IdeRoot = /^ht32-?ide$/i.test(path.basename(projectDir))
    ? projectDir
    : path.dirname(projectDir);
  const localMoved = copyIdeLocalFiles(ht32IdeRoot, gnuArmDir);
  if (localMoved.size > 0) {
    result.sources     = result.sources.map(s => ({ ...s, absPath: localMoved.get(s.absPath) ?? s.absPath }));
    result.extraLibFiles = result.extraLibFiles.map(f => localMoved.get(f.replace(/\\/g, '/')) ?? f);
  }

  const patchedResult = patchStartupFiles(result, bgDir, gnuArmDir);

  if (!result.isLibrary && patchedResult.hasCsrcs) {
    generateStackAnalysis(gnuArmDir, extPath);
    patchedResult.sources.push({ group: 'vscode', absPath: path.join(gnuArmDir, 'ht32_stack_analysis.c').replace(/\\/g, '/') });
  }

  const isM4         = result.armCore === 'cortex-m4';
  // M4 without explicit FPU from .cproject: check __FPU_PRESENT before assuming fpv4-sp-d16.
  // HT32F490x1 is a Cortex-M4 with __FPU_PRESENT=0 — the fallback must not force FPU on it.
  const fpuDefault   = (isM4 && !result.fpuName)
    ? (detectFpuPresentFromHeader(result.includePaths ?? [], '') !== false ? 'fpv4-sp-d16' : undefined)
    : undefined;
  const fpuFinal     = result.fpuName || fpuDefault;
  const floatAbiFinal = result.fpuName
    ? (result.hardFloat ? 'hard' : 'softfp')
    : (fpuFinal ? 'hard' : 'soft');
  const idePostBuildCmd = result.postBuildCmd
    ? resolveHt32IdePostBuildPath(result.postBuildCmd, ht32VsDir, path.dirname(projectDir))
    : undefined;
  const isFirstConvert = !fs.existsSync(path.join(bgDir, 'project.settings.json'));
  const _existingSettings = readProjectSettings(bgDir);
  const effectiveExtraCFlags = _existingSettings.extraCFlags || '-std=gnu11';
  writeProjectSettings(bgDir, {
    ..._existingSettings,
    extraCFlags: effectiveExtraCFlags,
    ...(isFirstConvert ? { openocdDebugLevel: 1 } : {}),
    mcu:               result.armCore,
    targetName:        result.outputName,
    ramOrigin:         result.ramOrigin,
    ramLength:         result.ramLength,
    deviceName:        result.deviceName,
    optimizationLevel: result.optimization || 'Os',
    useNano:           patchedResult.hasCsrcs ? result.useNano  : false,
    useNosys:          patchedResult.hasCsrcs ? result.useNosys : false,
    fpu:               fpuFinal || 'none',
    floatAbi:          floatAbiFinal,
    useLto:            result.useLto,
    printfFloat:       result.printfFloat,
    scanfFloat:        result.scanfFloat,
    extraLibNames:     result.extraLibNames,
    extraLibPaths:     result.extraLibPaths.map((p: string) => {
      const abs = p.replace(/\//g, path.sep);
      return fs.existsSync(abs) ? path.relative(bgDir, abs).replace(/\\/g, '/') : p;
    }),
    includePaths: ['../GNU_ARM', ...(result.includePaths ?? []).map((p: string) => {
      const rel = path.relative(bgDir, p.replace(/\//g, path.sep)).replace(/\\/g, '/');
      return path.isAbsolute(rel) ? p : rel;
    })],
    ...(result.defines?.length ? { cDefs: result.defines } : {}),
    ...(() => {
      const cSet = new Set(result.defines ?? []);
      const asm = (result.asmDefines ?? []).filter(d => !cSet.has(d));
      return asm.length ? { aDefs: asm } : {};
    })(),
    ...(idePostBuildCmd ? { postBuildCmd: idePostBuildCmd } : {}),
  });

  const gcSections = _existingSettings.gcSections;
  fs.writeFileSync(path.join(bgDir, 'Makefile'), generateMakefile(patchedResult, bgDir, gccPath, effectiveExtraCFlags, gcSections));
  writeHt32IdeLists(bgDir, patchedResult);

  await writeCCDbFromLists(bgDir, {
    armCore:      patchedResult.armCore,
    fpu:          fpuFinal || undefined,
    floatAbi:     floatAbiFinal,
    optimization: patchedResult.optimization || 'Os',
    gcSections,
  });

  const baseMeta = buildProjectMeta(patchedResult, wsRoot);
  const allLdRelPaths: string[] = [];
  if (!result.isLibrary && ldFileName) {
    const ldGroup = 'Linker';
    allLdRelPaths.push(path.relative(bgDir, path.join(gnuArmDir, ldFileName)).replace(/\\/g, '/'));
    (baseMeta.groups[ldGroup] ??= []).push(
      path.relative(wsRoot, path.join(gnuArmDir, ldFileName)).replace(/\\/g, '/')
    );
    for (const eld of result.extraLinkerScripts ?? []) {
      allLdRelPaths.push(path.relative(bgDir, path.join(gnuArmDir, path.basename(eld))).replace(/\\/g, '/'));
      (baseMeta.groups[ldGroup] ??= []).push(
        path.relative(wsRoot, path.join(gnuArmDir, path.basename(eld))).replace(/\\/g, '/')
      );
    }
  }
  const meta = {
    ...baseMeta,
    ...(allLdRelPaths.length ? { linkerScripts: allLdRelPaths } : {}),
    ...(result.isLibrary ? { isLibrary: true } : {}),
  };
  fs.writeFileSync(path.join(bgDir, 'project.meta.json'), JSON.stringify(meta, null, 2));

  return {
    wsRoot,
    dirName,
    bgDir,
    projectName: result.outputName,
    deviceName:  result.deviceName,
    armCore:     result.armCore,
    ramOrigin:   result.ramOrigin,
    ramLength:   result.ramLength,
    fpuName:     result.fpuName,
    hardFloat:   result.hardFloat,
    meta,
    warnings,
  };
}
