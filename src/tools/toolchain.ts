// src/tools/toolchain.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { semverCmp } from './utils';
import { exec as cpExec, spawn, ExecOptions } from 'child_process';

/* ──────────────────────────────────────
 * 共用 OutputChannel / Log
 * ────────────────────────────────────── */
export const CHANNEL = vscode.window.createOutputChannel('HT32 Toolchain');

export function logInfo(msg: string) {
  CHANNEL.appendLine(`[INFO] ${msg}`);
}
export function logWarn(msg: string) {
  CHANNEL.appendLine(`[WARN] ${msg}`);
}
export function logError(msg: string) {
  CHANNEL.appendLine(`[ERROR] ${msg}`);
}

/* ──────────────────────────────────────
 * exec helper（包成 Promise）
 * ────────────────────────────────────── */
function execp(cmd: string, options: ExecOptions = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    cpExec(cmd, { windowsHide: true, ...options }, (err, stdout, stderr) => {
      const code = (err && typeof (err as any).code === 'number') ? (err as any).code as number : 0;
      const outStr = stdout ? stdout.toString() : '';
      const errStr = stderr ? stderr.toString() : '';
      resolve({ code, stdout: outStr, stderr: errStr });
    });
  });
}

/** 取得 arm-none-eabi-gcc 主版本號（例如 10、13），解析失敗回傳 undefined */
async function getArmGccMajorVersion(exe: string): Promise<number | undefined> {
  const cmd = process.platform === 'win32'
    ? `cmd /c "${exe}" --version`
    : `"${exe}" --version`;
  const { code, stdout, stderr } = await execp(cmd);
  if (code !== 0) return undefined;
  const text = stdout + '\n' + stderr;
  const m = text.match(/\)\s+(\d+)\.\d+\.\d+/);
  return m ? parseInt(m[1], 10) : undefined;
}

/** 驗證 exe 執行結果是否包含某些關鍵字（不拋錯） */
async function verifyExe(exe: string, args: string[], mustIncludes: string[]): Promise<boolean> {
  const joined = args.join(' ');
  const cmd = process.platform === 'win32'
    ? `cmd /c "${exe}" ${joined}`
    : `"${exe}" ${joined}`;

  const { code, stdout, stderr } = await execp(cmd);
  if (code !== 0) return false;
  const text = (stdout + '\n' + stderr).toLowerCase();
  return mustIncludes.every(s => text.includes(s.toLowerCase()));
}

/* ──────────────────────────────────────
 * make 尋找相關 helper
 * ────────────────────────────────────── */

async function isGnuMake(fullPath: string): Promise<boolean> {
  return verifyExe(fullPath, ['--version'], ['gnu make']);
}

/** 掃一組候選路徑，只接受 MSYS2 / Git / MinGW，排除 GnuWin32 / Cygwin */
async function scanMakeCandidates(title: string, list: string[]): Promise<string | undefined> {
  logInfo(`-- scanning ${title} --`);
  for (const p of list) {
    if (!p) continue;
    if (!fs.existsSync(p)) {
      logInfo(`  [MISS] ${p}`);
      continue;
    }
    const lower = p.toLowerCase();
    // 排除 GnuWin32 / Cygwin
    if (lower.includes('\\gnuwin32\\') || lower.includes('\\cygwin\\')) {
      logInfo(`  [SKIP bad origin] ${p}`);
      continue;
    }

    if (await isGnuMake(p)) {
      logInfo(`  [OK] ${p}`);
      return p;
    } else {
      logInfo(`  [NOT GNU MAKE] ${p}`);
    }
  }
  return undefined;
}

/** Windows 的 where */
async function whereAll(cmd: string): Promise<string[]> {
  const { code, stdout } = await execp(`where ${cmd}`);
  if (code !== 0) return [];
  return stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

/** In-session cache：同一個 VS Code 視窗內只搜尋一次（找到時才 cache；找不到不 cache，讓安裝後可重試） */
let _makePathCache: string | undefined = undefined;

/** 跨平台尋找 make（只吃 MSYS2 / Git / MinGW；排除 GnuWin32 / Cygwin） */
export async function locateMake(extensionPath?: string): Promise<string | undefined> {
  if (_makePathCache !== undefined) {
    logInfo(`locateMake: returning cached result: ${_makePathCache}`);
    return _makePathCache;
  }
  const found = await _locateMakeInner(extensionPath);
  if (found !== undefined) { _makePathCache = found; }
  return found;
}

async function _locateMakeInner(extensionPath?: string): Promise<string | undefined> {
  logInfo('======= locateMake() START =======');
  logInfo(`platform = ${process.platform}`);

  // 1) user 設定 — 暫時停用：make 未開放給 user 設定，且 bundled 4.4.1 保證
  //    --output-sync=line 可用；開放 user 設定時需同步檢查版本 ≥ 4.0。
  // const manual = cfg.get<string>('ht32.makePath') || '';
  // if (manual && fs.existsSync(manual) && await isGnuMake(manual)) {
  //   logInfo(`use user-configured make: ${manual}`);
  //   return manual;
  // }

  // 2) Windows：優先用 bundled make（保證 GNU Make 4.4，支援 $(file <...)）
  //    不掃系統，避免找到不支援 $(file <...) 語法的舊版本
  if (process.platform === 'win32') {
    if (extensionPath) {
      const bundled = path.join(extensionPath, 'bin', 'win32-x64', 'make.exe');
      if (fs.existsSync(bundled) && await isGnuMake(bundled)) {
        logInfo(`use bundled make: ${bundled}`);
        return bundled;
      }
      logWarn(`bundled make not found at: ${bundled}`);
    }
    // bundled 找不到時，嘗試已安裝的 LLVM-MinGW（winget，同樣支援 $(file <...)）
    const wingetRoot = path.join(
      process.env.LOCALAPPDATA ?? '',
      'Microsoft', 'WinGet', 'Packages'
    );
    if (fs.existsSync(wingetRoot)) {
      for (const d of fs.readdirSync(wingetRoot, { withFileTypes: true })) {
        if (!d.isDirectory() || !d.name.startsWith('MartinStorsjo.LLVM-MinGW')) continue;
        for (const sub of fs.readdirSync(path.join(wingetRoot, d.name), { withFileTypes: true })) {
          if (!sub.isDirectory()) continue;
          const candidate = path.join(wingetRoot, d.name, sub.name, 'bin', 'make.exe');
          if (fs.existsSync(candidate) && await isGnuMake(candidate)) {
            logInfo(`use LLVM-MinGW (winget) make: ${candidate}`);
            return candidate;
          }
        }
      }
    }
    logWarn('locateMake: no make available on Windows');
    return undefined;
  }

  // 3) Linux / macOS：系統 make 為主
  const unix = await scanMakeCandidates('UNIX default', [
    '/usr/bin/make',
    '/bin/make',
    '/usr/local/bin/make',
  ]);
  if (unix) return unix;

  const { code, stdout } = await execp('which make');
  if (code === 0) {
    const p = stdout.trim();
    if (p && await isGnuMake(p)) {
      logInfo(`use which make: ${p}`);
      return p;
    }
  }

  logInfo('locateMake: no suitable make detected on UNIX');
  return undefined;
}

/* ──────────────────────────────────────
 * arm-none-eabi-gcc 尋找相關
 * ────────────────────────────────────── */

/**
 * Shallow scan for arm-none-eabi-gcc.exe under the given root directories.
 * Recurses at most `maxDepth` levels deep (breadth-first so shallowest wins).
 * Returns the first match found, preferring newer version numbers via directory name comparison.
 */
function findArmGccShallow(roots: string[], maxDepth: number): string | undefined {
  const candidates: string[] = [];

  function scan(dir: string, depth: number) {
    if (!fs.existsSync(dir)) { return; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    const gcc = path.join(dir, 'bin', 'arm-none-eabi-gcc.exe');
    if (fs.existsSync(gcc)) { candidates.push(gcc); }

    if (depth < maxDepth) {
      for (const e of entries) {
        if (e.isDirectory()) { scan(path.join(dir, e.name), depth + 1); }
      }
    }
  }

  for (const root of roots) {
    scan(root.replace(/\//g, path.sep), 0);
  }

  if (candidates.length === 0) { return undefined; }
  candidates.sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
  return candidates[0];
}

/** In-session cache：同一個 VS Code 視窗內只搜尋一次 */
let _gccPathCache: string | null | undefined = undefined;  // undefined = not searched yet, null = searched but not found
let _manualGccCache: { path: string; valid: boolean } | undefined;
const _warnedGccPaths = new Set<string>();
const _warnedInvalidGccPaths = new Set<string>();

/** 尋找 arm-none-eabi-gcc（跨平台），永遠回傳絕對路徑或 undefined */
export async function locateArmGcc(): Promise<string | undefined> {
  const cfg = vscode.workspace.getConfiguration();

  // 使用者設定優先；同一個路徑 cache verify 結果，避免每次都 spawn subprocess
  const manual = cfg.get<string>('ht32.gccPath') || '';
  if (manual) {
    if (_manualGccCache?.path === manual && _manualGccCache.valid) {
      return manual;  // 只有 valid=true 才 cache；invalid 路徑每次重試（讓使用者修好後不需重啟）
    }
    if (!fs.existsSync(manual)) {
      if (!_warnedInvalidGccPaths.has(manual)) {
        _warnedInvalidGccPaths.add(manual);
        vscode.window.showWarningMessage(`ht32.gccPath "${manual}" does not exist — falling back to auto-detect.`);
      }
    } else if (await verifyExe(manual, ['--version'], ['arm-none-eabi-gcc'])) {
      logInfo(`use user-configured arm gcc: ${manual}`);
      await warnIfGccTooOld(manual);
      _manualGccCache = { path: manual, valid: true };
      return manual;
    } else {
      if (!_warnedInvalidGccPaths.has(manual)) {
        _warnedInvalidGccPaths.add(manual);
        vscode.window.showWarningMessage(`ht32.gccPath "${manual}" is not arm-none-eabi-gcc — falling back to auto-detect.`);
      }
    }
  }

  // auto-detect 才走 cache
  if (_gccPathCache !== undefined) {
    logInfo(`locateArmGcc: returning cached result: ${_gccPathCache ?? '(not found)'}`);
    return _gccPathCache ?? undefined;
  }

  logInfo('======= locateArmGcc() START =======');
  logInfo(`platform = ${process.platform}`);

  const found = await _locateArmGccInner(cfg);
  if (found) await warnIfGccTooOld(found);
  _gccPathCache = found ?? null;
  return found;
}

async function warnIfGccTooOld(exe: string): Promise<void> {
  if (_warnedGccPaths.has(exe)) return;
  _warnedGccPaths.add(exe);
  const major = await getArmGccMajorVersion(exe);
  if (major !== undefined && major < 8) {
    logWarn(`arm-none-eabi-gcc version ${major} is too old (minimum required: 8). ` +
      `Please upgrade to GCC 8 or later — the Makefile uses -ffile-prefix-map which requires GCC 8+.`);
    vscode.window.showWarningMessage(
      `GNU Arm GCC version ${major} is too old. Holtek HT32 VS Code Extension requires GCC 8 or later (-ffile-prefix-map).`
    );
  }
}

async function _locateArmGccInner(cfg: vscode.WorkspaceConfiguration): Promise<string | undefined> {
  // 1) PATH：用 where/which 取得完整路徑（避免回傳裸名稱，讓呼叫端無法判斷是否真正找到）
  if (process.platform === 'win32') {
    const { code, stdout } = await execp('where arm-none-eabi-gcc');
    if (code === 0 && stdout.trim()) {
      const full = stdout.trim().split(/\r?\n/)[0].trim();
      if (full && fs.existsSync(full)) {
        logInfo(`locateArmGcc: found in PATH: ${full}`);
        return full;
      }
    }
  } else {
    const { code, stdout } = await execp('which arm-none-eabi-gcc');
    if (code === 0 && stdout.trim()) {
      logInfo(`locateArmGcc: found in PATH: ${stdout.trim()}`);
      return stdout.trim();
    }
  }

  // 3) Windows：HT32-IDE xPack 固定路徑（最常見安裝位置）
  if (process.platform === 'win32') {
    const xpackRoots = [
      'C:/Program Files (x86)/Holtek HT32 Series/HT32-IDE/xPack',
      'C:/Program Files/Holtek HT32 Series/HT32-IDE/xPack',
    ];
    for (const xpackRoot of xpackRoots) {
      if (!fs.existsSync(xpackRoot)) continue;
      const dirs = fs.readdirSync(xpackRoot)
        .filter(d => d.startsWith('arm-gnu-toolchain'))
        .sort((a, b) => semverCmp(b, a));  // newest first
      for (const d of dirs) {
        const candidate = path.join(xpackRoot, d, 'bin', 'arm-none-eabi-gcc.exe');
        if (fs.existsSync(candidate)) {
          logInfo(`locateArmGcc: found HT32-IDE xPack toolchain at ${candidate}`);
          return candidate;
        }
      }
    }

    // 4) Arm 官方安裝程式（各版本子目錄名稱不固定，做 shallow scan）
    const armInstallRoots = [
      'C:/Program Files/Arm',
      'C:/Program Files (x86)/Arm',
      'C:/Program Files/Arm GNU Toolchain',
      'C:/Program Files (x86)/Arm GNU Toolchain',
    ];
    const shallowFound = findArmGccShallow(armInstallRoots, 3);
    if (shallowFound) {
      logInfo(`locateArmGcc: found Arm toolchain at ${shallowFound}`);
      return shallowFound;
    }
  } else {
    // 5) UNIX：固定常見路徑
    const unixCandidates = [
      '/usr/bin/arm-none-eabi-gcc',
      '/usr/local/bin/arm-none-eabi-gcc',
      '/opt/arm-none-eabi/bin/arm-none-eabi-gcc',
    ];
    for (const c of unixCandidates) {
      if (fs.existsSync(c)) {
        logInfo(`locateArmGcc: found at ${c}`);
        return c;
      }
    }
  }

  logInfo('locateArmGcc: arm-none-eabi-gcc not found');
  return undefined;
}

/* ──────────────────────────────────────
 * winget 執行（帶 VSCode progress）
 * ────────────────────────────────────── */

async function hasWinget(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const { code } = await execp('winget --version');
  return code === 0;
}

async function runWingetWithProgress(
  title: string,
  args: string[],
): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  if (!await hasWinget()) {
    logWarn('winget not available on this system.');
    return false;
  }

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: false,
    },
    () =>
      new Promise<boolean>((resolve) => {
        logInfo(`[winget] start: winget ${args.join(' ')}`);
        const child = spawn('winget', args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        child.stdout.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8').replace(/\r/g, '').trim();
          // 只挑幾行乾淨的 log，不把整個 TUI 丟出來
          if (/Downloading|Installing|Verifying|Acquiring/i.test(text)) {
            logInfo(`[winget] ${text}`);
          }
        });

        child.stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8').replace(/\r/g, '').trim();
          if (text) {
            logWarn(`[winget:stderr] ${text}`);
          }
        });

        child.on('error', (err) => {
          logError(`[winget] failed to start: ${err.message}`);
          resolve(false);
        });

        child.on('exit', (code) => {
          logInfo(`[winget] exit code = ${code}`);
          resolve(code === 0);
        });
      })
  );
}

/* ──────────────────────────────────────
 * 使用 winget 安裝工具
 * ────────────────────────────────────── */

/** 使用 winget 安裝 MSYS2 + pacman make，然後再用 locateMake 找 */
/** 使用 winget 安裝 LLVM-Mingw（內含 make.exe），然後再用 locateMake 找 */
async function installMakeWithWinget(): Promise<string | undefined> {
  if (process.platform !== 'win32') {
    logWarn('installMakeWithWinget: non-Windows platform, skip.');
    return undefined;
  }

  const ok = await runWingetWithProgress(
    'Installing LLVM-Mingw (includes GNU Make)...',
    [
      'install', '--id', 'MartinStorsjo.LLVM-MinGW.UCRT',
      '--source', 'winget',
      '--accept-source-agreements',
      '--accept-package-agreements',
    ]
  );

  if (!ok) {
    logWarn('LLVM-Mingw installation failed or skipped.');
    return undefined;
  }

  // 安裝完之後，統一交給 locateMake() 做路徑搜尋
  const makePath = await locateMake();
  if (!makePath) {
    logWarn('After installing LLVM-Mingw, still cannot locate make.exe');
    return undefined;
  }

  logInfo(`installMakeWithWinget: using make at ${makePath}`);
  return makePath;
}

/*async function installMakeWithWinget(): Promise<string | undefined> {
  if (process.platform !== 'win32') {
    logWarn('installMakeWithWinget: non-Windows platform, skip.');
    return undefined;
  }

  // 安裝 msys2.msys2（你之前就用這個）
  const okMsys = await runWingetWithProgress(
    'Installing MSYS2 (for GNU make)...',
    [
      'install', '--id', 'msys2.msys2',
      '--source', 'winget',
      '--accept-source-agreements',
      '--accept-package-agreements',
    ]
  );
  if (!okMsys) {
    logWarn('MSYS2 installation failed or skipped.');
    return undefined;
  }

  // 安裝 make：透過 pacman
  const bashPath = 'C:\\msys64\\usr\\bin\\bash.exe';
  if (!fs.existsSync(bashPath)) {
    logWarn(`Cannot find MSYS2 bash at ${bashPath}`);
    return undefined;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Installing make via pacman (MSYS2)...',
      cancellable: false,
    },
    () =>
      new Promise<void>((resolve) => {
        logInfo('[pacman] pacman -Sy --noconfirm make');
        const child = spawn(bashPath, ['-lc', 'pacman -Sy --noconfirm make'], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        child.stdout.on('data', (buf: Buffer) => {
          const text = buf.toString('utf8').replace(/\r/g, '').trim();
          if (text) logInfo(`[pacman] ${text}`);
        });
        child.stderr.on('data', (buf: Buffer) => {
          const text = buf.toString('utf8').replace(/\r/g, '').trim();
          if (text) logWarn(`[pacman:stderr] ${text}`);
        });
        child.on('exit', () => resolve());
        child.on('error', () => resolve());
      })
  );

  // 再 locate 一次
  const makePath = await locateMake();
  if (!makePath) {
    logWarn('After MSYS2 pacman make, still cannot locate GNU make.');
    return undefined;
  }
  return makePath;
}*/



/** 使用 winget 安裝 Arm GNU Embedded Toolchain */
async function installArmGccWithWinget(): Promise<string | undefined> {
  if (process.platform !== 'win32') {
    logWarn('installArmGccWithWinget: non-Windows platform, skip.');
    return undefined;
  }

  const ok = await runWingetWithProgress(
    'Installing GNU Arm Embedded Toolchain (arm-none-eabi-gcc)...',
    [
      'install', '-e', '--id', 'Arm.GnuArmEmbeddedToolchain',
      '--source', 'winget',
      '--accept-source-agreements',
      '--accept-package-agreements',
    ]
  );
  if (!ok) {
    logWarn('Arm.GnuArmEmbeddedToolchain installation failed or skipped.');
    return undefined;
  }

  // 安裝完再找一次
  const gccPath = await locateArmGcc();
  if (!gccPath) {
    logWarn('After winget Arm.GnuArmEmbeddedToolchain, still cannot locate arm-none-eabi-gcc.');
    return undefined;
  }
  return gccPath;
}

/* ──────────────────────────────────────
 * 將路徑寫入 .vscode/settings.json
 * ────────────────────────────────────── */

function updateSettingsJson(root: string, makePath?: string, gccPath?: string) {
  const settingsPath = path.join(root, '.vscode', 'settings.json');
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let data: any = {};
  if (fs.existsSync(settingsPath)) {
    try {
      data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e: any) {
      logWarn(`updateSettingsJson: failed to parse ${settingsPath}: ${e?.message ?? e}; existing settings will be preserved as-is`);
      return;
    }
  }

  if (makePath) {
    data['ht32.makePath'] = makePath;
  }
  if (gccPath) {
    const queryDriver = gccPath.replace(/arm-none-eabi-gcc(\.exe)?$/i, 'arm-none-eabi-*');
    const args: string[] = Array.isArray(data['clangd.arguments']) ? data['clangd.arguments'] : [];
    data['clangd.arguments'] = [...args.filter((a: string) => !a.startsWith('--query-driver=')), `--query-driver=${queryDriver}`];
  }

  // Auto-detect file encoding (Big5, Shift-JIS, …) — set as default, don't override if user changed it
  if (data['files.autoGuessEncoding'] === undefined) {
    data['files.autoGuessEncoding'] = true;
  }

  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2));
  logInfo(`settings.json updated at: ${settingsPath}`);
}


/**
 * 根據 openocd 可執行檔路徑，推算 FlashLoader 目錄（HT32 HLM 檔案位置）。
 * 目錄結構：xPack/xpack-openocd-x.x.x/bin/openocd.exe
 *           xPack/FlashLoader/HT32F.HLM
 */
export function deriveFlashLoaderDir(openocdExePath: string): string {
  const xpackDir = path.dirname(path.dirname(openocdExePath));   // xpack-openocd-x.x.x
  return path.normalize(path.join(xpackDir, '..', 'FlashLoader'));
}

/* ──────────────────────────────────────
 * 對外：確保 Toolchain 存在 + 設定 JSON
 * ────────────────────────────────────── */

/**
 * rootFolder: 一般是 workspaceFolder.fsPath
 * 1. 先 locateMake / locateArmGcc
 * 2. 找不到就用 winget 安裝（Windows）
 * 3. 把路徑寫入 .vscode/settings.json
 * 4. 若有任何工具是本次新安裝的，呼叫 onInstalled(makePath, gccPath)
 *    讓呼叫端重新產生 Makefile / tasks.json
 */
export async function ensureToolchain(
  rootFolder: string,
  extensionPath?: string,
  onInstalled?: (makePath: string | undefined, gccPath: string | undefined) => Promise<void>
) {
  CHANNEL.show(true);
  logInfo('=== ensureToolchain() ===');

  let makePath = await locateMake(extensionPath);
  let gccPath  = await locateArmGcc();
  let installed = false;

  // Windows：bundled 與已安裝的 LLVM-MinGW 都找不到，才透過 winget 安裝
  if (!makePath && process.platform === 'win32') {
    makePath  = await installMakeWithWinget();
    installed = installed || !!makePath;
  }
  if (!makePath && process.platform !== 'win32') {
    vscode.window.showWarningMessage('GNU make not found. Please install it using your system package manager (e.g. apt, yum, pacman, brew).');
  }

  // 如果沒有 gcc，試著用 winget 安裝
  if (!gccPath && process.platform === 'win32') {
    gccPath   = await installArmGccWithWinget();
    installed = installed || !!gccPath;
  }
  if (!gccPath && process.platform !== 'win32') {
    vscode.window.showWarningMessage('arm-none-eabi-gcc not found. Please install the GNU Arm Embedded Toolchain.');
  }

  if (!makePath && !gccPath) {
    logWarn('ensureToolchain: make & gcc both missing after attempt.');
    return;
  }

  updateSettingsJson(rootFolder, makePath, gccPath);

  if (installed && onInstalled) {
    vscode.window.showInformationMessage('Toolchain installed. Regenerating project files...');
    await onInstalled(makePath, gccPath);
  }

  vscode.window.showInformationMessage('HT32 Toolchain check complete. Paths written to .vscode/settings.json.');
}
