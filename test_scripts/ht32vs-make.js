#!/usr/bin/env node
'use strict';
// ht32vs-make.js — CLI build tool for HT32 VS Code projects
// Reads .ht32vs project file, regenerates Makefile flags for each project, runs make.
// Usage: ht32vs-make.exe <project.ht32vs> [-o <logfile>] [--no-regen] [--no-compile] [-j <n>]

// ── vscode mock (must be before any require of extension code) ────────────────
const Module = require('module');
const _origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'vscode') return {
    window: {
      createOutputChannel: () => ({ appendLine: () => {}, show: () => {} }),
      showWarningMessage:     () => Promise.resolve(undefined),
      showInformationMessage: () => Promise.resolve(undefined),
      withProgress: (_, task) => task({ report: () => {} }, { isCancellationRequested: false }),
    },
    workspace: { getConfiguration: () => ({ get: (_k, d) => d, inspect: () => undefined }) },
    ProgressLocation: { Notification: 15 },
  };
  return _origReq.apply(this, arguments);
};

const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const { spawn } = require('child_process');

// ── locate make.exe ───────────────────────────────────────────────────────────
// make.exe must be on real filesystem (cannot run from pkg snapshot).
//   pkg exe:     process.pkg === true; process.execPath = real path of ht32vs-make.exe
//   node script: __dirname = test_scripts/ (real filesystem)
const _realExeDir = process.pkg ? path.dirname(process.execPath) : __dirname;

// Find make.exe from installed extension: ~/.vscode/extensions/holtek.ht32-vscode-*/bin/win32-x64/make.exe
const _extInstallDir = path.join(os.homedir(), '.vscode', 'extensions');
const _installed = fs.existsSync(_extInstallDir)
  ? fs.readdirSync(_extInstallDir).filter(d => d.startsWith('holtek.ht32-vscode-')).sort()
  : [];
if (!_installed.length) {
  console.error(`ERROR: Holtek HT32 VS Code Extension not installed under ${_extInstallDir}`);
  process.exit(2);
}
const _extDir  = path.join(_extInstallDir, _installed[_installed.length - 1]);
const MAKE_EXE = path.join(_extDir, 'bin', 'win32-x64', 'make.exe');

if (!process.pkg && !fs.existsSync(path.join(__dirname, '../out/tools/uv2make.js'))) {
  console.error(`ERROR: ../out/tools/uv2make.js not found — run "npm run compile" first`);
  process.exit(2);
}

// String literal requires let pkg statically bundle ../out/tools/*.js into snapshot.
const { buildMakefileText, refreshDerivedFiles, readProjectMeta, writeCCDbFromLists } = require('../out/tools/uv2make.js');
const { readProjectSettings } = require('../out/tools/settingsWebview.js');
const { locateArmGcc }        = require('../out/tools/toolchain.js');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (!args.length || args.includes('--help') || args.includes('-h')) {
  console.log([
    'Usage:',
    '  ht32vs-make.exe <project.ht32vs> [options]',
    '',
    'Arguments:',
    '  <project.ht32vs>   HT32 VS Code project file',
    '',
    'Options:',
    '  -o <file>      Write build log to file (always printed to stdout as well)',
    '  --no-regen     Skip regenerateMakefileFlags (use existing Makefile as-is)',
    '  --no-compile   Regenerate flags only, do not run make',
    '  -j <n>         Parallel make jobs (default: auto)',
  ].join('\n'));
  process.exit(0);
}

const ht32vsFile = path.resolve(args[0]);
const logFile    = (() => { const i = args.indexOf('-o'); return i >= 0 ? args[i + 1] : null; })();
const noRegen    = args.includes('--no-regen');
const noCompile  = args.includes('--no-compile');
const jobs       = (() => { const i = args.indexOf('-j'); return i >= 0 ? (args[i + 1] ?? '') : ''; })();

// ── log helper (sync write to avoid flush loss on process.exit) ──────────────
let _logFd = null;
if (logFile) {
  try { _logFd = fs.openSync(logFile, 'w'); } catch (e) {
    console.error(`WARN: cannot open log file ${logFile}: ${e.message}`);
  }
}
function log(line) {
  if (_logFd !== null) {
    fs.writeSync(_logFd, line + '\n');
  } else {
    console.log(line);
  }
}
function logClose() {
  if (_logFd !== null) { fs.closeSync(_logFd); _logFd = null; }
}
// exitErr: always print to stderr so it's visible even when -o is used
function exitErr(msg, code = 2) {
  console.error(`ERROR: ${msg}`);
  if (_logFd !== null) fs.writeSync(_logFd, `ERROR: ${msg}\n`);
  logClose();
  process.exit(code);
}

// ── parse .ht32vs → bgDirs ────────────────────────────────────────────────────
if (!fs.existsSync(ht32vsFile))
  exitErr(`project file not found: ${ht32vsFile}`);
if (!ht32vsFile.toLowerCase().endsWith('.ht32vs'))
  exitErr(`not a .ht32vs file: ${ht32vsFile}`);

let projects;
try {
  const raw = fs.readFileSync(ht32vsFile, 'utf8');
  projects = JSON.parse(raw.replace(/,\s*([}\]])/g, '$1')).projects;
} catch (e) {
  exitErr(`failed to parse ${ht32vsFile}: ${e.message}`);
}
if (!Array.isArray(projects) || !projects.length)
  exitErr(`no projects found in ${ht32vsFile}`);

const bgParentDir = path.dirname(ht32vsFile);
const bgDirs = projects.map(p => path.join(bgParentDir, p));

// ── build one bgDir ───────────────────────────────────────────────────────────
async function buildOne(bgDir, gcc) {
  const settings = readProjectSettings(bgDir);
  if (!settings.mcu) {
    log(`ERROR: ${bgDir}: project.settings.json has no mcu field`);
    return false;
  }

  if (!noRegen) {
    const meta = readProjectMeta(bgDir);
    if (!meta) {
      log(`ERROR: ${bgDir}: project.meta.json missing or invalid`);
      return false;
    }
    const fpu      = (settings.fpu && settings.fpu !== 'none') ? settings.fpu : undefined;
    const floatAbi = settings.floatAbi || undefined;
    try {
      // 1. Generate full Makefile from scratch (same as Open Project / initProjectsFromMeta)
      const makeText = buildMakefileText({
        target:            settings.targetName ?? meta.targetName ?? path.basename(bgDir),
        cc:                gcc,
        mcu:               settings.mcu,
        srcs:              [],
        linkerScripts:     meta.linkerScripts ?? ['../GNU_ARM/linker.ld'],
        isLibrary:         settings.outputType === 'lib',
        fpu,
        floatAbi,
        optimizationLevel: settings.optimizationLevel,
        debugInfo:         settings.debugInfo,
        useNano:           settings.useNano,
        useNosys:          settings.useNosys,
        useLto:            settings.useLto,
        printfFloat:       settings.printfFloat,
        scanfFloat:        settings.scanfFloat,
        gcSections:        settings.gcSections,
        extraCFlags:       settings.extraCFlags,
        extraLDFlags:      settings.extraLDFlags,
        extraLibs:         settings.extraLibs,
        extraLibNames:     settings.extraLibNames,
        extraLibPaths:     settings.extraLibPaths,
      });
      fs.writeFileSync(path.join(bgDir, 'Makefile'), makeText);

      // 2. Populate SRCS, compile rules, flags, compile_commands.json from meta
      await refreshDerivedFiles(bgDir, meta, {
        skipElfInvalidation: true,
        gccPath: gcc,
        onWarn: msg => log(`WARN: ${msg}`),
      });

      // 3. Overwrite compile_commands.json with the resolved gcc path
      await writeCCDbFromLists(bgDir, {
        armCore:      settings.mcu,
        fpu,
        floatAbi,
        optimization: settings.optimizationLevel || undefined,
        debugInfo:    settings.debugInfo         || undefined,
        gccFullPath:  gcc,
        gcSections:   settings.gcSections,
      });
    } catch (e) {
      log(`ERROR: ${bgDir}: Makefile generation failed: ${e.message}`);
      return false;
    }
  }

  if (noCompile) return true;

  if (!fs.existsSync(path.join(bgDir, 'Makefile'))) {
    log(`ERROR: ${bgDir}: Makefile not found`);
    return false;
  }

  const gccBin = path.dirname(gcc);
  const env    = { ...process.env, PATH: gccBin + ';' + (process.env.PATH || '') };
  const makeArgs = ['--no-print-directory', '-j'];
  if (jobs) makeArgs.push(jobs);

  const makeCode = await new Promise((resolve) => {
    const proc = spawn(MAKE_EXE, makeArgs, { cwd: bgDir, env, stdio: 'pipe' });
    proc.stdout.on('data', d => log(d.toString().trimEnd()));
    proc.stderr.on('data', d => log(d.toString().trimEnd()));
    proc.on('error', err => { log(`ERROR: make failed to start: ${err.message}`); resolve(2); });
    proc.on('close', c => resolve(c ?? 1));
  });
  if (makeCode !== 0) return false;

  // Run postBuildCmd (stored in project.settings.json, executed separately after make — same as extension)
  const postBuildCmd = settings.postBuildCmd?.trim();
  if (!postBuildCmd) return true;

  // Mirror wrapPostBuildCmd logic from extension
  let pbCmd = postBuildCmd;
  if (!/^cmd\b/i.test(pbCmd) && /\.bat(\s|$)/i.test(pbCmd.split(/\s+/)[0]))
    pbCmd = `cmd /c ${pbCmd}`;

  const pbCwd = path.dirname(bgDir); // HT32_VSCode/ — same as ${workspaceFolder} in VS Code tasks
  log(`\n[Post-Build] ${pbCmd}`);

  const pbCode = await new Promise((resolve) => {
    const proc = spawn(pbCmd, [], { cwd: pbCwd, shell: true, stdio: 'pipe' });
    proc.stdout.on('data', d => log(d.toString().trimEnd()));
    proc.stderr.on('data', d => log(d.toString().trimEnd()));
    proc.on('error', err => { log(`ERROR: post-build failed to start: ${err.message}`); resolve(2); });
    proc.on('close', c => resolve(c ?? 1));
  });
  if (pbCode !== 0) {
    log(`ERROR: post-build exited with code ${pbCode}`);
    return false;
  }
  return true;
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const gcc = await locateArmGcc();
  if (!gcc) exitErr('arm-none-eabi-gcc not found. Install GNU Arm toolchain or set ht32.gccPath.');

  let allOk = true;
  for (const bgDir of bgDirs) {
    log(`\n${'='.repeat(72)}`);
    log(`Building: ${bgDir}`);
    log('='.repeat(72));

    if (!fs.existsSync(path.join(bgDir, 'project.meta.json'))) {
      log(`ERROR: project.meta.json not found — skipping`);
      allOk = false;
      continue;
    }

    const ok = await buildOne(bgDir, gcc);
    if (!ok) allOk = false;
  }

  logClose();
  process.exit(allOk ? 0 : 1);
}

main().catch(e => { exitErr(`FATAL: ${e.message}`); });
