// src/tools/settingsWebview.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { semverCmp } from './utils';

export interface FlashLoaderEntry {
  flm:      string;   // FLM basename e.g. "HT32F493x5_EXT_TYPE2_REAMP0_GENERAL.FLM"
  start:    string;
  end:      string;
  enabled?: boolean;   // undefined / true = enabled
}

/** Auto-configured loader entry (read-only display, derived from device info) */
export interface AutoLoaderEntry {
  flm:   string;   // FLM basename e.g. "HT32F493x5_512.FLM"
  start: string;
  end:   string;
  label: string;   // e.g. "Internal Flash", "Option Bytes"
}

/** Settings stored per-project in build-gen-{name}/project.settings.json */
export type ProjectSettings = {
  optimizationLevel: string;
  floatAbi:          string;
  fpu:               string;
  useNano:           boolean;
  useNosys:          boolean;
  extraCFlags:       string;
  extraLDFlags:      string;
  debugInterface:    string;
  adapterSerial:     string;   // empty = auto-select first matching adapter
  adapterSpeed:      string;   // kHz, empty = use interface cfg default
  dfpPath:           string;
  svdFile:           string;
  flashLoaders:      FlashLoaderEntry[];
  eraseMode:         string;
  serverType: string;          // 'openocd' | 'pyocd'
  openocdDebugLevel: number;
  smartFlash:        boolean;  // pyocd only: skip unchanged pages (smart_flash in pyocd.yaml)
  extraLibs:         string[];   // extra .a / .o file paths added to link step (direct path)
  extraLibNames:     string[];   // -lName  (library names, paired with extraLibPaths)
  extraLibPaths:     string[];   // -L"dir" (search paths for extraLibNames)
  outputName:        string;     // override TARGET := in Makefile (empty = keep original)
  debugInfo:         string;     // 'g0'|'g1'|'g'|'g3'  — GCC debug info level
  useLto:            boolean;    // -flto (added to both CFLAGS and LDFLAGS)
  printfFloat:       boolean;    // -u _printf_float (newlib-nano float printf)
  scanfFloat:        boolean;    // -u _scanf_float  (newlib-nano float scanf)
  postBuildCmd:       string;   // shell command to run after build (empty = disabled)
  gcSections:    boolean;  // -ffunction-sections -fdata-sections -Wl,--gc-sections
  includePaths:  string[]; // all -I paths written to includes.list (converter-generated + user-added)
  cDefs?:        string[]; // C defines (without -D prefix) written to defines.list
  aDefs?:        string[]; // ASM-only defines (without -D prefix) written to adefines.list
  // Read-only conversion metadata (written by convert/create, not user-editable via webview)
  mcu?:         string;   // e.g. "cortex-m0" / "cortex-m4"
  targetName?:  string;   // project/target name (used for ELF filename)
  ramOrigin?:   string;   // e.g. "0x20000000"
  ramLength?:   string;   // e.g. "0x4000"
  deviceName?:  string;   // e.g. "HT32F52352"
  outputType?:  string;   // "app" | "lib"
};

/** Machine-scoped settings saved to VS Code Global (User) settings */
export type MachineSettings = {
  gccPath:    string;
  openocdPath: string;
};

/** Backward-compat alias */
export type HT32Settings = MachineSettings & ProjectSettings;

const DEFAULT_LINKER_SCRIPTS = ['../GNU_ARM/linker.ld'];

const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  optimizationLevel: 'Os',
  floatAbi:          'soft',
  fpu:               'none',
  useNano:           true,
  useNosys:          true,
  extraCFlags:       '-std=gnu11',
  extraLDFlags:      '',
  debugInterface:    'CMSIS-DAP',
  adapterSerial:     '',
  adapterSpeed:      '',
  dfpPath:           '',
  svdFile:           '',
  flashLoaders:      [],
  eraseMode:         'erase_sector',
  serverType:        'pyocd',
  openocdDebugLevel: 1,
  smartFlash:        false,
  extraLibs:         [],
  extraLibNames:     [],
  extraLibPaths:     [],
  outputName:        '',
  debugInfo:         'g3',
  useLto:            false,
  printfFloat:       false,
  scanfFloat:        false,
  postBuildCmd:       '',
  gcSections:    true,
  includePaths:  [],
};

/** Migrate legacy debugInterface values to current names. */
function normalizeDebugInterface(val: string): string {
  if (val === 'e-Link32 Pro' || val === 'e-Link32 Lite') return 'CMSIS-DAP';
  return val;
}

/** Read per-project settings from build-gen-{name}/project.settings.json.
 *  Falls back to VS Code workspace settings if the file doesn't exist (migration / first run).
 *  For backward compat, merges missing meta fields from build.meta.json if present. */
export { DEFAULT_PROJECT_SETTINGS };

export function readProjectSettings(bgDir: string): ProjectSettings {
  const settingsPath = path.join(bgDir, 'project.settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const stored = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      // Migrate old field name extraIncludePaths → includePaths
      if (stored.extraIncludePaths !== undefined && stored.includePaths === undefined) {
        stored.includePaths = stored.extraIncludePaths;
      }
      const s = { ...DEFAULT_PROJECT_SETTINGS, ...stored };
      s.debugInterface = normalizeDebugInterface(s.debugInterface);
      if (!['openocd', 'pyocd'].includes(s.serverType)) { s.serverType = 'pyocd'; }
      // Migrate removed level 0 (was ERROR-only, breaks pyocd server detection)
      if (s.openocdDebugLevel < 1) { s.openocdDebugLevel = 1; }
      // Migrate removed 'none' erase mode (flash always requires sector erase)
      if (s.eraseMode === 'none') { s.eraseMode = 'erase_sector'; }
      // Migrate projects generated before 0.2.0: extraCFlags defaulted to ''.
      // 0.2.0+ defaults to -std=gnu11; back-fill it once and persist.
      if (!stored.extraCFlags) {
        let metaVersion = '';
        try { metaVersion = JSON.parse(fs.readFileSync(path.join(bgDir, 'project.meta.json'), 'utf8')).metaVersion ?? ''; } catch { /* ok */ }
        if (!metaVersion || semverCmp(metaVersion, '0.2.0') < 0) {
          s.extraCFlags = '-std=gnu11';
          try { writeProjectSettings(bgDir, s); } catch { /* non-critical */ }
        }
      }
      // Backward compat: old projects wrote meta fields only to build.meta.json
      if (!s.mcu) {
        try {
          const bm = JSON.parse(fs.readFileSync(path.join(bgDir, 'build.meta.json'), 'utf8'));
          if (bm.mcu)         s.mcu         = bm.mcu;
          if (bm.targetName)  s.targetName  = bm.targetName;
          if (bm.ramOrigin)   s.ramOrigin   = bm.ramOrigin;
          if (bm.ramLength)   s.ramLength   = bm.ramLength;
          if (bm.deviceName)  s.deviceName  = bm.deviceName;
          if (bm.outputType)  s.outputType  = bm.outputType;
        } catch { /* no build.meta.json */ }
      }
      return s;
    } catch (e: any) {
      vscode.window.showWarningMessage(
        `HT32: Failed to read project settings (${path.basename(bgDir)}): ${e?.message ?? e}. Using defaults.`
      );
    }
  }
  // Fallback: VS Code workspace settings (pre-migration or no bgDir)
  const cfg = vscode.workspace.getConfiguration('ht32');
  return {
    optimizationLevel: cfg.get('optimizationLevel', DEFAULT_PROJECT_SETTINGS.optimizationLevel),
    floatAbi:          cfg.get('floatAbi',          DEFAULT_PROJECT_SETTINGS.floatAbi),
    fpu:               cfg.get('fpu',               DEFAULT_PROJECT_SETTINGS.fpu),
    useNano:           cfg.get('useNano',           DEFAULT_PROJECT_SETTINGS.useNano),
    useNosys:          cfg.get('useNosys',          DEFAULT_PROJECT_SETTINGS.useNosys),
    extraCFlags:       cfg.get('extraCFlags',       DEFAULT_PROJECT_SETTINGS.extraCFlags),
    extraLDFlags:      cfg.get('extraLDFlags',      DEFAULT_PROJECT_SETTINGS.extraLDFlags),
    debugInterface:    normalizeDebugInterface(cfg.get('debugInterface', DEFAULT_PROJECT_SETTINGS.debugInterface)),
    adapterSerial:     cfg.get('adapterSerial',     DEFAULT_PROJECT_SETTINGS.adapterSerial),
    adapterSpeed:      cfg.get('adapterSpeed',      DEFAULT_PROJECT_SETTINGS.adapterSpeed),
    dfpPath:           cfg.get('dfpPath',           DEFAULT_PROJECT_SETTINGS.dfpPath),
    svdFile:           cfg.get('svdFile',           DEFAULT_PROJECT_SETTINGS.svdFile),
    flashLoaders:      cfg.get<FlashLoaderEntry[]>('flashLoaders', DEFAULT_PROJECT_SETTINGS.flashLoaders),
    eraseMode:         cfg.get<string>('eraseMode', DEFAULT_PROJECT_SETTINGS.eraseMode),
    serverType:        DEFAULT_PROJECT_SETTINGS.serverType,
    openocdDebugLevel: cfg.get<number>('openocdDebugLevel', DEFAULT_PROJECT_SETTINGS.openocdDebugLevel),
    smartFlash:        cfg.get<boolean>('smartFlash', DEFAULT_PROJECT_SETTINGS.smartFlash),
    extraLibs:         cfg.get<string[]>('extraLibs', DEFAULT_PROJECT_SETTINGS.extraLibs),
    extraLibNames:     [],
    extraLibPaths:     [],
    outputName:        '',
    debugInfo:         'g3',
    useLto:            false,
    printfFloat:       false,
    scanfFloat:        false,
    postBuildCmd:       '',
    gcSections:    true,
    includePaths:  [],
  };
}

/** Write per-project settings to build-gen-{name}/project.settings.json */
export function writeProjectSettings(bgDir: string, s: ProjectSettings, opts?: { keepEmptyFlashLoaders?: boolean }): void {
  // Omit flashLoaders when empty unless explicitly requested (e.g. webview save).
  // Key absence = "never configured" → generateTasksAndLaunchAndMakefile will auto-detect SPIM.
  // Key present as [] = user intentionally cleared loaders → skip auto-detect.
  const toWrite: Record<string, unknown> = { ...s, schemaVersion: '0.2.0' };
  if (!opts?.keepEmptyFlashLoaders &&
      (!Array.isArray(toWrite['flashLoaders']) || (toWrite['flashLoaders'] as unknown[]).length === 0)) {
    delete toWrite['flashLoaders'];
  }
  fs.writeFileSync(path.join(bgDir, 'project.settings.json'), JSON.stringify(toWrite, null, 2));
}

function readMachineSettings(): MachineSettings {
  const cfg = vscode.workspace.getConfiguration('ht32');
  return {
    gccPath:     cfg.get('gccPath',    ''),
    openocdPath: cfg.get('openocdPath', ''),
  };
}

async function writeMachineSettings(s: MachineSettings): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('ht32');
  await cfg.update('gccPath',     s.gccPath     || undefined, vscode.ConfigurationTarget.Global);
  await cfg.update('openocdPath', s.openocdPath  || undefined, vscode.ConfigurationTarget.Global);
}

/** Fallback: write project settings to VS Code workspace settings (when no project loaded) */
async function writeProjectSettingsToWorkspace(s: ProjectSettings): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('ht32');
  const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
  const target = hasWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await cfg.update('optimizationLevel', s.optimizationLevel || undefined, target);
  await cfg.update('floatAbi',          s.floatAbi          || undefined, target);
  await cfg.update('fpu',               s.fpu               || undefined, target);
  await cfg.update('useNano',           s.useNano,           target);
  await cfg.update('useNosys',          s.useNosys,          target);
  await cfg.update('extraCFlags',       s.extraCFlags       || undefined, target);
  await cfg.update('extraLDFlags',      s.extraLDFlags      || undefined, target);
  await cfg.update('debugInfo',         s.debugInfo         || undefined, target);
  await cfg.update('debugInterface',    s.debugInterface    || undefined, target);
  await cfg.update('adapterSerial',     s.adapterSerial     || undefined, target);
  await cfg.update('dfpPath',           s.dfpPath           || undefined, target);
  await cfg.update('svdFile',           s.svdFile           || undefined, target);
  await cfg.update('eraseMode',         s.eraseMode         || undefined, target);
  await cfg.update('smartFlash',        s.smartFlash        !== DEFAULT_PROJECT_SETTINGS.smartFlash        ? s.smartFlash        : undefined, target);
  await cfg.update('openocdDebugLevel', s.openocdDebugLevel || undefined, target);
  const loaders = s.flashLoaders.filter(l => l.flm && l.start && l.end);
  await cfg.update('flashLoaders', loaders.length > 0 ? loaders : undefined, target);
}

let panel: vscode.WebviewPanel | undefined;
let _openocdAvailable = true;

/** Known USB VID:PID pairs per debug interface type */
const ADAPTER_VID_PIDS: Record<string, string[]> = {
  'CMSIS-DAP': [
    'VID_04D9&PID_802F',  // Holtek e-Link32 Pro
    'VID_04D9&PID_8052',  // Holtek e-Link32 Lite
    'VID_0D28&PID_0204',  // Arm DAPLink / mbed
    'VID_1FC9&PID_0090',  // NXP LPC-Link2
    'VID_03EB&PID_2141',  // Microchip EDBG / Atmel-ICE
    'VID_1CBE&PID_00FD',  // TI ICDI (CMSIS-DAP mode)
  ],
  'ST-Link': [
    'VID_0483&PID_3748',  // ST-Link V2
    'VID_0483&PID_374B',  // ST-Link V2-1
    'VID_0483&PID_374E',  // ST-Link V3E
    'VID_0483&PID_374F',  // ST-Link V3S
    'VID_0483&PID_3754',  // ST-Link V3 PWR
  ],
  'J-Link': [
    'VID_1366&PID_0101',  // J-Link
    'VID_1366&PID_0105',  // J-Link Pro
    'VID_1366&PID_1015',  // J-Link Ultra+
    'VID_1366&PID_1020',  // J-Link OB (on-board)
  ],
};

/** Friendly device names keyed by VID_XXXX&PID_XXXX (upper-case) */
const ADAPTER_FRIENDLY_NAMES: Record<string, string> = {
  'VID_04D9&PID_802F': 'e-Link32',
  'VID_04D9&PID_8052': 'e-Link32',
  'VID_0D28&PID_0204': 'Arm DAPLink',
  'VID_1FC9&PID_0090': 'NXP LPC-Link2',
  'VID_03EB&PID_2141': 'Microchip EDBG / Atmel-ICE',
  'VID_1CBE&PID_00FD': 'TI ICDI',
  'VID_0483&PID_3748': 'ST-Link V2',
  'VID_0483&PID_374B': 'ST-Link V2-1',
  'VID_0483&PID_374E': 'ST-Link V3E',
  'VID_0483&PID_374F': 'ST-Link V3S',
  'VID_0483&PID_3754': 'ST-Link V3 PWR',
  'VID_1366&PID_0101': 'J-Link',
  'VID_1366&PID_0105': 'J-Link Pro',
  'VID_1366&PID_1015': 'J-Link Ultra+',
  'VID_1366&PID_1020': 'J-Link OB',
};

/**
 * Enumerate connected debug adapters via PowerShell USB device query.
 * Uses spawn+stdin to avoid cmd.exe mangling & and $ characters.
 * Returns list of { serial, label } — serial is the USB serial string (empty if not available).
 */
export async function scanAdapters(debugInterface: string): Promise<Array<{ serial: string; label: string }>> {
  const vidPids = ADAPTER_VID_PIDS[debugInterface] ?? ADAPTER_VID_PIDS['CMSIS-DAP'];
  const pattern = vidPids.join('|');

  // Use Get-WmiObject (universally available) rather than Get-PnpDevice
  // Filter out sub-interface entries (&MI_) to keep only the root USB device,
  // whose DeviceID ends with the actual USB serial number.
  // @() forces array even for single result; -InputObject avoids pipeline serialization issues
  const script = [
    `$pattern = '${pattern}'`,
    `$devs = @(Get-WmiObject Win32_PnPEntity | Where-Object { $_.DeviceID -match $pattern -and $_.DeviceID -notmatch '&MI_' })`,
    `$out = $devs | ForEach-Object { [PSCustomObject]@{ DeviceID=$_.DeviceID; Label=$_.Name; Serial=($_.DeviceID -split '\\\\')[-1] } }`,
    `if ($out) { ConvertTo-Json -InputObject @($out) -Compress } else { Write-Output '[]' }`,
  ].join('\n');

  return new Promise(resolve => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'],
      { timeout: 8000 });
    let stdout = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.on('close', () => {
      try {
        const parsed = JSON.parse(stdout.trim() || '[]');
        const arr: Array<{ DeviceID: string; Label: string; Serial: string }> = Array.isArray(parsed) ? parsed : [parsed];
        resolve(
          arr
            .filter(a => a?.DeviceID)  // keep all matched devices
            .map(a => {
              const vidPidMatch = (a.DeviceID ?? '').match(/VID_[0-9A-Fa-f]{4}&PID_[0-9A-Fa-f]{4}/i);
              const friendlyName = vidPidMatch ? ADAPTER_FRIENDLY_NAMES[vidPidMatch[0].toUpperCase()] : undefined;
              // Windows-generated IDs (e.g. 7&216E41C0&0&0000) mean the device has no USB serial number;
              // keep the entry but use empty serial so "adapter serial" is not set in OpenOCD config.
              const hasRealSerial = !!a.Serial && !/^\d+(&[0-9A-Fa-f]+)+$/i.test(a.Serial);
              return { serial: hasRealSerial ? a.Serial : '', label: friendlyName ?? a.Label ?? '' };
            })
        );
      } catch { resolve([]); }
    });
    proc.on('error', () => resolve([]));
    proc.stdin.write(script);
    proc.stdin.end();
  });
}

/** Locate pyocd without prompting to install. Returns the exe path, or undefined if not found. */
async function findPyocdExeQuick(extPath: string): Promise<string | undefined> {
  const inPath = await new Promise<boolean>(resolve => {
    const proc = spawn('pyocd', ['--version'], { timeout: 3000 });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
  if (inPath) return 'pyocd';

  const uvExe = path.join(extPath, 'bin', 'win32-x64', 'uv.exe');
  if (!fs.existsSync(uvExe)) return undefined;
  return new Promise(resolve => {
    const proc = spawn(uvExe, ['tool', 'dir', '--bin'], { timeout: 8000 });
    let out = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('close', () => {
      const exe = path.join(out.trim(), 'pyocd.exe');
      resolve(fs.existsSync(exe) ? exe : undefined);
    });
    proc.on('error', () => resolve(undefined));
  });
}

/** Run `pyocd list --json` and return connected probes as { serial: unique_id, label }. */
export async function scanPyocdProbes(pyocdExe: string): Promise<Array<{ serial: string; label: string }>> {
  return new Promise(resolve => {
    const proc = spawn(pyocdExe, ['list', '--json'], { timeout: 8000 });
    let stdout = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.on('close', () => {
      try {
        const parsed = JSON.parse(stdout.trim());
        const probes: Array<{ unique_id?: string; description?: string }> =
          Array.isArray(parsed.probes) ? parsed.probes : [];
        resolve(probes.map(p => ({ serial: p.unique_id ?? '', label: p.description ?? '' })));
      } catch { resolve([]); }
    });
    proc.on('error', () => resolve([]));
  });
}

/**
 * @param bgDirs   All build-gen-* dirs in the workspace. Empty = no project loaded yet.
 * @param autoLoadersByBg  Per-bgDir auto loaders (read-only display), keyed by bgDir name.
 * @param projectNamesByBg Per-bgDir project name from project.meta.json, keyed by bgDir name.
 */
/** Run OpenOCD briefly to read adapter/target info.
 *  Native (JLink/CMSIS-DAP): inline swj_newdap + dap create + dap info.
 *  HLA (ST-Link): transport hla_swd + HLMm0x.cfg + targets (dap info unsupported for HLA). */
async function runOpenocdProbe(exe: string, ifaceCfg: string, serial: string, speed: string): Promise<string> {
  const scriptsRoot = path.dirname(path.dirname(ifaceCfg));
  const isHla = ifaceCfg.toLowerCase().includes('stlink');
  const targetCfg = path.join(scriptsRoot, 'target', 'HLMm0x.cfg');

  const args = isHla
    ? [
        '-s', scriptsRoot,
        '-c', 'set WORKAREASIZE 0x800',
        '-f', ifaceCfg,
        ...(serial ? ['-c', `adapter serial ${serial}`] : []),
        '-c', 'transport select hla_swd',
        '-f', targetCfg,
        '-c', `adapter speed ${speed || '1000'}`,
        '-c', 'init',
        '-c', 'targets',
        '-c', 'HT32M0.cpu arp_examine',
        '-c', 'mdw 0xE000ED00',
        '-c', 'shutdown',
      ]
    : [
        '-s', scriptsRoot,
        '-f', ifaceCfg,
        ...(serial ? ['-c', `adapter serial ${serial}`] : []),
        '-c', 'transport select swd',
        '-c', `adapter speed ${speed || '1000'}`,
        '-c', 'source [find target/swj-dp.tcl]',
        '-c', 'swj_newdap _probe cpu -irlen 4',
        '-c', 'dap create _probe.dap -chain-position _probe.cpu',
        '-c', 'target create _probe.cpu cortex_m -dap _probe.dap',
        '-c', 'init',
        '-c', 'dap info',
        '-c', 'shutdown',
      ];

  return new Promise(resolve => {
    const proc = spawn(exe, args);
    let out = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    const killer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 4000);
    proc.on('close', () => {
      clearTimeout(killer);
      const lines = out.split('\n').map(l => l.replace(/^(Info|Warn|Error)\s*:\s*/i, '').trim());
      const result: string[] = [];
      // Adapter firmware: JLink/CMSIS-DAP → "FW: ...", ST-Link → "STLINK V2J45..."
      const fwLine = lines.find(l => /FW:/i.test(l) || /STLINK\s+V/i.test(l));
      if (fwLine) result.push(fwLine.trim());
      // HLA: parse "targets" table — state is the last word on the target row
      const tblLine = lines.find(l => /hla_target|cortex_m/i.test(l) && /running|halted|reset|unknown/i.test(l));
      if (tblLine) {
        // Resolve core type from CPUID register via mdw output: "0xe000ed00: 410cc601"
        const mdwLine = lines.find(l => /0xe000ed00\s*:\s*[0-9a-f]+/i.test(l));
        let coreType = 'Cortex-M';
        if (mdwLine) {
          const m = mdwLine.match(/0xe000ed00\s*:\s*([0-9a-f]+)/i);
          if (m) {
            const cpuid = parseInt(m[1], 16);
            const partNo = (cpuid >> 4) & 0xFFF;
            const partMap: Record<number, string> = {
              0xC20: 'Cortex-M0', 0xC60: 'Cortex-M0+',
              0xC23: 'Cortex-M3', 0xC24: 'Cortex-M4', 0xC27: 'Cortex-M7',
              0xD20: 'Cortex-M23', 0xD21: 'Cortex-M33',
            };
            coreType = partMap[partNo] ?? `Cortex-M (CPUID=0x${cpuid.toString(16).toUpperCase()})`;
          }
        }
        const stM = tblLine.match(/\b(running|halted|reset)\b/i);
        result.push(stM ? `Target: ${coreType} (${stM[1]})` : `Target: ${coreType}`);
      }
      // Native: Cortex-M core type from dap info ROM table
      if (!tblLine) {
        for (const l of lines) {
          const m = l.match(/Part is [^,]+,\s*(Cortex-M[^\s(,]+)/i);
          if (m) { result.push(`Target: ${m[1]}`); break; }
        }
      }
      // Fallback: show first error if nothing useful found
      if (result.length === 0) {
        const errLine = lines.find(l => /^error:/i.test(l) || /failed|unable|timeout/i.test(l));
        if (errLine) result.push(errLine);
      }
      resolve(result.join('\n') || '(no response)');
    });
    proc.on('error', (e: Error) => resolve(`Error: ${e.message}`));
  });
}

/** Map debug interface name to interface cfg path (mirrors selectInterfaceCfg in main extension) */
function selectIfaceCfgForProbe(debugInterface: string, openocdRoot: string): string {
  switch (debugInterface) {
    case 'ST-Link': return `${openocdRoot}/scripts/interface/stlink.cfg`;
    case 'J-Link':  return `${openocdRoot}/scripts/interface/jlink.cfg`;
    default:        return `${openocdRoot}/scripts/interface/cmsis-dap.cfg`;
  }
}

export function openSettingsPanel(
  bgDirs: Array<{ name: string; dir: string }>,
  availableFlms: string[],
  autoLoadersByBg: Record<string, AutoLoaderEntry[]>,
  projectNamesByBg: Record<string, string>,
  flmAddrMap: Record<string, { start: string; end: string }>,
  openocdExe: string,
  openocdRoot: string,
  extensionPath: string,
  onSave: (updateConfig: boolean) => Promise<void>,
  detectedGccPath?: string
): void {
  if (panel) { panel.reveal(); return; }

  panel = vscode.window.createWebviewPanel(
    'ht32Settings', 'HT32 Settings',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  const machineSettings = readMachineSettings();
  const projectSettingsByBg: Record<string, ProjectSettings> = {};
  const targetNamesByBg:     Record<string, string> = {};
  const linkerScriptsByBg:   Record<string, string[]> = {};
  for (const bg of bgDirs) {
    const s = readProjectSettings(bg.dir);
    projectSettingsByBg[bg.name] = s;
    if (s.targetName) targetNamesByBg[bg.name] = s.targetName;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(bg.dir, 'project.meta.json'), 'utf8'));
      linkerScriptsByBg[bg.name] = (meta.linkerScripts as string[] | undefined) ?? DEFAULT_LINKER_SCRIPTS;
    } catch (e) {
      vscode.window.showWarningMessage(`HT32: Failed to read linker scripts for ${bg.name} — ${(e as Error).message ?? e}`);
      linkerScriptsByBg[bg.name] = DEFAULT_LINKER_SCRIPTS;
    }
  }

  _openocdAvailable = fs.existsSync(openocdRoot);
  panel.webview.html = buildHtml(
    machineSettings, bgDirs, projectSettingsByBg, availableFlms, autoLoadersByBg, projectNamesByBg, flmAddrMap, targetNamesByBg, linkerScriptsByBg, detectedGccPath
  );

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'autoSave' || msg.type === 'save') {
      await writeMachineSettings(msg.machineSettings as MachineSettings);
      const allProj = msg.allProjectSettings as Record<string, ProjectSettings> | undefined;
      if (allProj) {
        for (const bg of bgDirs) {
          if (allProj[bg.name]) {
            writeProjectSettings(bg.dir, { ...readProjectSettings(bg.dir), ...allProj[bg.name] }, { keepEmptyFlashLoaders: true });
          }
        }
      } else {
        // No project loaded: fallback to workspace settings
        if (msg.projectSettings) {
          await writeProjectSettingsToWorkspace(msg.projectSettings as ProjectSettings);
        }
      }
      // Write linkerScripts back to meta.json (not part of ProjectSettings)
      const ldByBg = msg.linkerScriptsByBg as Record<string, string[]> | undefined;
      if (ldByBg) {
        for (const bg of bgDirs) {
          const scripts = ldByBg[bg.name];
          if (!scripts) continue;
          try {
            const metaPath = path.join(bg.dir, 'project.meta.json');
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            // Normalize: convert absolute paths to bgDir-relative
            const newScripts: string[] = scripts.map((s: string) =>
              path.isAbsolute(s) ? path.relative(bg.dir, s).replace(/\\/g, '/') : s
            );
            const projectRoot = path.dirname(path.dirname(bg.dir));
            meta.groups = meta.groups ?? {};

            // Helper: bgDir-relative ld → projectRoot-relative (newScripts are always relative after normalization above)
            const toGroupPath = (ldRel: string) =>
              path.relative(projectRoot, path.resolve(bg.dir, ldRel)).replace(/\\/g, '/');

            const prevScripts: string[] = meta.linkerScripts ?? [];
            const prevSet = new Set(prevScripts.map(toGroupPath));
            const newSet  = new Set(newScripts.map(toGroupPath));

            // Add new entries to groups["Linker"] (dedup)
            const linkerGroup: string[] = meta.groups['Linker'] ?? [];
            for (const gp of newSet) {
              if (!prevSet.has(gp) && !linkerGroup.includes(gp)) {
                linkerGroup.push(gp);
              }
            }
            meta.groups['Linker'] = linkerGroup;

            // Remove deleted entries from whichever group contains them
            const removedSet = new Set([...prevSet].filter(gp => !newSet.has(gp)));
            for (const grp of Object.keys(meta.groups)) {
              meta.groups[grp] = (meta.groups[grp] as string[]).filter(
                (p: string) => !removedSet.has(p)
              );
            }

            meta.linkerScripts = newScripts;
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
          } catch (e) {
              vscode.window.showWarningMessage(`HT32: Failed to update linker scripts in project.meta.json — ${(e as Error).message ?? e}`);
            }
        }
      }
      if (msg.type === 'autoSave') {
        await onSave(true);    // Makefile flags + tasks/launch
        panel?.webview.postMessage({ type: 'autoSaved' });
      } else {
        await onSave(msg.updateConfig as boolean);
        panel?.dispose();
        vscode.window.showInformationMessage('HT32 settings saved.');
      }
    } else if (msg.type === 'scanAdapters') {
      let adapters: Array<{ serial: string; label: string }> = [];
      if ((msg.serverType as string | undefined) === 'pyocd') {
        const pyocdExe = await findPyocdExeQuick(extensionPath);
        if (pyocdExe) { adapters = await scanPyocdProbes(pyocdExe); }
        // fallback to WMI scan if pyocd list returns nothing
        if (adapters.length === 0) { adapters = await scanAdapters(msg.debugInterface as string); }
      } else {
        adapters = await scanAdapters(msg.debugInterface as string);
      }
      panel?.webview.postMessage({ type: 'adapterList', bgName: msg.bgName ?? '', adapters, fromUser: msg.fromUser ?? false });
    } else if (msg.type === 'queryIdcode') {
      const ifaceCfg = selectIfaceCfgForProbe(msg.debugInterface as string, openocdRoot);
      const result = await runOpenocdProbe(openocdExe, ifaceCfg, msg.serial as string, msg.adapterSpeed as string);
      panel?.webview.postMessage({ type: 'idcodeResult', bgName: msg.bgName ?? '', serial: msg.serial ?? '', text: result });
    } else if (msg.type === 'browseFile') {
      const relativeBase = msg.relativeBase as string | undefined;
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Select',
        defaultUri: resolveBrowseDefaultUri(msg.currentPath as string | undefined, msg.bgDir as string | undefined),
        filters: (msg.filters as Record<string, string[]> | undefined) ?? { 'All files': ['*'] },
      });
      if (uris && uris.length > 0) {
        const filePath = relativeBase
          ? path.relative(relativeBase, uris[0].fsPath).replace(/\\/g, '/')
          : uris[0].fsPath;
        panel?.webview.postMessage({ type: 'browseFileResult', browseId: msg.browseId, filePath });
      }
    } else if (msg.type === 'browseDir') {
      const relativeBase = msg.relativeBase as string | undefined;
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        canSelectFolders: true,
        canSelectFiles: false,
        openLabel: 'Select Folder',
        defaultUri: resolveBrowseDefaultUri(msg.currentPath as string | undefined, msg.bgDir as string | undefined),
      });
      if (uris && uris.length > 0) {
        const filePath = relativeBase
          ? path.relative(relativeBase, uris[0].fsPath).replace(/\\/g, '/')
          : uris[0].fsPath;
        panel?.webview.postMessage({ type: 'browseFileResult', browseId: msg.browseId, filePath });
      }
    } else if (msg.type === 'cancel') {
      panel?.dispose();
    }
  });

  panel.onDidChangeViewState(e => {
    if (!e.webviewPanel.visible) {
      panel?.webview.postMessage({ type: 'requestFlush' });
    }
  });
  panel.onDidDispose(() => { panel = undefined; });
}

/**
 * Called by TreeView operations (add/remove .ld) to sync the open Settings WebView.
 * If the panel is not open, this is a no-op.
 */
export function notifySettingsLinkerScriptsChanged(bgName: string, linkerScripts: string[]): void {
  panel?.webview.postMessage({ type: 'updateLinkerScripts', bgName, linkerScripts });
}

/** Resolve the default directory for a file/folder browse dialog.
 *  Tries to open at the current path's directory; falls back to bgDir. */
function resolveBrowseDefaultUri(currentPath: string | undefined, bgDir: string | undefined): vscode.Uri | undefined {
  if (currentPath) {
    try {
      const resolved = (bgDir && !path.isAbsolute(currentPath)) ? path.resolve(bgDir, currentPath) : currentPath;
      const stat = fs.statSync(resolved);
      return vscode.Uri.file(stat.isDirectory() ? resolved : path.dirname(resolved));
    } catch { /* path doesn't exist yet */ }
  }
  if (bgDir) {
    try { return vscode.Uri.file(bgDir); } catch { /* ignore */ }
  }
  return undefined;
}

/* ────────────────────────────────────────────────
 * HTML builder
 * ──────────────────────────────────────────────── */

const PROJ_COLORS = ['#4db6ac', '#ff8a65', '#ce93d8', '#4fc3f7', '#aed581', '#ffcc80'];

function buildHtml(
  machine: MachineSettings,
  bgDirs: Array<{ name: string; dir: string }>,
  projectSettingsByBg: Record<string, ProjectSettings>,
  availableFlms: string[],
  autoLoadersByBg: Record<string, AutoLoaderEntry[]>,
  projectNamesByBg: Record<string, string>,
  flmAddrMap: Record<string, { start: string; end: string }>,
  targetNamesByBg:   Record<string, string> = {},
  linkerScriptsByBg: Record<string, string[]> = {},
  detectedGccPath?: string
): string {
  const flmsJson    = JSON.stringify(availableFlms);
  const addrMapJson = JSON.stringify(flmAddrMap);
  const bgNamesJson = JSON.stringify(bgDirs.map(b => b.name));
  const bgDirsJson  = JSON.stringify(Object.fromEntries(bgDirs.map(b => [b.name, b.dir])));

  const projSections = bgDirs.length > 0
    ? bgDirs.map((bg, i) => buildProjectSection(
        bg.name,
        projectNamesByBg[bg.name] ?? bg.name,
        PROJ_COLORS[i % PROJ_COLORS.length],
        projectSettingsByBg[bg.name] ?? DEFAULT_PROJECT_SETTINGS,
        autoLoadersByBg[bg.name] ?? [],
        availableFlms,
        targetNamesByBg[bg.name]  ?? '',
        i === 0 ? machine : null,
        i === 0 ? detectedGccPath : undefined,
        linkerScriptsByBg[bg.name] ?? DEFAULT_LINKER_SCRIPTS
      )).join('\n')
    : `<p class="hint" style="color:var(--vscode-inputValidation-warningForeground);margin:8px 0 16px">
  No converted project found in the workspace. Convert a .uvprojx/.uvmpw first, then reopen this panel.
</p>` + buildProjectSection('', '', '', DEFAULT_PROJECT_SETTINGS, [], availableFlms, '', machine, undefined, []);

  const saveCancelBar = (isTop: boolean) => `
<div class="${isTop ? 'sticky-bar' : 'footer-bar'}">
  <label class="checkbox-row">
    <input type="checkbox" id="${isTop ? 'updateConfigTop' : 'updateConfig'}" checked
      ${isTop ? 'onchange="document.getElementById(\'updateConfig\').checked=this.checked;document.getElementById(\'updateConfigTop\').checked=this.checked"'
              : 'onchange="document.getElementById(\'updateConfigTop\').checked=this.checked;document.getElementById(\'updateConfig\').checked=this.checked"'}>
    Update tasks.json &amp; launch.json after save
  </label>
  <div style="flex:1"></div>
  <span id="autoSaveStatus" style="font-size:0.85em;color:var(--vscode-descriptionForeground);margin-right:8px"></span>
  <button class="btn-secondary" onclick="doCancel()">Cancel</button>
  <button class="btn-primary"   onclick="doSave()">Save All</button>
</div>`;

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 0 28px 28px; max-width: 820px; margin: 0; }

  /* Sticky top bar */
  .sticky-bar {
    position: sticky; top: 0; z-index: 200;
    background: var(--vscode-editor-background);
    border-bottom: 1px solid var(--vscode-panel-border);
    padding: 10px 0;
    display: flex; align-items: center; gap: 10px;
    margin-bottom: 20px;
  }
  .footer-bar {
    margin-top: 24px;
    border-top: 1px solid var(--vscode-panel-border);
    padding-top: 14px;
    display: flex; align-items: center; gap: 10px;
  }
  .checkbox-row { display: flex; align-items: center; gap: 8px; font-size: 0.9em; }

  button { padding: 6px 18px; border: none; border-radius: 2px; cursor: pointer; font-size: var(--vscode-font-size); font-family: var(--vscode-font-family); }
  .btn-primary   { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-primary:hover   { background: var(--vscode-button-hoverBackground); }
  .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }

  /* Machine section */
  .machine-section { margin-bottom: 24px; }

  /* Project section */
  .proj-section {
    border-left: 4px solid var(--proj-color);
    padding: 14px 18px 18px;
    margin-bottom: 28px;
    border-radius: 0 4px 4px 0;
    background: color-mix(in srgb, var(--proj-color) 6%, var(--vscode-editor-background));
  }
  .proj-title {
    font-size: 1.25em; font-weight: 700; color: var(--proj-color);
    margin: 0 0 16px; padding-bottom: 8px;
    border-bottom: 2px solid var(--proj-color);
    display: flex; align-items: center; gap: 10px;
  }
  .proj-badge {
    background: var(--proj-color); color: #fff;
    border-radius: 12px; padding: 2px 12px; font-size: 0.88em; font-weight: 700;
    letter-spacing: 0.03em;
  }

  h2 {
    font-size: 1.0em; font-weight: 700; margin: 0 0 10px;
    padding: 5px 8px 5px 10px;
    border-left: 3px solid var(--vscode-textLink-foreground, #4db6ac);
    color: var(--vscode-textLink-foreground, #4db6ac);
    background: color-mix(in srgb, var(--vscode-textLink-foreground, #4db6ac) 8%, transparent);
    border-radius: 0 3px 3px 0;
  }
  .settings-group { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 12px 14px; margin-bottom: 12px; }
  .row { display: flex; flex-direction: column; margin-bottom: 10px; }
  label { font-size: 0.83em; color: var(--vscode-foreground); margin-bottom: 3px; font-weight: 700; }
  .checkbox-label, .checkbox-row { color: var(--vscode-descriptionForeground); font-weight: normal; }
  input[type="text"], select {
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #555);
    padding: 5px 8px; font-size: var(--vscode-font-size); font-family: var(--vscode-font-family); border-radius: 2px;
  }
  input[type="text"]:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
  .hint { font-size: 0.76em; color: var(--vscode-descriptionForeground); margin-top: 2px; }

  /* Flash loader / extra lib table */
  .loader-row {
    display: grid;
    grid-template-columns: 22px 1fr 130px 130px 28px;
    gap: 6px; align-items: center;
    padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border);
  }
  .loader-row:last-child { border-bottom: none; }
  .loader-row select { min-width: 0; font-size: 0.82em; }
  .loader-row input[type="text"] { font-size: 0.82em; padding: 4px 6px; }
  .loader-row input[type="checkbox"] { margin: 0; width: 16px; height: 16px; cursor: pointer; }
  .loader-header {
    display: grid; grid-template-columns: 22px 1fr 130px 130px 28px;
    gap: 6px; font-size: 0.76em; color: var(--vscode-descriptionForeground);
    padding: 0 0 3px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 3px;
  }
  .lib-row {
    display: grid; grid-template-columns: 1fr 28px 28px;
    gap: 6px; align-items: center;
    padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border);
  }
  .lib-row:last-child { border-bottom: none; }
  .lib-row input[type="text"] { font-size: 0.82em; padding: 4px 6px; }
  .lib-name-row {
    display: grid; grid-template-columns: 1fr 28px;
    gap: 6px; align-items: center;
    padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border);
  }
  .lib-name-row:last-child { border-bottom: none; }
  .lib-name-row input[type="text"] { font-size: 0.82em; padding: 4px 6px; }
  .lib-path-row {
    display: grid; grid-template-columns: 1fr 28px 28px;
    gap: 6px; align-items: center;
    padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border);
  }
  .lib-path-row:last-child { border-bottom: none; }
  .lib-path-row input[type="text"] { font-size: 0.82em; padding: 4px 6px; }
  .inc-path-row {
    display: grid; grid-template-columns: 1fr 28px 28px;
    gap: 6px; align-items: center;
    padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border);
  }
  .inc-path-row:last-child { border-bottom: none; }
  .inc-path-row input[type="text"] { font-size: 0.82em; padding: 4px 6px; }
  .def-row {
    display: flex; align-items: center; gap: 4px;
    width: calc(33.333% - 4px); min-width: 140px;
  }
  .def-row input[type="text"] { font-size: 0.82em; padding: 4px 6px; flex: 1; min-width: 0; }
  .lib-section-label { font-size: 0.76em; color: var(--vscode-descriptionForeground); margin: 4px 0 2px; font-weight: 600; letter-spacing: 0.03em; }
  .btn-remove { padding: 2px 6px; font-size: 0.85em; border-radius: 2px; background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-input-border, #555); cursor: pointer; }
  .btn-remove:hover { background: var(--vscode-inputValidation-errorBackground); }
  .auto-row { opacity: 0.65; }
  .auto-row span { font-size: 0.82em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 3px 2px; }
  .auto-row .auto-icon { text-align: center; }
  .auto-row .auto-addr { font-family: monospace; }
  .auto-section-label { font-size: 0.76em; color: var(--vscode-descriptionForeground); margin: 5px 0 2px; font-style: italic; }
  .no-items { font-size: 0.84em; color: var(--vscode-descriptionForeground); padding: 4px 0; font-style: italic; }
  .add-btn { margin-top: 5px; padding: 3px 12px; font-size: 0.85em; }

  /* Tabs */
  .tab-bar { display: flex; gap: 0; margin-bottom: 14px; border-bottom: 2px solid var(--vscode-panel-border); }
  .tab-btn {
    padding: 8px 22px; border: none; background: transparent;
    color: var(--vscode-tab-inactiveForeground, var(--vscode-foreground));
    cursor: pointer; font-size: 1.15em; font-weight: 600;
    font-family: var(--vscode-font-family); border-bottom: 3px solid transparent; margin-bottom: -2px;
    letter-spacing: 0.02em;
  }
  .tab-btn:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
  .tab-btn.active {
    border-bottom-color: var(--proj-color, var(--vscode-textLink-foreground));
    color: var(--proj-color, var(--vscode-textLink-foreground));
    font-weight: 700;
  }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
</style>
</head>
<body>

${saveCancelBar(true)}

${projSections}

${saveCancelBar(false)}

<script>
const vscode   = acquireVsCodeApi();
const FLMS     = ${flmsJson};
const FLM_ADDR = ${addrMapJson};
const BG_NAMES = ${bgNamesJson};
const BG_DIRS  = ${bgDirsJson};

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}
function stripExt(s) { return String(s).replace(/\.[^.]+$/, ''); }
function v(id) { var el = document.getElementById(id); return el ? el.value : ''; }
function pid(bg, field) { return bg ? bg + '__' + field : field; }

function flmOptions(selected) {
  var ph = '<option value="" disabled' + (selected ? '' : ' selected') + '>— Select Flash Loader —</option>';
  return ph + FLMS.map(h => '<option value="' + escHtml(h) + '"' + (h === selected ? ' selected' : '') + '>' + escHtml(stripExt(h)) + '</option>').join('');
}
function fillAddr(sel, si, ei) {
  var addr = sel.value ? FLM_ADDR[sel.value] : null;
  if (addr) { si.value = addr.start; ei.value = addr.end; }
}

function addLoader(bgName) {
  var rows = document.getElementById(pid(bgName, 'loaderRows'));
  var ph = rows.querySelector('.no-items');
  if (ph) ph.remove();

  var row = document.createElement('div');
  row.className = 'loader-row';

  var cb = document.createElement('input');
  cb.type = 'checkbox'; cb.className = 'loader-enabled'; cb.checked = true;
  cb.title = 'Include in flash download';

  var sel = document.createElement('select');
  sel.className = 'loader-flm';
  sel.innerHTML = flmOptions('');

  var si = document.createElement('input');
  si.type = 'text'; si.className = 'loader-start'; si.placeholder = 'Start (hex)';

  var ei = document.createElement('input');
  ei.type = 'text'; ei.className = 'loader-end'; ei.placeholder = 'End (hex)';

  sel.addEventListener('change', function() { fillAddr(sel, si, ei); });

  var btn = document.createElement('button');
  btn.className = 'btn-remove'; btn.title = 'Remove'; btn.textContent = '\u2715';
  btn.addEventListener('click', function() { row.remove(); setDirty(); });

  [cb, sel, si, ei, btn].forEach(function(el) { row.appendChild(el); });
  rows.appendChild(row);
}

function addLibName(bgName) {
  var rows = document.getElementById(pid(bgName, 'libNameRows'));
  var ph = rows.querySelector('.no-items');
  if (ph) ph.remove();

  var row = document.createElement('div');
  row.className = 'lib-name-row';

  var nameInp = document.createElement('input');
  nameInp.type = 'text'; nameInp.className = 'lib-lname';
  nameInp.placeholder = 'e.g. HoltekPDF32';

  var removeBtn = document.createElement('button');
  removeBtn.className = 'btn-remove'; removeBtn.title = 'Remove'; removeBtn.textContent = '\u2715';
  removeBtn.addEventListener('click', function() { row.remove(); setDirty(); });

  row.appendChild(nameInp); row.appendChild(removeBtn);
  rows.appendChild(row);
}

var _browseLibPathCounter = 0;
function addLibPath(bgName) {
  var rows = document.getElementById(pid(bgName, 'libPathRows'));
  var ph = rows.querySelector('.no-items');
  if (ph) ph.remove();

  var row = document.createElement('div');
  row.className = 'lib-path-row';

  var pathInp = document.createElement('input');
  pathInp.type = 'text'; pathInp.className = 'lib-lpath';
  pathInp.placeholder = 'e.g. ../../libs';
  var browseId = 'libPathBrowse_' + (++_browseLibPathCounter);
  pathInp.dataset.browseId = browseId;

  var browseBtn = document.createElement('button');
  browseBtn.className = 'btn-secondary'; browseBtn.title = 'Browse directory'; browseBtn.textContent = '…';
  browseBtn.style.cssText = 'padding:0 6px;min-width:26px;';
  browseBtn.addEventListener('click', function() { browseDirAt(browseId, bgName); });

  var removeBtn = document.createElement('button');
  removeBtn.className = 'btn-remove'; removeBtn.title = 'Remove'; removeBtn.textContent = '\u2715';
  removeBtn.addEventListener('click', function() { row.remove(); setDirty(); });

  row.appendChild(pathInp); row.appendChild(browseBtn); row.appendChild(removeBtn);
  rows.appendChild(row);
}

function collectLibNames(bgName) {
  var rows = document.getElementById(pid(bgName, 'libNameRows'));
  if (!rows) return [];
  return Array.from(rows.querySelectorAll('.lib-name-row'))
    .map(function(row) { return row.querySelector('.lib-lname').value.trim(); })
    .filter(function(n) { return n !== ''; });
}

function collectLibPaths(bgName) {
  var rows = document.getElementById(pid(bgName, 'libPathRows'));
  if (!rows) return [];
  return Array.from(rows.querySelectorAll('.lib-path-row'))
    .map(function(row) { return row.querySelector('.lib-lpath').value.trim(); })
    .filter(function(p) { return p !== ''; });
}

function browseDirAt(browseId, bgName) {
  var inp = document.querySelector('[data-browse-id="' + browseId + '"]');
  var bgDir = BG_DIRS[bgName] || '';
  vscode.postMessage({ type: 'browseDir', browseId: browseId, currentPath: inp ? inp.value.trim() : '',
    bgDir: bgDir, relativeBase: bgDir });
}

function addIncPath(bgName) {
  var rows = document.getElementById(pid(bgName, 'extraIncRows'));
  var ph = rows.querySelector('.no-items');
  if (ph) ph.remove();

  var row = document.createElement('div');
  row.className = 'inc-path-row';

  var inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'inc-path-val';
  inp.placeholder = 'e.g. ../../freertos/source/portable/GCC/ARM_CM4F';

  var browseId = 'incBrowse_' + Date.now();
  var browseBtn = document.createElement('button');
  browseBtn.className = 'btn-secondary'; browseBtn.title = 'Browse directory';
  browseBtn.style.cssText = 'padding:0 6px;min-width:26px;';
  browseBtn.textContent = '\u2026';
  browseBtn.addEventListener('click', function() { browseDirAt(browseId, bgName); });
  inp.setAttribute('data-browse-id', browseId);

  var removeBtn = document.createElement('button');
  removeBtn.className = 'btn-remove'; removeBtn.title = 'Remove'; removeBtn.textContent = '\u2715';
  removeBtn.addEventListener('click', function() { row.remove(); setDirty(); });

  row.appendChild(inp); row.appendChild(browseBtn); row.appendChild(removeBtn);
  rows.appendChild(row);
}

function collectIncPaths(bgName) {
  var rows = document.getElementById(pid(bgName, 'extraIncRows'));
  if (!rows) return [];
  return Array.from(rows.querySelectorAll('.inc-path-val'))
    .map(function(inp) { return inp.value.trim(); })
    .filter(function(v) { return v !== ''; });
}

function addLinkerScript(bgName) {
  var rows = document.getElementById(pid(bgName, 'ldRows'));
  if (!rows) return;
  var ph = rows.querySelector('.no-items');
  if (ph) ph.remove();
  var row = document.createElement('div');
  row.className = 'ld-row';
  var inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'ld-path-val';
  inp.placeholder = '../GNU_ARM/linker.ld';
  var browseId = 'ldBrowse_' + Date.now();
  inp.setAttribute('data-browse-id', browseId);
  var browseBtn = document.createElement('button');
  browseBtn.className = 'btn-secondary'; browseBtn.title = 'Browse .ld file';
  browseBtn.style.cssText = 'padding:0 6px;min-width:26px;';
  browseBtn.textContent = '…';
  browseBtn.addEventListener('click', function() { browseFileAt(browseId, bgName, { 'Linker Scripts': ['ld'] }); });
  var removeBtn = document.createElement('button');
  removeBtn.className = 'btn-remove'; removeBtn.title = 'Remove'; removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', function() { row.remove(); setDirty(); });
  row.appendChild(inp); row.appendChild(browseBtn); row.appendChild(removeBtn);
  rows.appendChild(row);
}

function collectLinkerScripts(bgName) {
  var rows = document.getElementById(pid(bgName, 'ldRows'));
  if (!rows) return [];
  return Array.from(rows.querySelectorAll('.ld-path-val'))
    .map(function(inp) { return inp.value.trim(); })
    .filter(function(v) { return v !== ''; });
}

function browseFileAt(browseId, bgName, filters) {
  var inp = document.querySelector('[data-browse-id="' + browseId + '"]');
  var bgDir = BG_DIRS[bgName] || '';
  vscode.postMessage({ type: 'browseFile', browseId: browseId, currentPath: inp ? inp.value.trim() : '',
    filters: filters || {}, bgDir: bgDir, relativeBase: bgDir });
}

function addDef(bgName, defType) {
  var rowsId = defType === 'a' ? pid(bgName, 'aDefRows') : pid(bgName, 'cDefRows');
  var rows = document.getElementById(rowsId);
  if (!rows) return;
  var ph = rows.querySelector('.no-items');
  if (ph) ph.remove();
  var row = document.createElement('div');
  row.className = 'def-row';
  var inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'def-val';
  inp.placeholder = defType === 'a' ? 'e.g. USE_HT32_CHIP=4' : 'e.g. USE_HT32_DRIVER';
  var removeBtn = document.createElement('button');
  removeBtn.className = 'btn-remove'; removeBtn.title = 'Remove'; removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', function() { row.remove(); setDirty(); });
  row.appendChild(inp); row.appendChild(removeBtn);
  rows.appendChild(row);
}

function collectDefs(bgName, defType) {
  var rowsId = defType === 'a' ? pid(bgName, 'aDefRows') : pid(bgName, 'cDefRows');
  var rows = document.getElementById(rowsId);
  if (!rows) return [];
  return Array.from(rows.querySelectorAll('.def-val'))
    .map(function(inp) { return inp.value.trim(); })
    .filter(function(v) { return v !== ''; });
}

function collectLoaders(bgName) {
  var rows = document.getElementById(pid(bgName, 'loaderRows'));
  if (!rows) return [];
  return Array.from(rows.querySelectorAll('.loader-row:not(.auto-row)')).map(function(row) {
    return {
      enabled: row.querySelector('.loader-enabled').checked,
      flm:     row.querySelector('.loader-flm').value,
      start:   row.querySelector('.loader-start').value.trim(),
      end:     row.querySelector('.loader-end').value.trim(),
    };
  }).filter(function(l) { return l.flm; });
}


function collectProjectSettings(bgName) {
  var p = bgName ? bgName + '__' : '';
  return {
    optimizationLevel: v(p + 'optimizationLevel'),
    floatAbi:          v(p + 'floatAbi'),
    fpu:               v(p + 'fpu'),
    useNano:  !!(document.getElementById(p + 'useNanoSpec')  && document.getElementById(p + 'useNanoSpec').checked),
    useNosys: !!(document.getElementById(p + 'useNosysSpec') && document.getElementById(p + 'useNosysSpec').checked),
    extraCFlags:       v(p + 'extraCFlags'),
    extraLDFlags:      v(p + 'extraLDFlags'),
    debugInterface:    v(p + 'debugInterface'),
    adapterSerial:     v(p + 'adapterSerial'),
    adapterSpeed:      v(p + 'adapterSpeed'),
    dfpPath:           v(p + 'dfpPath'),
    svdFile:           v(p + 'svdFile'),
    serverType: v(p + 'serverType') || 'pyocd',
    openocdDebugLevel: Number(v(p + 'openocdDebugLevel')),
    smartFlash:   !!(document.getElementById(p + 'smartFlash')  && document.getElementById(p + 'smartFlash').checked),
    eraseMode:         v(p + 'eraseMode'),
    flashLoaders:      collectLoaders(bgName),
    extraLibs:         [],
    extraLibNames:     collectLibNames(bgName),
    extraLibPaths:     collectLibPaths(bgName),
    outputName:        (v(p + 'outputName') || '').trim(),
    debugInfo:         v(p + 'debugInfo') || 'g3',
    useLto:       !!(document.getElementById(p + 'useLto')       && document.getElementById(p + 'useLto').checked),
    printfFloat:  !!(document.getElementById(p + 'printfFloat')  && document.getElementById(p + 'printfFloat').checked),
    scanfFloat:   !!(document.getElementById(p + 'scanfFloat')   && document.getElementById(p + 'scanfFloat').checked),

    postBuildCmd:       (v(p + 'postBuildCmd') || '').trim(),
    gcSections:   !!(document.getElementById(p + 'gcSections') && document.getElementById(p + 'gcSections').checked),
    includePaths:  collectIncPaths(bgName),
    cDefs:         collectDefs(bgName, 'c'),
    aDefs:         collectDefs(bgName, 'a'),
  };
}

function switchTab(bgName, tab) {
  var targets = BG_NAMES.length > 0 ? BG_NAMES : [''];
  targets.forEach(function(bg) {
    var prefix = bg ? bg + '__' : '';
    ['compiler', 'linker', 'debugger', 'build'].forEach(function(t) {
      var panel = document.getElementById(prefix + 'tab_' + t);
      var btn   = document.getElementById(prefix + 'tabBtn_' + t);
      if (panel) panel.classList.toggle('active', t === tab);
      if (btn)   btn.classList.toggle('active', t === tab);
    });
  });
}

function onDebugInterfaceChange(bgName) {
  var p = bgName ? bgName + '__' : '';
  // Clear adapter serial and scan results when switching interface type
  var serialEl = document.getElementById(p + 'adapterSerial');
  if (serialEl) { serialEl.value = ''; }
  var listEl = document.getElementById(p + 'adapterListResult');
  if (listEl) { listEl.innerHTML = ''; }
  var idcodeEl = document.getElementById(p + 'idcodeResult');
  if (idcodeEl) { idcodeEl.style.display = 'none'; idcodeEl.textContent = ''; }
  updateJlinkOcdWarning(bgName);
  triggerScan(bgName, true);
}
function onServerTypeChange(bgName) {
  updateJlinkOcdWarning(bgName);
  var p = bgName ? bgName + '__' : '';
  var stype = document.getElementById(p + 'serverType');
  var smartFlashRow = document.getElementById(p + 'smartFlashRow');
  if (smartFlashRow && stype) {
    smartFlashRow.style.display = stype.value === 'pyocd' ? 'flex' : 'none';
  }
  // Clear serial + rescan when switching server type (probe list differs between pyocd / openocd)
  var serialEl = document.getElementById(p + 'adapterSerial');
  if (serialEl) { serialEl.value = ''; }
  var listEl = document.getElementById(p + 'adapterListResult');
  if (listEl) { listEl.style.display = 'none'; listEl.innerHTML = ''; }
  triggerScan(bgName, false);
}
function updateJlinkOcdWarning(bgName) {
  var p = bgName ? bgName + '__' : '';
  var iface = document.getElementById(p + 'debugInterface');
  var stype = document.getElementById(p + 'serverType');
  var warn  = document.getElementById(p + 'jlinkOcdWarning');
  if (!warn) return;
  var show = iface && stype && iface.value === 'J-Link' && stype.value === 'openocd';
  warn.style.display = show ? 'block' : 'none';
}
function triggerScan(bgName, fromUser) {
  var p = bgName ? bgName + '__' : '';
  var iface  = document.getElementById(p + 'debugInterface');
  var stype  = document.getElementById(p + 'serverType');
  if (!iface) return;
  vscode.postMessage({ type: 'scanAdapters', debugInterface: iface.value, serverType: stype ? stype.value : 'openocd', bgName: bgName, fromUser: !!fromUser });
}
function scanAdapters(bgName) {
  var p = bgName ? bgName + '__' : '';
  var btn = document.getElementById(p + 'scanBtn');
if (btn) { btn.disabled = true; btn.textContent = 'Scanning…'; }
  triggerScan(bgName, true);
}
function selectAdapter(bgName, serial) {
  var p = bgName ? bgName + '__' : '';
  document.getElementById(p + 'adapterSerial').value = serial;
  var w = document.getElementById(p + 'serialNotFoundWarn');
  if (w) { w.style.display = 'none'; }
  scheduleAutoSave();
  // Highlight selected button without hiding the list
  var box = document.getElementById(p + 'adapterListResult');
  if (box) {
    box.querySelectorAll('button[data-serial]').forEach(function(btn) {
      btn.style.outline = btn.getAttribute('data-serial') === serial
        ? '2px solid var(--vscode-focusBorder)' : '';
    });
  }
  // Show probe status and request IDCODE
  var idcodeDiv = document.getElementById(p + 'idcodeResult');
  if (idcodeDiv) { idcodeDiv.textContent = 'Probing…'; idcodeDiv.style.display = 'block'; }
  var iface = document.getElementById(p + 'debugInterface');
  var speed = document.getElementById(p + 'adapterSpeed');
  vscode.postMessage({ type: 'queryIdcode', bgName: bgName, serial: serial,
    debugInterface: iface ? iface.value : 'CMSIS-DAP',
    adapterSpeed: speed ? speed.value : '1000' });
}
function selectAdapterFromBtn(btn) {
  selectAdapter(btn.getAttribute('data-bg') || '', btn.getAttribute('data-serial') || '');
}
window.addEventListener('message', function(event) {
  var msg = event.data;
  if (msg.type === 'autoSaved') {
    _isDirty = false;
    var el = document.getElementById('autoSaveStatus');
    if (el) { el.textContent = '\u2713 Saved'; setTimeout(function() { if (el.textContent === '\u2713 Saved') el.textContent = ''; }, 2000); }
    return;
  }
  if (msg.type === 'requestFlush') {
    if (_isDirty) { if (_autoSaveTimer) { clearTimeout(_autoSaveTimer); _autoSaveTimer = null; } doAutoSave(); }
    return;
  }
  if (msg.type === 'browseFileResult') {
    var inp = document.querySelector('[data-browse-id="' + msg.browseId + '"]');
    if (inp) { inp.value = msg.filePath; inp.dispatchEvent(new Event('change', { bubbles: true })); }
    return;
  }
  if (msg.type === 'updateLinkerScripts') {
    // TreeView changed linkerScripts — refresh the ldRows without rebuilding the whole panel
    var rows = document.getElementById(pid(msg.bgName, 'ldRows'));
    if (!rows) return;
    rows.innerHTML = '';
    var scripts = msg.linkerScripts || [];
    if (scripts.length === 0) {
      rows.innerHTML = '<p class="no-items">No linker scripts.</p>';
    } else {
      scripts.forEach(function(v, i) {
        var browseId = 'ldBrowse_tv_' + (msg.bgName || '') + i;
        var div = document.createElement('div');
        div.className = 'ld-row';
        var inp2 = document.createElement('input');
        inp2.type = 'text'; inp2.className = 'ld-path-val'; inp2.value = v;
        inp2.placeholder = '../GNU_ARM/linker.ld';
        inp2.setAttribute('data-browse-id', browseId);
        var browseBtn = document.createElement('button');
        browseBtn.className = 'btn-secondary'; browseBtn.title = 'Browse .ld file';
        browseBtn.style.cssText = 'padding:0 6px;min-width:26px;';
        browseBtn.textContent = '…';
        browseBtn.addEventListener('click', function() { browseFileAt(browseId, msg.bgName, { 'Linker Scripts': ['ld'] }); });
        var removeBtn = document.createElement('button');
        removeBtn.className = 'btn-remove'; removeBtn.title = 'Remove'; removeBtn.textContent = '✕';
        removeBtn.addEventListener('click', function() { div.remove(); setDirty(); });
        div.appendChild(inp2); div.appendChild(browseBtn); div.appendChild(removeBtn);
        rows.appendChild(div);
      });
    }
    return;
  }
  if (msg.type === 'idcodeResult') {
    var p0  = (msg.bgName || '') ? (msg.bgName + '__') : '';
    var div = document.getElementById(p0 + 'idcodeResult');
    if (div) { div.textContent = msg.text || '(no response)'; div.style.display = 'block'; }
    return;
  }
  if (msg.type !== 'adapterList') return;
  var bg  = msg.bgName || '';
  var p   = bg ? bg + '__' : '';
  var btn = document.getElementById(p + 'scanBtn');
  if (btn) { btn.disabled = false; btn.textContent = 'Scan'; }
  var box         = document.getElementById(p + 'adapterListResult');
  var serialInput = document.getElementById(p + 'adapterSerial');
  if (!box || !serialInput) return;
  var adapters = msg.adapters || [];
  var serialWarn = document.getElementById(p + 'serialNotFoundWarn');
  if (adapters.length === 0) {
    serialInput.placeholder = 'Empty = auto (only works when 1 probe connected)';
    if (serialInput.value.trim() && serialWarn) { serialWarn.style.display = 'block'; }
    if (msg.fromUser) {
      box.innerHTML = '<p class="hint" style="color:var(--vscode-inputValidation-warningForeground);margin:0">No adapters found. Make sure the adapter is connected.</p>';
      box.style.display = 'block';
    }
    return;
  }
  var currentSerial = serialInput.value;
  if (!currentSerial && adapters[0] && adapters[0].serial) {
    currentSerial = adapters[0].serial;
    serialInput.value = currentSerial;
    if (msg.fromUser) { scheduleAutoSave(); }
  }
  if (serialWarn) {
    serialWarn.style.display = currentSerial.trim() && !adapters.some(function(a) { return a.serial === currentSerial; }) ? 'block' : 'none';
  }
  serialInput.placeholder = 'Empty = auto (only works when 1 probe connected)';
  var noSerialCount = adapters.filter(function(a) { return !a.serial; }).length;
  box.innerHTML = adapters.map(function(a) {
    var selected = a.serial === currentSerial;
    var serialText = a.serial || '(no serial)';
    var serialStyle = a.serial ? 'color:var(--vscode-editor-foreground)' : 'color:var(--vscode-disabledForeground);font-style:italic';
    return '<button class="btn-secondary" style="font-size:0.88em;flex-shrink:0' +
      (selected ? ';outline:2px solid var(--vscode-focusBorder)' : '') + '" ' +
      'data-bg="' + escHtml(bg) + '" data-serial="' + escHtml(a.serial) + '" ' +
      'onclick="selectAdapterFromBtn(this)">' +
      '<code style="' + serialStyle + '">' + escHtml(serialText) + '</code>' +
      (a.label ? ' &nbsp;<span style="opacity:0.6;font-size:0.9em">' + escHtml(a.label) + '</span>' : '') +
    '</button>';
  }).join('') +
  (noSerialCount > 1
    ? '<p class="hint" style="color:var(--vscode-inputValidation-warningForeground);margin:4px 0 0">Warning: ' + noSerialCount + ' adapters without serial number — cannot distinguish between them. Only the first will be used.</p>'
    : '');
  box.style.display = 'block';
});
window.addEventListener('load', function() {
  // Auto-scan on open (silent — only auto-fills if exactly 1 adapter found and field is empty)
  if (BG_NAMES.length > 0) {
    BG_NAMES.forEach(function(bgName) { triggerScan(bgName, false); });
  } else {
    triggerScan('', false);
  }
});

var _autoSaveTimer = null;
var _isDirty = false;
function setDirty() {
  _isDirty = true;
  scheduleAutoSave();
}
function scheduleAutoSave() {
  if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(doAutoSave, 1500);
}
function doAutoSave() {
  _autoSaveTimer = null;
  var allProjectSettings = {};
  var linkerScriptsByBg = {};
  if (BG_NAMES.length > 0) {
    BG_NAMES.forEach(function(bgName) {
      allProjectSettings[bgName] = collectProjectSettings(bgName);
      linkerScriptsByBg[bgName]  = collectLinkerScripts(bgName);
    });
  }
  vscode.postMessage({
    type: 'autoSave',
    machineSettings: { gccPath: v('gccPath'), openocdPath: v('openocdPath') },
    allProjectSettings:  BG_NAMES.length > 0 ? allProjectSettings : undefined,
    projectSettings:     BG_NAMES.length === 0 ? collectProjectSettings('') : undefined,
    linkerScriptsByBg:   BG_NAMES.length > 0 ? linkerScriptsByBg : undefined,
  });
}
document.addEventListener('change', setDirty);
document.addEventListener('input',  setDirty);

function doSave() {
  var allProjectSettings = {};
  var linkerScriptsByBg = {};
  if (BG_NAMES.length > 0) {
    BG_NAMES.forEach(function(bgName) {
      allProjectSettings[bgName] = collectProjectSettings(bgName);
      linkerScriptsByBg[bgName]  = collectLinkerScripts(bgName);
    });
  }
  vscode.postMessage({
    type: 'save',
    updateConfig: document.getElementById('updateConfig').checked,
    machineSettings: {
      gccPath:     v('gccPath'),
      openocdPath: v('openocdPath'),
    },
    allProjectSettings:  BG_NAMES.length > 0 ? allProjectSettings : undefined,
    projectSettings:     BG_NAMES.length === 0 ? collectProjectSettings('') : undefined,
    linkerScriptsByBg:   BG_NAMES.length > 0 ? linkerScriptsByBg : undefined,
  });
}

function doCancel() { vscode.postMessage({ type: 'cancel' }); }
</script>
</body>
</html>`;
}

/* ────────────────────────────────────────────────
 * Per-project section builder
 * ──────────────────────────────────────────────── */
function buildProjectSection(
  bgName: string,
  projectName: string,
  color: string,
  s: ProjectSettings,
  autoLoaders: AutoLoaderEntry[],
  availableFlms: string[],
  defaultTargetName: string = '',
  machine: MachineSettings | null = null,
  detectedGccPath?: string,
  linkerScripts: string[] = DEFAULT_LINKER_SCRIPTS
): string {
  const p   = bgName ? bgName + '__' : '';
  const id  = (field: string) => `${p}${field}`;
  const opt = (val: string, cur: string, label: string) =>
    `<option value="${val}" ${cur === val ? 'selected' : ''}>${label}</option>`;

  const loaderRowsHtml = s.flashLoaders.map(l => loaderRowHtml(l, availableFlms, p)).join('');
  // C defines chip list rows
  const cDefRowsHtml = (s.cDefs ?? []).map(v => `<div class="def-row">
  <input class="def-val" type="text" value="${esc(v)}" placeholder="e.g. USE_HT32_DRIVER">
  <button class="btn-remove" onclick="this.closest('.def-row').remove();setDirty()" title="Remove">✕</button>
</div>`).join('');
  // ASM-only defines chip list rows
  const aDefRowsHtml = (s.aDefs ?? []).map(v => `<div class="def-row">
  <input class="def-val" type="text" value="${esc(v)}" placeholder="e.g. USE_HT32_CHIP=4">
  <button class="btn-remove" onclick="this.closest('.def-row').remove();setDirty()" title="Remove">✕</button>
</div>`).join('');
  // extra include path rows
  const incPathRowsHtml = (s.includePaths ?? []).map((v, i) => {
    const browseId = `incBrowse_static_${p}${i}`;
    return `<div class="inc-path-row">
  <input class="inc-path-val" type="text" value="${esc(v)}" placeholder="e.g. ../../freertos/source/portable/GCC/ARM_CM4F" data-browse-id="${browseId}">
  <button class="btn-secondary" title="Browse directory" style="padding:0 6px;min-width:26px;" onclick="browseDirAt('${browseId}','${esc(bgName)}')">&#8230;</button>
  <button class="btn-remove" onclick="this.closest('.inc-path-row').remove();setDirty()" title="Remove">\u2715</button>
</div>`;
  }).join('');

  // linker script rows
  const ldRowsHtml = linkerScripts.map((v, i) => {
    const browseId = `ldBrowse_static_${p}${i}`;
    return `<div class="ld-row">
  <input class="ld-path-val" type="text" value="${esc(v)}" placeholder="../GNU_ARM/linker.ld" data-browse-id="${browseId}">
  <button class="btn-secondary" title="Browse .ld file" style="padding:0 6px;min-width:26px;" onclick="browseFileAt('${browseId}',${bgName ? `'${esc(bgName)}'` : "''"},{'Linker Scripts':['ld']})">&#8230;</button>
  <button class="btn-remove" onclick="this.closest('.ld-row').remove();setDirty()" title="Remove">✕</button>
</div>`;
  }).join('');

  // -l name rows (independent from -L paths)
  const libNameRowsHtml = s.extraLibNames.map(name => `<div class="lib-name-row">
  <input class="lib-lname" type="text" value="${esc(name)}" placeholder="e.g. HoltekPDF32">
  <button class="btn-remove" onclick="this.closest('.lib-name-row').remove();setDirty()" title="Remove">\u2715</button>
</div>`).join('');
  // -L path rows (independent from -l names)
  const libPathRowsHtml = s.extraLibPaths.map((lp, i) => {
    const browseId = `libPathBrowse_static_${p}${i}`;
    return `<div class="lib-path-row">
  <input class="lib-lpath" type="text" value="${esc(lp)}" placeholder="e.g. ../../libs" data-browse-id="${browseId}">
  <button class="btn-secondary" title="Browse directory" style="padding:0 6px;min-width:26px;" onclick="browseDirAt('${browseId}','${esc(bgName)}')">&#8230;</button>
  <button class="btn-remove" onclick="this.closest('.lib-path-row').remove();setDirty()" title="Remove">\u2715</button>
</div>`;
  }).join('');


  const autoSection = autoLoaders.length > 0 ? `
<p class="auto-section-label">Auto-configured (from device info, read-only):</p>
${autoLoaders.map(l => `<div class="loader-row auto-row" title="${esc(l.label)}">
  <span class="auto-icon">&#128274;</span>
  <span title="${esc(l.flm)}">${esc(l.flm.replace(/\.[^.]+$/, ''))}</span>
  <span class="auto-addr">${esc(l.start)}</span>
  <span class="auto-addr">${esc(l.end)}</span>
  <span></span>
</div>`).join('')}
<p class="auto-section-label">Extra loaders (editable):</p>`
  : (bgName ? `<p class="hint" style="color:var(--vscode-inputValidation-warningForeground);margin:0 0 6px">
  Auto flash loaders not detected. Ensure the project was converted (device name in project.settings.json).
  If you just converted, reopen this panel after the workspace reloads.</p>` : '');

  const titleHtml = bgName
    ? `<div class="proj-title"><span class="proj-badge">${esc(projectName || bgName)}</span></div>`
    : '';
  const wrapOpen  = color
    ? `<div class="proj-section" style="--proj-color:${color}">`
    : '<div>';
  const wrapClose = '</div>';

  const bg = bgName || '';
  return `${wrapOpen}
${titleHtml}
<div class="tab-bar">
  <button class="tab-btn active" id="${p}tabBtn_compiler" onclick="switchTab('${esc(bg)}','compiler')">Compiler</button>
  <button class="tab-btn"        id="${p}tabBtn_linker"   onclick="switchTab('${esc(bg)}','linker')">Linker</button>
  <button class="tab-btn"        id="${p}tabBtn_debugger" onclick="switchTab('${esc(bg)}','debugger')">Debugger</button>
  <button class="tab-btn"        id="${p}tabBtn_build"    onclick="switchTab('${esc(bg)}','build')">Build</button>
</div>

<div class="tab-panel" id="${p}tab_debugger">
<div class="settings-group">
<h2>Debugger</h2>
<div class="row">
  <label>Debug Server</label>
  <select id="${id('serverType')}" onchange="onServerTypeChange('${esc(bgName || '')}')">
    ${opt('pyocd',   s.serverType, 'PyOCD')}
    ${_openocdAvailable ? opt('openocd', s.serverType, 'OpenOCD') : ''}
  </select>
  <p class="hint">PyOCD: works with CMSIS-DAP / JLink / ST-Link out of the box. OpenOCD: required for advanced target configuration; uses HLM files mapped from FLM names.</p>
</div>
<div class="row">
  <label>Debug Interface</label>
  <select id="${id('debugInterface')}" onchange="onDebugInterfaceChange('${esc(bgName || '')}')">
    ${opt('CMSIS-DAP', s.debugInterface, 'CMSIS-DAP (e-Link32 / generic)')}
    ${opt('ST-Link',   s.debugInterface, 'ST-Link')}
    ${opt('J-Link',    s.debugInterface, 'J-Link')}
  </select>
  <div id="${id('jlinkOcdWarning')}" style="display:${s.debugInterface === 'J-Link' && s.serverType === 'openocd' ? 'block' : 'none'};margin-top:6px;padding:6px 10px;border-radius:4px;background:var(--vscode-inputValidation-warningBackground);border:1px solid var(--vscode-inputValidation-warningBorder);font-size:0.85em">
    JLink + OpenOCD requires WinUSB driver via Zadig. If you see LIBUSB_ERROR_NOT_SUPPORTED, run Zadig and switch JLink to WinUSB. PyOCD does not require this driver change.
  </div>
</div>
<div class="row">
  <label>Adapter Serial</label>
  <div style="display:flex;gap:6px;align-items:center">
    <input id="${id('adapterSerial')}" type="text" value="${esc(s.adapterSerial)}" placeholder="Empty = auto (only works when 1 probe connected)" style="flex:1" oninput="var w=document.getElementById('${id('serialNotFoundWarn')}');if(w)w.style.display='none'">
    <button id="${id('scanBtn')}" class="btn-primary" onclick="scanAdapters('${esc(bgName || '')}')">Scan</button>
  </div>
  <div id="${id('serialNotFoundWarn')}" style="display:none;margin-top:4px;padding:4px 8px;border-radius:3px;background:var(--vscode-inputValidation-warningBackground);border:1px solid var(--vscode-inputValidation-warningBorder);font-size:0.85em;color:var(--vscode-inputValidation-warningForeground)">&#9888; This adapter is not currently connected.</div>
  <div id="${id('adapterListResult')}" style="display:none;margin-top:6px"></div>
  <div id="${id('idcodeResult')}" style="display:none;margin-top:6px;font-family:monospace;font-size:0.82em;white-space:pre;color:var(--vscode-descriptionForeground);background:var(--vscode-editor-background);padding:4px 8px;border-radius:3px;border:1px solid var(--vscode-widget-border)"></div>
  <p class="hint">Serial number of the debug adapter. Required when multiple adapters of the same type are connected.</p>
</div>
<div class="row">
  <label>Adapter Speed</label>
  <select id="${id('adapterSpeed')}">
    ${opt('',     s.adapterSpeed, 'Default (interface cfg)')}
    ${opt('5',    s.adapterSpeed, '5 kHz')}
    ${opt('10',   s.adapterSpeed, '10 kHz')}
    ${opt('20',   s.adapterSpeed, '20 kHz')}
    ${opt('50',   s.adapterSpeed, '50 kHz')}
    ${opt('100',  s.adapterSpeed, '100 kHz')}
    ${opt('200',  s.adapterSpeed, '200 kHz')}
    ${opt('500',  s.adapterSpeed, '500 kHz')}
    ${opt('1000', s.adapterSpeed, '1 MHz')}
    ${opt('2000', s.adapterSpeed, '2 MHz')}
    ${opt('5000', s.adapterSpeed, '5 MHz')}
    ${opt('10000',s.adapterSpeed, '10 MHz')}
  </select>
  <p class="hint">SWD/JTAG clock speed. Reduce if you see connection errors on long cables or noisy boards.</p>
</div>
<div class="row">
  <label>Debug Level</label>
  <select id="${id('openocdDebugLevel')}">
    ${opt('1', String(s.openocdDebugLevel), '1 — Warning  [pyocd: (default) / openocd: -d1] ★')}
    ${opt('2', String(s.openocdDebugLevel), '2 — Info     [pyocd: -v / openocd: (default)]')}
    ${opt('3', String(s.openocdDebugLevel), '3 — Debug    [pyocd: -v -v / openocd: -d3]')}
    ${opt('4', String(s.openocdDebugLevel), '4 — Debug IO [pyocd: -v -v / openocd: -d4]')}
  </select>
  <p class="hint">★ Level 2 is the recommended default: matches OpenOCD INFO output and enables pyocd progress bar / pyocd_user.py logs.</p>
</div>
<div class="row" id="${id('smartFlashRow')}" style="display:${s.serverType === 'pyocd' ? 'flex' : 'none'}">
  <label>Smart Flash</label>
  <label class="checkbox-label"><input type="checkbox" id="${id('smartFlash')}" ${s.smartFlash ? 'checked' : ''}> Skip unchanged pages (faster repeated download)</label>
  <p class="hint">PyOCD only. When enabled, pyocd reads back each flash page before writing and skips identical pages. Disable if EXT flash read-back is unreliable.</p>
</div>
<div class="row">
  <label>DFP Path (for SVD auto-detection)</label>
  <input id="${id('dfpPath')}" type="text" value="${esc(s.dfpPath)}" placeholder="e.g. ./dfp/Holtek/HT32_DFP/1.0.76">
</div>
<div class="row">
  <label>SVD File (manual override)</label>
  <input id="${id('svdFile')}" type="text" value="${esc(s.svdFile)}" placeholder="Leave empty to auto-detect from DFP">
</div>

</div>
<div class="settings-group">
<h2>Flash Loaders</h2>
<div class="row">
  <label>Erase Mode</label>
  <select id="${id('eraseMode')}">
    ${opt('erase_sector', s.eraseMode, 'Erase Sectors (default)')}
    ${opt('erase_chip',   s.eraseMode, 'Erase Full Chip')}
  </select>
</div>
${availableFlms.length > 0 || autoLoaders.length > 0 ? `
<div class="loader-header">
  <span title="Enabled">En</span><span>Flash Loader</span>
  <span>Start</span><span>End</span><span></span>
</div>
${autoSection}
<div id="${id('loaderRows')}">${loaderRowsHtml || '<p class="no-items">No extra loaders.</p>'}</div>
${availableFlms.length > 0 ? `<button class="btn-secondary add-btn" onclick="addLoader(${bgName ? `'${esc(bgName)}'` : "''"})" >+ Add Loader</button>` : ''}
<p class="hint" style="margin-top:4px">Extra loaders for external flash (SPIM, etc.). PyOCD uses the FLM from the DFP pack; OpenOCD maps to the corresponding HLM. When any loader is present, SPIM auto-detection is skipped.</p>
` : `<p class="hint" style="color:var(--vscode-inputValidation-warningForeground)">No SPIM flash loaders found in DFP. SPIM extra loaders are unavailable for this device.</p>`}
</div>

</div><!-- /tab_debugger -->

<div class="tab-panel active" id="${p}tab_compiler">
<div class="settings-group">
<div class="row">
  <label>Optimization Level</label>
  <select id="${id('optimizationLevel')}">
    ${opt('O0',s.optimizationLevel,'O0 — No optimization (fastest rebuild)')}
    ${opt('O1',s.optimizationLevel,'O1 — Basic optimization')}
    ${opt('O2',s.optimizationLevel,'O2 — Balanced')}
    ${opt('O3',s.optimizationLevel,'O3 — Maximum optimization')}
    ${opt('Os',s.optimizationLevel,'Os — Optimize for size')}
    ${opt('Og',s.optimizationLevel,'Og — Optimize for debugging')}
  </select>
</div>
<div class="row">
  <label>Debug Info</label>
  <select id="${id('debugInfo')}">
    ${opt('g3',s.debugInfo,'g3 — Full debug info + macros (default)')}
    ${opt('g', s.debugInfo,'g — Standard debug info')}
    ${opt('g1',s.debugInfo,'g1 — Minimal debug info (line numbers only)')}
    ${opt('g0',s.debugInfo,'g0 — No debug info (release)')}
  </select>
  <p class="hint">Does not affect flash size — <code>.bin</code>/<code>.hex</code> strips debug sections. Only affects <code>.elf</code> file size on disk.</p>
</div>
<div class="row">
  <label>Float ABI</label>
  <select id="${id('floatAbi')}">
    ${opt('soft',  s.floatAbi, 'soft — Software FP (M0/M0+/M3)')}
    ${opt('softfp',s.floatAbi, 'softfp — Software ABI with HW FP instructions')}
    ${opt('hard',  s.floatAbi, 'hard — Hardware FP ABI (M4F/M7 only)')}
  </select>
</div>
<div class="row">
  <label>FPU</label>
  <select id="${id('fpu')}">
    ${opt('none',       s.fpu, 'none — No FPU (M0/M0+/M3)')}
    ${opt('fpv4-sp-d16',s.fpu, 'fpv4-sp-d16 — Cortex-M4F')}
    ${opt('fpv5-sp-d16',s.fpu, 'fpv5-sp-d16 — Cortex-M7 single-precision')}
    ${opt('fpv5-d16',   s.fpu, 'fpv5-d16 — Cortex-M7 double-precision')}
  </select>
</div>
<div class="row">
  <label class="checkbox-row" style="font-size:var(--vscode-font-size)">
    <input type="checkbox" id="${id('useLto')}" ${s.useLto ? 'checked' : ''}>
    Link-time optimization (<code>-flto</code>)
  </label>
  <p class="hint">Adds <code>-flto</code> to CFLAGS and LDFLAGS. Reduces code size but increases build time.</p>
</div>
<div class="row">
  <label>C Defines (<code>defines.list</code>)</label>
  <div style="display:flex;flex-direction:column;gap:0">
    <p class="hint" style="margin:0 0 4px">Preprocessor defines passed to C/C++ compiler (<code>-D</code>). Populated automatically at conversion time.</p>
    <div id="${id('cDefRows')}" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">${cDefRowsHtml || '<p class="no-items">No C defines.</p>'}</div>
    <button class="btn-secondary add-btn" style="margin-top:4px;align-self:flex-start" onclick="addDef(${bgName ? `'${esc(bgName)}'` : "''"}, 'c')">+ Add C Define</button>
  </div>
</div>
<div class="row">
  <label>ASM Defines (<code>adefines.list</code>)</label>
  <div style="display:flex;flex-direction:column;gap:0">
    <p class="hint" style="margin:0 0 4px">Preprocessor defines passed to assembler only (<code>-D</code>). Standard series: contains <code>USE_HT32_CHIP=X</code>.</p>
    <div id="${id('aDefRows')}" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">${aDefRowsHtml || '<p class="no-items">No ASM defines.</p>'}</div>
    <button class="btn-secondary add-btn" style="margin-top:4px;align-self:flex-start" onclick="addDef(${bgName ? `'${esc(bgName)}'` : "''"}, 'a')">+ Add ASM Define</button>
  </div>
</div>
<div class="row">
  <label>Include Paths</label>
  <div style="display:flex;flex-direction:column;gap:0">
    <p class="hint" style="margin:0 0 4px">All <code>-I</code> paths written to <code>includes.list</code>. Populated automatically at conversion time; add extra paths here (e.g. FreeRTOS GCC port directory).</p>
    <div id="${id('extraIncRows')}">${incPathRowsHtml || '<p class="no-items">No include paths.</p>'}</div>
    <button class="btn-secondary add-btn" style="margin-top:4px;align-self:flex-start" onclick="addIncPath(${bgName ? `'${esc(bgName)}'` : "''"})">+ Add Include Path</button>
  </div>
</div>
<div class="row">
  <label>Extra CFLAGS</label>
  <input id="${id('extraCFlags')}" type="text" value="${esc(s.extraCFlags)}" placeholder="e.g. -std=gnu11 -DDEBUG">
</div>
<div class="row">
  <p class="hint" style="margin:0;line-height:1.7">
    <strong>Default flags always included:</strong><br>
    CFLAGS: <code>-mcpu=… -mthumb [-mfpu=… -mfloat-abi=…] -Os -g3 [-ffunction-sections -fdata-sections] "-ffile-prefix-map=$(CURDIR)=."</code><br>
    ASFLAGS: <code>-mcpu=… -mthumb [-mfpu=… -mfloat-abi=…] -x assembler-with-cpp "-ffile-prefix-map=$(CURDIR)=."</code>
  </p>
</div>
</div>
</div><!-- /tab_compiler -->

<div class="tab-panel" id="${p}tab_linker">
<div class="settings-group">
<div class="row">
  <label class="checkbox-row" style="font-size:var(--vscode-font-size)">
    <input type="checkbox" id="${id('gcSections')}" ${s.gcSections ? 'checked' : ''}>
    Dead code elimination (<code>-ffunction-sections -fdata-sections -Wl,--gc-sections</code>)
  </label>
  <p class="hint">Removes unused functions and data at link time. Disable if you encounter weak symbol or coverage tool issues.</p>
</div>
<div class="row">
  <label>C Runtime Library</label>
  <label class="checkbox-row">
    <input type="checkbox" id="${id('useNanoSpec')}" ${s.useNano ? 'checked' : ''}>
    Use newlib-nano (<code>--specs=nano.specs</code>)
  </label>
  <label class="checkbox-row">
    <input type="checkbox" id="${id('printfFloat')}" ${s.printfFloat ? 'checked' : ''}>
    Use float with nano printf (<code>-u _printf_float</code>)
  </label>
  <label class="checkbox-row">
    <input type="checkbox" id="${id('scanfFloat')}" ${s.scanfFloat ? 'checked' : ''}>
    Use float with nano scanf (<code>-u _scanf_float</code>)
  </label>
  <label class="checkbox-row">
    <input type="checkbox" id="${id('useNosysSpec')}" ${s.useNosys ? 'checked' : ''}>
    Do not use syscalls (<code>--specs=nosys.specs</code>)
  </label>
</div>
<div class="row">
  <label>Extra Libraries</label>
  <p class="lib-section-label" style="margin-top:0">Libraries (-l)</p>
  <div id="${id('libNameRows')}">${libNameRowsHtml || '<p class="no-items">No -l libraries.</p>'}</div>
  <button class="btn-secondary add-btn" style="margin-top:4px;align-self:flex-start" onclick="addLibName(${bgName ? `'${esc(bgName)}'` : "''"})">+ Add -l</button>
  <p class="lib-section-label" style="margin-top:10px">Search Paths (-L)</p>
  <div id="${id('libPathRows')}">${libPathRowsHtml || '<p class="no-items">No -L search paths.</p>'}</div>
  <button class="btn-secondary add-btn" style="margin-top:4px;align-self:flex-start" onclick="addLibPath(${bgName ? `'${esc(bgName)}'` : "''"})">+ Add -L</button>
</div>
<div class="row">
  <label>Extra LDFLAGS</label>
  <input id="${id('extraLDFlags')}" type="text" value="${esc(s.extraLDFlags)}" placeholder="e.g. -Wl,--wrap=malloc">
</div>
<div class="row">
  <label>Linker Scripts</label>
  <div style="display:flex;flex-direction:column;gap:0">
    <p class="hint" style="margin:0 0 4px">Paths relative to the project build directory (e.g. <code>../GNU_ARM/linker.ld</code>). Multiple scripts are linked in order.</p>
    <div id="${id('ldRows')}">${ldRowsHtml || '<p class="no-items">No linker scripts.</p>'}</div>
    <button class="btn-secondary add-btn" style="margin-top:4px;align-self:flex-start" onclick="addLinkerScript(${bgName ? `'${esc(bgName)}'` : "''"})">+ Add Linker Script</button>
  </div>
</div>
<div class="row">
  <p class="hint" style="margin:0;line-height:1.7">
    <strong>Default LDFLAGS always included:</strong><br>
    <code>[-Wl,--gc-sections,]--print-memory-usage,-Map,build/xxx.map -T linker.ld --specs=nano.specs --specs=nosys.specs -Wl,--start-group,-lm,-lc,-lgcc,-lnosys -Wl,--end-group</code>
  </p>
</div>
</div>
</div><!-- /tab_linker -->

<div class="tab-panel" id="${p}tab_build">
<div class="settings-group">
<h2>Build</h2>
<div class="row">
  <label>Output Filename</label>
  <input id="${id('outputName')}" type="text" value="${esc(s.outputName ?? '')}" placeholder="${defaultTargetName ? esc(defaultTargetName) + ' (current)' : 'e.g. app'}">
  <p class="hint">Sets <code>TARGET :=</code> in the Makefile — the name of the generated <code>.elf</code> / <code>.a</code>. Leave empty to keep the original name from conversion.</p>
</div>
<div class="row">
  <label>Post-Build Command</label>
  <input id="${id('postBuildCmd')}" type="text" value="${esc(s.postBuildCmd)}" placeholder='e.g. ..\\Tools\\afterbuild_ap.bat vsc IAP_AP HT32F52352' style="font-family:monospace">
</div>
<div class="row">
  <p class="hint" style="margin:0">Runs after <strong>Build</strong> completes. Working directory: <code>\${workspaceFolder}</code>.<br>
  Adds a <strong>Post-Build</strong> task in tasks.json that chains after the build task.</p>
</div>
</div>
${machine ? `<div class="settings-group">
<h2>Toolchain <span class="hint" style="font-size:0.85em;font-weight:normal">(machine-wide — saved to User Settings)</span></h2>
<div class="row">
  <label>GCC Path (arm-none-eabi-gcc)</label>
  <div style="display:flex;gap:4px">
    <input id="gccPath" type="text" value="${esc(machine.gccPath)}" placeholder="${detectedGccPath ? esc(detectedGccPath) : 'Leave empty to auto-detect'}" data-browse-id="gccPathBrowse" style="flex:1">
    <button class="btn-secondary" title="Browse" style="padding:0 8px;min-width:30px" onclick="vscode.postMessage({type:'browseFile',browseId:'gccPathBrowse',currentPath:document.getElementById('gccPath').value.trim()})">&#8230;</button>
  </div>
</div>
${_openocdAvailable ? `<div class="row">
  <label>OpenOCD Path</label>
  <div style="display:flex;gap:4px">
    <input id="openocdPath" type="text" value="${esc(machine.openocdPath)}" placeholder="Leave empty to use bundled OpenOCD" data-browse-id="openocdPathBrowse" style="flex:1">
    <button class="btn-secondary" title="Browse" style="padding:0 8px;min-width:30px" onclick="vscode.postMessage({type:'browseFile',browseId:'openocdPathBrowse',currentPath:document.getElementById('openocdPath').value.trim()})">&#8230;</button>
  </div>
</div>` : ''}
</div>` : ''}
</div><!-- /tab_build -->

${wrapClose}`;
}

/** Generate HTML for a single loader row (server-side initial render) */
function loaderRowHtml(l: FlashLoaderEntry, availableFlms: string[], _prefix: string): string {
  const opts = availableFlms
    .map(h => `<option value="${esc(h)}"${h === l.flm ? ' selected' : ''}>${esc(h.replace(/\.[^.]+$/, ''))}</option>`)
    .join('');
  const checked = l.enabled !== false ? ' checked' : '';
  return `<div class="loader-row">
  <input class="loader-enabled" type="checkbox" title="Include in flash download"${checked}>
  <select class="loader-flm">${opts}</select>
  <input class="loader-start" type="text" value="${esc(l.start)}" placeholder="0x08000000">
  <input class="loader-end"   type="text" value="${esc(l.end)}"   placeholder="0x0FFFFFFF">
  <button class="btn-remove" onclick="this.closest('.loader-row').remove();setDirty()" title="Remove">\u2715</button>
</div>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
