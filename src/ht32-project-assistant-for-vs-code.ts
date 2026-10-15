// src/ht32-project-assistant-for-vs-code.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec as cpExec, ExecException, ExecOptions } from 'child_process';
import { XMLParser } from 'fast-xml-parser';
import { uv2make, regenerateMakefileFlags, parseUvmpw, generateCompileRuleSection, extractDeviceInfoFromUvprojx, getAllPdscPaths, findSvdFile, clearSvdCache, generateStackAnalysis, buildCCDb, writeCCDbFromLists, buildMakefileText, fwlRootFromSourcePath, patchLinkerScriptRom, miscCNeedsRedefine, patchMiscCWeak, ensureStackAnalysisStrong, ensureStackAnalysisWeak } from './tools/uv2make';
import { ensureToolchain, locateArmGcc, locateMake } from './tools/toolchain';
import { openSettingsPanel, AutoLoaderEntry, readProjectSettings, writeProjectSettings, scanAdapters, notifySettingsLinkerScriptsChanged } from './tools/settingsWebview';
import { openCreateProjectPanel, generateProjectFiles } from './tools/createProject';
import { parseHt32IdeProject, generateMakefile, buildProjectMeta, generateLinkerScript, patchStartupFiles, writeHt32IdeLists, resolveHt32IdePostBuildPath, computeHt32IdeWsRoot, convertHt32IdeProject, Ht32IdeConvertProjectResult } from './tools/ht32ide2make';
import { StackAnalysisProvider, StackAnalysisTrackerFactory } from './tools/stackAnalysisProvider';
import { semverCmp, writeProjectLists } from './tools/utils';
import { syncAfterBuildBats } from './tools/afterbuildSync';
import * as https from 'https';
import AdmZip = require('adm-zip');

let extensionPath: string;    // set in activate(), used by generateTasksAndLaunchAndMakefile()
let extensionVersion = '';    // set in activate(), injected into project.meta.json
let _recentTree: RecentTreeProvider | undefined;  // set in activate()

// Debug session tracking — only sessions started via ht32.startDebug are tracked
let ourDebugStartPending = false;
const ourDebugSessionIds = new Set<string>();

let statusItem: vscode.StatusBarItem;
let prebuiltDiagCollection: vscode.DiagnosticCollection;
let convertDiagCollection:  vscode.DiagnosticCollection;
/** ====== constants ====== */
const PROJECT_VIEW_ID = 'ht32ProjectView';      // ← package.json 中 views[].id
const CONTAINER_VIEW_ID = 'ht32Assistant';      // ← package.json 中 viewsContainers.activitybar[].id
/** ====== logging ====== */
const CHANNEL = vscode.window.createOutputChannel('HT32 VSCode');
function logInfo(msg: string) { CHANNEL.appendLine(`[INFO] ${msg}`); }
function logWarn(msg: string) { CHANNEL.appendLine(`[WARN] ${msg}`); }
function logError(msg: string) { CHANNEL.appendLine(`[ERROR] ${msg}`); }

/** ====== activate / deactivate ====== */
export async function activate(ctx: vscode.ExtensionContext) {
  extensionPath    = ctx.extensionPath;
  extensionVersion = (ctx.extension.packageJSON as any).version as string || '';
  CHANNEL.show(true);
  logInfo('Extension activating...');

  // 只在 extensionPath 改變時（升版後首次啟動）才寫入，避免每次啟動都寫 settings.json
  // 存 forward slash：${config:ht32.internal.extensionRoot} 展開後直接給 OpenOCD TCL 用，反斜線會被 TCL 當 escape 吃掉
  const globalCfg = vscode.workspace.getConfiguration();
  const extPathFwdSlash = ctx.extensionPath.replace(/\\/g, '/');
  if (globalCfg.get<string>('ht32.internal.extensionRoot') !== extPathFwdSlash) {
    await globalCfg.update('ht32.internal.extensionRoot', extPathFwdSlash, vscode.ConfigurationTarget.Global);
    logInfo(`ht32.internal.extensionRoot updated → ${extPathFwdSlash}`);
  }
  setContextHasProject(false);

  if (!vscode.workspace.isTrusted) {
    setTimeout(() => vscode.commands.executeCommand('workbench.trust.manage'), 500);
  }

  setTimeout(() => ensureClangd().catch(() => {}), 3000);

  if (ctx.globalState.get('ht32.focusOnActivate')) {
    ctx.globalState.update('ht32.focusOnActivate', false);
    setTimeout(() => vscode.commands.executeCommand('ht32RecentView.focus'), 300);
    setTimeout(() => vscode.commands.executeCommand('ht32RecentView.focus'), 1000);
  }

  // open project / convert 後 reload：在背景工作開始之前立刻切回 HT32 panel，
  // 避免使用者一直看著 Explorer 等慢操作（initProjectsFromMeta / generateTasksAndLaunchAndMakefile）結束。
  if (ctx.globalState.get('ht32.focusHt32OnActivate')) {
    ctx.globalState.update('ht32.focusHt32OnActivate', false);
    setTimeout(() => vscode.commands.executeCommand(`workbench.view.extension.${CONTAINER_VIEW_ID}`), 200);
    setTimeout(() => vscode.commands.executeCommand(`${PROJECT_VIEW_ID}.focus`), 350);
  }

  // StatusBar
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.text = '$(gear) Build';
  statusItem.command = 'ht32.build';
  statusItem.tooltip = 'Build with Make';
  statusItem.hide();
  statusItem.show(); // 顯示，但在沒有專案時我們會 hide
  prebuiltDiagCollection = vscode.languages.createDiagnosticCollection('ht32-prebuilt');
  convertDiagCollection  = vscode.languages.createDiagnosticCollection('ht32-convert');
  ctx.subscriptions.push(CHANNEL, statusItem, prebuiltDiagCollection, convertDiagCollection);

  // Restore prebuilt warnings that survived a window reload (written before ensureWorkspaceAt)
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    const pendingFile = path.join(bgParent(f.uri.fsPath), '.ht32-prebuilt-warnings.json');
    if (fs.existsSync(pendingFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
        // backward-compat: old format was string[]
        const warnings: { file: string; projName: string }[] = Array.isArray(raw) && typeof raw[0] === 'string'
          ? (raw as string[]).map((f: string) => ({ file: f, projName: '' }))
          : raw;
        applyPrebuiltDiagnostics(warnings);
        fs.unlinkSync(pendingFile);
        setTimeout(() => vscode.commands.executeCommand('workbench.panel.markers.view.focus'), 1000);
      } catch { /* non-critical */ }
      break;  // only one pending file expected
    }
  }

  // Restore convert warnings (source-not-found etc.) that survived a window reload
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    const pendingFile = path.join(bgParent(f.uri.fsPath), '.ht32-convert-warnings.json');
    if (fs.existsSync(pendingFile)) {
      try {
        const warnings: { message: string; file: string; line?: number; col?: number; len?: number }[] = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
        applyConvertDiagnostics(warnings);
        fs.unlinkSync(pendingFile);
        setTimeout(() => vscode.commands.executeCommand('workbench.panel.markers.view.focus'), 1000);
      } catch { /* non-critical */ }
      break;
    }
  }

  // Tree
  const tree = new ProjectTreeProvider();
  const treeView = vscode.window.createTreeView(PROJECT_VIEW_ID, { treeDataProvider: tree });
  treeView.title = `PROJECT FILES (v${ctx.extension.packageJSON.version})`;
  ctx.subscriptions.push(treeView);
  ctx.subscriptions.push(treeView.onDidChangeSelection(e => {
    const item = e.selection[0];
    if (!item) {
      vscode.commands.executeCommand('setContext', 'ht32.canMoveProjectUp',   false);
      vscode.commands.executeCommand('setContext', 'ht32.canMoveProjectDown', false);
      return;
    }
    const cv = (item as any).contextValue as string | undefined;
    // Extract bgDir from item id regardless of tree level:
    //   project → id = buildGenDir
    //   group   → id = `${buildGenDir}::${groupName}`
    //   file    → id = `${buildGenDir}::${groupName}::${relPath}`
    let bgDir: string | undefined;
    if (cv === 'project') {
      bgDir = item.id;
    } else if (cv === 'group' || cv === 'file' || cv === 'linkerFile') {
      const sep = (item.id ?? '').indexOf('::');
      if (sep >= 0) bgDir = item.id!.slice(0, sep);
    }
    if (!bgDir) {
      vscode.commands.executeCommand('setContext', 'ht32.canMoveProjectUp',   false);
      vscode.commands.executeCommand('setContext', 'ht32.canMoveProjectDown', false);
      return;
    }
    const bgName = path.basename(bgDir);
    const bgParentDir = path.dirname(bgDir);
    if (cv === 'project') {
      let projects: string[] = [];
      try {
        let _s: any = {};
        try { _s = JSON.parse(fs.readFileSync(path.join(bgParentDir, '.vscode', 'settings.json'), 'utf8')); } catch {}
        const _f: string | undefined = _s['ht32.activeProjectFile'];
        if (_f) {
          const _p = path.isAbsolute(_f) ? _f : path.join(bgParentDir, _f);
          projects = parseHt32vsFile(_p)?.projects ?? [];
        }
      } catch {}
      const idx = projects.indexOf(bgName);
      vscode.commands.executeCommand('setContext', 'ht32.canMoveProjectUp',   idx > 0);
      vscode.commands.executeCommand('setContext', 'ht32.canMoveProjectDown', idx >= 0 && idx < projects.length - 1);
    } else {
      vscode.commands.executeCommand('setContext', 'ht32.canMoveProjectUp',   false);
      vscode.commands.executeCommand('setContext', 'ht32.canMoveProjectDown', false);
    }
    setClangdIntelliSenseProject(bgParentDir, bgName);
    tree.setClangdActive(bgDir);
  }));


  _recentTree = new RecentTreeProvider(ctx);
  ctx.subscriptions.push(vscode.window.createTreeView('ht32RecentView', { treeDataProvider: _recentTree }));
  const initRecents = pruneRecentProjects(ctx);

  const stackProvider = new StackAnalysisProvider(ctx);
  ctx.subscriptions.push(vscode.window.createTreeView('ht32StackView', { treeDataProvider: stackProvider }));
  ctx.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory('cortex-debug', new StackAnalysisTrackerFactory(stackProvider)));
  await vscode.commands.executeCommand('setContext', 'ht32.hasRecent', initRecents.length > 0);

  // Commands
  ctx.subscriptions.push(
    vscode.commands.registerCommand('ht32.openRecentProject', async (filePath: string) => {
      if (!fs.existsSync(filePath)) {
        vscode.window.showErrorMessage(`Project not found: ${filePath}`);
        const all = ctx.globalState.get<string[]>(RECENT_KEY, []);
        await ctx.globalState.update(RECENT_KEY, all.filter(p => p !== filePath));
        _recentTree?.refresh();
        return;
      }
      await addRecentProject(ctx, filePath);
      await openHt32vsFile(ctx, tree, filePath);
    }),
    vscode.commands.registerCommand('ht32.createProject', () => createProjectCommand(ctx, tree, treeView)),
    vscode.commands.registerCommand('ht32.addNewProject', () => addNewProjectCommand(ctx, tree, treeView)),
    vscode.commands.registerCommand('ht32.openProject',       () => openProjectCommand(ctx, tree)),
    vscode.commands.registerCommand('ht32.openProjectFolder', () => openProjectFolderCommand(ctx, tree)),
    vscode.commands.registerCommand('ht32.clearRecentProjects', async () => {
      await ctx.globalState.update(RECENT_KEY, []);
      await vscode.commands.executeCommand('setContext', 'ht32.hasRecent', false);
      _recentTree?.refresh();
    }),
    vscode.commands.registerCommand('ht32.renameProjectFile', async () => {
      const root = currentWsRoot();
      if (!root) return;
      const parent = bgParent(root);
      const current = readActiveProjectFile(bgParent(root)) || '';
      if (!current) { vscode.window.showErrorMessage('No active project file to rename.'); return; }
      const currentName = path.basename(current, '.ht32vs');
      const newName = await vscode.window.showInputBox({
        title: 'Rename Project File',
        value: currentName,
        validateInput: v => !v.trim() ? 'Name cannot be empty'
          : /[<>:"/\\|?*]/.test(v.trim()) ? 'Invalid characters' : undefined,
      });
      if (!newName || newName.trim() === currentName) return;
      const oldPath = path.join(parent, current);
      const newFile = newName.trim() + '.ht32vs';
      const newPath = path.join(parent, newFile);
      try {
        if (fs.existsSync(oldPath)) {
          fs.renameSync(oldPath, newPath);
        } else {
          // Source doesn't exist yet — create from current project dirs.
          const bgDirs = fs.readdirSync(parent).filter(d => isBgDir(parent, d)).sort();
          fs.writeFileSync(newPath, JSON.stringify({ projects: bgDirs }, null, 2), 'utf8');
        }
        // Write directly to settings.json — bypasses VS Code config API cache lag.
        const settingsPath2 = path.join(parent, '.vscode', 'settings.json');
        try {
          const s2: any = fs.existsSync(settingsPath2) ? JSON.parse(fs.readFileSync(settingsPath2, 'utf8')) : {};
          s2['ht32.activeProjectFile'] = newFile;
          fs.writeFileSync(settingsPath2, JSON.stringify(s2, null, 2), 'utf8');
        } catch {}
        // Update recent projects list so the renamed entry doesn't disappear.
        const recents = ctx.globalState.get<string[]>(RECENT_KEY, []);
        const updatedRecents = recents.map(p => path.resolve(p) === path.resolve(oldPath) ? newPath : p);
        await ctx.globalState.update(RECENT_KEY, updatedRecents);
        _recentTree?.refresh();
        tree.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Rename failed: ${e.message}`);
      }
    }),
    vscode.commands.registerCommand('ht32.addProject', async () => {
      const root = currentWsRoot();
      if (!root) return;
      const parent = bgParent(root);
      const activeFile = readActiveProjectFile(bgParent(root)) || '';
      if (!activeFile) { vscode.window.showErrorMessage('No active project file.'); return; }
      // Read currently listed projects from .ht32vs
      const ht32wsPath = path.isAbsolute(activeFile) ? activeFile : path.join(parent, activeFile);
      const _parsed = parseHt32vsFile(ht32wsPath, e =>
        vscode.window.showErrorMessage(`Project file "${path.basename(ht32wsPath)}" contains invalid JSON: ${e.message}`)
      );
      if (!_parsed) return;
      const existing: string[] = _parsed.projects ?? [];
      // Find bgDirs in the same parent that are not yet listed
      const available = fs.existsSync(parent)
        ? fs.readdirSync(parent).filter(d => isBgDir(parent, d) && !existing.includes(d)).sort()
        : [];
      const picks = await vscode.window.showQuickPick(
        available.map(d => ({ label: d })),
        {
          canPickMany: true,
          placeHolder: available.length === 0
            ? 'No additional projects found in this folder — run Convert or Create Project first'
            : 'Select projects to include'
        }
      );
      if (!picks || picks.length === 0) return;
      const toAdd = picks.map(p => p.label);

      if (existing.length === 1) {
        // First time going multi-project: prompt for workspace file name
        const defaultName = path.basename(path.dirname(parent));
        const wsName = await showInputDialog({
          title: 'Multi-Project File Name',
          prompt: 'Enter a name for the multi-project file',
          value: defaultName,
          placeHolder: defaultName,
        });
        if (wsName === undefined) return;
        // Keep the single-project .ht32vs intact; create a new multi-project .ht32vs
        const newProjFile = writeOrUpdateProjectFile(parent, [...existing, ...toAdd], wsName.trim() || defaultName);
        await addRecentProject(ctx, newProjFile);
      } else {
        writeOrUpdateProjectFile(parent, toAdd, path.basename(activeFile, '.ht32vs'));
      }
      tree.refresh();
    }),
    vscode.commands.registerCommand('ht32.deleteProject', async (item: vscode.TreeItem) => {
      const root = currentWsRoot();
      if (!root) return;
      const parent = bgParent(root);
      const activeFile = readActiveProjectFile(parent) || '';
      if (!activeFile) return;
      const dirName = item.id ? path.basename(item.id as string) : (item.label as string);
      const ht32wsPath = path.isAbsolute(activeFile) ? activeFile : path.join(parent, activeFile);
      const parsed = parseHt32vsFile(ht32wsPath, e =>
        vscode.window.showErrorMessage(`Project file "${path.basename(ht32wsPath)}" contains invalid JSON: ${e.message}`)
      );
      if (!parsed) return;
      const projects: string[] = parsed.projects ?? [];
      if (projects.length <= 1) {
        vscode.window.showWarningMessage('Cannot remove the only remaining sub-project.');
        return;
      }
      const updated = projects.filter(p => p !== dirName);
      if (updated.length === projects.length) { return; }
      fs.writeFileSync(ht32wsPath, JSON.stringify({ projects: updated }, null, 2), 'utf8');
      tree.refresh();
    }),
    vscode.commands.registerCommand('ht32.closeProject',  () => {
      const root = currentWsRoot();
      if (root) { clearActiveProjectFileSetting(computeWsOpenRoot(root)); }
      tree.setRoot(undefined);
      tree.refresh();
      setContextHasProject(false);
      ctx.globalState.update('ht32.focusOnActivate', true);
      vscode.commands.executeCommand('workbench.action.closeFolder');
    }),
    vscode.commands.registerCommand('ht32.openReadme', () => {
      const readmePath = vscode.Uri.joinPath(ctx.extensionUri, 'README.md');
      vscode.commands.executeCommand('markdown.showPreview', readmePath);
    }),
    vscode.commands.registerCommand('ht32.updateFromMarketplace', async () => {
      const current = ctx.extension.packageJSON.version as string;
      CHANNEL.show(true);
      logInfo(`[Update] Checking for updates… (current: v${current})`);
      const sb = vscode.window.setStatusBarMessage('$(sync~spin) Checking for updates…');
      try {
        const latest = await fetchMarketplaceVersion('holtek.ht32-vscode');
        logInfo(`[Update] Marketplace version: v${latest}`);
        if (semverCmp(latest, current) <= 0) {
          vscode.window.showInformationMessage(`Holtek HT32 VS Code Extension is already up to date (v${current}).`);
        } else {
          logInfo(`[Update] Installing v${latest}…`);
          await vscode.commands.executeCommand('workbench.extensions.installExtension', 'holtek.ht32-vscode');
          logInfo(`[Update] Done.`);
          vscode.window.showInformationMessage(`Holtek HT32 VS Code Extension updated to v${latest}.`, 'Reload Now').then(sel => {
            if (sel === 'Reload Now') vscode.commands.executeCommand('workbench.action.reloadWindow');
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logError(`[Update] ${msg}`);
        vscode.window.showErrorMessage(`Failed to check for updates: ${msg}`);
      } finally {
        sb.dispose();
      }
    }),
    vscode.commands.registerCommand('ht32.installFromVsix', async () => {
      const files = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'VSIX Package': ['vsix'] },
        title: 'Select VSIX to Install'
      });
      if (!files?.[0]) return;
      CHANNEL.show(true);
      logInfo(`[VSIX] Installing: ${files[0].fsPath}`);
      try {
        await vscode.commands.executeCommand('workbench.extensions.installExtension', files[0]);
        logInfo('[VSIX] Done.');
        vscode.window.showInformationMessage('Extension installed.', 'Reload Now').then(sel => {
          if (sel === 'Reload Now') vscode.commands.executeCommand('workbench.action.reloadWindow');
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logError(`[VSIX] ${msg}`);
        vscode.window.showErrorMessage(`Failed to install VSIX: ${msg}`);
      }
    }),
    vscode.commands.registerCommand('ht32.updateDevicePacks', async () => {
      CHANNEL.show(true);
      await updateDevicePacks(ctx.extensionPath, true);
    }),
    vscode.commands.registerCommand('ht32.installPackFile', async () => {
      const files = await vscode.window.showOpenDialog({
        canSelectMany: true,
        filters: { 'CMSIS Pack': ['pack'] },
        title: 'Select Pack File(s) to Install'
      });
      if (!files?.length) return;
      CHANNEL.show(true);
      const dfpDir = path.join(ctx.extensionPath, 'dfp');
      fs.mkdirSync(dfpDir, { recursive: true });
      let succeeded = 0, failed = 0, skipped = 0;
      for (const file of files) {
        const name = path.basename(file.fsPath);
        if (!/^Holtek\..+\.pack$/i.test(name)) {
          logWarn(`[DFP] Skipped non-Holtek pack: ${name}`);
          skipped++;
          continue;
        }
        try {
          fs.copyFileSync(file.fsPath, path.join(dfpDir, name));
          logInfo(`[DFP] Installed pack: ${name}`);
          succeeded++;
        } catch (e: any) {
          logError(`[DFP] Failed to install ${name}: ${e?.message ?? e}`);
          failed++;
        }
      }
      if (succeeded > 0) {
        await extractDfpPacksIfNeeded(ctx.extensionPath);
        const skipNote = skipped > 0 ? ` ${skipped} skipped (invalid name).` : '';
        const failNote = failed > 0 ? ` ${failed} failed — see Output.` : '';
        vscode.window.showInformationMessage(`HT32: ${succeeded} pack(s) installed successfully.${failNote}${skipNote}`);
      } else if (failed > 0) {
        vscode.window.showWarningMessage(`HT32: All ${failed} pack installation(s) failed. Check Output.`);
      } else if (skipped > 0) {
        vscode.window.showWarningMessage(`HT32: No packs installed — ${skipped} file(s) skipped (filename must match Holtek.*.pack).`);
      }
    }),
    vscode.commands.registerCommand('ht32.convertUvision', () => convertUvision(ctx, tree, treeView)),
    vscode.commands.registerCommand('ht32.convertHt32Ide', () => convertHt32Ide(ctx, tree, treeView)),
    vscode.commands.registerCommand('ht32.generateTasksLaunch', () => generateTasksLaunchCommand(ctx)),
    vscode.commands.registerCommand('ht32.regenerateCompileCommands', () => regenerateCompileCommandsCommand()),
    vscode.commands.registerCommand('ht32.regenerateMakefile', async () => {
      const root = currentWsRoot();
      if (!root) { vscode.window.showErrorMessage('No workspace folder open.'); return; }
      const result = await pickBgDir(root, { placeHolder: 'Select project to regenerate' });
      if (!result) return;
      const bgDir = path.join(result.parent, result.chosen);
      if (!readProjectMeta(bgDir)) {
        vscode.window.showErrorMessage(`project.meta.json not found in ${result.chosen} — re-convert the project first.`);
        return;
      }
      await initProjectsFromMeta([bgDir], root);
      vscode.window.showInformationMessage(`Makefile regenerated: ${result.chosen}`);
    }),
    vscode.commands.registerCommand('ht32.build', () => smartRunTask('build')),
    vscode.commands.registerCommand('ht32.runClean', () => smartRunTask('clean')),
    vscode.commands.registerCommand('ht32.openSettings', async () => {
      const wsFolder = currentWsRoot();
      const root = wsFolder ? computeWsOpenRoot(wsFolder) : undefined;
      const spimFlmMap  = buildFlmAddrMap(extensionPath);
      const availableFlms = Object.keys(spimFlmMap).sort();
      // Collect all bgDirs for per-project settings panel
      const bgParentDir = root ? bgParent(root) : undefined;
      const activeBg = vscode.workspace.getConfiguration('ht32').get<string>('activeBuildGen') || '';
      const ht32vsOrder = bgParentDir ? readProjectOrder(bgParentDir) : undefined;
      const allowedBgs = ht32vsOrder ? new Set(ht32vsOrder) : undefined;
      const ht32vsOrderMap = ht32vsOrder ? new Map(ht32vsOrder.map((p, i) => [p, i])) : undefined;
      const bgDirNames: string[] = bgParentDir && fs.existsSync(bgParentDir)
        ? fs.readdirSync(bgParentDir).filter(d =>
            isBgDir(bgParentDir, d) &&
            (!activeBg || d === activeBg) &&
            (!allowedBgs || allowedBgs.has(d)))
            .sort((a, b) => ht32vsOrderMap
              ? (ht32vsOrderMap.get(a) ?? 9999) - (ht32vsOrderMap.get(b) ?? 9999) || a.localeCompare(b)
              : (a === BG_BASE || a === BG_BASE_OLD) ? -1 : (b === BG_BASE || b === BG_BASE_OLD) ? 1 : a.localeCompare(b))
        : [];
      const bgDirsArg = bgDirNames.map(name => ({ name, dir: path.join(bgParentDir!, name) }));
      // Per-bgDir auto loaders for the WebView
      const autoLoadersByBg: Record<string, AutoLoaderEntry[]> = {};
      for (const bg of bgDirsArg) {
        autoLoadersByBg[bg.name] = computeAutoLoadersForBg(bg.dir, extensionPath);
      }
      const flmAddrMap = spimFlmMap;
      const projectNamesByBg: Record<string, string> = {};
      for (const bg of bgDirsArg) {
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(bg.dir, 'project.meta.json'), 'utf8'));
          if (meta.projectName) projectNamesByBg[bg.name] = meta.projectName;
        } catch { /* no meta, fall back to bgDir name */ }
      }
      const settingsOcdRoot = path.join(extensionPath, 'openocd').replace(/\\/g, '/');
      const settingsOcdExe  = (vscode.workspace.getConfiguration('ht32').get<string>('openocdPath', '').trim())
                              || `${settingsOcdRoot}/bin/openocd.exe`;
      const detectedGcc = await locateArmGcc();
      openSettingsPanel(bgDirsArg, availableFlms, autoLoadersByBg, projectNamesByBg, flmAddrMap, settingsOcdExe, settingsOcdRoot, extensionPath, async (updateConfig) => {
        if (!root) return;
        if (updateConfig) {
          await generateTasksAndLaunchAndMakefile(root);            // tasks/launch + full regen
        } else {
          await regenAllMakefileFlags(root, bgDirsArg);  // 只 regen 此 .ht32vs 的 projects
        }
        tree.refresh();  // linkerScripts / sources 改變後同步更新 TreeView
      }, detectedGcc ?? undefined);
    }),
    vscode.commands.registerCommand('ht32.download', () => smartRunTask('download')),
    vscode.commands.registerCommand('ht32.refreshStackAnalysis', () => stackProvider.refresh()),
    vscode.commands.registerCommand('ht32.refreshProjectTree', () => autoAttachProjectFromWorkspace(ctx, tree)),

    vscode.commands.registerCommand('ht32.startDebug', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) return vscode.window.showErrorMessage('No workspace folder.');
      const launchPath = path.join(folder.uri.fsPath, '.vscode', 'launch.json');
      let allConfigs: any[] = [];
      try {
        const launch = JSON.parse(fs.readFileSync(launchPath, 'utf8'));
        allConfigs = (launch.configurations as any[] ?? []).filter((c: any) => c.name);
      } catch {}
      // Filter by active .ht32vs project list: scan bgParentDir for subdirs with
      // project.meta.json, intersect with .ht32vs projects list, build allowed suffixes.
      const _debugParent = bgParent(computeWsOpenRoot(folder.uri.fsPath));
      const _projectOrder = readProjectOrder(_debugParent);
      const _allowedBgs   = _projectOrder ? new Set(_projectOrder) : undefined;
      if (_allowedBgs) {
        const allowedLower = new Set([..._allowedBgs].map(s => s.toLowerCase()));
        // Collect valid bg dirs: must have project.meta.json AND be in .ht32vs projects list
        const validBgDirs = fs.existsSync(_debugParent)
          ? fs.readdirSync(_debugParent).filter(d =>
              allowedLower.has(d.toLowerCase()) && isBgDir(_debugParent, d)
            )
          : [];
        allConfigs = allConfigs.filter((c: any) => {
          const m = (c.name as string ?? '').match(/\(([^)]+)\)$/);
          const suffix = m ? m[1] : '';
          return validBgDirs.some(d => bgDirSuffix(d) === suffix);
        });
        // Sort allConfigs to match .ht32vs projects[] order
        if (_projectOrder) {
          const suffixOrder = new Map(_projectOrder.map((p, i) => [bgDirSuffix(p), i]));
          allConfigs.sort((a: any, b: any) => {
            const ma = (a.name as string ?? '').match(/\(([^)]+)\)$/);
            const mb = (b.name as string ?? '').match(/\(([^)]+)\)$/);
            const ia = suffixOrder.get(ma ? ma[1] : '') ?? 9999;
            const ib = suffixOrder.get(mb ? mb[1] : '') ?? 9999;
            return ia - ib;
          });
        }
      }
      if (allConfigs.length === 0) {
        return vscode.window.showErrorMessage('No debug configurations found. Run "Generate Build & Debug Config" first.');
      }
      let selectedConfig = allConfigs[0];
      if (allConfigs.length > 1) {
        const picked = await vscode.window.showQuickPick(allConfigs.map((c: any) => c.name), { placeHolder: 'Select debug configuration' });
        if (!picked) return;
        selectedConfig = allConfigs.find((c: any) => c.name === picked) ?? allConfigs[0];
      }

      // Verify the stored adapter serial is still connected; if stale, clear it and
      // regenerate tasks/launch so future runs are also clean.
      const bgDirName = bgDirFromConfigName(selectedConfig.name, _debugParent);
      const bgDir = path.join(bgParent(folder.uri.fsPath), bgDirName);
      const serialFresh = await ensureAdapterSerialFresh(bgDir, folder.uri.fsPath);
      if (!serialFresh) {
        // Also strip from this session's in-memory config so startDebugging uses auto-detect.
        const preConfigCmds: string[] = selectedConfig.openOCDPreConfigLaunchCommands ?? [];
        selectedConfig = {
          ...selectedConfig,
          openOCDPreConfigLaunchCommands: preConfigCmds.filter((cmd: string) => !cmd.startsWith('adapter serial ')),
        };
      }

      ourDebugStartPending = true;
      const ok = await vscode.debug.startDebugging(folder, selectedConfig);
      if (!ok) {
        ourDebugStartPending = false;
        vscode.window.showErrorMessage('Failed to start debug. Check launch.json.');
      }
    })
  );

  registerTreeEditCommands(ctx, tree, treeView);

  // Intercept VS Code's built-in restart button for all cortex-debug sessions.
  // cortex-debug's internal restart (monitor reset) is unreliable on HT32 MCUs running at
  // high frequency — SWD communication fails mid-flight. Full stop + F5 is more reliable.
  ctx.subscriptions.push(
    vscode.commands.registerCommand('workbench.action.debug.restart', async () => {
      const session = vscode.debug.activeDebugSession;
      if (!session || session.type !== 'cortex-debug') return;
      const savedConfig = session.configuration;  // save before stop; preserves request:attach vs launch
      const folder = vscode.workspace.workspaceFolders?.[0];
      await vscode.debug.stopDebugging(session);
      await new Promise<void>(resolve => {
        const d = vscode.debug.onDidTerminateDebugSession(s => {
          if (s.id === session.id) { d.dispose(); resolve(); }
        });
        setTimeout(resolve, 2000);  // fallback timeout
      });
      await new Promise(r => setTimeout(r, 300));  // probe release delay
      ourDebugStartPending = true;
      const ok = await vscode.debug.startDebugging(folder, savedConfig);
      if (!ok) { ourDebugStartPending = false; }
    })
  );

  // download 開始前 focus gdb-server terminal。
  // onWillStartSession 在 cortex-debug adapter 啟動瞬間觸發，早於 OpenOCD spawn/reuse 及 download。
  // 第二次+：terminal 已存在，立即 show()。
  // 第一次：terminal 尚未建立，每 100ms 輪詢直到出現（最多等 3 秒）。
  ctx.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory('cortex-debug', {
      createDebugAdapterTracker(_session) {
        let firstStop = true;
        return {
          onWillStartSession() {
            const tryFocus = (remaining: number) => {
              const term = vscode.window.terminals.find(t => t.name.startsWith('gdb-server'));
              if (term) { term.show(false); }
              else if (remaining > 0) { setTimeout(() => tryFocus(remaining - 1), 100); }
            };
            tryFocus(30);
          },
          onDidSendMessage(message: any) {
            if (firstStop && message.type === 'event' && message.event === 'stopped') {
              firstStop = false;
              const term = vscode.window.terminals.find(t => t.name.startsWith('gdb-server'));
              if (term) { term.sendText('Debug Ready'); }
            }
          }
        };
      }
    })
  );

  ctx.subscriptions.push(
    vscode.debug.onDidStartDebugSession(session => {
      if (ourDebugStartPending) { ourDebugStartPending = false; }
      // Track ALL cortex-debug sessions so stop always returns to HT32 sidebar
      if (session.configuration.type === 'cortex-debug') {
        ourDebugSessionIds.add(session.id);
        vscode.commands.executeCommand('workbench.view.debug');
      }
    })
  );

  ctx.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(session => {
      logInfo(`[debug] terminate session=${session.id} type=${session.configuration.type} tracked=${ourDebugSessionIds.has(session.id)}`);
      if (ourDebugSessionIds.has(session.id)) {
        ourDebugSessionIds.delete(session.id);
        const focusHt32 = () => {
          vscode.commands.executeCommand(`workbench.view.extension.${CONTAINER_VIEW_ID}`);
          vscode.commands.executeCommand(`${PROJECT_VIEW_ID}.focus`);
        };
        // Fire twice: VS Code auto-switches focus after session ends, so we override after it settles
        setTimeout(focusHt32, 300);
        setTimeout(focusHt32, 700);
      }
    })
  );

  // Double-click .ht32vs → open project directly instead of showing raw JSON.
  // customEditors handles the "VS Code already open" case (reliable).
  ctx.subscriptions.push(
    vscode.window.registerCustomEditorProvider('ht32.ht32vsEditor', {
      async resolveCustomTextEditor(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel) {
        openHt32vsFile(ctx, tree, document.uri.fsPath).then(() => {
          try { webviewPanel.dispose(); } catch {}
        }).catch(() => {});
      }
    } as vscode.CustomTextEditorProvider, { supportsMultipleEditorsPerDocument: false })
  );
  // onDidOpenTextDocument handles .ht32vs opened as text after extension is active.
  ctx.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.uri.scheme !== 'file' || !doc.fileName.toLowerCase().endsWith('.ht32vs')) { return; }
      const folder = path.dirname(doc.uri.fsPath);
      const currentRoot = currentWsRoot();
      if (!currentRoot || path.resolve(currentRoot) !== path.resolve(folder)) {
        openHt32vsFile(ctx, tree, doc.uri.fsPath).catch(() => {});
      }
    })
  );
  // Cold-start: extension activates via onStartupFinished after file is already open as text.
  // textDocuments contains all already-open docs so we can still catch it.
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme !== 'file' || !doc.fileName.toLowerCase().endsWith('.ht32vs')) { continue; }
    const folder = path.dirname(doc.uri.fsPath);
    const currentRoot = currentWsRoot();
    if (!currentRoot || path.resolve(currentRoot) !== path.resolve(folder)) {
      openHt32vsFile(ctx, tree, doc.uri.fsPath).catch(() => {});
      break;
    }
  }

  // 啟動時自動 attach 既有專案、並聚焦到我們的 View
  await autoAttachProjectFromWorkspace(ctx, tree).catch(e => logError(`autoAttach: ${e?.message ?? e}`));

  // 監聽 workspace 變動（例如剛 convert 後 openFolder 造成 reload）
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await autoAttachProjectFromWorkspace(ctx, tree).catch(e => logError(`autoAttach: ${e?.message ?? e}`));
    })
  );

  // activeProjectFile 改變時重整 TreeView（rename 後 label 更新）
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('ht32.activeProjectFile')) {
        tree.refresh();
      }
    })
  );

  // === 啟動時檢查 toolchain ===
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length > 0) {
    const root = folders[0].uri.fsPath;

    // 確認這是不是 HT32 專案（用 isBgDir 掃描，不寫死 BG_BASE 目錄名）
    const bgParentDir = bgParent(root);
    const hasHint = (() => {
      try {
        if (fs.existsSync(bgParentDir) &&
            fs.readdirSync(bgParentDir).some(d => isBgDir(bgParentDir, d))) return true;
      } catch {}
      try {
        if (fs.existsSync(root) &&
            fs.readdirSync(root).some(f => f.endsWith('.uvprojx') || f.endsWith('.cproject'))) return true;
      } catch {}
      return false;
    })();

    if (hasHint) {
      setTimeout(async () => {
        // tasks.json 不存在時 generateTasksAndLaunchAndMakefile 會檢查，這裡只補「已有 tasks.json 但工具鏈未裝」的漏洞
        if (!fs.existsSync(path.join(root, '.vscode', 'tasks.json'))) return;
        const bgNames   = fs.existsSync(bgParentDir)
          ? fs.readdirSync(bgParentDir).filter(d => isBgDir(bgParentDir, d))
          : [];
        const bgDirsAll = bgNames.map(d => path.join(bgParentDir, d));
        // 傳 [] 跳過 pyocd 偵測：pyocd 已在 generateTasksAndLaunchAndMakefile 內檢查過，此處只補 gcc/make 的缺口
        await resolveToolchain(root, [], async () => {
          if (bgDirsAll.length > 0) { await initProjectsFromMeta(bgDirsAll, root); }
          await generateTasksAndLaunchAndMakefile(root);
        });
      }, 300);
    }
  }

  // Check companion extension
  checkWizardExtension(ctx);

  // Register .ht32vs file association in Windows Registry (HKCU, no admin needed).
  // Check registry directly so reinstall always re-registers if needed.
  if (process.platform === 'win32') {
    const regCheck = [
      `$ext = (Get-ItemProperty 'HKCU:\\Software\\Classes\\.ht32vs' -EA SilentlyContinue).'(Default)'`,
      `$cmd = (Get-ItemProperty 'HKCU:\\Software\\Classes\\HT32WorkspaceFile\\shell\\open\\command' -EA SilentlyContinue).'(Default)'`,
      `if ($ext -eq 'HT32WorkspaceFile' -and $cmd -like '*code.exe*') { 'ok' }`,
    ].join('; ');
    require('child_process').exec(
      `powershell -NoProfile -NonInteractive -Command "${regCheck}"`,
      (_err: any, stdout: string) => {
        if (!stdout.trim().toLowerCase().includes('ok')) {
          registerHt32vsFileAssoc();
        }
      }
    );
  }

  extractDfpPacksIfNeeded(ctx.extensionPath).catch(e => logError(`[DFP] extractDfpPacksIfNeeded: ${e?.message ?? e}`));
  checkDfpPackUpdatesInBackground(ctx.extensionPath, ctx).catch(e => logError(`[DFP] checkDfpPackUpdatesInBackground: ${e?.message ?? e}`));
  logInfo('Extension activated.');
}
export function deactivate() {}

async function ensureClangd(): Promise<void> {
  const clangdExt = vscode.extensions.getExtension('llvm-vs-code-extensions.vscode-clangd');
  if (!clangdExt) return;

  // 若 clangd.path 已指向有效執行檔，直接略過
  const cfgPath = vscode.workspace.getConfiguration('clangd').get<string>('path', '');
  if (cfgPath && fs.existsSync(cfgPath)) return;

  // 檢查 PATH 裡是否已有 clangd
  const foundInPath = await new Promise<boolean>(resolve => {
    cpExec('where clangd', err => resolve(!err));
  });
  if (foundInPath) return;

  // clangd binary 不存在，透過 vscode-clangd extension 觸發安裝
  await clangdExt.activate();
  await vscode.commands.executeCommand('clangd.install');
}

/** 將 .ht32vs 關聯到 VS Code（HKCU，不需 admin）。回傳 true 表示成功。 */
function registerHt32vsFileAssoc(): Promise<boolean> {
  const codeExe = process.execPath; // e.g. C:\Users\...\Code.exe (single backslashes)
  const openCmdPs = `"${codeExe.replace(/'/g, "''")}" "%1"`;
  const script = [
    `$null = New-Item -Force -Path 'HKCU:\\Software\\Classes\\.ht32vs'`,
    `Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\.ht32vs' -Name '(Default)' -Value 'HT32WorkspaceFile'`,
    `$null = New-Item -Force -Path 'HKCU:\\Software\\Classes\\HT32WorkspaceFile'`,
    `Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\HT32WorkspaceFile' -Name '(Default)' -Value 'HT32 Workspace'`,
    `$null = New-Item -Force -Path 'HKCU:\\Software\\Classes\\HT32WorkspaceFile\\shell\\open\\command'`,
    `Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\HT32WorkspaceFile\\shell\\open\\command' -Name '(Default)' -Value '${openCmdPs}'`,
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise(resolve => {
    require('child_process').exec(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
      (err: any) => resolve(!err)
    );
  });
}

function checkWizardExtension(ctx: vscode.ExtensionContext) {
  const WIZARD_ID = 'holtek.ht32-config-vscode';
  const SUPPRESS_KEY = 'wizardInstallPromptDismissed';
  if (ctx.globalState.get<boolean>(SUPPRESS_KEY)) return;

  const showPrompt = () => {
    if (vscode.extensions.getExtension(WIZARD_ID)) return;
    vscode.window.showInformationMessage(
      'Holtek Configuration Wizard is not installed. It provides a visual editor for HT32 config files (conf.h, system_ht32.c, startup.s…).',
      'Install',
      'Don\'t show again'
    ).then(sel => {
      if (sel === 'Install') {
        vscode.commands.executeCommand('workbench.extensions.installExtension', WIZARD_ID)
          .then(undefined, () => {
            vscode.window.showWarningMessage(
              'Could not install Holtek Configuration Wizard from Marketplace. Please install the .vsix manually.'
            );
          });
      } else if (sel === 'Don\'t show again') {
        ctx.globalState.update(SUPPRESS_KEY, true);
      }
    });
  };

  const run = () => {
    // Use onDidChange to wait for all extensions to finish loading after trust is granted.
    // This avoids a false-negative where getExtension() returns undefined during the brief
    // window between activation and extension host fully populating the extensions list.
    const sub = vscode.extensions.onDidChange(() => {
      if (vscode.extensions.getExtension(WIZARD_ID)) { sub.dispose(); }
    });
    ctx.subscriptions.push(sub);
    // Fallback timeout: if no extension change fires within 3 s, check and prompt if needed.
    setTimeout(() => { sub.dispose(); showPrompt(); }, 3000);
  };

  // In Restricted Mode other extensions are disabled, so getExtension() returns undefined
  // even if the wizard is installed. Wait until the workspace is trusted before running.
  if (vscode.workspace.isTrusted) {
    run();
  } else {
    const trustSub = vscode.workspace.onDidGrantWorkspaceTrust(() => {
      trustSub.dispose();
      run();
    });
    ctx.subscriptions.push(trustSub);
  }
}

/** Populate the Problems panel with prebuilt-binary warnings. */
function applyPrebuiltDiagnostics(warnings: { file: string; projName: string }[]) {
  prebuiltDiagCollection.clear();
  if (!warnings.length) { return; }
  const diagMap = new Map<string, vscode.Diagnostic[]>();
  for (const { file: absPath, projName } of warnings) {
    const uri = vscode.Uri.file(absPath);
    const projSuffix = projName ? ` Add equivalent .a to project: ${projName}` : '';
    const diag = new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 0),
      `Prebuilt binary skipped — Keil-compiled, not usable by GNU toolchain.${projSuffix}`,
      vscode.DiagnosticSeverity.Warning
    );
    diag.source = 'HT32 Convert';
    const key = uri.toString();
    if (!diagMap.has(key)) { diagMap.set(key, []); }
    diagMap.get(key)!.push(diag);
  }
  for (const [uriStr, diags] of diagMap) {
    prebuiltDiagCollection.set(vscode.Uri.parse(uriStr), diags);
  }
  logInfo(`Prebuilt warnings set in Problems panel: ${warnings.length} file(s)`);
}

/** Populate the Problems panel with general conversion warnings (device not found, missing paths, etc.) */
function applyConvertDiagnostics(entries: { message: string; file: string; line?: number; col?: number; len?: number }[]) {
  convertDiagCollection.clear();
  if (!entries.length) { return; }
  const diagMap = new Map<string, vscode.Diagnostic[]>();
  for (const e of entries) {
    const ln  = e.line ?? 0;
    const col = e.col  ?? 0;
    const endCol = (e.len !== undefined) ? col + e.len : Number.MAX_SAFE_INTEGER;
    const diag = new vscode.Diagnostic(
      new vscode.Range(ln, col, ln, endCol),
      e.message,
      vscode.DiagnosticSeverity.Warning
    );
    diag.source = 'HT32 Convert';
    const key = vscode.Uri.file(e.file).toString();
    if (!diagMap.has(key)) { diagMap.set(key, []); }
    diagMap.get(key)!.push(diag);
  }
  for (const [uriStr, diags] of diagMap) {
    convertDiagCollection.set(vscode.Uri.parse(uriStr), diags);
  }
  logInfo(`Convert warnings set in Problems panel: ${entries.length}`);
}

/** ====== helpers ====== */
/** Show a centered WebviewPanel input dialog. Returns the entered string, or undefined if cancelled. */
function showInputDialog(opts: {
  title: string;
  prompt: string;
  value: string;
  placeHolder?: string;
}): Promise<string | undefined> {
  return new Promise(resolve => {
    const panel = vscode.window.createWebviewPanel(
      'ht32InputDialog', opts.title, vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false },
    );
    let resolved = false;
    const done = (v: string | undefined) => { if (!resolved) { resolved = true; resolve(v); } };

    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  body { display:flex; align-items:center; justify-content:center; height:100vh; margin:0;
         background:var(--vscode-editor-background); color:var(--vscode-foreground);
         font-family:var(--vscode-font-family); font-size:var(--vscode-font-size); }
  .card { background:var(--vscode-editorWidget-background);
          border:1px solid var(--vscode-editorWidget-border,#454545);
          border-radius:6px; padding:24px 28px; width:380px; box-shadow:0 4px 20px #0006; }
  h2 { margin:0 0 8px; font-size:1.1em; font-weight:600; }
  p  { margin:0 0 14px; color:var(--vscode-descriptionForeground); font-size:.9em; }
  input { width:100%; box-sizing:border-box; padding:5px 8px;
          background:var(--vscode-input-background); color:var(--vscode-input-foreground);
          border:1px solid var(--vscode-input-border,#3c3c3c); border-radius:3px;
          font-size:1em; outline:none; }
  input:focus { border-color:var(--vscode-focusBorder,#007fd4); }
  .row { display:flex; justify-content:flex-end; gap:8px; margin-top:16px; }
  button { padding:5px 16px; border:none; border-radius:3px; cursor:pointer; font-size:.9em; }
  #ok  { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
  #ok:hover  { background:var(--vscode-button-hoverBackground); }
  #cancel { background:var(--vscode-button-secondaryBackground,#3a3d41);
             color:var(--vscode-button-secondaryForeground,#ccc); }
  #cancel:hover { background:var(--vscode-button-secondaryHoverBackground,#45494e); }
</style></head><body>
<div class="card">
  <h2>${esc(opts.title)}</h2>
  <p>${esc(opts.prompt)}</p>
  <input id="inp" type="text" value="${esc(opts.value)}" placeholder="${esc(opts.placeHolder ?? opts.value)}" autofocus />
  <div class="row"><button id="cancel">Cancel</button><button id="ok">OK</button></div>
</div>
<script>
  const vscode = acquireVsCodeApi();
  const inp = document.getElementById('inp');
  inp.select();
  const submit = () => vscode.postMessage({ type: 'ok', value: inp.value.trim() || inp.placeholder });
  document.getElementById('ok').addEventListener('click', submit);
  document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') vscode.postMessage({ type: 'cancel' }); });
  inp.focus();
</script></body></html>`;

    vscode.commands.executeCommand('workbench.action.maximizeEditorGroup');

    panel.webview.onDidReceiveMessage(msg => {
      done(msg.type === 'ok' ? msg.value : undefined);
      panel.dispose();
    });
    panel.onDidDispose(() => {
      vscode.commands.executeCommand('workbench.action.evenEditorWidths');
      done(undefined);
    });
  });
}

async function withProgress<T>(title: string, task: () => Promise<T> | T): Promise<T | undefined> {
  logInfo(`Progress: ${title}`);
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async () => {
    try {
      const r = await task();
      logInfo(`Progress done: ${title}`);
      return r;
    } catch (err: any) {
      const msg = err?.message || String(err);
      logError(`${title} failed: ${msg}`);
      vscode.window.showErrorMessage(msg);
      return undefined;
    }
  });
}

function exec(cmd: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
  const shellPath = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
  const options: ExecOptions & { encoding: 'utf8' } = { cwd, shell: shellPath, encoding: 'utf8' };
  logInfo(`$ ${cmd}`);
  return new Promise((resolve, reject) => {
    cpExec(cmd, options, (err: ExecException | null, stdout: string, stderr: string) => {
      if (stdout) CHANNEL.appendLine(stdout);
      if (stderr) CHANNEL.appendLine(stderr);
      if (err) {
        logError(`Command failed: ${cmd}`);
        return reject(new Error(`Command failed: ${cmd}\n${stderr || err.message}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

async function pickFile(globLabel: string, exts: string | string[]): Promise<string | undefined> {
  const filters: Record<string, string[]> = {};
  filters[globLabel] = Array.isArray(exts) ? exts : [exts];
  const pick = await vscode.window.showOpenDialog({ canSelectMany: false, filters });
  return pick?.[0]?.fsPath;
}
function ensureDir(fileOrDir: string) {
  const dir = fileOrDir.endsWith(path.sep) ? fileOrDir : path.dirname(fileOrDir);
  fs.mkdirSync(dir, { recursive: true });
}
function writeJsonPretty(file: string, obj: unknown) {
  ensureDir(file);
  const rel = file.replace(/\\/g, '/').split('/').slice(-2).join('/');
  logInfo(`Write → ${rel}`);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}
function setContextHasProject(val: boolean) {
  vscode.commands.executeCommand('setContext', 'ht32.hasProject', val);
}

async function runTask(label: string) {
  const tasks = await vscode.tasks.fetchTasks();
  const t = tasks.find(t => t.name === label || (t as any).detail === label || (t as any).definition?.label === label);
  if (!t) {
    vscode.window.showErrorMessage(`Task "${label}" not found. Generate tasks.json first.`);
    return;
  }
  await vscode.tasks.executeTask(t);
}

const HT32_VSCODE_DIRNAME = 'HT32_VSCode';

const BG_BASE     = 'Project';
const BG_BASE_OLD = 'build-gen';   // kept for sort priority in existing old-layout dirs

/** bg dir → config name suffix（與 generateTasksAndLaunchAndMakefile 內的 bgSuffix 邏輯相同） */
function bgDirSuffix(dir: string): string {
  const m = dir.match(/^(?:Project_|build-gen-)(\w+)$/);
  if (m) return m[1].toUpperCase();
  if (dir === BG_BASE || dir === BG_BASE_OLD) return '';
  return dir.toUpperCase();
}

/** config name "(SUFFIX)" → bg dir name; falls back to BG_BASE if no suffix or not found */
function bgDirFromConfigName(configName: string, bgParentDir: string): string {
  const m = configName.match(/\(([^)]+)\)$/);
  const suffix = m ? m[1] : '';
  if (!fs.existsSync(bgParentDir)) return BG_BASE;
  const found = fs.readdirSync(bgParentDir).find(d =>
    isBgDir(bgParentDir, d) && bgDirSuffix(d) === suffix
  );
  return found ?? BG_BASE;
}

/** A directory is a bgDir if it contains project.meta.json. */
function isBgDir(parentDir: string, d: string): boolean {
  try {
    return fs.statSync(path.join(parentDir, d)).isDirectory() &&
           fs.existsSync(path.join(parentDir, d, 'project.meta.json'));
  } catch { return false; }
}

function currentWsRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Parent directory for all project dirs (Project, Project_xxx, …).
 *  Layout: workspaceFolder IS HT32_VSCode/ → Project dirs sit directly inside it. */
function bgParent(root: string): string {
  if (path.basename(root).toLowerCase() === HT32_VSCODE_DIRNAME.toLowerCase()) return root;
  return path.join(root, HT32_VSCODE_DIRNAME);
}

/** VS Code workspace root to open after conversion.
 *  New layout: HT32_VSCode/ (inside project root).
 *  Old layout: project root itself. */
function computeWsOpenRoot(root: string): string {
  const bp = bgParent(root);
  return path.basename(bp).toLowerCase() === HT32_VSCODE_DIRNAME.toLowerCase() ? bp : root;
}

/**
 * Checks whether the stored adapter serial for bgDir is still connected.
 * If stale: clears adapterSerial in project.settings.json, regenerates tasks/launch
 * so the files are clean for future runs, shows a warning, and returns false.
 * Returns true when serial is empty (auto-detect) or the adapter is present.
 */
async function ensureAdapterSerialFresh(bgDir: string, wsRoot: string): Promise<boolean> {
  const projSettings = readProjectSettings(bgDir);
  const serial = projSettings.adapterSerial?.trim();
  if (!serial) return true;

  const adapters = await scanAdapters(projSettings.debugInterface ?? 'CMSIS-DAP');
  if (adapters.some(a => a.serial === serial)) return true;

  writeProjectSettings(bgDir, { ...projSettings, adapterSerial: '' });
  await generateTasksAndLaunchAndMakefile(wsRoot);
  return false;
}

/** Build / Clean 按鈕的智慧路由：
 *  - 只有一個 build-gen → 直接執行
 *  - 多個 build-gen    → QuickPick 讓使用者選擇
 */
async function smartRunTask(kind: 'build' | 'clean' | 'download') {
  const root = currentWsRoot();
  if (!root) { vscode.window.showErrorMessage('No workspace folder open.'); return; }

  let bgDirs: string[] = [];
  try {
    const parent  = bgParent(root);
    const activeBg = vscode.workspace.getConfiguration('ht32').get<string>('activeBuildGen') || '';
    const projectOrder = readProjectOrder(parent);
    const allowedBgs = projectOrder ? new Set(projectOrder) : undefined;
    bgDirs = fs.readdirSync(parent)
      .filter(d =>
        isBgDir(parent, d) &&
        fs.existsSync(path.join(parent, d, 'Makefile')) &&
        (!activeBg || d === activeBg) &&
        (!allowedBgs || allowedBgs.has(d)));
    if (projectOrder) {
      const orderMap = new Map(projectOrder.map((p, i) => [p, i]));
      bgDirs.sort((a, b) => (orderMap.get(a) ?? 9999) - (orderMap.get(b) ?? 9999) || a.localeCompare(b));
    } else {
      bgDirs.sort((a, b) => (a === BG_BASE || a === BG_BASE_OLD) ? -1 : (b === BG_BASE || b === BG_BASE_OLD) ? 1 : a.localeCompare(b));
    }
  } catch (e: any) {
    logError(`Failed to read project list: ${e?.message ?? e}`);
  }

  if (bgDirs.length === 0) {
    vscode.window.showErrorMessage('No Project directory found. Convert a project first.');
    return;
  }

  const suf           = bgDirSuffix;
  const buildLabel    = (d: string) => { const s = suf(d); return s ? `Build ${s}` : 'Build (make)'; };
  const cleanLabel    = (d: string) => { const s = suf(d); return s ? `Clean ${s}` : 'Clean'; };
  const downloadLabel = (d: string) => { const s = suf(d); return s ? `Download ${s}` : 'Download'; };
  const taskLabel     = (d: string) =>
    kind === 'build' ? buildLabel(d) : kind === 'clean' ? cleanLabel(d) : downloadLabel(d);

  if (kind === 'build') {
    const parent = bgParent(root);
    for (const d of bgDirs) {
      const bgPath = path.join(parent, d);
      const marker = path.join(bgPath, '.needs-rebuild');
      if (fs.existsSync(marker)) {
        const buildDir = path.join(bgPath, 'build');
        if (fs.existsSync(buildDir)) {
          try {
            fs.rmSync(buildDir, { recursive: true, force: true });
            logInfo(`Compiler flags changed → deleted ${buildDir} to force clean rebuild`);
          } catch (e) {
            logWarn(`Could not delete build dir: ${e}`);
          }
        }
        try { fs.unlinkSync(marker); } catch {}
      }
    }
  }

  if (bgDirs.length === 1) {
    if (kind === 'download') {
      await ensureAdapterSerialFresh(path.join(bgParent(root), bgDirs[0]), root);
    }
    await runTask(taskLabel(bgDirs[0]));
    return;
  }

  // 多個 Project → QuickPick
  const items: vscode.QuickPickItem[] = bgDirs.map(d => ({
    label:       taskLabel(d),
    description: (d === BG_BASE || d === BG_BASE_OLD) ? '(active project)' : ''
  }));
  if (kind === 'build') {
    items.push({ label: 'Build All', description: 'Build all projects in sequence' });
  }
  if (kind === 'clean') {
    items.push({ label: 'Clean All', description: 'Clean all projects in sequence' });
  }

  const placeHolder = kind === 'build' ? 'Select project to build' : kind === 'clean' ? 'Select project to clean' : 'Select project to download';
  const sel = await vscode.window.showQuickPick(items, { placeHolder });
  if (!sel) return;
  if (kind === 'download') {
    const selectedBg = bgDirs.find(d => taskLabel(d) === sel.label);
    if (selectedBg) {
      await ensureAdapterSerialFresh(path.join(bgParent(root), selectedBg), root);
    }
  }
  await runTask(sel.label);
}

/** TreeView 選到 project node 時，更新 settings.json 的 --compile-commands-dir 並重啟 clangd。
 *  相同路徑直接略過，避免不必要的重啟。 */
function setClangdIntelliSenseProject(root: string, bgName: string) {
  let changed = false;
  // 更新 .clangd 的 CompilationDatabase（可能未存在，non-critical）
  try {
    const destPath = path.join(root, '.clangd');
    if (fs.existsSync(destPath)) {
      const current = fs.readFileSync(destPath, 'utf8');
      if (!current.includes(`CompilationDatabase: ${bgName}`)) {
        const updated = current.replace(/CompilationDatabase:\s*.+/, `CompilationDatabase: ${bgName}`);
        if (updated !== current) { fs.writeFileSync(destPath, updated); changed = true; }
      }
    }
  } catch { /* non-critical */ }
  // 更新 settings.json 的 --compile-commands-dir（關鍵：clangd 靠此找 compile_commands.json）
  try {
    const settingsPath = path.join(root, '.vscode', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const args: string[] = Array.isArray(settings['clangd.arguments']) ? settings['clangd.arguments'] : [];
      const newArgs = args.map((a: string) => {
        if (!a.startsWith('--compile-commands-dir=')) return a;
        // 只替換最後一段路徑（bgDir 名稱），保留 ${workspaceFolder} 等前綴
        return a.replace(/\/[^/]+$/, `/${bgName}`);
      });
      if (JSON.stringify(newArgs) !== JSON.stringify(args)) {
        settings['clangd.arguments'] = newArgs;
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        changed = true;
      }
    }
  } catch { /* non-critical */ }
  if (changed) {
    setTimeout(() => vscode.commands.executeCommand('clangd.restart').then(undefined, () => {}), 100);
  }
}

/** 在 workspace root（HT32_VSCode/）內產出 .clangd。
 *  clangd 從 source file 往上找時會在 workspace root 找到，CompilationDatabase 路徑
 *  相對於此檔案位置，不含 HT32_VSCode/ 前綴，避免與 workspace root 解析衝突。
 *  gccPath 由呼叫端從 resolveToolchain 取得後傳入，推算 toolchain root 取得 isystem flags。 */
function ensureClangdAtProjectRoot(root: string, bgName?: string, gccPath?: string) {
  try {

    const isystemFlags: string[] = [];
    if (gccPath && fs.existsSync(gccPath)) {
      const toolchainRoot = path.dirname(path.dirname(gccPath));
      const newlibInc = path.join(toolchainRoot, 'arm-none-eabi', 'include').replace(/\\/g, '/');
      if (fs.existsSync(newlibInc)) { isystemFlags.push(`-isystem${newlibInc}`); }
      const gccLibBase = path.join(toolchainRoot, 'lib', 'gcc', 'arm-none-eabi');
      if (fs.existsSync(gccLibBase)) {
        const versions = fs.readdirSync(gccLibBase).sort(semverCmp);
        const ver = versions[versions.length - 1];  // newest
        if (ver) {
          const inc = path.join(gccLibBase, ver, 'include').replace(/\\/g, '/');
          if (fs.existsSync(inc)) { isystemFlags.push(`-isystem${inc}`); }
          const incFixed = path.join(gccLibBase, ver, 'include-fixed').replace(/\\/g, '/');
          if (fs.existsSync(incFixed)) { isystemFlags.push(`-isystem${incFixed}`); }
        }
      }
    }

    const lines = [
      'CompileFlags:',
      `  CompilationDatabase: ${bgName ?? '.vscode'}`,
      '  Add:',
      '    - --target=arm-none-eabi',
      ...isystemFlags.map(f => `    - ${f}`),
      'Diagnostics:',
      '  UnusedIncludes: None',
      '  ClangTidy:',
      '    Remove:',
      '      - readability-misleading-indentation',
    ];
    const destPath = path.join(root, '.clangd');
    const newContent = lines.join('\n') + '\n';
    const existed = fs.existsSync(destPath);
    logInfo(`Write → .clangd`);
    fs.writeFileSync(destPath, newContent);
    // 第一次產出時 clangd 已經啟動卻找不到 .clangd，需要重啟讓它重新載入設定
    if (!existed) {
      setTimeout(() => {
        vscode.commands.executeCommand('clangd.restart').then(undefined, () => {});
      }, 2000);
    }
  } catch { /* non-critical */ }
}

/** 在 FWLib 根目錄寫入最小 .clangd（僅 UnusedIncludes: None）。
 *  只在尚無 .clangd 時寫入，不覆蓋使用者自訂設定。
 *  讓 clangd 解析 utilities/、libraries/ 等 FWLib 內的檔案時也套用相同診斷設定。 */
function ensureClangdAtFwlibRoot(fwlibRoot: string | undefined) {
  if (!fwlibRoot) return;
  try {
    const dest = path.join(fwlibRoot, '.clangd');
    if (fs.existsSync(dest)) return;
    const content = [
      'Diagnostics:',
      '  UnusedIncludes: None',
      '  ClangTidy:',
      '    Remove:',
      '      - readability-misleading-indentation',
    ].join('\n') + '\n';
    fs.writeFileSync(dest, content);
  } catch { /* non-critical */ }
}


interface ToolchainPaths {
  makePathFull: string | undefined;
  makeExe:      string;
  gccPath:      string | undefined;
  pyocdPath:    string | undefined;
}

/**
 * 解析 make / gcc / pyocd 路徑。
 * gcc 或 make 缺失時顯示單一 warning；使用者點選「Install via winget」後呼叫 onInstalled。
 * pyocd 只在 bgFullDirs 中有 serverType=pyocd 的專案時才檢查（自動安裝，不另外提示）。
 * 傳入空陣列 [] 可跳過 pyocd 檢查。
 */
let _toolchainInstallPromise: Promise<void> | undefined;

async function resolveToolchain(
  root: string,
  bgFullDirs: string[],
  onInstalled: () => Promise<void>
): Promise<ToolchainPaths> {
  const cfg             = vscode.workspace.getConfiguration('ht32');
  const makePathSetting = cfg.get<string>('makePath', '').trim();
  const makePathFull    = makePathSetting || await locateMake(extensionPath);
  const gccPath         = await locateArmGcc();

  if (!makePathFull || !gccPath) {
    _toolchainInstallPromise ??= (async () => {
      const missing = [!gccPath && 'arm-none-eabi-gcc', !makePathFull && 'GNU make'].filter(Boolean).join(', ');
      const sel = await vscode.window.showWarningMessage(
        `HT32: ${missing} not found. Build will not work until the toolchain is installed.`,
        'Install via winget'
      );
      if (sel) await ensureToolchain(root, extensionPath, async () => { await onInstalled(); });
    })().finally(() => { _toolchainInstallPromise = undefined; });
  }

  const makeExe = makePathFull ? path.basename(makePathFull).replace(/\.exe$/i, '') : 'make';

  const needsPyocd  = bgFullDirs.some(d => readProjectSettings(d).serverType === 'pyocd');
  const pyocdPath   = needsPyocd ? await findOrInstallPyocd(extensionPath) : undefined;

  return { makePathFull, makeExe, gccPath, pyocdPath };
}

/** FWLib bat 產生的模板專案：有 project.meta.json 但無 Makefile，
 *  從 meta + settings 自動產生 Makefile / sources.list / includes.list / defines.list / adefines.list / compile_commands.json。
 *  .vscode/ 由呼叫端在此之後呼叫 generateTasksAndLaunchAndMakefile() 產出。 */
async function initProjectsFromMeta(bgDirs: string[], wsRoot: string): Promise<void> {
  const gccFound = await locateArmGcc();
  const gcc = gccFound ?? 'arm-none-eabi-gcc';
  for (const bgDir of bgDirs) {
    try {
      // skip if Makefile is newer than both input files (settings/meta unchanged since last open)
      // also require all derived list files to exist — missing lists (e.g. after git clean)
      // must trigger regeneration even when mtime check would otherwise pass
      const makefilePath  = path.join(bgDir, 'Makefile');
      const settingsPath  = path.join(bgDir, 'project.settings.json');
      const metaPath      = path.join(bgDir, 'project.meta.json');
      if (fs.existsSync(makefilePath) && fs.existsSync(settingsPath) && fs.existsSync(metaPath)) {
        const makeMtime     = fs.statSync(makefilePath).mtimeMs;
        const settingsMtime = fs.statSync(settingsPath).mtimeMs;
        const metaMtime     = fs.statSync(metaPath).mtimeMs;
        const allListsExist = ['sources.list', 'includes.list', 'defines.list', 'adefines.list', 'compile_commands.json']
          .every(f => fs.existsSync(path.join(bgDir, f)));
        if (allListsExist && makeMtime > settingsMtime && makeMtime > metaMtime) { continue; }
      }

      const meta = readProjectMeta(bgDir);
      if (!meta) continue;
      const s = readProjectSettings(bgDir);

      // 1. 產生 Makefile（srcs 先空，refreshDerivedFiles 補 SRCS + compile rules）
      const linkerScripts = (meta.linkerScripts ?? ['../GNU_ARM/linker.ld']);
      const makeText = buildMakefileText({
        target:            s.targetName ?? path.basename(bgDir),
        cc:                gcc,
        mcu:               s.mcu ?? 'cortex-m3',
        srcs:              [],
        linkerScripts,
        isLibrary:         s.outputType === 'lib',
        fpu:               s.fpu,
        floatAbi:          s.floatAbi,
        optimizationLevel: s.optimizationLevel,
        debugInfo:         s.debugInfo,
        useNano:           s.useNano,
        useNosys:          s.useNosys,
        useLto:            s.useLto,
        printfFloat:       s.printfFloat,
        scanfFloat:        s.scanfFloat,
        gcSections:        s.gcSections,
        extraCFlags:       s.extraCFlags,
        extraLDFlags:      s.extraLDFlags,
        extraLibs:         s.extraLibs,
        extraLibNames:     s.extraLibNames,
        extraLibPaths:     s.extraLibPaths,
      });
      fs.writeFileSync(path.join(bgDir, 'Makefile'), makeText);

      // 2. 從 meta 更新 SRCS + sources.list + includes/defines/adefines.list + compile_commands.json
      //    （refreshDerivedFiles 內部已呼叫 regenerateMakefileFlags 寫三個 list 檔）
      refreshDerivedFiles(bgDir, meta, { skipElfInvalidation: true });

      // 3. 以 locateArmGcc() 的完整路徑（含 auto-detect）重寫 compile_commands.json，
      //    確保 -isystem 指向正確的 gcc header 目錄（refreshDerivedFiles 內部只讀 VS Code config）
      writeCCDbFromLists(bgDir, {
        gccFullPath: gcc ?? undefined,
        armCore:     s.mcu ?? 'cortex-m3',
        fpu:         s.fpu,
        floatAbi:    s.floatAbi,
        optimization: s.optimizationLevel,
        debugInfo:   s.debugInfo,
        gcSections:  s.gcSections,
      });
    } catch (e: any) { logError(`initProjectsFromMeta(${bgDir}): ${e?.message ?? e}`); }
    await new Promise<void>(r => setImmediate(r));
  }
}

/** 啟動/工作區變動時自動 attach 已轉換的專案，並聚焦到我們的 View */
async function autoAttachProjectFromWorkspace(ctx: vscode.ExtensionContext, tree: ProjectTreeProvider) {
  const folders = vscode.workspace.workspaceFolders || [];
  for (const f of folders) {
    const root = f.uri.fsPath;
    // 掃描 Project/ 和 Project_*（多專案支援）
    const parent = bgParent(root);
    const hasBuildGen = fs.existsSync(parent) && (() => {
      try {
        return fs.readdirSync(parent).some(d =>
          (isBgDir(parent, d) ||
           (fs.statSync(path.join(parent, d)).isDirectory() &&
            fs.existsSync(path.join(parent, d, 'compile_commands.json')))));
      } catch { return false; }
    })();
    if (hasBuildGen) {
      // 儘早設 loading state：讓 tree view 在背景工作完成前顯示 spinner
      setContextHasProject(true);
      tree.setLoading(true);
      // 從 project.meta.json sources 動態推算 FWLib root，產生 FWLib root .clangd
      try {
        const _names = (readProjectOrder(parent) ?? fs.readdirSync(parent)).filter(d => isBgDir(parent, d));
        const bgDirs = _names.map(d => path.join(parent, d));
        if (bgDirs.length) {
          const wsRoot = path.dirname(parent);
          const meta = readProjectMeta(bgDirs[0]);
          const anyLibSrc = Object.values(meta?.groups ?? {}).flat()
            .find(f => /[/\\](library|utilities)[/\\]/i.test(f));
          if (anyLibSrc) {
            const abs = path.isAbsolute(anyLibSrc) ? anyLibSrc : path.resolve(wsRoot, anyLibSrc);
            ensureClangdAtFwlibRoot(fwlRootFromSourcePath(abs));
          }
        }
      } catch { /* non-critical */ }
      // 每次開啟專案都重新產生 Makefile / sources.list / includes.list / defines.list / adefines.list
      // 確保與 project.meta.json + project.settings.json 保持一致
      try {
        const allBgNames = (readProjectOrder(parent) ?? fs.readdirSync(parent)).filter(d => {
          try {
            const p = path.join(parent, d);
            return fs.statSync(p).isDirectory() &&
              (fs.existsSync(path.join(p, 'project.meta.json')) ||
               fs.existsSync(path.join(p, 'project.settings.json')) ||
               fs.existsSync(path.join(p, 'compile_commands.json')));
          } catch { return false; }
        });

        const invalidErrors: string[] = [];
        const bgNames = allBgNames.filter(d => {
          const err = validateProjectFiles(path.join(parent, d));
          if (err) { invalidErrors.push(`${d}: ${err}`); logError(`[Open] ${d}: ${err}`); }
          return !err;
        });
        if (invalidErrors.length > 0 && bgNames.length > 0) {
          CHANNEL.show(true);
          vscode.window.showWarningMessage(`Skipped ${invalidErrors.length} invalid project(s). Check "HT32 VSCode" output for details.`);
        }
        if (bgNames.length === 0) {
          const _af = vscode.workspace.getConfiguration('ht32').get<string>('activeProjectFile');
          if (_af) {
            const _abs = path.isAbsolute(_af) ? _af : path.join(parent, _af);
            await removeRecentProject(ctx, _abs);
          }
          tree.setRoot(undefined);
          tree.refresh();
          tree.setLoading(false);
          setContextHasProject(false);
          await vscode.window.showErrorMessage(
            `Failed to open project: ${invalidErrors.join(' | ')}`,
            { modal: true }, 'OK'
          );
          await ctx.globalState.update('ht32.focusHt32OnActivate', true);
          await vscode.commands.executeCommand('workbench.action.closeFolder');
          return false;
        }

        setActiveBuildGenSetting(computeWsOpenRoot(root), null);

        const bgDirsAll = bgNames.map(d => path.join(parent, d));
        await initProjectsFromMeta(bgDirsAll, root);
        const gccP = await locateArmGcc();
        writeMakefileToolsSettings(root, bgNames, gccP ?? undefined);
        await generateTasksAndLaunchAndMakefile(root, { regenMakefile: false });

        const _activeFile = vscode.workspace.getConfiguration('ht32').get<string>('activeProjectFile');
        if (_activeFile) {
          const _ht32wsAbs = path.isAbsolute(_activeFile) ? _activeFile : path.join(parent, _activeFile);
          if (fs.existsSync(_ht32wsAbs)) { await addRecentProject(ctx, _ht32wsAbs); }
        }
      } catch (e: any) {
        logError(`initProjectsFromMeta failed: ${e?.message ?? e}`);
        tree.setLoading(false);
        return false;
      }
      tree.setRoot(root);
      await vscode.commands.executeCommand('setContext', 'ht32.hasProject', true);
      statusItem.show();
      tree.refresh();

      /*setTimeout(async () => {
        await ensureToolchain(root);
      }, 300); // 延遲 0.8 秒讓 View 載入完再跳窗
      */

      // 聚焦 HT32 panel。openFolder reload 路徑的早期 focus 由 ht32.focusHt32OnActivate flag 處理，
      // 這裡的 focus 是給 onDidChangeWorkspaceFolders（外部觸發）路徑補上，同時也作為 reload 路徑的確認。
      setTimeout(async () => {
        try { await vscode.commands.executeCommand(`workbench.view.extension.${CONTAINER_VIEW_ID}`); } catch {}
        try { await vscode.commands.executeCommand(`${PROJECT_VIEW_ID}.focus`); } catch {}
      }, 400);

      return true;
    }
  }
  statusItem.hide();
  return false;
}

/** 快速從 uvprojx XML 取 device name（轉換前用，不做完整解析） */
function quickParseDeviceName(uvprojxPath: string): string | undefined {
  try {
    const text = fs.readFileSync(uvprojxPath, 'utf8');
    return /<Device>([\w]+)<\/Device>/i.exec(text)?.[1];
  } catch { return undefined; }
}

/** 從 uvprojx 路徑推算 Project 目錄名稱（固定用 uvprojx 檔名，不含副檔名）
 *  例：calibration.uvprojx → 'calibration'，Project_12366.uvprojx → 'Project_12366'
 */
function buildGenDirName(uvprojxPath: string, _isMulti: boolean = false): string {
  return path.basename(uvprojxPath, '.uvprojx');
}

/** ====== Create Project ====== */
function createProjectCommand(ctx: vscode.ExtensionContext, tree: ProjectTreeProvider, treeView: vscode.TreeView<vscode.TreeItem>) {
  const defaultFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  openCreateProjectPanel(ctx, defaultFolder, async (result) => {
    const cpBgDir = path.join(computeWsOpenRoot(result.projectFolder), result.projectName);
    if (fs.existsSync(cpBgDir)) {
      const answer = await vscode.window.showWarningMessage(
        `"${cpBgDir}" already exists. The folder will be deleted and recreated. Continue?`,
        { modal: true },
        'Continue'
      );
      if (answer !== 'Continue') return;
      fs.rmSync(cpBgDir, { recursive: true, force: true });
    }
    await withProgress(`Create Project: ${result.projectName}`, async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      const cpCfg = vscode.workspace.getConfiguration('ht32-project-assistant');
      result.useNano  = cpCfg.inspect<boolean>('useNano')?.workspaceValue  ?? true;
      result.useNosys = cpCfg.inspect<boolean>('useNosys')?.workspaceValue ?? true;
      const generated   = await generateProjectFiles(result, extensionPath);
      const wsOpenRoot  = computeWsOpenRoot(result.projectFolder);
      // elfPath 格式為 "Project_49395/build/xxx.elf"，取第一段即 bgDirName
      const generatedBgDirName = generated.elfPath.split('/')[0] || BG_BASE;
      const cpBgDir = path.join(bgParent(wsOpenRoot), generatedBgDirName);
      const cpMeta  = readProjectMeta(cpBgDir);
      if (cpMeta) { persistMeta(cpBgDir, cpMeta, { skipElfInvalidation: true }); }

      await generateTasksAndLaunchAndMakefile(wsOpenRoot, {
        bgDirHint:      generatedBgDirName,
        elfPathHint:    generated.elfPath,
        deviceNameHint: generated.deviceName,
        mcuHint:        generated.mcu,
        ramOriginHint:  generated.ramOrigin,
        ramLengthHint:  generated.ramLength,
      });

      const cpProjFile = writeOrUpdateProjectFile(wsOpenRoot, [generatedBgDirName], generatedBgDirName);
      await addRecentProject(ctx, cpProjFile);

      const _curRoot = currentWsRoot();
      if (!_curRoot || path.resolve(_curRoot) !== path.resolve(wsOpenRoot)) {
        ctx.globalState.update('ht32.focusHt32OnActivate', true);
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wsOpenRoot));
      } else {
        // writeOrUpdateProjectFile already wrote activeProjectFile to settings.json — just refresh.
        tree.setRoot(wsOpenRoot);
        setContextHasProject(true);
        tree.refresh();
        statusItem.show();
        statusItem.text = `$(circuit-board) HT32: ${result.projectName}`;
        try { await tree.expandAll(treeView); } catch {}
      }
    });
  });
}

/** ====== Add New Project (Create + merge into current workspace) ====== */
function addNewProjectCommand(ctx: vscode.ExtensionContext, tree: ProjectTreeProvider, treeView: vscode.TreeView<vscode.TreeItem>) {
  const wsRoot = currentWsRoot();
  if (!wsRoot) { vscode.window.showErrorMessage('No workspace folder open.'); return; }
  const lockedFolder = path.dirname(wsRoot);
  openCreateProjectPanel(ctx, lockedFolder, async (result) => {
    // ── 若現有單一專案 .ht32vs，詢問升級為 Multi-Project ──
    const wsOpenRootPre = computeWsOpenRoot(lockedFolder);
    let multiProjSetup: { name: string; existingDir: string } | undefined;
    {
      const af = readActiveProjectFile(wsOpenRootPre);
      if (af) {
        const afPath = path.isAbsolute(af) ? af : path.join(wsOpenRootPre, af);
        const existing: string[] = parseHt32vsFile(afPath)?.projects ?? [];
        if (existing.length === 1) {
          const defaultName = path.basename(lockedFolder);
          const name = await showInputDialog({
            title: 'Multi-Project File Name',
            prompt: 'Enter a name for the multi-project file',
            value: defaultName,
            placeHolder: defaultName,
          });
          if (name === undefined) return;
          multiProjSetup = { name: name.trim() || defaultName, existingDir: existing[0] };
        }
      }
    }

    const addBgDir = path.join(wsOpenRootPre, result.projectName);
    if (fs.existsSync(addBgDir)) {
      const answer = await vscode.window.showWarningMessage(
        `"${addBgDir}" already exists. The folder will be deleted and recreated. Continue?`,
        { modal: true },
        'Continue'
      );
      if (answer !== 'Continue') return;
      fs.rmSync(addBgDir, { recursive: true, force: true });
    }

    await withProgress(`Add New Project: ${result.projectName}`, async () => {
      result.projectFolder = lockedFolder;
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      const cpCfg = vscode.workspace.getConfiguration('ht32-project-assistant');
      result.useNano  = cpCfg.inspect<boolean>('useNano')?.workspaceValue  ?? true;
      result.useNosys = cpCfg.inspect<boolean>('useNosys')?.workspaceValue ?? true;
      const generated          = await generateProjectFiles(result, extensionPath);
      const wsOpenRoot         = computeWsOpenRoot(result.projectFolder);
      const generatedBgDirName = generated.elfPath.split('/')[0] || BG_BASE;
      const cpBgDir2 = path.join(bgParent(wsOpenRoot), generatedBgDirName);
      const cpMeta2  = readProjectMeta(cpBgDir2);
      if (cpMeta2) { persistMeta(cpBgDir2, cpMeta2, { skipElfInvalidation: true }); }

      await generateTasksAndLaunchAndMakefile(wsOpenRoot, {
        bgDirHint:      generatedBgDirName,
        elfPathHint:    generated.elfPath,
        deviceNameHint: generated.deviceName,
        mcuHint:        generated.mcu,
        ramOriginHint:  generated.ramOrigin,
        ramLengthHint:  generated.ramLength,
      });

      let cpProjFile: string;
      if (multiProjSetup) {
        writeOrUpdateProjectFile(wsOpenRoot, [generatedBgDirName], generatedBgDirName);
        cpProjFile = writeOrUpdateProjectFile(wsOpenRoot, [multiProjSetup.existingDir, generatedBgDirName], multiProjSetup.name);
      } else {
        const activeFile = readActiveProjectFile(wsOpenRoot);
        const ht32wsName = activeFile ? path.basename(activeFile, '.ht32vs') : generatedBgDirName;
        cpProjFile = writeOrUpdateProjectFile(wsOpenRoot, [generatedBgDirName], ht32wsName);
      }
      await addRecentProject(ctx, cpProjFile);

      tree.setRoot(wsOpenRoot);
      setContextHasProject(true);
      tree.refresh();
      statusItem.show();
      statusItem.text = `$(circuit-board) HT32: ${result.projectName}`;
      try { await tree.expandAll(treeView); } catch {}
    });
  }, lockedFolder);
}

/** ====== Open Project ====== */
async function openProjectCommand(ctx: vscode.ExtensionContext, tree: ProjectTreeProvider) {
  const picks = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { 'HT32 Project': ['ht32vs'] },
    openLabel: 'Open HT32 Project',
  });
  if (!picks || !picks[0]) return;
  const ht32wsPath = picks[0].fsPath;
  await addRecentProject(ctx, ht32wsPath);
  await openHt32vsFile(ctx, tree, ht32wsPath);
}

/** Open a .ht32vs project file: set it as active and open the parent folder if needed. */
async function openHt32vsFile(ctx: vscode.ExtensionContext, tree: ProjectTreeProvider, ht32wsPath: string) {
  const bgParentDir = path.dirname(ht32wsPath);
  const fileName    = path.basename(ht32wsPath);
  const currentRoot = currentWsRoot();
  if (currentRoot && path.resolve(currentRoot) === path.resolve(bgParentDir)) {
    // Already in the right folder — write directly to settings.json (bypasses VS Code config API cache lag).
    const settingsPath = path.join(bgParentDir, '.vscode', 'settings.json');
    let settings: any = {};
    if (fs.existsSync(settingsPath)) { try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {} }
    settings['ht32.activeProjectFile'] = fileName;
    try { fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8'); } catch {}
    tree.refresh();
    vscode.commands.executeCommand('ht32ProjectView.focus');
  } else {
    // Write setting to settings.json before opening folder so it's ready on reload.
    const settingsPath = path.join(bgParentDir, '.vscode', 'settings.json');
    let settings: any = {};
    if (fs.existsSync(settingsPath)) {
      try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
    }
    settings['ht32.activeProjectFile'] = fileName;
    try {
      fs.mkdirSync(path.join(bgParentDir, '.vscode'), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    } catch {}
    ctx.globalState.update('ht32.focusHt32OnActivate', true);
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(bgParentDir));
  }
}

/** ====== Open Project Folder (legacy) ====== */
async function openProjectFolderCommand(ctx: vscode.ExtensionContext, tree: ProjectTreeProvider) {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Open HT32 Project',
  });
  if (!uris || uris.length === 0) { return; }

  const selected  = uris[0].fsPath;
  const baseName  = path.basename(selected);

  let wsRoot: string;
  let activeBg: string | null = null;  // null = show all

  if (fs.existsSync(path.join(selected, 'project.meta.json'))) {
    // 使用者選了 Project_xxx/ → 單一 variant（parent 必須是 HT32_VSCode/）
    const parentDir = path.dirname(selected);
    if (path.basename(parentDir).toLowerCase() !== HT32_VSCODE_DIRNAME.toLowerCase()) {
      vscode.window.showErrorMessage(`Not an HT32 project — "${baseName}" must be inside a ${HT32_VSCODE_DIRNAME} folder.`);
      return;
    }
    wsRoot = parentDir;
    activeBg = baseName;
  } else if (baseName.toLowerCase() === HT32_VSCODE_DIRNAME.toLowerCase() && hasBuildGenMeta(selected)) {
    // 使用者選了 HT32_VSCode/ → 它就是 workspace root
    wsRoot = selected;
  } else if (hasBuildGenMeta(path.join(selected, HT32_VSCODE_DIRNAME))) {
    // 使用者選了 project root（HT32_VSCode 在裡面）→ 開啟 HT32_VSCode 為 workspace
    wsRoot = path.join(selected, HT32_VSCODE_DIRNAME);
  } else {
    vscode.window.showErrorMessage(
      `Not an HT32 project — cannot find Project*/project.meta.json in "${baseName}"`
    );
    return;
  }

  // 寫入或清除 ht32.activeBuildGen（在開啟 workspace 之前就寫進 settings.json）
  setActiveBuildGenSetting(wsRoot, activeBg);
  // Open Folder 模式：清除 activeProjectFile，讓 TreeView 顯示 .vscode 而非舊 .ht32vs 名稱
  clearActiveProjectFileSetting(wsRoot);

  const current = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (current && path.resolve(current) === path.resolve(wsRoot)) {
    // 已在同一個 workspace — settings.json 已被 clearActiveProjectFileSetting 清掉，直接 re-attach
    await autoAttachProjectFromWorkspace(ctx, tree);
  } else {
    ctx.globalState.update('ht32.focusHt32OnActivate', true);
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wsRoot));
  }
}

/**
 * For multi-project HT32-IDE conversions: scan each project's C sources for
 * `asm(".incbin \"../../name.bin\"")` inline assembly directives (HT32 IAP pattern).
 * When a referenced binary matches a sibling project's target name, append a Makefile
 * rule to the CONSUMER project so `make` automatically satisfies the dependency —
 * consistent with how uVision handles it (keil2gnu remaps the path in the generated .s).
 *
 * Example: Src_AP/iap.c has  asm(".incbin \"../../IAP.bin\"");
 *   → producer = Project_IAP, output = Project_IAP/build/IAP.bin
 *   → appends to Project_AP/Makefile:
 *       ../../IAP.bin: ../Project_IAP/build/IAP.bin
 *           @cmd /c copy /Y "$<" "$@"
 *       all: ../../IAP.bin
 */
function autoDetectIncbinDeps(
  projects: Array<{ bgDir: string; projectName: string }>
): { message: string; file: string }[] {
  const warnings: { message: string; file: string }[] = [];

  // Match .incbin "../../something.bin" inside C asm strings (quotes may be backslash-escaped)
  const INCBIN_RE = /\.incbin\s+\\?"((?:\.\.\/)+[^"\\]+\.bin)\\?"/gi;

  for (const { bgDir } of projects) {
    const sourcesListPath = path.join(bgDir, 'sources.list');
    if (!fs.existsSync(sourcesListPath)) continue;

    for (const line of fs.readFileSync(sourcesListPath, 'utf8').split('\n')) {
      const srcRel = line.trim();
      if (!srcRel || !/\.c$/i.test(srcRel)) continue;
      const srcAbs = path.resolve(bgDir, srcRel);
      if (!fs.existsSync(srcAbs)) continue;

      let content: string;
      try { content = fs.readFileSync(srcAbs, 'utf8'); } catch { continue; }

      INCBIN_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = INCBIN_RE.exec(content)) !== null) {
        const incbinRel = m[1];  // e.g. "../../IAP.bin"
        const binName   = path.basename(incbinRel);  // "IAP.bin"
        const msg = `${path.basename(srcAbs)} embeds \`${binName}\` via .incbin — ensure ${binName} is built and placed at \`${incbinRel}\` relative to the build directory before building this project.`;
        warnings.push({ message: msg, file: srcAbs });
        logInfo(`autoDetectIncbinDeps: warning emitted for ${path.basename(srcAbs)} → ${binName}`);
      }
    }
  }

  return warnings;
}

/** 檢查 parentDir 下是否有任何 Project(_xxx)?/project.meta.json（或舊版 build-gen） */
function hasBuildGenMeta(vscodeDir: string): boolean {
  if (!fs.existsSync(vscodeDir)) { return false; }
  try {
    return fs.readdirSync(vscodeDir).some(d => isBgDir(vscodeDir, d));
  } catch { return false; }
}

/** 寫入或清除 .vscode/settings.json 的 ht32.activeBuildGen */
function setActiveBuildGenSetting(wsRoot: string, bgDirName: string | null): void {
  const settingsPath = path.join(wsRoot, '.vscode', 'settings.json');
  let data: any = {};
  if (fs.existsSync(settingsPath)) {
    try { data = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
  }
  if (bgDirName) {
    data['ht32.activeBuildGen'] = bgDirName;
  } else {
    delete data['ht32.activeBuildGen'];
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2));
}

/** 直接從 settings.json 讀取 ht32.activeProjectFile，繞過 VS Code config API cache。 */
function readActiveProjectFile(bgParentDir: string): string | undefined {
  try {
    const settingsPath = path.join(computeWsOpenRoot(bgParentDir), '.vscode', 'settings.json');
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return data['ht32.activeProjectFile'] || undefined;
  } catch { return undefined; }
}

/** 讀取並解析 .ht32vs 檔案，相容 trailing comma；失敗時回傳 undefined 並呼叫 onError。 */
function parseHt32vsFile(filePath: string, onError?: (e: Error) => void): { projects: string[] } | undefined {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw.replace(/,\s*([}\]])/g, '$1'));
  } catch (e) {
    onError?.(e instanceof Error ? e : new Error(String(e)));
    return undefined;
  }
}

/** 從 active .ht32vs 讀取 projects[] 順序陣列；無 .ht32vs 時回傳 undefined。 */
function readProjectOrder(bgParentDir: string): string[] | undefined {
  const activeFile = readActiveProjectFile(bgParentDir);
  if (!activeFile) return undefined;
  const ht32wsPath = path.isAbsolute(activeFile) ? activeFile : path.join(bgParentDir, activeFile);
  const ws = parseHt32vsFile(ht32wsPath, () =>
    vscode.window.showWarningMessage(
      `HT32: "${path.basename(ht32wsPath)}" 格式錯誤，無法解析，將顯示所有專案。請檢查 JSON 格式是否正確。`
    )
  );
  if (ws && Array.isArray(ws.projects) && ws.projects.length > 0) {
    return ws.projects.filter((p: unknown): p is string => typeof p === 'string');
  }
  return undefined;
}

/** 清除 .vscode/settings.json 的 ht32.activeProjectFile（Open Folder 模式用） */
function clearActiveProjectFileSetting(wsRoot: string): void {
  const settingsPath = path.join(wsRoot, '.vscode', 'settings.json');
  if (!fs.existsSync(settingsPath)) { return; }
  let data: any = {};
  try { data = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { return; }
  delete data['ht32.activeProjectFile'];
  try { fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2)); } catch {}
}

/** ====== Convert: uVision (built-in uv2make) ====== */
async function convertUvision(ctx: vscode.ExtensionContext, tree: ProjectTreeProvider, treeView: vscode.TreeView<vscode.TreeItem>) {
  // ── 步驟 1：選檔案、解析 workspace（UI 操作在 progress 之外）──
  const picked = await pickFile('uVision Project / Workspace', ['uvprojx', 'uvmpw']);
  if (!picked) return;

  // toConvert：要轉換的 uvprojx 清單（含 isActive 資訊）
  let toConvert: Array<{ uvprojx: string; isActive: boolean }>;

  if (picked.toLowerCase().endsWith('.uvmpw')) {
    const projects = parseUvmpw(picked);
    if (projects.length === 0) {
      vscode.window.showErrorMessage('.uvmpw contains no <project> entries.');
      return;
    }

    toConvert = projects.map(p => ({
      uvprojx:  path.resolve(path.dirname(picked), p.relativePath),
      isActive: p.isActive
    }));
  } else {
    toConvert = [{ uvprojx: picked, isActive: true }];
  }

  // 計算 workspace root（以第一個專案的目錄推算）
  const firstUvDir = path.dirname(toConvert[0].uvprojx);
  const MDK_SUBDIR_RE = /^(mdk|keil|arm|mdk_arm|gnu_arm)/i;
  const root = MDK_SUBDIR_RE.test(path.basename(firstUvDir)) ? path.dirname(firstUvDir) : firstUvDir;
  // wsOpenRoot: ht32_vscode/ for new layout, project root for old layout (backward compat)
  const wsOpenRoot = computeWsOpenRoot(root);

  // ── 步驟 1.5：若現有單一專案 .ht32vs，詢問是否升級為 Multi-Project ──
  let uvMultiProjSetup: { name: string; existingDir: string } | undefined;
  if (toConvert.length === 1) {
    const af = readActiveProjectFile(bgParent(wsOpenRoot));
    if (af) {
      const afPath = path.isAbsolute(af) ? af : path.join(bgParent(wsOpenRoot), af);
      const existing: string[] = parseHt32vsFile(afPath)?.projects ?? [];
      if (existing.length === 1) {
        const defaultName = path.basename(path.dirname(bgParent(wsOpenRoot)));
        const name = await showInputDialog({
          title: 'Multi-Project File Name',
          prompt: 'Enter a name for the multi-project file',
          value: defaultName,
          placeHolder: defaultName,
        });
        if (name === undefined) return;
        uvMultiProjSetup = { name: name.trim() || defaultName, existingDir: existing[0] };
      }
    }
  }

  // ── 步驟 1.6：若 HT32_VSCode 已存在，詢問是否覆蓋 ──
  const ht32vsDirUv = bgParent(wsOpenRoot);
  if (fs.existsSync(ht32vsDirUv)) {
    const answer = await vscode.window.showWarningMessage(
      `"${ht32vsDirUv}" already exists. The folder will be deleted and recreated. Continue?`,
      { modal: true },
      'Continue'
    );
    if (answer !== 'Continue') return;
    fs.rmSync(ht32vsDirUv, { recursive: true, force: true });
  }

  // ── 步驟 2：執行轉換（帶 progress notification）──
  const uvDefaultWsName = path.basename(picked,
    picked.toLowerCase().endsWith('.uvmpw') ? '.uvmpw' : '.uvprojx');
  const allPrebuiltWarnings: { file: string; projName: string }[] = [];
  const allConvertWarnings: { message: string; file: string; line?: number; col?: number; len?: number }[] = [];
  await withProgress('Convert uVision (.uvprojx / .uvmpw)', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const cfg = vscode.workspace.getConfiguration('ht32');
    // Use inspect() so that package.json defaults are NOT treated as user-set values.
    // cfg.get('floatAbi') returns 'soft' (the default) even when the user never touched it,
    // which would suppress auto-detection from uvprojx. workspaceValue is only set when
    // the user has explicitly written the setting to settings.json.
    const cfgOpts = {
      cc:                'arm-none-eabi-gcc',
      floatAbi:          (cfg.inspect<string>('floatAbi')?.workspaceValue || undefined) as 'soft' | 'softfp' | 'hard' | undefined,
      fpu:               cfg.inspect<string>('fpu')?.workspaceValue || undefined,
      optimizationLevel: cfg.inspect<string>('optimizationLevel')?.workspaceValue || undefined,
      useNano:           cfg.inspect<boolean>('useNano')?.workspaceValue  ?? undefined,
      useNosys:          cfg.inspect<boolean>('useNosys')?.workspaceValue ?? undefined,
      extraCFlags:       cfg.inspect<string>('extraCFlags')?.workspaceValue || undefined,
      extraLDFlags:      cfg.inspect<string>('extraLDFlags')?.workspaceValue || undefined,
    };

    // 逐一轉換，記錄 active 專案的結果（供 launch.json 使用）
    // isMulti：uvmpw 多專案 OR 同目錄還有其他 .uvprojx（example 資料夾情境）
    const uvprojxDir = path.dirname(toConvert[0].uvprojx);
    const hasSiblingUvprojx = toConvert.length === 1 && (() => {
      try { return fs.readdirSync(uvprojxDir).filter(f => f.toLowerCase().endsWith('.uvprojx')).length > 1; }
      catch { return false; }
    })();
    const isMulti = toConvert.length > 1 || hasSiblingUvprojx;
    let activeResult: Awaited<ReturnType<typeof uv2make>> | undefined;
    let activeBgDir: string | undefined;

    // Pre-compute dirNames.
    // .uvmpw (toConvert.length > 1): filenames in a workspace are already filesystem-unique,
    //   so derive dirName from the uvprojx filename directly (no MCU lookup needed).
    // sibling uvprojx (hasSiblingUvprojx): files target different MCUs in the same folder,
    //   so use device name to distinguish them.
    const projDirNames = toConvert.map(proj =>
      buildGenDirName(proj.uvprojx, isMulti)
    );

    for (let pi = 0; pi < toConvert.length; pi++) {
      const proj    = toConvert[pi];
      const dirName = projDirNames[pi];
      const outDir = path.join(bgParent(root), dirName);
      const result = await uv2make({ uvprojx: proj.uvprojx, outDir, workspaceRoot: wsOpenRoot, extPath: extensionPath, ...cfgOpts });
      if (result.prebuiltWarnings?.length) {
        const projName = path.basename(proj.uvprojx, '.uvprojx');
        allPrebuiltWarnings.push(...result.prebuiltWarnings.map(f => ({ file: f, projName })));
      }
      if (result.conversionWarnings?.length) {
        for (const w of result.conversionWarnings) {
          allConvertWarnings.push({ message: w.message, file: w.file ?? proj.uvprojx, line: w.line, col: w.col, len: w.len });
        }
      }
      // 將 uv2make 解析出的值寫入 project.settings.json，與 HT32-IDE 路徑保持一致。
      // 必須同時寫入 fpu/floatAbi，否則 project.settings.json 建立後
      // readProjectSettings 就不再讀 workspace settings，導致 FPU 被重置為 'none'。
      if (result.includes) {
        const uvIsFirstConvert = !fs.existsSync(path.join(outDir, 'project.settings.json'));
        writeProjectSettings(outDir, {
          ...readProjectSettings(outDir),
          ...(uvIsFirstConvert ? { openocdDebugLevel: 1 } : {}),
          ...(result.fpu      && result.fpu !== 'none' ? { fpu:      result.fpu      } : {}),
          ...(result.floatAbi                           ? { floatAbi: result.floatAbi } : {}),
          includePaths: ['../GNU_ARM', ...(result.includes ?? [])],
          ...(result.defines?.length ? { cDefs: result.defines } : {}),
          // Pure assembly: disable newlib specs so webview reflects actual Makefile behaviour
          ...(result.hasCsrcs === false ? { useNano: false, useNosys: false } : {}),
        });
      }
      if (proj.isActive || !activeResult) {
        activeResult = result;
        activeBgDir  = dirName;
      }
    } // end for

    // Write .ht32vs before generateTasksAndLaunchAndMakefile so that Build All order matches TreeView order.
    let uvProjFile: string;
    if (uvMultiProjSetup) {
      writeOrUpdateProjectFile(bgParent(wsOpenRoot), [projDirNames[0]], projDirNames[0]);
      uvProjFile = writeOrUpdateProjectFile(bgParent(wsOpenRoot), [uvMultiProjSetup.existingDir, projDirNames[0]], uvMultiProjSetup.name);
    } else {
      uvProjFile = writeOrUpdateProjectFile(bgParent(wsOpenRoot), projDirNames, uvDefaultWsName);
    }
    await addRecentProject(ctx, uvProjFile);

    await generateTasksAndLaunchAndMakefile(wsOpenRoot, {
      bgDirHint:      activeBgDir,
      elfPathHint:    activeResult?.elfPath,
      deviceNameHint: activeResult?.deviceName,
      mcuHint:        activeResult?.mcu,
      ramOriginHint:  activeResult?.ramOrigin,
      ramLengthHint:  activeResult?.ramLength,
      spimFlmHint:    activeResult?.spimFlm,
    });
    runAfterBuildSync(wsOpenRoot);

    // Sync auto-detected floatAbi/fpu into settings.json so Settings WebView reflects
    // the actual Makefile values. Done after generateTasksAndLaunchAndMakefile (which creates
    // settings.json). Use direct file write — cfg.update() requires workspace to be open
    // but ensureWorkspaceAt hasn't been called yet.
    if (activeResult) {
      const settingsPath = path.join(wsOpenRoot, '.vscode', 'settings.json');
      try {
        const data: any = fs.existsSync(settingsPath)
          ? JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
          : {};
        let changed = false;
        // 有記錄用 project 值；兩者都沒記錄且是 M4 → 預設 hard + fpv4-sp-d16
        const isM4Uv = (activeResult.mcu || '').includes('cortex-m4');
        const hasAnyFpuInfo = activeResult.fpu !== undefined || activeResult.floatAbi !== undefined;
        const uvFpuWrite      = activeResult.fpu      ?? ((!hasAnyFpuInfo && isM4Uv) ? 'fpv4-sp-d16' : undefined);
        const uvFloatAbiWrite = activeResult.floatAbi ?? ((!hasAnyFpuInfo && isM4Uv) ? 'hard'         : undefined);
        if (uvFloatAbiWrite && data['ht32.floatAbi'] === undefined) {
          data['ht32.floatAbi'] = uvFloatAbiWrite;
          changed = true;
        }
        if (uvFpuWrite && data['ht32.fpu'] === undefined) {
          data['ht32.fpu'] = uvFpuWrite;
          changed = true;
        }
        if (changed) { fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2)); }
      } catch { /* non-critical */ }
    }

    // 更新當前 UI
    tree.setRoot(wsOpenRoot);
    setContextHasProject(true);
    tree.refresh();
    statusItem.show();
    statusItem.text = `$(circuit-board) HT32: converted ${toConvert.length} project(s)`;

    try { await tree.expandAll(treeView); } catch {}

    applyPrebuiltDiagnostics(allPrebuiltWarnings);
    applyConvertDiagnostics(allConvertWarnings);
    const _curRoot2 = currentWsRoot();
    const needsReload2 = !_curRoot2 || path.resolve(_curRoot2) !== path.resolve(wsOpenRoot);
    const hasAnyDiag2 = allPrebuiltWarnings.length > 0 || allConvertWarnings.length > 0;
    if (needsReload2) {
      if (allPrebuiltWarnings.length) {
        const pendingFile = path.join(bgParent(wsOpenRoot), '.ht32-prebuilt-warnings.json');
        try { fs.writeFileSync(pendingFile, JSON.stringify(allPrebuiltWarnings)); } catch {}
      }
      if (allConvertWarnings.length) {
        const pendingFile = path.join(bgParent(wsOpenRoot), '.ht32-convert-warnings.json');
        try { fs.writeFileSync(pendingFile, JSON.stringify(allConvertWarnings)); } catch {}
      }
    } else if (hasAnyDiag2) {
      setTimeout(() => vscode.commands.executeCommand('workbench.panel.markers.view.focus'), 300);
    }
    if (needsReload2) {
      ctx.globalState.update('ht32.focusHt32OnActivate', true);
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wsOpenRoot));
    }
  });
}

/** ====== Convert: HT32-IDE / Eclipse ====== */
async function convertHt32Ide(ctx: vscode.ExtensionContext, tree: ProjectTreeProvider, treeView: vscode.TreeView<vscode.TreeItem>) {
  // Multi-select: user can pick individual Project_* folders (Ctrl+click)
  // or a parent HT32-IDE/ folder (all Project_* children are auto-included).
  const picks = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles:   false,
    canSelectMany:    true,
    openLabel: 'Select HT32-IDE Project Folder(s)',
    title: 'Convert HT32-IDE Projects',
  });
  if (!picks || !picks.length) return;

  const isHt32IdeProject = (dir: string) =>
    fs.existsSync(path.join(dir, '.project')) && fs.existsSync(path.join(dir, '.cproject'));

  // singleParentExpansion: user selected ONE parent folder (not a Project_* itself) →
  // auto-expanded into sub-projects → each gets its own .ht32vs.
  // Any other case (multi-select, or direct Project_* selection) → merged .ht32vs.
  const singleParentExpansion = picks.length === 1 && !isHt32IdeProject(picks[0].fsPath);

  const projectDirs: string[] = [];
  for (const uri of picks) {
    const dir = uri.fsPath;
    if (isHt32IdeProject(dir)) {
      if (!projectDirs.includes(dir)) { projectDirs.push(dir); }
    } else {
      // Parent folder → collect all Project_* subdirs
      try {
        fs.readdirSync(dir)
          .filter(d => /^Project_/i.test(d))
          .map(d => path.join(dir, d))
          .filter(d => { try { return fs.statSync(d).isDirectory() && isHt32IdeProject(d); } catch { return false; } })
          .forEach(d => { if (!projectDirs.includes(d)) { projectDirs.push(d); } });
      } catch {}
    }
  }
  projectDirs.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));

  if (!projectDirs.length) {
    vscode.window.showErrorMessage(
      'No HT32-IDE projects found. Select a Project_* folder or a folder containing Project_* subdirectories.'
    );
    return;
  }

  // isMulti: more than one project, OR a single project that has siblings —
  // in either case each project gets its own build-gen-{suffix}/ directory.
  const isMulti = projectDirs.length > 1 || (() => {
    const ht32ideDir = path.dirname(projectDirs[0]);
    try {
      return fs.readdirSync(ht32ideDir).some(d =>
        d !== path.basename(projectDirs[0]) &&
        /^Project_/i.test(d) &&
        fs.statSync(path.join(ht32ideDir, d)).isDirectory()
      );
    } catch { return false; }
  })();

  // 若 HT32_VSCode 已存在，詢問是否覆蓋（以第一個 project 快速推算 wsRoot）
  try {
    const r0 = parseHt32IdeProject(projectDirs[0]);
    const wsRoot0 = computeHt32IdeWsRoot(projectDirs[0], r0.sources);
    const ht32vsDirIde = bgParent(computeWsOpenRoot(wsRoot0));
    if (fs.existsSync(ht32vsDirIde)) {
      const answer = await vscode.window.showWarningMessage(
        `"${ht32vsDirIde}" already exists. The folder will be deleted and recreated. Continue?`,
        { modal: true },
        'Continue'
      );
      if (answer !== 'Continue') return;
      fs.rmSync(ht32vsDirIde, { recursive: true, force: true });
    }
  } catch { /* 若 parse 失敗就跳過確認，讓後續 convert 正常報錯 */ }

  await withProgress('Convert HT32-IDE (.project/.cproject)', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    const cfg = vscode.workspace.getConfiguration('ht32');
    const gccPathSetting = cfg.get<string>('gccPath', '').trim();
    const gccPath = gccPathSetting || await locateArmGcc() || 'arm-none-eabi-gcc';

    let activeWsRoot: string | undefined;
    let activeDirName: string | undefined;
    let activeResult:  Ht32IdeConvertProjectResult | undefined;
    const ideConvertWarnings: { message: string; file: string; line?: number }[] = [];
    const convResults: { bgDir: string; projectName: string }[] = [];

    for (const projectDir of projectDirs) {
      const r = convertHt32IdeProject(projectDir, { extPath: extensionPath, gccPath });
      ideConvertWarnings.push(...r.warnings);
      convResults.push({ bgDir: r.bgDir, projectName: r.projectName });
      persistMeta(r.bgDir, r.meta);
      if (!activeWsRoot) {
        activeWsRoot  = r.wsRoot;
        activeDirName = r.dirName;
        activeResult  = r;
      }
    } // end for

    ideConvertWarnings.push(...autoDetectIncbinDeps(convResults));

    const ideWsOpenRoot = computeWsOpenRoot(activeWsRoot!);

    // Write .ht32vs before generateTasksAndLaunchAndMakefile so that Build All order matches TreeView order.
    // For multiple projects: write one .ht32vs per sub-project (each listing only itself),
    // then write (and activate) one merged .ht32vs listing all converted projects.
    if (convResults.length > 1) {
      for (const r of convResults) {
        const subName = path.basename(r.bgDir);
        // Not added to recent — the merged .ht32vs below is the single recent entry.
        writeOrUpdateProjectFile(bgParent(ideWsOpenRoot), [subName], subName);
      }
    }
    {
      const ideConvDirNames = convResults.map(r => path.basename(r.bgDir));
      const wsBaseName = (convResults.length === 1)
        ? path.basename(convResults[0].bgDir)
        : ((activeWsRoot ? path.basename(activeWsRoot) : '') || path.basename(path.dirname(projectDirs[0])) || 'HT32');
      const ideProjFile = writeOrUpdateProjectFile(bgParent(ideWsOpenRoot), ideConvDirNames, wsBaseName);
      await addRecentProject(ctx, ideProjFile);
    }

    await generateTasksAndLaunchAndMakefile(ideWsOpenRoot, {
      bgDirHint:      activeDirName,
      deviceNameHint: activeResult?.deviceName,
      mcuHint:        activeResult?.armCore,
      ramOriginHint:  activeResult?.ramOrigin,
      ramLengthHint:  activeResult?.ramLength,
    });
    runAfterBuildSync(ideWsOpenRoot);

    // Sync floatAbi/fpu into settings.json（同 uVision conversion 邏輯）
    if (activeResult) {
      const settingsPath = path.join(ideWsOpenRoot, '.vscode', 'settings.json');
      try {
        const data: any = fs.existsSync(settingsPath)
          ? JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
          : {};
        let changed = false;
        const isM4Active  = activeResult.armCore === 'cortex-m4';
        const fpuToWrite      = activeResult.fpuName || (isM4Active ? 'fpv4-sp-d16' : undefined);
        const floatAbiToWrite = activeResult.fpuName
          ? (activeResult.hardFloat ? 'hard' : 'softfp')
          : (isM4Active ? 'hard' : undefined);
        if (floatAbiToWrite && data['ht32.floatAbi'] === undefined) {
          data['ht32.floatAbi'] = floatAbiToWrite;
          changed = true;
        }
        if (fpuToWrite && data['ht32.fpu'] === undefined) {
          data['ht32.fpu'] = fpuToWrite;
          changed = true;
        }
        if (changed) { fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2)); }
      } catch { /* non-critical */ }
    }

    tree.setRoot(ideWsOpenRoot);
    setContextHasProject(true);
    tree.refresh();
    statusItem.show();
    statusItem.text = '$(circuit-board) HT32: HT32-IDE converted';

    try { await tree.expandAll(treeView); } catch {}

    applyConvertDiagnostics(ideConvertWarnings);
    const _curRoot3 = currentWsRoot();
    const needsReload3 = !_curRoot3 || path.resolve(_curRoot3) !== path.resolve(ideWsOpenRoot);
    if (ideConvertWarnings.length) {
      if (needsReload3) {
        const pendingFile = path.join(bgParent(ideWsOpenRoot), '.ht32-convert-warnings.json');
        try { fs.writeFileSync(pendingFile, JSON.stringify(ideConvertWarnings)); } catch {}
      } else {
        setTimeout(() => vscode.commands.executeCommand('workbench.panel.markers.view.focus'), 300);
      }
    }
    if (needsReload3) {
      ctx.globalState.update('ht32.focusHt32OnActivate', true);
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(ideWsOpenRoot));
    }
  });
}

/** ====== tasks.json & launch.json ====== */
function writeMakefileToolsSettings(root: string, bgDirs: string[], gccPath?: string) {
  const vscodeDir = path.join(root, '.vscode');
  const settingsPath = path.join(vscodeDir, 'settings.json');
  fs.mkdirSync(vscodeDir, { recursive: true });

  let data: any = {};
  if (fs.existsSync(settingsPath)) {
    try { data = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
  }

  const bgParentDir = bgParent(root);
  const bgRel = path.relative(root, bgParentDir).replace(/\\/g, '/');
  const primaryBg = bgDirs[0] ?? BG_BASE;
  data['makefile.configureOnOpen'] = false;
  data['cmake.configureOnOpen'] = false;
  data['cortex-debug.variableUseNaturalFormat'] = false;

  // clangd: compile-commands-dir 指向 active project 的 bgDir，確保 source files 在任何位置時
  // clangd 都能找到 compile_commands.json（source files 在 MDK_ARMv537/ 等 HT32_VSCode 的兄弟目錄）
  const ccDir = bgRel
    ? `\${workspaceFolder}/${bgRel}/${primaryBg}`
    : `\${workspaceFolder}/${primaryBg}`;
  const gccFull = gccPath ? gccPath.replace(/\\/g, '/') : undefined;
  const queryDriver = gccFull
    ? gccFull.replace(/arm-none-eabi-gcc(\.exe)?$/i, 'arm-none-eabi-*')
    : '**/arm-none-eabi-gcc*';
  data['clangd.arguments'] = [
    `--compile-commands-dir=${ccDir}`,
    `--query-driver=${queryDriver}`,
  ];
  // 禁用 C/C++ extension 的內建 IntelliSense，讓 clangd 接管跳轉與 include 解析
  // 若兩者並存，cpptools 會搶先接管，因為沒有 c_cpp_properties.json 所以 include 無法解析
  data['C_Cpp.intelliSenseEngine'] = 'disabled';

  // Auto-detect file encoding (Big5, Shift-JIS, …) — set as default, don't override if user changed it
  if (data['files.autoGuessEncoding'] === undefined) {
    data['files.autoGuessEncoding'] = true;
  }

  logInfo(`Write → ${path.join(path.basename(path.dirname(settingsPath)), path.basename(settingsPath)).replace(/\\/g, '/')}`);
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2));

}

async function generateTasksLaunchCommand(ctx: vscode.ExtensionContext) {
  // 優先使用已開啟的 workspace root，否則才跳 folder picker
  const wsFolder = currentWsRoot()
    ?? (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectMany: false }))?.[0]?.fsPath;
  if (!wsFolder) return;

  // Normalize to HT32_VSCode/ (new layout) or project root (old layout).
  // Matches the same logic as Convert uVision / HT32-IDE paths.
  const root = computeWsOpenRoot(wsFolder);

  await withProgress('Generate Build & Debug Config', async () => {
    await generateTasksAndLaunchAndMakefile(root);
    vscode.window.showInformationMessage('tasks.json & launch.json updated under .vscode/');
  });

  // Switch workspace to HT32_VSCode/ if needed (same as Convert flow)
  if (path.resolve(root) !== path.resolve(wsFolder)) {
    ctx.globalState.update('ht32.focusHt32OnActivate', true);
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root));
  }
}

/** bgDirs 掃描 + QuickPick 共用 helper（regenerateMakefile / regenerateCompileCommands 共用） */
async function pickBgDir(
  root: string,
  opts: { requireMakefile?: boolean; placeHolder?: string } = {}
): Promise<{ parent: string; chosen: string; bgDirs: string[] } | undefined> {
  const parent = bgParent(root);
  const projectOrder = readProjectOrder(parent);
  const allowedBgs = projectOrder ? new Set(projectOrder) : undefined;
  let bgDirs: string[] = [];
  try {
    bgDirs = fs.readdirSync(parent)
      .filter(d => isBgDir(parent, d)
                && (!opts.requireMakefile || fs.existsSync(path.join(parent, d, 'Makefile')))
                && (!allowedBgs || allowedBgs.has(d)));
    const orderMap = projectOrder ? new Map(projectOrder.map((p, i) => [p, i])) : undefined;
    bgDirs.sort((a, b) => ((orderMap?.get(a) ?? 9999) - (orderMap?.get(b) ?? 9999)) || a.localeCompare(b));
  } catch {}
  if (bgDirs.length === 0) { vscode.window.showErrorMessage('No Project directory found.'); return undefined; }
  let chosen = bgDirs[0];
  if (bgDirs.length > 1) {
    const picked = await vscode.window.showQuickPick(bgDirs, { placeHolder: opts.placeHolder ?? 'Select project' });
    if (!picked) return undefined;
    chosen = picked;
  }
  return { parent, chosen, bgDirs };
}

/** Regenerate compile_commands.json from sources.list / includes.list / defines.list */
async function regenerateCompileCommandsCommand() {
  const root = currentWsRoot();
  if (!root) { vscode.window.showErrorMessage('No workspace folder open.'); return; }

  const result = await pickBgDir(root, { requireMakefile: true, placeHolder: 'Select project to regenerate' });
  if (!result) return;
  const { parent, chosen, bgDirs } = result;

  const bgDir = path.join(parent, chosen);

  await withProgress('Regenerate compile_commands.json', async () => {
    const ps = readProjectSettings(bgDir);
    if (!ps.mcu) {
      vscode.window.showErrorMessage('MCU not set in project settings. Please configure the project first.'); return;
    }

    const gccPath = await locateArmGcc();
    writeCCDbFromLists(bgDir, {
      armCore:  ps.mcu,
      fpu:      ps.fpu || undefined,
      floatAbi: ps.floatAbi as any || undefined,
      optimization: 'Os',
      gccFullPath: gccPath ?? undefined,
      gcSections:  ps.gcSections,
    });

    writeMakefileToolsSettings(root, bgDirs, gccPath ?? undefined);

    vscode.window.showInformationMessage(`compile_commands.json regenerated for ${chosen}.`);
  });
}

/** Map debug interface setting → interface cfg absolute path */
function selectInterfaceCfg(debugInterface: string, openocdRoot: string): string {
  switch (debugInterface) {
    case 'ST-Link':      return `${openocdRoot}/scripts/interface/stlink.cfg`;
    case 'J-Link':       return `${openocdRoot}/scripts/interface/jlink.cfg`;
    case 'e-Link32 Pro':
    case 'e-Link32 Lite': return `${openocdRoot}/scripts/interface/htlink.cfg`;  // legacy values
    default:             return `${openocdRoot}/scripts/interface/cmsis-dap.cfg`;
  }
}

/**
 * Map MCU device name → HLM target cfg file (under openocd/scripts/target/).
 *
 * Scans scripts/target/ for device-specific HLM cfg files whose name suffix (after "HLM")
 * starts with a digit — these are device-family cfgs (HLM490x1.cfg, HLM491x3.cfg, HLM493x5.cfg…).
 * Matches by stripping the package suffix then testing with x→. wildcard
 * (e.g. HLM493x5.cfg suffix "493x5" → regex 493.5 → matches HT32F49395).
 * Falls back to HLMm3x.cfg for M3/M4/M7, HLMm0x.cfg for M0.
 */
function selectTargetCfg(extPath: string, mcu?: string, deviceName?: string): string {
  const stripped = (deviceName || '').replace(/_[^_]+$/, '');  // strip package suffix
  const targetDir = path.join(extPath, 'openocd', 'scripts', 'target');

  // Device-specific cfg: HLM[digit]*.cfg, match suffix with x→. wildcard against device name
  try {
    for (const f of fs.readdirSync(targetDir).sort()) {
      const m = /^HLM([0-9]\w*)\.cfg$/i.exec(f);
      if (!m) continue;
      const pat = new RegExp(m[1].replace(/x/gi, '.'), 'i');
      if (pat.test(stripped)) return `target/${f}`;
    }
  } catch {}

  // Core fallback
  const core = (mcu || '').toLowerCase();
  if (core.includes('m4') || core.includes('m7')) return 'target/HLMm4x.cfg';
  if (core.includes('m3'))                         return 'target/HLMm3x.cfg';
  return 'target/HLMm0x.cfg';
}

/**
 * Read IRAM1 size for a device from the bundled HT32_DFP PDSC.
 * Tries exact Dname match first, then strips package suffix (e.g. HT32F52341_48LQFP → HT32F52341).
 * Returns size in bytes, or undefined if not found.
 */
function readPdscIram1(deviceName: string, extPath: string, extraPdscPaths?: string[]): { start: number; size: number } | undefined {
  const parser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '',
    isArray: (name) => ['family', 'subFamily', 'device', 'memory'].includes(name),
  });
  const stripped = deviceName.replace(/_[^_]+$/, '');
  // Match exact name, stripped base, or package-suffixed variant (e.g. HT32F49041_20TSSOP when looking for HT32F49041)
  const matches  = (name: string) => name === deviceName || name === stripped || name.replace(/_[^_]+$/, '') === stripped;

  for (const pdscPath of getAllPdscPaths(extPath, extraPdscPaths)) {
    try {
      if (!_pdscRawCache.has(pdscPath)) { _pdscRawCache.set(pdscPath, fs.readFileSync(pdscPath, 'utf8')); }
      const doc      = parser.parse(_pdscRawCache.get(pdscPath)!);
      const families: any[] = doc?.package?.devices?.family ?? [];
      for (const fam of families) {
        for (const src of [fam, ...(fam.subFamily ?? [])]) {
          for (const dev of (src.device ?? [])) {
            if (!matches(dev.Dname ?? '')) continue;
            const iram1 = (dev.memory ?? []).find((m: any) => m.id === 'IRAM1');
            if (!iram1) continue;
            const start = parseInt(iram1.start);
            const size  = parseInt(iram1.size);
            if (!isNaN(start) && !isNaN(size) && size > 0) return { start, size };
          }
        }
      }
    } catch { /* PDSC missing or malformed — try next */ }
  }
  return undefined;
}

/**
 * Parse conf/Settings.ini (mirrors HT32-IDE plugin JAR structure).
 * Returns a map of deviceName (with or without package suffix) → workAreaSize bytes.
 * Key lookup: first tries full name (e.g. HT32F49395_100LQFP), then prefix (e.g. HT32F49395).
 */
function readSettingsIni(extPath: string): Record<string, number> {
  const iniPath = path.join(extPath, 'conf', 'Settings.ini');
  const result: Record<string, number> = {};
  try {
    const lines = fs.readFileSync(iniPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('[')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      const num = val.startsWith('0x') || val.startsWith('0X') ? parseInt(val, 16) : parseInt(val, 10);
      if (!isNaN(num)) result[key] = num;
    }
  } catch { /* file missing or unreadable — caller will fallback */ }
  return result;
}

/**
 * Get flash and option bytes address ranges for a device from PDSC.
 * Scans all DFP versions (union, newest first) via getAllPdscPaths().
 * Internal flash: first non-EXT, non-OPT algorithm entry.
 * Option bytes:   algorithm entry whose name contains "OPT".
 * Returns null if device not found in any PDSC.
 */
// Cache: pdscPath → raw XML string；同一 PDSC 檔案只讀一次，解析仍各自按需進行
const _pdscRawCache = new Map<string, string>();
// Cache: deviceName → parsed result；同一 device 只 parse 一次
// INVARIANT: extPath === extensionPath，在 activate() 中設定後 session 內不變，故 key 不含 extPath
const _mcuCfgResultCache = new Map<string, { flashStart: number; flashEnd: number; optStart: number; optEnd: number } | null>();
// Cache: `${deviceName}:${flashSizeBytes}` → FLM basename（同上 extPath invariant）
const _internalFlmCache = new Map<string, string | undefined>();

function parseMcuCfg(deviceName: string, extPath: string): {
  flashStart: number; flashEnd: number;
  optStart:   number; optEnd:   number;
} | null {
  if (_mcuCfgResultCache.has(deviceName)) return _mcuCfgResultCache.get(deviceName) ?? null;
  const stripped = deviceName.replace(/_[^_]+$/, '');
  const parser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '',
    isArray: (name) => ['family', 'subFamily', 'device', 'algorithm'].includes(name),
  });
  for (const pdscPath of getAllPdscPaths(extPath)) {
    try {
      if (!_pdscRawCache.has(pdscPath)) { _pdscRawCache.set(pdscPath, fs.readFileSync(pdscPath, 'utf8')); }
      const doc      = parser.parse(_pdscRawCache.get(pdscPath)!);
      const families: any[] = doc?.package?.devices?.family ?? [];
      for (const fam of families) {
        for (const subfam of [fam, ...(fam.subFamily ?? [])]) {
          for (const dev of (subfam.device ?? [])) {
            const dname: string = dev.Dname ?? '';
            // Match exact name, stripped base name, or dname's own base (for package-suffixed entries like HT32F49041_20TSSOP)
            if (dname !== deviceName && dname !== stripped && dname.replace(/_[^_]+$/, '') !== stripped) continue;
            const algos: any[] = [
              ...(dev.algorithm    ?? []),
              ...(subfam.algorithm ?? []),
              ...(fam.algorithm    ?? []),
            ];
            let flashStart: number | undefined, flashEnd: number | undefined;
            let optStart:   number | undefined, optEnd:   number | undefined;
            for (const algo of algos) {
              const algName: string = algo.name ?? '';
              if (/EXT_TYPE\d+_REAMP\d+/i.test(algName)) continue;  // skip SPIM
              const start = parseInt(algo.start);
              const size  = parseInt(algo.size);
              if (isNaN(start) || isNaN(size) || size <= 0) continue;
              if (/OPT/i.test(algName)) {
                if (optStart === undefined) { optStart = start; optEnd = start + size - 1; }
              } else if (flashStart === undefined) {
                flashStart = start; flashEnd = start + size - 1;
              }
            }
            if (flashStart !== undefined && flashEnd !== undefined) {
              const result = {
                flashStart, flashEnd,
                optStart: optStart ?? 0x1FF00000,
                optEnd:   optEnd   ?? 0x1FF00FFF,
              };
              _mcuCfgResultCache.set(deviceName, result);
              return result;
            }
          }
        }
      }
    } catch { /* malformed PDSC — try next */ }
  }
  _mcuCfgResultCache.set(deviceName, null);
  return null;
}

/**
 * Find the internal flash FLM for a given device + flash size from PDSC.
 * Scans all DFP versions (union, newest first) via getAllPdscPaths().
 * Returns FLM basename (e.g. "HT32F493x5_512.FLM"), or undefined if not found.
 */
function selectInternalFlm(deviceName: string, flashSizeBytes: number, extPath: string): string | undefined {
  const cacheKey = `${deviceName}:${flashSizeBytes}`;
  if (_internalFlmCache.has(cacheKey)) return _internalFlmCache.get(cacheKey);
  const stripped = deviceName.replace(/_[^_]+$/, '');
  const parser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '',
    isArray: (name) => ['family', 'subFamily', 'device', 'algorithm'].includes(name),
  });
  for (const pdscPath of getAllPdscPaths(extPath)) {
    try {
      if (!_pdscRawCache.has(pdscPath)) { _pdscRawCache.set(pdscPath, fs.readFileSync(pdscPath, 'utf8')); }
      const doc      = parser.parse(_pdscRawCache.get(pdscPath)!);
      const families: any[] = doc?.package?.devices?.family ?? [];
      for (const fam of families) {
        for (const subfam of [fam, ...(fam.subFamily ?? [])]) {
          for (const dev of (subfam.device ?? [])) {
            const dname: string = dev.Dname ?? '';
            if (dname !== deviceName && dname !== stripped && dname.replace(/_[^_]+$/, '') !== stripped) continue;
            // Algorithms can be on device or inherited from subFamily/family
            const algos: any[] = [
              ...(dev.algorithm    ?? []),
              ...(subfam.algorithm ?? []),
              ...(fam.algorithm    ?? []),
            ];
            for (const algo of algos) {
              const algName: string = algo.name ?? '';
              if (/EXT_TYPE\d+_REAMP\d+/i.test(algName)) continue;  // skip SPIM
              if (/OPT/i.test(algName)) continue;                    // skip option bytes
              const algSize = parseInt(algo.size);
              if (!isNaN(algSize) && Math.abs(algSize - flashSizeBytes) < 1024) {
                const flm = path.basename(algName);
                _internalFlmCache.set(cacheKey, flm);
                return flm;
              }
            }
          }
        }
      }
    } catch { /* malformed PDSC — try next */ }
  }
  _internalFlmCache.set(cacheKey, undefined);
  return undefined;
}

/**
 * Map a FLM basename to the corresponding HLM basename in openocd/FlashLoader/.
 * Internal flash:  HT32F493x5_512.FLM → HT32F493x5_512.HLM  (extension swap)
 * SPIM EXT flash:  HT32F493x5_EXT_TYPE2_REAMP0_GENERAL.FLM → findSpimHlmForFlm()
 * Returns undefined if the HLM file doesn't exist (OpenOCD caller should skip / warn).
 */
function flmToHlm(flmBasename: string, loaderDir: string): string | undefined {
  // SPIM EXT: use regex mapping
  if (/EXT_TYPE\d+_REAMP\d+/i.test(flmBasename)) {
    const hlm = findSpimHlmForFlm(loaderDir, flmBasename);
    if (hlm && fs.existsSync(path.join(loaderDir, hlm))) return hlm;
    return undefined;
  }
  // Internal flash / option bytes: direct extension swap
  const hlm = flmBasename.replace(/\.FLM$/i, '.HLM');
  if (fs.existsSync(path.join(loaderDir, hlm))) return hlm;
  return undefined;
}

/* ─────────────────────────────────────────────
 * SPIM flash loader selection (conf/SpimLoaders.ini)
 * ───────────────────────────────────────────── */

interface SpimLoaderOption {
  label:   string;
  flm:     string;   // FLM basename e.g. "HT32F493x5_EXT_TYPE2_REAMP0_GENERAL.FLM"
  flmKey?: string;   // optional substring matched against Keil FLM filename from uvoptx
  start?:  string;   // flash start address (hex)
  end?:    string;   // flash end address (hex)
}

interface SpimIni {
  generic: Record<string, { flm: string; start?: string; end?: string }>;  // core → {flm,start,end}
  devices: Array<{ pattern: RegExp; options: SpimLoaderOption[] }>;
}

/**
 * Find the HLM file in FlashLoader/ that corresponds to a PDSC FLM algorithm name.
 * FLM naming convention: HT32F493x5_EXT_TYPE2_REAMP0_GENERAL.FLM
 * HLM naming convention: HT32F493x5_EXT_FLASH_BANK3_TYPE2_EXT_SPIF_GRMP0_SIZE_16MB.HLM
 * Mapping rule: REAMP{N} in FLM name ↔ GRMP{N} in HLM name (same digit).
 */
function findSpimHlmForFlm(loaderDir: string, flmName: string): string | undefined {
  const m = /^(.+?)_EXT_TYPE(\d+)_REAMP(\d+)/i.exec(path.basename(flmName));
  if (!m) return undefined;
  const [, device, typeNum, reampNum] = m;
  const pat = new RegExp(`^${device}_EXT_FLASH_BANK\\d+_TYPE${typeNum}_EXT_SPIF_GRMP${reampNum}_SIZE_`, 'i');
  try {
    return fs.readdirSync(loaderDir).find(f => f.toUpperCase().endsWith('.HLM') && pat.test(f));
  } catch { return undefined; }
}

/**
 * Build SpimIni by scanning bundled device-specific PDSC files in dfp/Holtek/.
 * FLM-first: FLM names come directly from PDSC <algorithm> entries; no HLM required for listing.
 * All DFP versions are scanned newest-first (union) so MCUs only in older versions are included.
 *
 * For each device-specific DFP (e.g. HT32F493x5_DFP/):
 *   - Parse PDSC XML for <algorithm> entries with "EXT_TYPE*_REAMP*" in the name (SPIM EXT)
 *   - FLM basename comes directly from PDSC algo.name (e.g. "HT32F493x5_EXT_TYPE2_REAMP0_GENERAL.FLM")
 *   - start/size come from PDSC (authoritative)
 *   - seenFlmKeys deduplicates across versions and family/subFamily overlap
 *
 * Generic fallback (core-based, no device match):
 *   - Derived from device-specific FLM naming by stripping device prefix to get core variant
 *   - Only included when a bank3Base is available from device-specific scanning
 */
function readSpimLoaders(extPath: string): SpimIni {
  const result: SpimIni = { generic: {}, devices: [] };
  const dfpRoot = path.join(extPath, 'dfp', 'Holtek');
  const hex = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(8, '0');
  const parser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '',
    isArray: (name) => ['family', 'subFamily', 'algorithm', 'device'].includes(name),
  });

  let bank3Base: number | undefined;  // SPIM Bank3 start, derived from first PDSC EXT algo found

  try {
    for (const dfpName of fs.readdirSync(dfpRoot).sort()) {
      if (dfpName === 'HT32_DFP') continue;  // generic SVD-only pack, no SPIM algorithms

      const dfpPath = path.join(dfpRoot, dfpName);
      // Scan ALL versions newest-first; seenFlmKeys is shared across versions so
      // older-version-unique algorithms are still included (union approach).
      const versions = fs.readdirSync(dfpPath).sort((a, b) => semverCmp(b, a));  // newest first
      if (!versions.length) continue;

      // Device pattern: HT32F493x5_DFP → HT32F493x5 → regex ^HT32F493.5$ (x→. wildcard)
      const familyKey = dfpName.replace(/_DFP$/, '');
      const pattern   = new RegExp('^' + familyKey.replace(/x/gi, '.') + '$', 'i');
      const options: SpimLoaderOption[] = [];
      const seenFlmKeys = new Set<string>();

      for (const ver of versions) {
        const versionPath = path.join(dfpPath, ver);
        const pdscFile = fs.readdirSync(versionPath).find(f => f.endsWith('.pdsc'));
        if (!pdscFile) continue;

        const doc = parser.parse(fs.readFileSync(path.join(versionPath, pdscFile), 'utf8'));
        const families: any[] = doc?.package?.devices?.family ?? [];

        for (const fam of families) {
          const subFamilies: any[] = fam.subFamily ?? [];
          // EXT algorithms may appear at family or subFamily level — check both
          for (const src of [fam, ...subFamilies]) {
            const algos: any[] = src.algorithm ?? [];
            for (const algo of algos) {
              const algName: string = algo.name ?? '';
              if (!/EXT_TYPE\d+_REAMP\d+/i.test(algName)) continue;  // only SPIM EXT

              const start = parseInt(algo.start);
              const size  = parseInt(algo.size);
              if (isNaN(start) || isNaN(size)) continue;

              if (bank3Base === undefined) bank3Base = start;

              const flmKeyM = /EXT_TYPE(\d+)_REAMP(\d+)/i.exec(algName);
              if (!flmKeyM) continue;
              const flmKey = `TYPE${flmKeyM[1]}_REAMP${flmKeyM[2]}`;
              if (seenFlmKeys.has(flmKey)) continue;  // deduplicate (family + subFamily overlap)
              seenFlmKeys.add(flmKey);

              const flm = path.basename(algName);  // e.g. "HT32F493x5_EXT_TYPE2_REAMP0_GENERAL.FLM"
              // Label from FLM filename: EXT_TYPE2_REAMP0 → TYPE2 REAMP0
              const label = `TYPE${flmKeyM[1]} REAMP${flmKeyM[2]}`;
              options.push({ label, flm, flmKey, start: hex(start), end: hex(start + size - 1) });
            }
          }
        }
      }  // end version loop

      if (options.length > 0) {
        options.sort((a, b) => a.label.localeCompare(b.label));
        result.devices.push({ pattern, options });
      }
    }
  } catch {}

  // Generic fallback: no device-specific match — use first available device FLM for the core
  // (bank3Base from device scanning; size unknown without HLM binary — use 16MB default)
  if (bank3Base !== undefined) {
    try {
      for (const dev of result.devices) {
        for (const opt of dev.options) {
          const core = /M3/i.test(opt.flm) ? 'M3' : 'M4';
          if (!result.generic[core]) {
            result.generic[core] = { flm: opt.flm, start: hex(bank3Base), end: hex(bank3Base + 0xFFFFFF) };
          }
        }
      }
    } catch {}
  }

  return result;
}

/**
 * Build a map of HLM filename → {start, end} from SpimLoaders.ini.
 * Used by the Settings WebView to auto-fill address fields when an HLM is selected.
 */
/**
 * Parse the fixed-layout struct at the end of an HLM binary.
 * Layout (from file end, little-endian uint32):
 *   -4:  magic   0x484c4d21 ("!MLH")
 *   -8:  version
 *   -12: toErase
 *   -16: toProg
 *   -20: valEmpty
 *   -24: reserved
 *   -28: szPage
 *   -32: szDev   ← total flash size in bytes
 *   -36: devAdr  ← flash start address
 *   -40: devType (1=On-chip, 5=External SPI)
 * Returns null if magic doesn't match or file is too small.
 * Generic HLMs use devAdr=0x01000000 as a placeholder (< 0x08000000) — caller should skip.
 */
function parseHlmBinary(hlmPath: string): { devAdr: number; szDev: number; devType: number } | null {
  try {
    const d = fs.readFileSync(hlmPath);
    if (d.length < 40) return null;
    const magic = d.readUInt32LE(d.length - 4);
    if (magic !== 0x484c4d21) return null;   // "!MLH"
    const devType = d.readUInt32LE(d.length - 40);
    const devAdr  = d.readUInt32LE(d.length - 36);
    const szDev   = d.readUInt32LE(d.length - 32);
    return { devAdr, szDev, devType };
  } catch { return null; }
}

/**
 * Build HLM filename → {start, end} map by scanning FlashLoader/ and parsing each HLM binary.
 *
 * FLM-based: addresses come entirely from PDSC <algorithm> start/size.
 * Keys are FLM basenames (e.g. "HT32F493x5_EXT_TYPE2_REAMP0_GENERAL.FLM").
 * Only SPIM EXT loaders are listed here (internal flash uses computeAutoLoadersForBg).
 */
function buildFlmAddrMap(extPath: string): Record<string, { start: string; end: string }> {
  const map: Record<string, { start: string; end: string }> = {};
  const ini = readSpimLoaders(extPath);
  for (const dev of ini.devices) {
    for (const opt of dev.options) {
      if (opt.flm && opt.start && opt.end && !map[opt.flm]) {
        map[opt.flm] = { start: opt.start, end: opt.end };
      }
    }
  }
  return map;
}

/**
 * Determine core category (M4 / M3 / M0) from cortex-debug mcu string.
 * e.g. "cortex-m4" → "M4", "cortex-m3" → "M3", anything else → "M0"
 */
function coreCategory(mcuHint: string | undefined): 'M4' | 'M3' | 'M0' {
  const s = (mcuHint || '').toLowerCase();
  if (s.includes('m4')) return 'M4';
  if (s.includes('m3')) return 'M3';
  return 'M0';
}

/**
 * Select SPIM HLM.
 * Priority:
 *   1. Device section + FLM keyword match (uvoptx hint)  → auto-select
 *   2. Device section, single entry                       → auto-select
 *   3. Device section, multiple entries                   → QuickPick
 *   4. No device section                                  → [generic] auto-select
 * Returns undefined if cancelled or no loader defined.
 */
async function selectSpimFlm(
  deviceName:    string | undefined,
  mcuHint:       string | undefined,
  extPath:       string,
  spimFlmHint?:  string,      // FLM filename from uvoptx, e.g. "HT32F493x5_EXT_TYPE2_REAMP1_GENERAL.FLM"
  matchedAddrs?: Set<number>  // SPIM ORIGIN addresses found in the linker script — used to pre-filter options
): Promise<{ flm: string; start: string; end: string } | undefined> {
  const DEFAULT_START = '0x08400000';
  const DEFAULT_END   = '0x093FFFFF';

  const ini  = readSpimLoaders(extPath);
  const core = coreCategory(mcuHint);

  const toResult = (o: SpimLoaderOption | { flm: string; start?: string; end?: string }) => ({
    flm:   o.flm,
    start: o.start ?? DEFAULT_START,
    end:   o.end   ?? DEFAULT_END,
  });

  // Strip package suffix for device matching (e.g. HT32F49395_100LQFP → HT32F49395)
  const stripped = (deviceName || '').replace(/_[^_]+$/, '');

  // Find matching device section
  const deviceEntry = ini.devices.find(d => d.pattern.test(stripped));
  if (deviceEntry) {
    // Filter options to those whose start address matches what's in the linker script
    const filtered = matchedAddrs && matchedAddrs.size > 0
      ? deviceEntry.options.filter(o => o.start && matchedAddrs.has(parseInt(o.start)))
      : [];
    const options = filtered.length > 0 ? filtered : deviceEntry.options;

    // 1. FLM keyword auto-match (from uvoptx hint)
    if (spimFlmHint) {
      const flmUpper = spimFlmHint.toUpperCase();
      const matched = options.find(o => o.flmKey && flmUpper.includes(o.flmKey.toUpperCase()));
      if (matched) return toResult(matched);
    }

    // 2. Single entry
    if (options.length === 1) return toResult(options[0]);

    // 3. QuickPick
    const pick = await vscode.window.showQuickPick(
      options.map(o => ({ label: o.label, description: o.flm.replace(/\.[^.]+$/, '') })),
      { title: `Select SPIM Flash Loader for ${stripped}`, ignoreFocusOut: true }
    );
    if (!pick) return undefined;
    const chosen = options.find(o => o.flm.replace(/\.[^.]+$/, '') === pick.description);
    return chosen ? toResult(chosen) : undefined;
  }

  // 4. Fallback: generic section
  const gen = ini.generic[core];
  return gen ? toResult(gen) : undefined;
}

/**
 * Find MEMORY regions in a linker script whose ORIGIN falls outside the primary
 * (internal) flash range and are read-only (flash-like, not RAM).
 * These regions require an additional flash loader.
 * primaryStart/primaryEnd come from parseMcuCfg(); optStart/optEnd are excluded
 * because option bytes are handled automatically.
 */
function ldUncoveredFlashAddrs(
  ldPath:       string,
  primaryStart: number,
  primaryEnd:   number,
  optStart:     number,
  optEnd:       number,
): Set<number> {
  const uncovered = new Set<number>();
  try {
    const content  = fs.readFileSync(ldPath, 'utf8');
    const memBlock = content.match(/MEMORY\s*\{([^}]*)\}/s)?.[1] ?? '';
    // Capture both attribute string and ORIGIN: RegionName (attrs) : ORIGIN = 0xADDR
    const re = /\w+\s*\(([^)]*)\)\s*:\s*ORIGIN\s*=\s*(0x[\da-fA-F]+)/gi;
    let m;
    while ((m = re.exec(memBlock)) !== null) {
      const attrs = m[1].toLowerCase();
      const addr  = parseInt(m[2]);
      // Flash-like: readable ('r') but NOT writable ('w') — excludes RAM regions
      if (!attrs.includes('r') || attrs.includes('w')) { continue; }
      // Exclude primary internal flash
      if (addr >= primaryStart && addr <= primaryEnd) { continue; }
      // Exclude option bytes (handled automatically)
      if (addr >= optStart && addr <= optEnd) { continue; }
      uncovered.add(addr);
    }
  } catch {}
  return uncovered;
}

/**
 * Compute the auto-configured loader entries (internal flash + option bytes) for a given
 * workspace root. Used to display read-only info in the Flash Loaders settings panel.
 * Returns [] if device info cannot be determined.
 */
/** Compute auto loaders for a single bgDir (absolute path). */
function computeAutoLoadersForBg(bgDir: string, extPath: string): AutoLoaderEntry[] {
  const hex = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(8, '0');
  const entries: AutoLoaderEntry[] = [];
  try {
    const s = readProjectSettings(bgDir);
    const deviceName = s.deviceName;
    if (!deviceName) return [];
    const mcuInfo = parseMcuCfg(deviceName, extPath);
    if (!mcuInfo) return [];

    const flm = selectInternalFlm(deviceName, mcuInfo.flashEnd - mcuInfo.flashStart + 1, extPath);
    if (!flm) {
      logWarn(`No internal flash FLM found in DFP for device: ${deviceName}`);
      return [];
    }
    entries.push({ flm, start: hex(mcuInfo.flashStart), end: hex(mcuInfo.flashEnd), label: 'Internal Flash' });
    if (mcuInfo.flashStart < 0x08000000) {
      entries.push({ flm: 'HT32F_OPT.FLM', start: hex(mcuInfo.optStart), end: hex(mcuInfo.optEnd), label: 'Option Bytes' });
    }
  } catch { /* ignore */ }
  return entries;
}

function computeAutoLoaders(root: string | undefined, extPath: string): AutoLoaderEntry[] {
  if (!root) return [];
  const bgParentDir = bgParent(root);
  if (!fs.existsSync(bgParentDir)) return [];

  const activeBg = vscode.workspace.getConfiguration('ht32').get<string>('activeBuildGen') || '';
  let bgDirs: string[];
  try {
    bgDirs = fs.readdirSync(bgParentDir).filter(d =>
      isBgDir(bgParentDir, d) &&
      (!activeBg || d === activeBg));
  } catch { return []; }

  const seen = new Set<string>();
  const entries: AutoLoaderEntry[] = [];
  for (const bg of bgDirs) {
    const suffix = bgDirSuffix(bg);
    const tag    = suffix ? ` (${suffix})` : '';
    for (const e of computeAutoLoadersForBg(path.join(bgParentDir, bg), extPath)) {
      const key = `${e.flm}|${e.start}|${e.end}`;
      if (!seen.has(key)) {
        seen.add(key);
        entries.push({ ...e, label: e.label + tag });
      }
    }
  }
  return entries;
}

/**
 * Build the OpenOCD pre-config commands (hlm_SRAM / hlm_loader / WORKAREASIZE).
 * Work area size priority: conf/Settings.ini → PDSC IRAM1 → ramLength fallback.
 * Reads MCU cfg for accurate flash addresses.
 */
function buildHlmPreConfigCmds(
  deviceName:    string | undefined,
  ramOrigin:     string,
  ramLength:     string,
  extPath:       string,
  spimFlm?:      { flm: string; start: string; end: string },  // SPIM auto-detected (used when extraLoaders is empty)
  extraLoaders:  Array<{flm: string; start: string; end: string}> = [],
  adapterSerial: string = '',
  adapterSpeed:  string = '',
  extraPdscPaths: string[] = [],
  eraseMode:     string = 'erase_sector',
  outputExtRoot?: string  // prefix for paths embedded in output strings; defaults to extPath
): string[] {
  // Use absolute paths for hlm_loader so ht32_probe() can find ../MCU/<device>.cfg
  // relative to the OpenOCD executable regardless of the process CWD.
  const loaderDir    = path.join(extPath, 'openocd', 'FlashLoader');
  const outputRoot   = (outputExtRoot ?? extPath).replace(/\\/g, '/');
  const loaderDirFwd = `${outputRoot}/openocd/FlashLoader`;
  const hlmPath      = (f: string) => `${loaderDirFwd}/${f}`;
  const resolveHlm   = (flm: string): string | undefined => flmToHlm(flm, loaderDir);

  const cmds: string[] = [];

  // Adapter serial / speed — must be set before interface cfg is loaded
  if (adapterSerial.trim()) cmds.push(`adapter serial ${adapterSerial.trim()}`);
  if (adapterSpeed.trim())  cmds.push(`adapter speed ${adapterSpeed.trim()}`);

  // Work area size: Settings.ini → PDSC IRAM1 → physicalRamLength fallback.
  // Use physicalRamOrigin/physicalRamLength (pre-DataAddressRange) for hlm_SRAM:
  // flash algorithms run before the MCU executes any code, so the full physical
  // RAM is available regardless of IAP software reservations at the start of RAM.
  const settingsMap = readSettingsIni(extPath);
  const prefix      = (deviceName || '').replace(/_[^_]+$/, '');
  const workAreaNum = deviceName && settingsMap[deviceName]
    ? settingsMap[deviceName]
    : prefix && settingsMap[prefix]
      ? settingsMap[prefix]
      : undefined;
  const pdscIram1   = deviceName ? readPdscIram1(deviceName, extPath, extraPdscPaths) : undefined;
  const workAreaSz  = workAreaNum !== undefined
    ? '0x' + workAreaNum.toString(16)
    : pdscIram1 !== undefined ? '0x' + pdscIram1.size.toString(16) : ramLength;
  // IAP projects shift ramOrigin via DataAddressRange; PDSC always has the physical start.
  const hlmRamOrigin = pdscIram1 !== undefined ? '0x' + pdscIram1.start.toString(16) : ramOrigin;
  cmds.push(`hlm_SRAM ${hlmRamOrigin} ${workAreaSz}`);

  // Internal flash: FLM → HLM via flmToHlm(); error if HLM not found
  const mcuInfo = deviceName ? parseMcuCfg(deviceName, extPath) : null;
  if (mcuInfo) {
    const hex = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(8, '0');
    const intFlm = selectInternalFlm(deviceName!, mcuInfo.flashEnd - mcuInfo.flashStart + 1, extPath);
    if (intFlm) {
      const intHlm = resolveHlm(intFlm);
      if (intHlm) {
        cmds.push(`hlm_loader ${hlmPath(intHlm)} ${hex(mcuInfo.flashStart)} ${hex(mcuInfo.flashEnd)}`);
      } else {
        logWarn(`OpenOCD: HLM not found for internal flash FLM "${intFlm}" (device: ${deviceName})`);
      }
    } else {
      logWarn(`OpenOCD: no internal flash FLM found in DFP for device: ${deviceName}`);
    }
    if (mcuInfo.flashStart < 0x08000000) {
      const optHlm = resolveHlm('HT32F_OPT.FLM');
      if (optHlm) {
        cmds.push(`hlm_loader ${hlmPath(optHlm)} ${hex(mcuInfo.optStart)} ${hex(mcuInfo.optEnd)}`);
      } else {
        logWarn(`OpenOCD: HT32F_OPT.HLM not found in FlashLoader/`);
      }
    }
  } else {
    logWarn(`OpenOCD: MCU cfg not found for device: ${deviceName ?? '(unknown)'}; skipping internal flash loader`);
  }

  // Extra loaders from Flash Loaders settings (external flash, etc.)
  for (const l of extraLoaders) {
    const hlm = resolveHlm(l.flm);
    if (hlm) {
      cmds.push(`hlm_loader ${hlmPath(hlm)} ${l.start} ${l.end}`);
    } else {
      logWarn(`OpenOCD: HLM not found for extra loader FLM "${l.flm}"`);
    }
  }
  // Fallback: SPIM auto-detected loader (only used when extraLoaders is empty)
  if (spimFlm && extraLoaders.length === 0) {
    const hlm = resolveHlm(spimFlm.flm);
    if (hlm) {
      cmds.push(`hlm_loader ${hlmPath(hlm)} ${spimFlm.start} ${spimFlm.end}`);
    } else {
      logWarn(`OpenOCD: HLM not found for auto-detected SPIM FLM "${spimFlm.flm}"`);
    }
  }

  cmds.push(`ht_flags ${eraseMode}`);
  cmds.push(`set WORKAREASIZE ${workAreaSz}`);
  return cmds;
}

/**
 * Build a flat OpenOCD args array suitable for a shell task.
 * Ensures `set WORKAREASIZE` is emitted BEFORE the target cfg file so that
 * HLMm0x.cfg / HLMm3x.cfg can read it at source-time.
 * (Cortex-Debug handles this automatically for launch.json via
 *  openOCDPreConfigLaunchCommands; here we must do it explicitly.)
 *
 * @param cfgFiles       [-f] config files in order: [interfaceCfg, targetCfg]
 * @param preConfigCmds  commands from buildHlmPreConfigCmds()
 * @param postCmds       commands to append after preConfigCmds
 * @param skipCmdFilter  optional predicate to skip certain preConfigCmds
 */
function buildOpenOcdArgs(
  cfgFiles:       string[],
  preConfigCmds:  string[],
  postCmds:       string[],
  skipCmdFilter?: (cmd: string) => boolean,
  debugLevel:     number = 0,
): Array<string | { value: string; quoting: 'strong' }> {
  const q = (v: string) => ({ value: v, quoting: 'strong' as const });
  const args: Array<string | { value: string; quoting: 'strong' }> = [];
  // level 2 = OpenOCD INFO default (no flag needed); level 1 = Warning (-d1); level 0 treated as 1
  if (debugLevel <= 1)      { args.push('-d1'); }
  else if (debugLevel === 3){ args.push('-d3'); }
  else if (debugLevel >= 4) { args.push('-d4'); }
  // level 2: no flag — OpenOCD default is already INFO

  // set WORKAREASIZE must precede all -f cfg files
  const workAreaCmd = preConfigCmds.find(c => /^set WORKAREASIZE\b/i.test(c));
  if (workAreaCmd) args.push('-c', q(workAreaCmd));

  for (const f of cfgFiles) args.push('-f', q(f));

  for (const cmd of preConfigCmds) {
    if (cmd === workAreaCmd) continue;
    if (skipCmdFilter?.(cmd)) continue;
    args.push('-c', q(cmd));
  }

  for (const cmd of postCmds) args.push('-c', q(cmd));

  return args;
}

/**
 * Find ALL matching .pack files for a given device name, sorted newest-first.
 *
 * Returns multiple packs so the caller can pass all via --pack to pyOCD.
 * pyOCD searches each pack in order; a device only present in an older pack version
 * is still found even when a newer version doesn't list it (union strategy).
 *
 * Matching rules:
 *   Holtek.HT32F493x5_DFP.*.pack — specific series ('x' is a digit wildcard), takes priority
 *   Holtek.HT32_DFP.*.pack        — generic fallback for standard series
 */
function findPacksForDevice(deviceName: string | undefined, extPath: string): string[] {
  const dfpDir = path.join(extPath, 'dfp');
  if (!fs.existsSync(dfpDir)) return [];
  const packs = fs.readdirSync(dfpDir).filter(f => /^Holtek\..+\.pack$/i.test(f));
  const packVer = (f: string) => f.match(/\.([\d.]+)\.pack$/i)?.[1] ?? '';
  const toAbs   = (f: string) => path.join(dfpDir, f).replace(/\\/g, '/');

  if (deviceName) {
    // Collect all specific DFP packs that match the device, group by prefix
    const byPrefix = new Map<string, { pack: string; prefixLen: number }[]>();
    for (const pack of packs) {
      const m = pack.match(/^Holtek\.(HT32\w+?)_DFP\.\d/i);
      if (!m) continue;
      const dfpPrefix = m[1];
      const pattern = new RegExp('^' + dfpPrefix.replace(/x/gi, '\\d'), 'i');
      if (!pattern.test(deviceName)) continue;
      const arr = byPrefix.get(dfpPrefix) ?? [];
      arr.push({ pack, prefixLen: dfpPrefix.length });
      byPrefix.set(dfpPrefix, arr);
    }
    if (byPrefix.size > 0) {
      // Find the most specific (longest) prefix group, sort its packs newest-first
      const groups = [...byPrefix.values()].sort((a, b) => b[0].prefixLen - a[0].prefixLen);
      const best = groups[0].sort((a, b) => semverCmp(packVer(b.pack), packVer(a.pack)));
      return best.map(c => toAbs(c.pack));
    }
  }

  // Generic HT32_DFP fallback — return ALL generic versions newest-first
  const generic = packs
    .filter(f => /^Holtek\.HT32_DFP\./i.test(f))
    .sort((a, b) => semverCmp(packVer(b), packVer(a)));  // newest first
  if (generic.length > 0) return generic.map(toAbs);

  return packs.length > 0 ? [toAbs(packs[0])] : [];
}

/**
 * Generate pyocd.yaml and pyocd_user.py in outDir.
 * pyocd_user.py is only generated when extLoaders with EXT SPIM FLMs are present.
 * File must be pure ASCII (pyOCD reads it with system encoding on Windows).
 */
function generatePyocdFiles(
  outDir: string,
  packPaths: string[],      // all matching packs newest-first; pyocd_user.py uses packPaths[0]
  extLoaders: Array<{ flm: string; start: string; end: string }>,
  workAreaSize: number,     // from Settings.ini; limits RAM used by flash algorithm
  internalFlashEnd: number, // from parseMcuCfg; used for RAM work area reference
  smartFlash: boolean,      // pyocd smart_flash: skip unchanged pages
  eraseMode: string,        // 'erase_chip' → chip / 'erase_sector' → sector
): void {
  // Always generate pyocd_user.py: needed for RAM work area setup and EXT flash region
  // registration via _add_ext_region (when ext loaders are configured).
  const userScriptAbs = path.join(outDir, 'pyocd_user.py').replace(/\\/g, '/');
  const eraseYaml = eraseMode === 'erase_chip' ? 'chip' : 'sector';
  const yamlLines = [
    'connect_mode: under-reset',
    `smart_flash: ${smartFlash}`,
    `erase: ${eraseYaml}`,
    `user_script: "${userScriptAbs}"`,
    '',
  ];
  fs.writeFileSync(path.join(outDir, 'pyocd.yaml'), yamlLines.join('\n'), 'utf8');

  const packPath = packPaths[0] ?? '';
  const internalFlashEndHex = `0x${internalFlashEnd.toString(16).toUpperCase()}`;

  // Build per-loader entries (one entry per distinct EXT flash region)
  const entries: string[] = [];
  for (const loader of extLoaders) {
    const flmInPack = `Flash/${loader.flm}`;
    const startNum = parseInt(loader.start);
    const endNum   = parseInt(loader.end);
    if (isNaN(startNum) || isNaN(endNum)) continue;
    const size = endNum - startNum + 1;
    const startHex = `0x${startNum.toString(16).toUpperCase()}`;
    const sizeHex  = `0x${size.toString(16).toUpperCase()}`;
    const flmName  = loader.flm;
    entries.push(
      `        print("[pyocd_user] EXT flash @ ${startHex} size=${sizeHex}  FLM: ${flmName}")`,
      `        _add_ext_region(target, r"${packPath.replace(/\\/g, '/')}", ` +
      `r"${flmInPack}", ${startHex}, ${sizeHex})`
    );
  }


  const workAreaHex = `0x${workAreaSize.toString(16).toUpperCase()}`;
  const pyLines = [
    '# coding: utf-8',
    'import os, zipfile, tempfile, logging',
    'from pyocd.core.memory_map import RamRegion, FlashRegion, RomRegion  # type: ignore',
    'LOG = logging.getLogger(__name__)',
    '',
    `WORK_AREA_SIZE = ${workAreaHex}  # from Settings.ini`,
    '',
    '_flm_cache = {}',
    '_flm_name_cache = {}  # temp path -> original FLM basename',
    '',
    'def _add_ext_region(target, pack_path, flm_in_pack, start, size):',
    '    key = (pack_path, flm_in_pack)',
    '    if key not in _flm_cache or not os.path.exists(_flm_cache[key]):',
    '        print("[pyocd_user] Extracting FLM:", flm_in_pack)',
    '        with zipfile.ZipFile(pack_path, "r") as zf:',
    '            data = zf.read(flm_in_pack)',
    '        fd, tmp = tempfile.mkstemp(suffix=".FLM", prefix="ht32_ext_")',
    '        os.write(fd, data); os.close(fd)',
    '        _flm_cache[key] = tmp',
    '        _flm_name_cache[tmp] = os.path.basename(flm_in_pack)',
    '        print("[pyocd_user] FLM extracted to:", tmp)',
    '    else:',
    '        print("[pyocd_user] FLM (cached):", _flm_cache[key])',
    '    flm_path = _flm_cache[key]',
    '    for r in list(target.memory_map.regions):',
    '        if r.start == start:',
    '            target.memory_map.remove_region(r)',
    '    region = FlashRegion(name="EXT_SPIM", start=start, length=size,',
    '                         blocksize=0x1000, flm=flm_path)',
    '    target.memory_map.add_region(region)',
    '    print(f"[pyocd_user] EXT region added @ 0x{start:08X} len=0x{size:X}  FLM: {os.path.basename(flm_path)}")',
    '',
    '',
    'def did_connect(board):',
    '    try:',
    '        for r in board.target.memory_map.regions:',
    '            if r.type.name == "FLASH":',
    '                flm = getattr(r, "flm", None) or getattr(r, "_flm", None)',
    '                if flm is None:',
    '                    algo = "(DFP pack built-in)"',
    '                elif isinstance(flm, (str, bytes, os.PathLike)):',
    '                    algo = _flm_name_cache.get(str(flm), os.path.basename(flm))',
    '                else:',
    '                    algo = getattr(flm, "description", None) or getattr(flm, "source_path", None)',
    '                    if algo and not isinstance(algo, str): algo = str(algo)',
    '                    if algo: algo = os.path.basename(algo)',
    '                    if not algo: algo = "(DFP pack built-in)"',
    '                print(f"[pyocd_user] Flash Loader: {r.name:<20} @ 0x{r.start:08X}-0x{r.end:08X}  {algo}")',
    '    except Exception as e:',
    '        LOG.warning("[pyocd_user] did_connect algo dump failed: %s", e)',
    '',
    '',
    'def will_connect(board):',
    '    try:',
    '        target = board.target',
    '        for r in list(target.memory_map.regions):',
    '            if r.type.name == "RAM" and r.start == 0x20000000:',
    '                target.memory_map.remove_region(r)',
    '                break',
    '        target.memory_map.add_region(RamRegion(name="RAM_WORK", start=0x20000000, length=WORK_AREA_SIZE))',
    `        print(f"[pyocd_user] RAM work area limited to 0x{WORK_AREA_SIZE:X} bytes")`,
    ...entries,
    '    except Exception as e:',
    '        print("[pyocd_user] will_connect failed:", e)',
    '        LOG.error("[pyocd_user] will_connect failed: %s", e)',
    '        raise',
    '',
  ];
  fs.writeFileSync(path.join(outDir, 'pyocd_user.py'), pyLines.join('\n'), 'utf8');
}

/**
 * Detect pyocd in PATH or installed via bundled uv; ask user before installing if missing.
 * Returns the absolute path to pyocd.exe when installed via uv (must be set as serverpath).
 * Returns undefined when pyocd is already in PATH (cortex-debug finds it automatically).
 */
let _pyocdInstallPromise: Promise<string | undefined> | undefined;
let _pyocdPathCache: string | null | undefined = undefined;  // undefined = not checked, null = not found

async function findOrInstallPyocd(extPath: string): Promise<string | undefined> {
  if (_pyocdPathCache !== undefined) return _pyocdPathCache ?? undefined;
  if (_pyocdInstallPromise) return _pyocdInstallPromise;
  return (_pyocdInstallPromise = _doFindOrInstallPyocd(extPath).then(r => {
    // null  = permanent no-path state (in PATH, no uv): cache so we skip subprocess next call
    // string = found uv-managed path: cache
    // undefined = user declined / install failed: don't cache, re-ask / retry next call
    if (r !== undefined) _pyocdPathCache = r;
    return r ?? undefined;
  }).finally(() => { _pyocdInstallPromise = undefined; }));
}

async function _doFindOrInstallPyocd(extPath: string): Promise<string | null | undefined> {
  function runCmd(cmd: string, timeoutMs: number): Promise<{ ok: boolean; out: string }> {
    return new Promise(resolve => {
      cpExec(cmd, { windowsHide: true, timeout: timeoutMs }, (err, stdout) => {
        resolve({ ok: !err, out: stdout ? stdout.trim() : '' });
      });
    });
  }

  // 1. Already in PATH?
  const inPath = await runCmd('pyocd --version', 5000);
  if (inPath.ok) {
    logInfo('[pyOCD] found in PATH');
    return null;  // cache: permanent no-path state (cortex-debug finds it via PATH)
  }

  // 2. Bundled uv (Windows only)
  const uvExe = path.join(extPath, 'bin', 'win32-x64', 'uv.exe');
  if (!fs.existsSync(uvExe)) {
    logWarn('[pyOCD] not in PATH and bundled uv not found — skipping auto-install');
    return null;  // cache: permanent no-path state for this session
  }

  // 3. Check if already installed via uv
  const uvBinResult = await runCmd(`"${uvExe}" tool dir --bin`, 10000);
  const uvBinDir = uvBinResult.out;
  if (uvBinDir) {
    const pyocdExe = path.join(uvBinDir, 'pyocd.exe');
    if (fs.existsSync(pyocdExe)) {
      logInfo(`[pyOCD] found via uv: ${pyocdExe}`);
      return pyocdExe;
    }
  }

  // 4. Ask user before installing
  const sel = await vscode.window.showWarningMessage(
    'pyOCD not found. Install via uv to enable pyOCD debugging?',
    'Install', 'Not Now'
  );
  if (sel !== 'Install') {
    logInfo('[pyOCD] user declined installation');
    return undefined;
  }

  logInfo('[pyOCD] not found — installing via uv...');
  const success = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Installing pyOCD...', cancellable: false },
    async (progress) => {
      progress.report({ message: 'This may take a moment.' });
      const result = await runCmd(`"${uvExe}" tool install pyocd`, 180000);
      if (!result.ok) { logError(`[pyOCD] install failed: ${result.out}`); }
      return result.ok;
    }
  );

  if (!success) {
    vscode.window.showWarningMessage('pyOCD installation failed. Install manually: pip install pyocd');
    return undefined;
  }

  // 5. Re-query bin dir after install (uv may update it)
  const uvBinResult2 = await runCmd(`"${uvExe}" tool dir --bin`, 10000);
  const uvBinDir2 = uvBinResult2.out || uvBinDir;
  if (uvBinDir2) {
    const pyocdExe = path.join(uvBinDir2, 'pyocd.exe');
    if (fs.existsSync(pyocdExe)) {
      logInfo(`[pyOCD] installed: ${pyocdExe}`);
      vscode.window.showInformationMessage('pyOCD installed successfully.');
      return pyocdExe;
    }
  }

  logWarn('[pyOCD] installed but executable not found in uv bin dir');
  return undefined;
}

/**
 * Build cortex-debug launch + attach configs for servertype: 'pyocd'.
 * Flash programming is done by preLaunchTask (pyocd flash); loadFiles:[] disables GDB load.
 */
function buildPyocdServerConfigs(params: {
  configName:       string;
  attachName:       string;
  bgExecutable:     string;
  elfAbsPath:       string;              // absolute path for --elf (RTOS symbol lookup; harmless on non-RTOS projects)
  bgTargetId:       string;
  bgSvdEntry:       object;
  packPaths:        string[];             // all matching packs newest-first; each becomes --pack
  pyocdYamlRef:     string | undefined;  // e.g. "${workspaceFolder}/pyocd.yaml"
  adapterSerial:    string;
  adapterSpeed:     string;
  debugLevel:       number;
  gdbPath:          string | undefined;
  serverpath:       string | undefined;  // absolute path to pyocd.exe; undefined = use PATH
  debugBuildTask:   string;
  cwd:              string;
}): [object, object] {
  const { configName, attachName, bgExecutable, elfAbsPath, bgTargetId, bgSvdEntry,
          packPaths, pyocdYamlRef, adapterSerial, adapterSpeed,
          debugLevel, gdbPath, serverpath, debugBuildTask, cwd } = params;

  const serverArgs: string[] = ['-t', bgTargetId];
  for (const p of packPaths) { serverArgs.push('--pack', p); }
  if (pyocdYamlRef) { serverArgs.push('--config', pyocdYamlRef); }
  if (adapterSerial.trim()) { serverArgs.push('--probe', adapterSerial.trim()); }
  if (adapterSpeed.trim()) {
    const hz = String(Number(adapterSpeed) * 1000);
    serverArgs.push('--frequency', hz);
  }
  if (debugLevel >= 3)      { serverArgs.push('-v', '-v'); }   // DEBUG / DEBUG_IO
  else if (debugLevel >= 2) { serverArgs.push('-v'); }          // INFO
  // level <= 1: no flag — pyocd default is already WARNING (level 0 removed)
  serverArgs.push('--elf', elfAbsPath);


  const PYOCD_READY_REGEX = '[Gg][Dd][Bb].*[Ss]erver.*[Pp]ort[: ]*[0-9]';

  const base: Record<string, unknown> = {
    type:                          'cortex-debug',
    servertype:                    'pyocd',
    overrideGDBServerStartedRegex: PYOCD_READY_REGEX,
    showDevDebugOutput:            'raw',
    internalConsoleOptions:        'neverOpen',
    cwd:                           cwd,
    executable:                    bgExecutable,
    ...bgSvdEntry,
    ...(serverpath ? { serverpath } : {}),
    ...(gdbPath ? { gdbPath } : {}),
    ...(serverArgs.length > 0 ? { serverArgs } : {}),
    liveWatch:                     { enabled: true, samplesPerSecond: 4 },
  };

  const preConnectCmds = ['set mem inaccessible-by-default off', 'set remotetimeout 300'];

  const debugConfig = {
    name:    configName,
    request: 'launch',
    ...base,
    runToEntryPoint:      'main',
    loadFiles:            [],
    preLaunchCommands:    preConnectCmds,
    postLaunchCommands:   ['monitor reset halt', 'monitor arm semihosting enable'],
    overrideResetCommands: ['monitor reset halt'],
    preLaunchTask: debugBuildTask,
  };

  // Attach must not reset the target — override pyocd.yaml's connect_mode: under-reset
  const attachServerArgs = [...serverArgs.filter(a => a !== '--erase' && a !== 'chip' && a !== 'skip'), '-O', 'connect_mode=attach'];
  const attachBase = { ...base, ...(attachServerArgs.length > 0 ? { serverArgs: attachServerArgs } : { serverArgs: undefined }) };
  if (!attachServerArgs.length) delete (attachBase as Record<string,unknown>).serverArgs;

  const attachConfig = {
    name:    attachName,
    request: 'attach',
    ...attachBase,
    preAttachCommands:  preConnectCmds,
    postAttachCommands: ['monitor halt', 'monitor arm semihosting enable'],
    overrideResetCommands: ['monitor reset halt', 'tbreak *main'],
  };

  return [debugConfig, attachConfig];
}

/**
 * Build cortex-debug launch + attach configs for servertype: 'openocd'.
 * preLaunchTask = "Build & Download" compound: Build → Download (Kill OpenOCD → program exit).
 * cortex-debug then starts a fresh OpenOCD; firmware is already in flash so no GDB load needed.
 * bgPreConfigCmds comes from buildHlmPreConfigCmds():
 *   - adapter serial/speed → openOCDLaunchCommands (after config files)
 *   - hlm_SRAM / hlm_loader / ht_flags / WORKAREASIZE → openOCDPreConfigLaunchCommands (before config files)
 */
function buildOpenocdServerConfigs(params: {
  configName:      string;
  attachName:      string;
  bgExecutable:    string;
  bgDeviceFinal:   string;
  bgSvdEntry:      object;
  bgConfigFiles:   string[];
  bgPreConfigCmds: string[];
  bgServerArgs:    object;
  openocdExe:      string;
  gdbPath:         string | undefined;
  debugBuildTask:  string;
  rtos?:           string;
  cwd:             string;
}): [object, object] {
  const { configName, attachName, bgExecutable, bgDeviceFinal, bgSvdEntry,
          bgConfigFiles, bgPreConfigCmds, bgServerArgs, openocdExe, gdbPath,
          debugBuildTask, rtos, cwd } = params;

  const adapterCmds = bgPreConfigCmds.filter(c => c.startsWith('adapter '));
  const hlmCmds     = bgPreConfigCmds.filter(c => !c.startsWith('adapter '));

  const resetCmds = ['reset_config srst_only srst_push_pull srst_nogate'];

  const OCD_READY_SENTINEL = 'HT32_VSCode:OCD_READY';

  const base = {
    type:                          'cortex-debug',
    servertype:                    'openocd',
    overrideGDBServerStartedRegex: OCD_READY_SENTINEL,
    showDevDebugOutput:            'raw',
    internalConsoleOptions:        'neverOpen',
    cwd:                           cwd,
    executable:                    bgExecutable,
    device:                        bgDeviceFinal,
    ...bgSvdEntry,
    serverpath:                    openocdExe,
    configFiles:                   bgConfigFiles,
    ...bgServerArgs,
    ...(rtos ? { rtos } : {}),
    liveWatch:                     { enabled: true, samplesPerSecond: 4 },
    ...(gdbPath ? { gdbPath } : {}),
  };

  const debugConfig = {
    name:    configName,
    request: 'launch',
    ...base,
    runToEntryPoint:                'main',
    openOCDPreConfigLaunchCommands: hlmCmds,
    openOCDLaunchCommands: [
      ...adapterCmds,
      ...resetCmds,
      `set_expected_name ${bgDeviceFinal} SkipReadID`,
      `echo ${OCD_READY_SENTINEL}`,
    ],
    loadFiles:          [],
    preLaunchCommands:  ['set mem inaccessible-by-default off', 'set remotetimeout 300'],
    postLaunchCommands: ['monitor reset halt', 'monitor arm semihosting enable'],
    preLaunchTask: debugBuildTask,
  };

  const attachConfig = {
    name:    attachName,
    request: 'attach',
    ...base,
    openOCDPreConfigLaunchCommands: hlmCmds,
    openOCDLaunchCommands: [
      ...adapterCmds,
      ...resetCmds,
      `set_expected_name ${bgDeviceFinal} SkipReadID`,
      `echo ${OCD_READY_SENTINEL}`,
    ],
    preAttachCommands:  ['set mem inaccessible-by-default off', 'set remotetimeout 300'],
    postAttachCommands: ['monitor halt', 'monitor arm semihosting enable'],
    overrideResetCommands: ['monitor reset halt', 'tbreak *main'],
  };

  return [debugConfig, attachConfig];
}

const GCC_PROBLEM_MATCHER = {
  owner: 'gcc',
  fileLocation: ['autoDetect', '${workspaceFolder}'],
  pattern: {
    regexp: '^(.*):(\\d+):(\\d+):\\s+(warning|error|note):\\s+(.*)$',
    file: 1, line: 2, column: 3, severity: 4, message: 5
  }
};

function runAfterBuildSync(wsRoot: string): void {
  const bgParentDir = bgParent(wsRoot);
  const bgDirs = fs.existsSync(bgParentDir)
    ? fs.readdirSync(bgParentDir).filter(d => isBgDir(bgParentDir, d))
    : [];
  try {
    const seen = new Set<string>();
    const updatedNames: string[] = [];
    for (const bg of bgDirs) {
      const s = readProjectSettings(path.join(bgParentDir, bg));
      const cmd = s.postBuildCmd?.trim();
      if (!cmd) continue;
      for (const r of syncAfterBuildBats(cmd, wsRoot, extensionPath)) {
        if (seen.has(r.batPath.toLowerCase())) continue;
        seen.add(r.batPath.toLowerCase());
        if (r.message) logInfo(r.message);
        if (r.action === 'updated') updatedNames.push(path.basename(r.batPath));
      }
    }
    if (updatedNames.length) {
      vscode.window.showInformationMessage(
        `afterbuild bat(s) updated: ${updatedNames.join(', ')} (originals backed up as .bak)`
      );
    }
  } catch (e: any) { logError(`afterbuildSync failed: ${e?.message ?? e}`); }
}

async function generateTasksAndLaunchAndMakefile(
  root: string,
  opts?: { bgDirHint?: string; elfPathHint?: string; deviceNameHint?: string; mcuHint?: string; ramOriginHint?: string; ramLengthHint?: string; spimFlmHint?: string; regenMakefile?: boolean },
  isRetry = false
) {
  const cfg = vscode.workspace.getConfiguration('ht32');

  const vscodeDir = path.join(root, '.vscode');
  ensureDir(path.join(vscodeDir, 'keep'));

  // ${config:ht32.internal.extensionRoot} → VS Code 執行 task/launch 時動態展開為實際 extensionPath
  // 寫進 tasks.json / launch.json 的所有 extension 衍生路徑都用這個變數，升版後不需重新產生
  const EXT_ROOT = '${config:ht32.internal.extensionRoot}';

  // ----- tasks.json -----
  // 掃描所有 Project*/ 目錄（HT32_VSCode/ 直接下，或舊版 .vscode/ 下），各自產生 Build / Clean task
  const bgParentDir = bgParent(root);
  // bgRel: relative path from workspaceFolder to bgParentDir ('' for new layout, '.vscode' for old)
  const bgRel = path.relative(root, bgParentDir).replace(/\\/g, '/');
  /** Full cwd path for a Project dir in tasks.json */
  const bgCwdOf = (bg: string) => bgRel
    ? `\${workspaceFolder}/${bgRel}/${bg}`
    : `\${workspaceFolder}/${bg}`;
  /** ELF path relative to workspaceFolder */
  const bgElfOf = (bg: string, name: string, ext: string) => bgRel
    ? `${bgRel}/${bg}/build/${name}${ext}`
    : `${bg}/build/${name}${ext}`;
  // Read .ht32vs order for Build All sequence
  let ht32vsOrder: string[] | undefined;
  try {
    let _s: any = {};
    try { _s = JSON.parse(fs.readFileSync(path.join(bgParentDir, '.vscode', 'settings.json'), 'utf8')); } catch {}
    const _f: string | undefined = _s['ht32.activeProjectFile'];
    if (_f) {
      const _p = path.isAbsolute(_f) ? _f : path.join(bgParentDir, _f);
      const _ws = parseHt32vsFile(_p);
      if (_ws && Array.isArray(_ws.projects)) ht32vsOrder = _ws.projects.filter((p: unknown): p is string => typeof p === 'string');
    }
  } catch {}
  let bgDirs: string[];
  if (ht32vsOrder && ht32vsOrder.length > 0) {
    // .ht32vs 有幾個就處理幾個，順序跟著 .ht32vs，不掃描整個目錄
    bgDirs = ht32vsOrder.filter(d =>
      isBgDir(bgParentDir, d) &&
      fs.existsSync(path.join(bgParentDir, d, 'Makefile')));
  } else {
    bgDirs = fs.existsSync(bgParentDir)
      ? fs.readdirSync(bgParentDir)
          .filter(d =>
            isBgDir(bgParentDir, d) &&
            fs.existsSync(path.join(bgParentDir, d, 'Makefile')))
      : [];
    bgDirs.sort((a, b) => (a === BG_BASE || a === BG_BASE_OLD) ? -1 : (b === BG_BASE || b === BG_BASE_OLD) ? 1 : a.localeCompare(b));
  }
  if (bgDirs.length === 0) bgDirs = [BG_BASE];

  // ★ 統一工具鏈解析：make + gcc + pyocd；缺工具時顯示單一 warning
  const bgFullDirs = bgDirs.map(d => path.join(bgParentDir, d));
  const onToolchainInstalled = isRetry ? async () => {} : async () => {
    const bp      = bgParent(root);
    const bgNames = fs.existsSync(bp) ? fs.readdirSync(bp).filter(d => isBgDir(bp, d)) : [];
    if (bgNames.length) await initProjectsFromMeta(bgNames.map(d => path.join(bp, d)), root);
    // 工具鏈剛安裝完，必須完整 regen（不沿用 open-project 路徑的 regenMakefile: false）
    const { regenMakefile: _dropped, ...optsForRetry } = opts ?? {};
    await generateTasksAndLaunchAndMakefile(root, optsForRetry, true);
  };
  const { makePathFull, makeExe, gccPath, pyocdPath: pyocdServerPath } = await resolveToolchain(
    root, bgFullDirs, onToolchainInstalled
  );

  // settings.json：需要 bgDirs 才能確定路徑，放在掃描完之後
  await writeMakefileToolsSettings(root, bgDirs, gccPath || undefined);

  // .clangd：gcc 路徑已確定，統一在此產生，所有流程（create/open/convert）都經過這裡
  ensureClangdAtProjectRoot(root, bgDirs[0], gccPath || undefined);

  // 把 make dir + gcc dir 都加進 PATH，確保 task 能找到工具
  const extPathFwd = extensionPath.replace(/\\/g, '/');
  const pathDirs: string[] = [];
  if (makePathFull && path.isAbsolute(makePathFull)) {
    const makePathFwd = makePathFull.replace(/\\/g, '/');
    // bundled make 在 extensionPath 下 → 用 EXT_ROOT 取代版本號路徑
    if (makePathFwd.startsWith(extPathFwd + '/')) {
      const relDir = makePathFwd.slice(extPathFwd.length + 1).split('/').slice(0, -1).join('/');
      pathDirs.push(`${EXT_ROOT}/${relDir}`);
    } else {
      pathDirs.push(path.dirname(makePathFwd));
    }
  }
  let gdbPath = 'arm-none-eabi-gdb';
  if (gccPath && path.isAbsolute(gccPath)) {
    const gccDir = path.dirname(gccPath);
    pathDirs.push(gccDir.replace(/\\/g, '/'));

    const gdbCand = process.platform === 'win32'
      ? path.join(gccDir, 'arm-none-eabi-gdb.exe')
      : path.join(gccDir, 'arm-none-eabi-gdb');
    if (fs.existsSync(gdbCand)) {
      gdbPath = gdbCand.replace(/\\/g, '/');
    } else {
      logWarn(`arm-none-eabi-gdb not found next to gcc in ${gccDir}`);
    }
  }

  const envPath = pathDirs.length > 0
    ? pathDirs.join(process.platform === 'win32' ? ';' : ':')
      + (process.platform === 'win32' ? ';${env:PATH}' : ':${env:PATH}')
    : undefined;
  const envForTasks = envPath ? { PATH: envPath } : undefined;

  /** Project → ''，Project_iap → 'IAP'，build-gen → ''，build-gen-iap → 'IAP'，HT32F52352 → 'HT32F52352' */
  const bgSuffix      = bgDirSuffix;
  /** task label for Build（手動執行，terminal 留著讓 user 看結果） */
  const buildLabel      = (dir: string) => { const s = bgSuffix(dir); return s ? `Build ${s}` : 'Build (make)'; };
  /** task label for Clean */
  const cleanLabel      = (dir: string) => { const s = bgSuffix(dir); return s ? `Clean ${s}` : 'Clean'; };
  /** task label for Download */
  const downloadLabel   = (dir: string) => { const s = bgSuffix(dir); return s ? `Download ${s}` : 'Download'; };
  /** task label for F5 preLaunchTask: Kill → Compile → Download → OpenOCD */
  const debugPreLaunchLabel = (dir: string) => { const s = bgSuffix(dir); return s ? `Build & Download ${s}` : 'Build & Download'; };
  /** task label for OpenOCD background server（Debug 和 Attach 共用） */
  const openocdKeepLabel = (dir: string) => { const s = bgSuffix(dir); return s ? `OpenOCD ${s}` : 'OpenOCD'; };
  /** task label for Attach preLaunchTask（不 build，不 reset） */
  const attachPreLaunchLabel = (dir: string) => { const s = bgSuffix(dir); return s ? `Attach ${s}` : 'Attach'; };

  const compileLabel   = (dir: string) => { const s = bgSuffix(dir); return s ? `Compile ${s}` : 'Compile'; };
  const postBuildLabel = (dir: string) => { const s = bgSuffix(dir); return s ? `Post-Build ${s}` : 'Post-Build'; };

  /** .bat 檔在 PowerShell 下需要 cmd /c，自動補上（避免使用者自己寫） */
  const wrapPostBuildCmd = (cmd: string) => {
    const t = cmd.trim();
    if (/^cmd\b/i.test(t)) return t;                       // 已有 cmd，不重複加
    if (/\.bat(\s|$)/i.test(t.split(/\s+/)[0])) return `cmd /c ${t}`;  // .bat 自動加
    return t;
  };

  const taskList: any[] = [];
  for (const bg of bgDirs) {
    const bgSettings   = readProjectSettings(path.join(bgParentDir, bg));
    const postBuildCmd = bgSettings.postBuildCmd.trim();

    if (postBuildCmd) {
      // "Compile X" = make only（內部用，無 group）
      taskList.push({
        label:          compileLabel(bg),
        type:           'process',
        command:        makePathFull ?? 'make',
        args:           ['-j', '--output-sync=line', '--no-print-directory', '-C', bgCwdOf(bg)],
        options:        { cwd: bgCwdOf(bg), ...(envForTasks ? { env: envForTasks } : {}) },
        problemMatcher: [GCC_PROBLEM_MATCHER],
        presentation:   { reveal: 'always', panel: 'dedicated', clear: true },
      });
      // "Post-Build X" = bat only
      taskList.push({
        label:          postBuildLabel(bg),
        type:           'shell',
        command:        wrapPostBuildCmd(postBuildCmd),
        options:        { cwd: '${workspaceFolder}', ...(envForTasks ? { env: envForTasks } : {}) },
        problemMatcher: [],
        presentation:   { reveal: 'always', panel: 'dedicated', clear: true }
      });
      // "Build X" = compound：先 Compile 再 Post-Build
      taskList.push({
        label:        buildLabel(bg),
        dependsOn:    [compileLabel(bg), postBuildLabel(bg)],
        dependsOrder: 'sequence',
        group:        { kind: 'build', isDefault: (bg === BG_BASE || bg === BG_BASE_OLD) }
      });
    } else {
      // 沒有 postBuildCmd："Build X" = make
      taskList.push({
        label:          buildLabel(bg),
        type:           'process',
        command:        makePathFull ?? 'make',
        args:           ['-j', '--output-sync=line', '--no-print-directory', '-C', bgCwdOf(bg)],
        options:        { cwd: bgCwdOf(bg), ...(envForTasks ? { env: envForTasks } : {}) },
        problemMatcher: [GCC_PROBLEM_MATCHER],
        group:          { kind: 'build', isDefault: (bg === BG_BASE || bg === BG_BASE_OLD) },
        presentation:   { reveal: 'always', panel: 'dedicated', clear: true },
      });
    }
    taskList.push({
      label:          cleanLabel(bg),
      type:           'process',
      command:        makePathFull ?? 'make',
      args:           ['-C', bgCwdOf(bg), 'clean'],
      options:        { cwd: bgCwdOf(bg), ...(envForTasks ? { env: envForTasks } : {}) },
      problemMatcher: [],
      presentation:   { reveal: 'always', panel: 'dedicated', clear: true }
    });
  }
  // 多個 build-gen 時加 Build All / Clean All（依序編譯，Build X 已內含 Post-Build）
  if (bgDirs.length > 1) {
    taskList.push({
      label:        'Build All',
      dependsOn:    bgDirs.map(buildLabel),
      dependsOrder: 'sequence',
      group:        { kind: 'build' }
    });
    taskList.push({
      label:          'Clean All',
      dependsOn:      bgDirs.map(cleanLabel),
      dependsOrder:   'sequence',
      problemMatcher: []
    });
  }

  // Kill OpenOCD：清掉前一個 session 殘留的 openocd.exe（例如卡死無法自動退出）
  // 放在 preLaunchTask dependsOn 序列中，保證在 Download 啟動前完成，無 race condition。
  // 不放在 postDebugTask，因為 postDebugTask 在 restart 時會與新啟動的 OpenOCD 產生競爭。
  taskList.push({
    label:          'Kill OpenOCD',
    type:           'shell',
    command:        'taskkill /F /IM openocd.exe /T 2>nul & exit 0',
    options:        { shell: { executable: 'cmd.exe', args: ['/d', '/c'] } },
    problemMatcher: [],
    presentation:   { reveal: 'never', panel: 'shared', close: true }
  });

  // tasks.json 寫出移到 per-bg loop 之後（Download task 需要 openocdExe 等 per-bg 資料）

  // ----- launch.json -----

  // 使用 extension 內建的 OpenOCD（ht32.openocdPath 設定值可覆蓋，machine-scoped）
  const bundledOpenOcdRoot = `${EXT_ROOT}/openocd`;  // 寫進 JSON 的路徑用 ${config:...}
  const bundledOpenOcdExe  = `${bundledOpenOcdRoot}/bin/openocd.exe`;
  const openocdPathSetting = cfg.get<string>('openocdPath', '').trim();
  const openocdExe = openocdPathSetting || bundledOpenOcdExe;

  // 每個 build-gen*/ 各產生一個 debug configuration，各讀自己的 project.settings.json
  const configurations: any[] = [];

  for (const bg of bgDirs) {
    // Per-project settings（各自獨立；fallback 到 workspace settings）
    const projSettings = readProjectSettings(path.join(bgParentDir, bg));

    if (projSettings.serverType !== 'pyocd') {
      logInfo(`Using OpenOCD: ${openocdExe}`);
    }

    // Per-project interface cfg
    const interfaceCfgPath = selectInterfaceCfg(projSettings.debugInterface, bundledOpenOcdRoot);

    // Per-project flash loaders（有設定時跳過 SPIM auto-detect）
    const enabledFlashLoaders = projSettings.flashLoaders
      .filter(l => l.enabled !== false && l.flm && l.start && l.end);
    if (enabledFlashLoaders.length > 0) {
      logInfo(`Flash Loaders (${bg}): using ${enabledFlashLoaders.length} loader(s) from project settings (SPIM auto-detect skipped).`);
    }

    const svdFileSetting = projSettings.svdFile.trim();
    const dfpPathSetting = projSettings.dfpPath.trim();

    // opts 只套用到剛轉換的那個 bgDir（bgDirHint 指定；無 hint 時 fallback 到 bgDirs[0]）
    const isActiveBg = opts?.bgDirHint ? bg === opts.bgDirHint : bg === bgDirs[0];

    // Per-project hints: opts 僅用於剛轉換的 project，因為是最新的資料來源
    let bgElfPath    = isActiveBg ? opts?.elfPathHint    : undefined;
    let bgDevice     = isActiveBg ? opts?.deviceNameHint : undefined;
    let bgMcu        = isActiveBg ? opts?.mcuHint        : undefined;
    let bgRamOrigin  = isActiveBg ? opts?.ramOriginHint  : undefined;
    let bgRamLength  = isActiveBg ? opts?.ramLengthHint  : undefined;
    const bgSpimFlmHint = isActiveBg ? opts?.spimFlmHint : undefined;

    // 讀各自的 project.settings.json
    const bgSettings = readProjectSettings(path.join(bgParentDir, bg));
    const bgOutputType  = bgSettings.outputType;
    bgRamOrigin = bgRamOrigin || bgSettings.ramOrigin;
    bgRamLength = bgRamLength || bgSettings.ramLength;
    bgDevice    = bgDevice    || bgSettings.deviceName;
    bgMcu       = bgMcu       || bgSettings.mcu;
    const effectiveTargetName = bgSettings.outputName?.trim() || bgSettings.targetName;
    if (!bgElfPath && effectiveTargetName) {
      const ext = bgSettings.outputType === 'lib' ? '.a' : '.elf';
      bgElfPath = bgElfOf(bg, effectiveTargetName, ext);
    }

    // Final fallback（只對 active project 做，因為 uvprojx 掃描只能找到第一個）
    if (isActiveBg && (!bgDevice || !bgRamOrigin || !bgRamLength)) {
      try {
        const mdkDir = path.join(root, 'MDK_ARMv5');
        const scanDir = fs.existsSync(mdkDir) ? mdkDir : root;
        const uvprojx = fs.readdirSync(scanDir).find(f => f.endsWith('.uvprojx'));
        if (uvprojx) {
          const info = extractDeviceInfoFromUvprojx(path.join(scanDir, uvprojx), extensionPath);
          bgDevice    = bgDevice    || info.deviceName;
          bgRamOrigin = bgRamOrigin || info.ramOrigin;
          bgRamLength = bgRamLength || info.ramLength;
        }
      } catch (e: any) {
        logWarn(`Failed to extract device info from uvprojx for ${bg}: ${e?.message ?? e}`);
      }
    }

    if (!bgRamOrigin || !bgRamLength) {
      logWarn(`${bg}: RAM origin/length unknown, using generic defaults (0x20000000 / 0x4000) — build config may be incorrect. Run "Convert uVision Project" to fix.`);
    }
    if (!bgDevice) {
      logWarn(`${bg}: device name unknown, defaulting to Cortex-M0 — flash programming will not work. Run "Convert uVision Project" to fix.`);
    }
    bgRamOrigin = bgRamOrigin || '0x20000000';
    bgRamLength = bgRamLength || '0x4000';
    const bgDeviceFinal = bgDevice || 'Cortex-M0';

    // MCU cfg is required for flash address resolution; report error if missing
    if (bgDevice && !parseMcuCfg(bgDevice, extensionPath)) {
      const msg = `MCU config not found for "${bgDevice}". Flash programming will not work correctly. Check the device name, or use "HT32: Update Device Packs (Online)" / "HT32: Install Device Pack from File" to add support for this MCU.`;
      logError(msg);
      if (isActiveBg) { vscode.window.showErrorMessage(msg); }
    }

    // SVD per project
    const bgSvdFile = svdFileSetting ||
      (bgDevice ? findSvdFile(dfpPathSetting, bgDevice, extensionPath, cfg.get<string[]>('extraPdscPaths', [])) : undefined);
    if (bgSvdFile) {
      logInfo(`SVD file (${bg}): ${bgSvdFile}`);
    } else if (bgDevice && isActiveBg) {
      logWarn(`SVD file not found for device: ${bgDevice}. Set ht32.dfpPath or ht32.svdFile.`);
    }

    // Check whether the linker has flash regions not covered by the primary loader or any enabled extra loaders.
    // Always runs (even when enabledFlashLoaders is non-empty) so that LD changes are detected.
    let bgInternalFlashEnd = 0;
    let bgRtos: string | undefined;
    {
      // Resolve the primary linker script path from meta.linkerScripts[0] (bgDir-relative).
      let bgLdFile: string | undefined;
      try {
        const bgMetaRaw = fs.readFileSync(path.join(bgParentDir, bg, 'project.meta.json'), 'utf8');
        const bgMeta = JSON.parse(bgMetaRaw);
        bgLdFile = (bgMeta.linkerScripts as string[] | undefined)?.[0] ?? bgMeta.ldFile ?? undefined;
        const bgAllPaths = Object.values(bgMeta.groups as Record<string, string[]> ?? {}).flat()
          .concat(Object.keys(bgMeta.fileOptions ?? {}));
        bgRtos = bgAllPaths.some((p: string) => /freertos/i.test(p)) ? 'FreeRTOS' : undefined;
      } catch (e: any) {
        logWarn(`${bg}: failed to read project.meta.json for linker script path: ${e?.message ?? e}; flash coverage check may be inaccurate`);
      }
      let bgLdPath: string;
      if (bgLdFile && bgLdFile.includes('/')) {
        bgLdPath = path.resolve(path.join(bgParentDir, bg), bgLdFile);
      } else {
        const name = bgLdFile ?? 'linker_script.ld';
        const gnuArmPath = path.join(bgParentDir, 'GNU_ARM');
        bgLdPath = fs.existsSync(path.join(gnuArmPath, name))
          ? path.join(gnuArmPath, name)
          : path.join(bgParentDir, bg, name);
      }
      const mcuCfg = bgDevice ? parseMcuCfg(bgDevice, extensionPath) : null;
      if (mcuCfg) { bgInternalFlashEnd = mcuCfg.flashEnd; }
      const uncoveredAddrs = mcuCfg
        ? ldUncoveredFlashAddrs(bgLdPath, mcuCfg.flashStart, mcuCfg.flashEnd, mcuCfg.optStart, mcuCfg.optEnd)
        : new Set<number>(); // mcuCfg null → device unknown, conversion should have already reported an error
      // Remove addresses already covered by configured extra loaders
      for (const loader of enabledFlashLoaders) {
        const ls = parseInt(loader.start);
        const le = parseInt(loader.end);
        for (const addr of uncoveredAddrs) {
          if (addr >= ls && addr <= le) { uncoveredAddrs.delete(addr); }
        }
      }
      if (uncoveredAddrs.size > 0) {
        // Only auto-detect (show QuickPick) if flashLoaders was never explicitly set in project.settings.json.
        // If the key exists (even as []), the user has intentionally configured the loader list — respect it.
        let flashLoadersExplicit = false;
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(bgParentDir, bg, 'project.settings.json'), 'utf8'));
          flashLoadersExplicit = 'flashLoaders' in raw;
        } catch {}
        if (flashLoadersExplicit) {
          logWarn(`Extra flash region detected in ${bg} but flashLoaders is explicitly configured (possibly empty) — skipping auto-detect.`);
        } else {
          const bgSpimFlm = await selectSpimFlm(bgDevice, bgMcu, extensionPath, bgSpimFlmHint, uncoveredAddrs);
          if (!bgSpimFlm) {
            logWarn(`Extra flash region detected in ${bg} but no loader selected; those regions will not be programmed.`);
          } else {
            writeProjectSettings(path.join(bgParentDir, bg), { ...projSettings, flashLoaders: [{ flm: bgSpimFlm.flm, start: bgSpimFlm.start, end: bgSpimFlm.end }] });
            enabledFlashLoaders.push(bgSpimFlm);
            logInfo(`Extra flash loader auto-detected and saved to project settings (${bg}): ${bgSpimFlm.flm}`);
          }
        }
      }
    }

    const bgPreConfigCmds = buildHlmPreConfigCmds(
      bgDevice, bgRamOrigin, bgRamLength, extensionPath, undefined, enabledFlashLoaders,
      projSettings.adapterSerial, projSettings.adapterSpeed,
      cfg.get<string[]>('extraPdscPaths', []),
      projSettings.eraseMode,
      EXT_ROOT
    );
    const bgPostConfigCmds = [
      ...(bgDevice ? [`set_expected_name ${bgDevice}`] : []),
    ];

    // Config 命名規則：
    //   pyocd:   "HT32 PyOCD Debug (suffix)"  / "HT32 PyOCD Attach (suffix)"
    //   openocd: "HT32 OpenOCD Debug (suffix)" / "HT32 OpenOCD Attach (suffix)"
    //   external: same as openocd (legacy)
    const suffix = bgSuffix(bg);
    const serverLabel = projSettings.serverType === 'pyocd' ? 'PyOCD' : 'OpenOCD';
    const configName  = suffix ? `HT32 ${serverLabel} Debug (${suffix})`  : `HT32 ${serverLabel} Debug`;
    const attachName  = suffix ? `HT32 ${serverLabel} Attach (${suffix})` : `HT32 ${serverLabel} Attach`;

    // Library projects (.a) cannot be launched/debugged — skip launch config entry
    if (bgOutputType === 'lib') { continue; }

    const bgExecutable = bgElfPath
      ? '${workspaceFolder}/' + bgElfPath
      : `\${workspaceFolder}/${bgElfOf(bg, 'HT32', '.elf')}`;
    const bgConfigFiles = projSettings.serverType !== 'pyocd' ? [
      interfaceCfgPath,
      `${bundledOpenOcdRoot}/scripts/${selectTargetCfg(extensionPath, bgMcu, bgDevice)}`,  // selectTargetCfg 用實際 extensionPath 做 runtime 查詢；bundledOpenOcdRoot 已含 EXT_ROOT
    ] : [];
    const bgOcdDFlag = projSettings.openocdDebugLevel <= 1 ? '-d1'
      : projSettings.openocdDebugLevel === 3 ? '-d3'
      : projSettings.openocdDebugLevel >= 4  ? '-d4'
      : undefined; // level 2 = OpenOCD INFO default, no flag needed
    const bgServerArgs = bgOcdDFlag ? { serverArgs: [bgOcdDFlag] } : {};
    const bgSvdEntry  = bgSvdFile ? { svdFile: bgSvdFile } : {};

    // pyOCD params — hoisted so Download task can reuse without a second findPacksForDevice call
    const bgTargetId      = bgDeviceFinal.toLowerCase();
    const packPaths       = projSettings.serverType === 'pyocd'
      ? findPacksForDevice(bgDevice, extensionPath) : [];
    // tasks.json --pack args 用 EXT_ROOT 取代版本號路徑；pyocd_user.py 仍需實際路徑
    const packPathsForTask = packPaths.map(p =>
      p.replace(/\\/g, '/').startsWith(extPathFwd + '/')
        ? p.replace(/\\/g, '/').replace(extPathFwd, EXT_ROOT)
        : p.replace(/\\/g, '/'));
    if (projSettings.serverType === 'pyocd') {
      const iniMap      = readSettingsIni(extensionPath);
      const waPrefix    = (bgDevice ?? '').replace(/_[^_]+$/, '');
      const pdscIram1   = bgDevice ? readPdscIram1(bgDevice, extensionPath) : undefined;
      const workAreaSz  = (bgDevice ? iniMap[bgDevice] : undefined) ?? iniMap[waPrefix] ?? pdscIram1?.size ?? 0x20000;
      generatePyocdFiles(path.join(bgParentDir, bg), packPaths, enabledFlashLoaders, workAreaSz, bgInternalFlashEnd, projSettings.smartFlash, projSettings.eraseMode);
    }
    // pyocd.yaml + pyocd_user.py are always generated; yaml is always referenced via --config
    const pyocdYamlRef = projSettings.serverType === 'pyocd'
      ? (bgRel ? `\${workspaceFolder}/${bgRel}/${bg}/pyocd.yaml` : `\${workspaceFolder}/${bg}/pyocd.yaml`)
      : undefined;

    if (projSettings.serverType === 'pyocd') {
      // pyOCD branch — cortex-debug manages pyocd-gdbserver lifecycle
      const elfAbsPath = bgExecutable.replace('${workspaceFolder}', root.replace(/\\/g, '/'));
      const [debugCfg, attachCfg] = buildPyocdServerConfigs({
        configName,
        attachName,
        bgExecutable,
        elfAbsPath,
        bgTargetId,
        bgSvdEntry,
        packPaths,
        pyocdYamlRef,
        adapterSerial:  projSettings.adapterSerial,
        adapterSpeed:   projSettings.adapterSpeed,
        debugLevel:     projSettings.openocdDebugLevel,
        gdbPath,
        serverpath:     pyocdServerPath,
        debugBuildTask: debugPreLaunchLabel(bg),
        cwd:            bgCwdOf(bg),
      });
      configurations.push(debugCfg, attachCfg);
    } else if (projSettings.serverType === 'openocd') {
      const [debugCfg, attachCfg] = buildOpenocdServerConfigs({
        configName,
        attachName,
        bgExecutable,
        bgDeviceFinal,
        bgSvdEntry,
        bgConfigFiles,
        bgPreConfigCmds,
        bgServerArgs,
        openocdExe,
        gdbPath,
        debugBuildTask: debugPreLaunchLabel(bg),
        rtos:           bgRtos,
        cwd:            bgCwdOf(bg),
      });
      configurations.push(debugCfg, attachCfg);
    } else if (projSettings.serverType === 'external') {
      // servertype: 'external' — extension manages OpenOCD lifecycle via tasks.
      // Flash & Debug
      // preLaunchTask = Build & Download (debug)：build → kill old OpenOCD → Download (debug)
      // Download (debug) task programs flash then keeps OpenOCD running on port 3333.
      // cortex-debug uses servertype: 'external' to attach to the already-running OpenOCD,
      // saving the ~2-3s OpenOCD restart overhead.
      configurations.push({
        name: configName,
        type: 'cortex-debug',
        request: 'launch',
        servertype: 'external',
        gdbTarget: 'localhost:3333',
        showDevDebugOutput: 'raw',
        internalConsoleOptions: 'neverOpen',
        cwd: bgCwdOf(bg),
        executable: bgExecutable,
        device: bgDeviceFinal,
        runToEntryPoint: 'main',
        ...bgSvdEntry,
        gdbPath,
        loadFiles: [],
        preLaunchCommands: [
          'set mem inaccessible-by-default off',
          'set remotetimeout 300'
        ],
        postLaunchCommands: [
          'monitor reset halt',
          'monitor arm semihosting enable',
        ],
        preLaunchTask:  debugPreLaunchLabel(bg),
      });

      // Debug (Attach) — starts OpenOCD without flashing, connects to running target without reset.
      configurations.push({
        name: attachName,
        type: 'cortex-debug',
        request: 'attach',
        servertype: 'external',
        gdbTarget: 'localhost:3333',
        showDevDebugOutput: 'raw',
        internalConsoleOptions: 'neverOpen',
        cwd: bgCwdOf(bg),
        executable: bgExecutable,
        device: bgDeviceFinal,
        ...bgSvdEntry,
        gdbPath,
        preAttachCommands: [
          'set mem inaccessible-by-default off',
          'set remotetimeout 300'
        ],
        postAttachCommands: [
          'monitor halt',
          'monitor arm semihosting enable',
        ],
        overrideResetCommands: [
          'monitor reset halt',
          'tbreak *main',
          'continue',
        ],
        overrideRestartCommands: [
          'monitor reset halt',
          'tbreak *main',
          'continue',
        ],
        preLaunchTask:  attachPreLaunchLabel(bg),
      });
    } else {
      // Fallback — treat any unrecognised serverType as openocd (should not reach here after migration)
      const [debugCfg, attachCfg] = buildOpenocdServerConfigs({
        configName,
        attachName,
        bgExecutable,
        bgDeviceFinal,
        bgSvdEntry,
        bgConfigFiles,
        bgPreConfigCmds,
        bgServerArgs,
        openocdExe,
        gdbPath,
        debugBuildTask: debugPreLaunchLabel(bg),
        rtos:           bgRtos,
        cwd:            bgCwdOf(bg),
      });
      configurations.push(debugCfg, attachCfg);
    }

    // ----- Download task for this bg -----
    const bgTargetCfgPath = projSettings.serverType !== 'pyocd'
      ? `${bundledOpenOcdRoot}/scripts/${selectTargetCfg(extensionPath, bgMcu, bgDevice)}`  // bundledOpenOcdRoot 已含 EXT_ROOT
      : '';
    const bgElfForDl = bgElfPath || bgElfOf(bg, 'HT32', '.elf');

    if (projSettings.serverType === 'pyocd') {
      // pyOCD Download: `pyocd flash` subcommand — no OpenOCD dependency
      const pyocdExeForDl = pyocdServerPath || 'pyocd';
      const dlArgs: string[] = ['flash', '-t', bgTargetId];
      for (const p of packPathsForTask) { dlArgs.push('--pack', p); }
      if (pyocdYamlRef) { dlArgs.push('--config', pyocdYamlRef); }
      if (projSettings.adapterSerial.trim()) { dlArgs.push('--probe', projSettings.adapterSerial.trim()); }
      if (projSettings.adapterSpeed.trim()) {
        dlArgs.push('--frequency', String(Number(projSettings.adapterSpeed) * 1000));
      }
      if (projSettings.eraseMode === 'erase_chip') { dlArgs.push('--erase=chip'); }
      if (projSettings.openocdDebugLevel >= 3)      { dlArgs.push('-v', '-v'); }   // DEBUG / DEBUG_IO
      else if (projSettings.openocdDebugLevel >= 2) { dlArgs.push('-v'); }          // INFO
      // level <= 1: no flag — pyocd default is already WARNING (level 0 removed)
      dlArgs.push(bgElfForDl);
      taskList.push({
        label:          downloadLabel(bg),
        type:           'shell',
        command:        { value: pyocdExeForDl, quoting: 'strong' },
        args:           dlArgs.map(a => ({ value: a, quoting: 'strong' })),
        options:        { cwd: '${workspaceFolder}', ...(envForTasks ? { env: envForTasks } : {}) },
        problemMatcher: [],
        presentation:   { reveal: 'always', panel: 'dedicated', clear: true }
      });
      // F5 preLaunchTask：Build → Download (pyocd flash exits cleanly, no Kill OpenOCD needed)
      taskList.push({
        label:        debugPreLaunchLabel(bg),
        dependsOn:    [buildLabel(bg), downloadLabel(bg)],
        dependsOrder: 'sequence',
      });
    } else {
      // OpenOCD Download：Kill OpenOCD 確保燒錄前 probe 無人佔用
      // SkipReadID 讓 auto_obe 跳過 MCU cfg DID 驗證（HT32F493x5 無 package-generic cfg 檔）
      // erase_chip：program 內部寫死 flash write_image erase（sector erase），
      //   與 ht_flags erase_chip 的 chip erase 雙重操作導致 algorithm execution error。
      //   改用 init → reset halt → ht_flash erase_chip → ht_flash write_image，分離 erase 與 write。
      // erase_sector：program 內建 sector erase，維持原行為。
      const isChipErase = projSettings.eraseMode === 'erase_chip';
      const dlPostCmds = [
        `set_expected_name ${bgDeviceFinal} SkipReadID`,
        'init',
        'reset halt',
        ...(isChipErase ? ['ht_flash erase_chip'] : []),
        `ht_flash write_image${isChipErase ? '' : ' erase'} {${bgElfForDl}}`,
        'reset run',
        'exit',
      ];
      const dlArgs = buildOpenOcdArgs(
        [interfaceCfgPath, bgTargetCfgPath],
        bgPreConfigCmds,
        dlPostCmds,
        undefined,
        projSettings.openocdDebugLevel,
      );
      taskList.push({
        label:          downloadLabel(bg),
        type:           'shell',
        command:        { value: openocdExe, quoting: 'strong' },
        args:           dlArgs,
        dependsOn:      ['Kill OpenOCD'],
        dependsOrder:   'sequence',
        options:        { cwd: '${workspaceFolder}', ...(envForTasks ? { env: envForTasks } : {}) },
        problemMatcher: [],
        presentation:   { reveal: 'always', panel: 'dedicated', clear: true }
      });
      if (projSettings.serverType !== 'external') {
        // F5 preLaunchTask：Build → Download (Download already dependsOn Kill OpenOCD)
        taskList.push({
          label:        debugPreLaunchLabel(bg),
          dependsOn:    [buildLabel(bg), downloadLabel(bg)],
          dependsOrder: 'sequence',
        });
      }
    }

    if (projSettings.serverType === 'external') {
      // F5 preLaunchTask：Build → Download (Kill+program exit) → OpenOCD-keep (fresh start)
      taskList.push({
        label:        debugPreLaunchLabel(bg),
        dependsOn:    [buildLabel(bg), downloadLabel(bg), openocdKeepLabel(bg)],
        dependsOrder: 'sequence',
      });

      // OpenOCD background server：啟動 OpenOCD 不燒錄，等 GDB 連接。
      // Debug 和 Attach 共用同一個 task name，VS Code 若已在跑則直接 reuse。
      // Override connect_assert_srst so eLink does not SRST-reset the target on connect;
      // without this, Reset Device fails in attach mode because eLink enters a different state.
      const attachPostCmds = [
        'reset_config srst_only srst_push_pull srst_nogate',
        `set_expected_name ${bgDeviceFinal} SkipReadID`,
        `echo HT32_VSCode:READY`,
        `echo {GDB connecting...}`,
      ];
      const openocdKeepArgs = buildOpenOcdArgs(
        [interfaceCfgPath, bgTargetCfgPath],
        bgPreConfigCmds,
        attachPostCmds,
        () => false,
        projSettings.openocdDebugLevel,
      );
      taskList.push({
        label:          openocdKeepLabel(bg),
        type:           'shell',
        command:        { value: openocdExe, quoting: 'strong' },
        args:           openocdKeepArgs,
        options:        { cwd: '${workspaceFolder}', ...(envForTasks ? { env: envForTasks } : {}) },
        isBackground:   true,
        problemMatcher: {
          pattern: { regexp: '__will_not_match__', file: 1, location: 2, message: 3 },
          background: {
            activeOnStart: true,
            beginsPattern: 'Open On-Chip Debugger',
            endsPattern:   'HT32_VSCode:READY',
          }
        },
        presentation:   { reveal: 'always', panel: 'dedicated', clear: true, focus: true }
      });

      // Attach preLaunchTask：Kill → OpenOCD（不 build，不 reset）
      taskList.push({
        label:        attachPreLaunchLabel(bg),
        dependsOn:    ['Kill OpenOCD', openocdKeepLabel(bg)],
        dependsOrder: 'sequence',
      });
    }
    // yield to event loop so output channel flushes after each project (avoids all logs appearing at once)
    await new Promise<void>(r => setImmediate(r));
  }

  writeJsonPretty(path.join(vscodeDir, 'tasks.json'), { version: '2.0.0', tasks: taskList });
  writeJsonPretty(path.join(vscodeDir, 'launch.json'), { version: '0.2.0', configurations });

  // Makefile flags 重新產生（只處理本次已知有 Makefile 的 bgDirs，避免掃到同目錄下其他專案）
  // regenMakefile 預設 true；open project 路徑（initProjectsFromMeta 已做完）傳 false 跳過
  if (opts?.regenMakefile !== false) {
    await regenAllMakefileFlags(root, bgDirs.map(d => ({ name: d, dir: path.join(bgParentDir, d) })));
  }
}


/** Regenerate Makefile CFLAGS/LDFLAGS for all build-gen dirs under root.
 *  Called on webview Save and auto-save, independently of tasks/launch.json. */
async function regenAllMakefileFlags(root: string, limitToBgs?: Array<{name: string, dir: string}>): Promise<void> {
  const bgParentDir = bgParent(root);
  let bgEntries: Array<{name: string, dir: string}>;
  if (limitToBgs) {
    bgEntries = limitToBgs;
  } else {
    if (!fs.existsSync(bgParentDir)) return;
    const activeBg = vscode.workspace.getConfiguration('ht32').get<string>('activeBuildGen') || '';
    bgEntries = fs.readdirSync(bgParentDir)
      .filter(d => isBgDir(bgParentDir, d) && (!activeBg || d === activeBg))
      .sort((a, b) => (a === BG_BASE || a === BG_BASE_OLD) ? -1 : (b === BG_BASE || b === BG_BASE_OLD) ? 1 : a.localeCompare(b))
      .map(d => ({ name: d, dir: path.join(bgParentDir, d) }));
  }

  const gccPathForCCDb = await locateArmGcc();

  for (const { name: bg, dir: bgDir } of bgEntries) {
    const bgProjSettings = readProjectSettings(bgDir);
    if (!bgProjSettings.mcu) continue;
    try {
      const meta = readProjectMeta(bgDir);
      if (meta) {
        // per-file rules (--redefine-sym, -mpure-code) + CFLAGS/LDFLAGS + CCDb in one pass
        refreshDerivedFiles(bgDir, meta, { skipElfInvalidation: true });
        continue;
      }
      // fallback: no project.meta.json (very old projects), patch CFLAGS/LDFLAGS only
      const buildMeta = {
        targetName: bgProjSettings.targetName ?? bg,
        mcu:        bgProjSettings.mcu,
        fpu:        bgProjSettings.fpu !== 'none' ? bgProjSettings.fpu : undefined,
        floatAbi:   bgProjSettings.floatAbi as 'soft' | 'softfp' | 'hard' | undefined,
        ramOrigin:  bgProjSettings.ramOrigin,
        ramLength:  bgProjSettings.ramLength,
        deviceName: bgProjSettings.deviceName,
      };
      const explicitFloatAbi = bgProjSettings.floatAbi || undefined;
      const explicitFpu      = (bgProjSettings.fpu && bgProjSettings.fpu !== 'none') ? bgProjSettings.fpu : undefined;
      regenerateMakefileFlags(bgDir, buildMeta, {
        optimizationLevel: bgProjSettings.optimizationLevel || undefined,
        debugInfo:         bgProjSettings.debugInfo         || undefined,
        useNano:           bgProjSettings.useNano,
        useNosys:          bgProjSettings.useNosys,
        floatAbi:          explicitFloatAbi as 'soft' | 'softfp' | 'hard' | undefined,
        fpu:               explicitFpu,
        extraCFlags:       bgProjSettings.extraCFlags        || undefined,
        extraLDFlags:      bgProjSettings.extraLDFlags       || undefined,
        extraLibs:            (bgProjSettings.extraLibs          ?? []).filter(Boolean),
        extraLibNames:        (bgProjSettings.extraLibNames       ?? []).filter(Boolean),
        extraLibPaths:        (bgProjSettings.extraLibPaths       ?? []).filter(Boolean),
        includePaths:    (bgProjSettings.includePaths   ?? []).filter(Boolean),
        useLto:                bgProjSettings.useLto               ?? false,
        printfFloat:           bgProjSettings.printfFloat          ?? false,
        scanfFloat:            bgProjSettings.scanfFloat           ?? false,
        gcSections:            bgProjSettings.gcSections,
        cDefs:           bgProjSettings.cDefs,
        aDefs:           bgProjSettings.aDefs,
        outputName:      bgProjSettings.outputName?.trim() || undefined,
        cc:              gccPathForCCDb || undefined,
      });
      writeCCDbFromLists(bgDir, {
        armCore:      bgProjSettings.mcu,
        fpu:          explicitFpu,
        floatAbi:     explicitFloatAbi as any || undefined,
        optimization: bgProjSettings.optimizationLevel || undefined,
        debugInfo:    bgProjSettings.debugInfo || undefined,
        gccFullPath:  gccPathForCCDb ?? undefined,
        gcSections:   bgProjSettings.gcSections,
      });
    } catch (e: any) {
      logWarn(`regenAllMakefileFlags: ${bg}: ${e?.message ?? e}`);
    }
  }

  // Re-merge all per-bgDir compile_commands.json into .vscode/compile_commands.json
  const gccPath = await locateArmGcc();
  writeMakefileToolsSettings(root, bgEntries.map(e => e.name), gccPath ?? undefined);
}



/** ====== Tree View ====== */
type Meta = { projectName: string; groups: Record<string, string[]>; linkerScripts?: string[]; isLibrary?: boolean; metaVersion?: string; fileOptions?: Record<string, { exclude?: true; xo?: true; rom?: { origin: string; length: string } }> };

interface ProjectEntry {
  buildGenDir: string;   // 絕對路徑，例如 D:/xxx/OIF_ELSFP/Project_iap
  dirName: string;       // 目錄名，例如 'Project' / 'Project_iap'
  displayName: string;   // 顯示名稱（來自 meta.projectName）
  mcu?: string;          // MCU 型號（來自 project.settings.json）
  isLibrary?: boolean;   // true = 靜態函式庫輸出 (.a)
  meta?: Meta;
  files: string[];       // 後備用（沒有 meta 時）
}

/* ─────────────────────────────────────────────
 * TreeView edit helpers
 * ───────────────────────────────────────────── */

/**
 * Regenerate all derived build files from the current meta + project.settings.json,
 * without touching project.meta.json.
 * Called by persistMeta (after writing meta) and by read-only paths (open project,
 * regenAllMakefileFlags) that need to refresh build files without modifying meta.
 */
function refreshDerivedFiles(buildGenDir: string, meta: Meta, opts?: { skipElfInvalidation?: boolean }): void {

  // meta.groups paths are relative to project root (grandparent of Project dir,
  // same in both old layout .vscode/build-gen and new layout HT32_VSCode/Project).
  // Convert to buildGenDir-relative paths.
  const buildGenName = path.basename(buildGenDir); // e.g. 'Project'
  // project root = parent of HT32_VSCode (or parent of .vscode) = grandparent of buildGenDir
  const wsRoot     = path.dirname(path.dirname(buildGenDir));
  const bgParentDir = path.dirname(buildGenDir);   // e.g. HT32_VSCode/ or .vscode/
  const relUp  = path.relative(buildGenDir, wsRoot).replace(/\\/g, '/'); // '../..' in both layouts
  const allFiles: string[] = Object.values(meta.groups || {}).flat()
    .filter(f => !meta.fileOptions?.[f]?.exclude);
  const buildRelPaths = allFiles.flatMap(f => {
    const n = f.replace(/\\/g, '/');
    // Absolute path (e.g. FWLib on same drive): compute bgDir-relative directly.
    // This avoids the "../../E:/..." broken path that confuses Make's target parser.
    if (path.isAbsolute(f) || /^[A-Za-z]:\//.test(n)) {
      return [path.relative(buildGenDir, f.replace(/\//g, path.sep)).replace(/\\/g, '/')];
    }
    const absResolved = path.resolve(wsRoot, f);
    // Files inside buildGenDir (startup .s, ht32_op.c, etc.): keep as plain filename.
    // The extension filter is safe: converters only put compilable files here.
    if (absResolved.startsWith(buildGenDir + path.sep) || absResolved === buildGenDir) {
      const relToBg = path.relative(buildGenDir, absResolved).replace(/\\/g, '/');
      return /\.(c|cpp|s|S)$/i.test(relToBg) ? [relToBg] : [];
    }
    // Files in bgParentDir siblings (e.g. HT32_VSCode/GNU_ARM/startup.s, retarget.c, etc.):
    // compute bgDir-relative path directly (../GNU_ARM/<name> format).
    // Only include compilable files and archives — skip .ld and other non-build files.
    if (absResolved.startsWith(bgParentDir + path.sep)) {
      const relPath = path.relative(buildGenDir, absResolved).replace(/\\/g, '/');
      return /\.(c|cpp|s|S|a)$/i.test(relPath) ? [relPath] : [];
    }
    // workspace-root-relative (e.g. src/main.c, library files)
    return [relUp + '/' + n];
  });

  fs.writeFileSync(path.join(buildGenDir, 'sources.list'), buildRelPaths.join('\n'));

  const makefilePath = path.join(buildGenDir, 'Makefile');
  if (!fs.existsSync(makefilePath)) return;

  // Build per-file extra flags — resolve all paths to absolute first to avoid
  // format mismatches between meta.groups keys and buildRelPaths entries.
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

  // ── Unified Makefile format (SRCS :=, OBJ :=, 為每個源文件 section) ──────────
  // All three converters (uv2make, createProject, ht32ide2make) now produce this format.
  // Old-format Makefiles (OBJS :=) from pre-unification projects are no longer supported;
  // re-convert the project to get the new format.

  // 1. Replace SRCS line (compilable clean paths only)
  mk = mk.replace(/^SRCS\s*:=.*$/m, `SRCS := ${srcsClean}`);

  // 1b. Update LIBS line with .a archive paths; insert after SRCS if missing
  const libFiles = buildRelPaths.filter(s => /\.a$/i.test(s));
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

  // 2. Remove any existing "# Space-path..." comment + OBJ_SPACED line
  mk = mk.replace(/^# Space-path files[^\n]*\nOBJ_SPACED\s*:=[^\n]*\n/m, '');

  // 3. Replace OBJ := line (prepending OBJ_SPACED block if spaced paths exist)
  mk = mk.replace(/^OBJ\s*:=.*$/m, objVarBlock);

  // 4. Fully regenerate the explicit compile rules section
  // Match both Chinese (legacy) and English section headers for backwards compatibility.
  const oldRulesMatch = mk.match(/(?:# ---- \u70ba\u6bcf\u500b\u6e90\u6587\u4ef6\u751f\u6210\u5c08\u5c6c\u898f\u5247\uff08\u907f\u514d VPATH\uff09 ----|# ---- Per-source explicit rules \(avoids VPATH\) ----)[\s\S]*?(?=# ---- Dirs ----)/);
  const newRulesSection = `# ---- Per-source explicit rules (avoids VPATH) ----\n${rulesBlock}\n`;
  mk = mk.replace(
    /(?:# ---- \u70ba\u6bcf\u500b\u6e90\u6587\u4ef6\u751f\u6210\u5c08\u5c6c\u898f\u5247\uff08\u907f\u514d VPATH\uff09 ----|# ---- Per-source explicit rules \(avoids VPATH\) ----)[\s\S]*?(?=# ---- Dirs ----)/,
    newRulesSection
  );

  if (!mk.includes('# ---- Dirs ----')) {
    vscode.window.showWarningMessage(
      `Makefile in "${path.basename(buildGenDir)}" is outdated — compile rules may be incorrect. ` +
      `Run "HT32: Regenerate Makefile" from the Command Palette.`
    );
    return;
  }

  fs.writeFileSync(makefilePath, mk);

  if (oldRulesMatch && oldRulesMatch[0] !== newRulesSection) {
    try { fs.writeFileSync(path.join(buildGenDir, '.needs-rebuild'), '', 'utf8'); } catch {}
  }

  // 5. Rebuild LDFLAGS + elf dependency from meta.linkerScripts[] via shared regenerate.
  //    meta.json on disk is the authoritative source for linkerScripts[] here.
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
      });
    } catch { /* Makefile might not exist for new projects mid-creation */ }
  }

  // 5. Regenerate compile_commands.json so IntelliSense reflects the new file list
  try {
    const gccForCCDb = vscode.workspace.getConfiguration('ht32').get<string>('gccPath') || undefined;
    writeCCDbFromLists(buildGenDir, {
      armCore:     bgProjSettings.mcu || 'cortex-m0plus',
      fpu:         (bgProjSettings.fpu && bgProjSettings.fpu !== 'none') ? bgProjSettings.fpu : undefined,
      floatAbi:    bgProjSettings.floatAbi as any || undefined,
      optimization: bgProjSettings.optimizationLevel || undefined,
      debugInfo:   bgProjSettings.debugInfo || undefined,
      gccFullPath: gccForCCDb ?? undefined,
      gcSections:  bgProjSettings.gcSections,
    });
  } catch (e) {
    logWarn(`refreshDerivedFiles: compile_commands.json update failed: ${e}`);
  }

  // 6. Patch linker script ROM regions for files with rom fileOption
  if (meta.linkerScripts?.[0]) {
    const ldPath = path.resolve(buildGenDir, meta.linkerScripts[0]);
    try {
      patchLinkerScriptRom(ldPath, meta.fileOptions);
    } catch (e: any) {
      logWarn(`refreshDerivedFiles: linker script ROM patch failed: ${e?.message ?? e}`);
    }
  }

  // 7. Invalidate stale ELF/bin so Make is forced to re-link on next build.
  //    Without this, Make sees all remaining .o files are newer than the ELF
  //    and skips re-linking, leaving the old binary (with removed files still
  //    linked in) intact.
  //    Skipped on open-project (initProjectsFromMeta) where no files were added/removed.
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
      logWarn(`refreshDerivedFiles: stale ELF cleanup failed: ${e}`);
    }
  }
}

/**
 * Persist meta changes to disk and refresh all derived build files.
 * Use this when meta content has actually changed (TreeView edits, convert, create project).
 * For read-only paths (open project, regenAllMakefileFlags), use refreshDerivedFiles directly.
 */
function persistMeta(buildGenDir: string, meta: Meta, opts?: { skipElfInvalidation?: boolean }): void {
  if (extensionVersion) { meta.metaVersion = extensionVersion; }
  fs.writeFileSync(path.join(buildGenDir, 'project.meta.json'), JSON.stringify(meta, null, 2));
  refreshDerivedFiles(buildGenDir, meta, opts);
}

/** Parse file item id: "{buildGenDir}::{groupName}::{filePath}" */
function parseFileItemId(id: string): { buildGenDir: string; groupName: string; filePath: string } | null {
  const sep1 = id.indexOf('::');
  if (sep1 < 0) return null;
  const sep2 = id.indexOf('::', sep1 + 2);
  if (sep2 < 0) return null;
  return {
    buildGenDir: id.slice(0, sep1),
    groupName:   id.slice(sep1 + 2, sep2),
    filePath:    id.slice(sep2 + 2),
  };
}

/** Read project.meta.json; returns null if missing/invalid */
function readProjectMeta(buildGenDir: string): Meta | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(buildGenDir, 'project.meta.json'), 'utf8')) as Meta;
  } catch { return null; }
}

/** Validate project.meta.json and project.settings.json for a bgDir.
 *  Returns an error string if either file is missing or contains invalid JSON, null if OK. */
function validateProjectFiles(bgDir: string): string | null {
  for (const fname of ['project.meta.json', 'project.settings.json']) {
    const fpath = path.join(bgDir, fname);
    if (!fs.existsSync(fpath)) return `${fname} missing`;
    try { JSON.parse(fs.readFileSync(fpath, 'utf8')); }
    catch { return `${fname} contains invalid JSON`; }
  }
  return null;
}

function registerTreeEditCommands(
  ctx: vscode.ExtensionContext,
  tree: ProjectTreeProvider,
  treeView: vscode.TreeView<vscode.TreeItem>
): void {
  const root = () => currentWsRoot();

  // Reveal project source root in OS file manager
  ctx.subscriptions.push(vscode.commands.registerCommand('ht32.treeRevealProjectFolder', async (item: vscode.TreeItem) => {
    const buildGenDir = item.id;
    if (!buildGenDir) return;
    // buildGenDir = …/HT32_VSCode/Project  → HT32_VSCode is the workspace/source root
    const sourceRoot = path.dirname(buildGenDir);
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(sourceRoot));
  }));

  // Add Group (right-click on project node)
  ctx.subscriptions.push(vscode.commands.registerCommand('ht32.treeAddGroup', async (item: vscode.TreeItem) => {
    const buildGenDir = item.id;
    if (!buildGenDir) return;
    const name = await vscode.window.showInputBox({ prompt: 'New group name', placeHolder: 'e.g. user' });
    if (!name?.trim()) return;
    const meta = readProjectMeta(buildGenDir);
    if (!meta) return;
    if (!meta.groups) meta.groups = {};
    if (meta.groups[name]) { vscode.window.showWarningMessage(`Group "${name}" already exists.`); return; }
    meta.groups[name] = [];
    persistMeta(buildGenDir, meta);
    tree.refresh();
    // Reveal the new group so user sees it without manually expanding
    const newGroupItem = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.Expanded);
    newGroupItem.id = `${buildGenDir}::${name}`;
    (newGroupItem as any).contextValue = 'group';
    try { await treeView.reveal(newGroupItem, { expand: false, focus: false, select: true }); } catch {}
  }));

  // Add Files to Group (right-click on group node)
  const addFilesToGroupImpl = async (buildGenDir: string, groupName: string, uris: vscode.Uri[]) => {
    const meta = readProjectMeta(buildGenDir);
    if (!meta) return;
    if (!meta.groups) meta.groups = {};
    const existing = new Set<string>(meta.groups[groupName] ?? []);
    // Use project root (grandparent of buildGenDir) as the base for relative paths.
    // This matches the base used by buildProjectMeta() during conversion and by refreshDerivedFiles().
    // DO NOT use root() here — for new-layout projects root() points to HT32_VSCode/, which is
    // one level shallower than project root, causing paths like "../foo.a" that resolve incorrectly.
    const projectRoot = path.dirname(path.dirname(buildGenDir));
    for (const uri of uris) {
      const rel = path.relative(projectRoot, uri.fsPath).replace(/\\/g, '/');
      existing.add(rel);
    }
    meta.groups[groupName] = Array.from(existing);

    // .ld files also go into linkerScripts[] (bgDir-relative) so Makefile picks them up with -T
    const ldUris = uris.filter(u => u.fsPath.toLowerCase().endsWith('.ld'));
    if (ldUris.length) {
      const existingLd = new Set<string>(meta.linkerScripts ?? ['../GNU_ARM/linker.ld']);
      for (const u of ldUris) {
        existingLd.add(path.relative(buildGenDir, u.fsPath).replace(/\\/g, '/'));
      }
      meta.linkerScripts = Array.from(existingLd);
      notifySettingsLinkerScriptsChanged(path.basename(buildGenDir), meta.linkerScripts);
    }

    persistMeta(buildGenDir, meta);
    tree.refresh();
    const groupItem = new vscode.TreeItem(groupName, vscode.TreeItemCollapsibleState.Expanded);
    groupItem.id = `${buildGenDir}::${groupName}`;
    (groupItem as any).contextValue = 'group';
    try { await treeView.reveal(groupItem, { expand: true, focus: false, select: false }); } catch {}
  };

  ctx.subscriptions.push(vscode.commands.registerCommand('ht32.treeAddExistingFilesToGroup', async (item: vscode.TreeItem) => {
    if (!root()) return;
    const id = item.id || '';
    const sep = id.indexOf('::');
    if (sep < 0) return;
    const buildGenDir = id.slice(0, sep);
    const groupName   = id.slice(sep + 2);

    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFolders: false,
      openLabel: 'Add Existing Files to Group',
      filters: { 'Source & Library Files': ['c', 'C', 's', 'S', 'cpp', 'a', 'o', 'obj', 'ld'] },
    });
    if (!uris || uris.length === 0) return;
    await addFilesToGroupImpl(buildGenDir, groupName, uris);
  }));

  ctx.subscriptions.push(vscode.commands.registerCommand('ht32.treeAddNewFilesToGroup', async (item: vscode.TreeItem) => {
    if (!root()) return;
    const id = item.id || '';
    const sep = id.indexOf('::');
    if (sep < 0) return;
    const buildGenDir = id.slice(0, sep);
    const groupName   = id.slice(sep + 2);
    const projectRoot = path.dirname(path.dirname(buildGenDir));

    const saveUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(projectRoot, 'new_file.c')),
      filters: { 'Source Files': ['c', 'cpp', 's', 'h'] },
      saveLabel: 'Create + Add to Group',
      title: 'New File',
    });
    if (!saveUri) return;
    if (!fs.existsSync(saveUri.fsPath)) {
      fs.mkdirSync(path.dirname(saveUri.fsPath), { recursive: true });
      fs.writeFileSync(saveUri.fsPath, '', 'utf8');
    }
    await addFilesToGroupImpl(buildGenDir, groupName, [saveUri]);
    await vscode.window.showTextDocument(saveUri);
  }));

  // Remove Group (right-click on group node)
  ctx.subscriptions.push(vscode.commands.registerCommand('ht32.treeRemoveGroup', async (item: vscode.TreeItem) => {
    const id = item.id || '';
    const sep = id.indexOf('::');
    if (sep < 0) return;
    const buildGenDir = id.slice(0, sep);
    const groupName   = id.slice(sep + 2);

    const confirmed = await vscode.window.showWarningMessage(
      `Remove group "${groupName}" and all its files from the project?`,
      { modal: true }, 'Remove'
    );
    if (confirmed !== 'Remove') return;

    const meta = readProjectMeta(buildGenDir);
    if (!meta?.groups) return;
    delete meta.groups[groupName];
    persistMeta(buildGenDir, meta);
    tree.refresh();
  }));

  // Remove File (right-click on file node)
  ctx.subscriptions.push(vscode.commands.registerCommand('ht32.treeRemoveFile', async (item: vscode.TreeItem) => {
    const parsed = parseFileItemId(item.id || '');
    if (!parsed) return;
    const { buildGenDir, groupName, filePath } = parsed;

    const meta = readProjectMeta(buildGenDir);
    if (!meta?.groups?.[groupName]) return;
    meta.groups[groupName] = meta.groups[groupName].filter((f: string) => f !== filePath);
    // If the removed file is a .ld, also remove it from linkerScripts[]
    if (filePath.toLowerCase().endsWith('.ld') && meta.linkerScripts) {
      const ldRel = path.relative(buildGenDir, path.resolve(path.dirname(path.dirname(buildGenDir)), filePath)).replace(/\\/g, '/');
      meta.linkerScripts = meta.linkerScripts.filter((s: string) => s !== ldRel);
      notifySettingsLinkerScriptsChanged(path.basename(buildGenDir), meta.linkerScripts);
    }
    persistMeta(buildGenDir, meta);
    tree.refresh();
  }));

  // Delete File from disk (Delete key / right-click → Delete File)
  ctx.subscriptions.push(vscode.commands.registerCommand('ht32.treeDeleteFile', async (item?: vscode.TreeItem) => {
    // Keyboard shortcut doesn't pass item; fall back to tree selection
    const target = item ?? treeView.selection[0];
    if (!target) return;
    const parsed = parseFileItemId(target.id || '');
    if (!parsed || (target.contextValue !== 'file' && target.contextValue !== 'linkerFile')) return;
    const { buildGenDir, groupName, filePath } = parsed;

    const absPath = target.resourceUri?.fsPath ?? path.resolve(tree.getRoot() ?? '', filePath);
    const fileName = path.basename(absPath);
    const answer = await vscode.window.showWarningMessage(
      `Delete "${fileName}"? This will move it to the recycle bin.`,
      { modal: true }, 'Yes'
    );
    if (answer !== 'Yes') return;

    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(absPath), { useTrash: true });
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to delete "${fileName}": ${e}`);
      return;
    }

    const meta = readProjectMeta(buildGenDir);
    if (meta?.groups?.[groupName]) {
      meta.groups[groupName] = meta.groups[groupName].filter((f: string) => f !== filePath);
      if (filePath.toLowerCase().endsWith('.ld') && meta.linkerScripts) {
        const ldRel = path.relative(buildGenDir, path.resolve(path.dirname(path.dirname(buildGenDir)), filePath)).replace(/\\/g, '/');
        meta.linkerScripts = meta.linkerScripts.filter((s: string) => s !== ldRel);
        notifySettingsLinkerScriptsChanged(path.basename(buildGenDir), meta.linkerScripts);
      }
      persistMeta(buildGenDir, meta);
    }
    tree.refresh();
  }));

  // Move Project Up / Down — reorder projects[] in .ht32vs, refresh TreeView + regenerate tasks
  const moveProject = async (item: vscode.TreeItem, delta: -1 | 1) => {
    const bgDir = item.id!;
    const bgName = path.basename(bgDir);
    const bgParentDir = path.dirname(bgDir);
    let ht32vsName = '';
    try { ht32vsName = JSON.parse(fs.readFileSync(path.join(bgParentDir, '.vscode', 'settings.json'), 'utf8'))['ht32.activeProjectFile'] ?? ''; } catch {}
    if (!ht32vsName) return;
    const ht32vsPath = path.join(bgParentDir, ht32vsName);
    let projects: string[] = [];
    projects = parseHt32vsFile(ht32vsPath)?.projects ?? [];
    const idx = projects.indexOf(bgName);
    const newIdx = idx + delta;
    if (idx < 0 || newIdx < 0 || newIdx >= projects.length) return;
    [projects[idx], projects[newIdx]] = [projects[newIdx], projects[idx]];
    fs.writeFileSync(ht32vsPath, JSON.stringify({ projects }, null, 2), 'utf8');
    tree.refresh();
    const wsRoot = tree.getRoot();
    if (wsRoot) await generateTasksAndLaunchAndMakefile(wsRoot);
  };
  ctx.subscriptions.push(vscode.commands.registerCommand('ht32.treeMoveProjectUp',   (item: vscode.TreeItem) => moveProject(item, -1)));
  ctx.subscriptions.push(vscode.commands.registerCommand('ht32.treeMoveProjectDown', (item: vscode.TreeItem) => moveProject(item,  1)));

  // Per-file Settings (right-click on file node)
  ctx.subscriptions.push(vscode.commands.registerCommand('ht32.treeFileSettings', async (item: vscode.TreeItem) => {
    const parsed = parseFileItemId(item.id || '');
    if (!parsed) return;
    const { buildGenDir, filePath } = parsed;

    const meta = readProjectMeta(buildGenDir);
    if (!meta) return;

    type FO = { exclude?: true; xo?: true; rom?: { origin: string; length: string } };
    const fo: FO = { ...(meta.fileOptions?.[filePath] ?? {}) };
    const fileName = path.basename(filePath);

    // Parse available ROM regions from the linker script
    const romRegions = ldRomRegions(buildGenDir, meta);

    const numOrigin = (v: string) => /^0x/i.test(v) ? parseInt(v, 16) : parseInt(v, 10);
    const regionNameFor = (rom: { origin: string; length: string } | undefined): string => {
      if (!rom) return 'default (FLASH)';
      const n = numOrigin(rom.origin);
      return romRegions.find(r => numOrigin(r.origin) === n)?.name ?? `0x${n.toString(16)}`;
    };

    while (true) {
      const exIcon = fo.exclude ? '$(check)' : '$(blank)';
      const xoIcon = fo.xo     ? '$(check)' : '$(blank)';
      const romLabel = `ROM: ${regionNameFor(fo.rom)}`;

      type ActionItem = vscode.QuickPickItem & { id: string };
      const action = await vscode.window.showQuickPick<ActionItem>([
        { label: `${exIcon} Exclude from build`,       id: 'exclude',  description: fo.exclude ? 'enabled' : '' },
        { label: `${xoIcon} Execute-only (-mpure-code)`,id: 'xo',      description: fo.xo ? 'enabled' : '' },
        { label: `$(database) ${romLabel}`,             id: 'rom',      description: 'select region...' },
        { label: '$(check) Apply',                      id: 'apply',    description: 'save and regenerate Makefile' },
        { label: '$(discard) Cancel',                   id: 'cancel' },
      ], { title: `File Settings: ${fileName}`, placeHolder: 'Select a setting to toggle or Apply to save' });

      if (!action || action.id === 'cancel') return;

      if (action.id === 'exclude') {
        fo.exclude = fo.exclude ? undefined : true;
      } else if (action.id === 'xo') {
        fo.xo = fo.xo ? undefined : true;
      } else if (action.id === 'rom') {
        type RegionItem = vscode.QuickPickItem & { rom: FO['rom'] };
        const currentN = fo.rom ? numOrigin(fo.rom.origin) : -1;
        const regionItems: RegionItem[] = [
          { label: '$(dash) Default (FLASH)', description: 'use primary flash region', rom: undefined, picked: !fo.rom },
          ...romRegions.map(r => ({
            label: `$(database) ${r.name}`,
            description: `ORIGIN = ${r.origin}, LENGTH = ${r.length}`,
            rom: { origin: r.origin, length: r.length } as FO['rom'],
            picked: numOrigin(r.origin) === currentN,
          })),
        ];
        const picked = await vscode.window.showQuickPick<RegionItem>(regionItems, {
          title: `ROM Region for ${fileName}`,
          placeHolder: 'Choose which memory region to place this file\'s code in',
        });
        if (picked !== undefined) fo.rom = picked.rom;
      } else if (action.id === 'apply') {
        break;
      }
    }

    // Write back to meta.fileOptions
    const cleaned: FO = {};
    if (fo.exclude) cleaned.exclude = true;
    if (fo.xo)     cleaned.xo = true;
    if (fo.rom)    cleaned.rom = fo.rom;

    if (!meta.fileOptions) meta.fileOptions = {};
    if (Object.keys(cleaned).length) {
      meta.fileOptions[filePath] = cleaned;
    } else {
      delete meta.fileOptions[filePath];
    }
    if (!Object.keys(meta.fileOptions).length) delete meta.fileOptions;

    persistMeta(buildGenDir, meta);
    tree.refresh();
  }));
}

/** Parse ROM (non-writeable) MEMORY regions from the project's linker script */
function ldRomRegions(buildGenDir: string, meta: Meta): Array<{ name: string; origin: string; length: string }> {
  const ldRel = meta.linkerScripts?.[0];
  if (!ldRel) return [];
  const ldPath = path.join(buildGenDir, ldRel);
  if (!fs.existsSync(ldPath)) return [];
  try {
    const ld = fs.readFileSync(ldPath, 'utf8');
    const re = /^\s*(\w+)\s*\(([^)]*)\)\s*:\s*ORIGIN\s*=\s*(0x[0-9a-fA-F]+|\d+)\s*,\s*LENGTH\s*=\s*([^\n,}]+)/gm;
    const results: Array<{ name: string; origin: string; length: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(ld)) !== null) {
      const flags = m[2];
      if (!flags.includes('w')) {  // no write flag → ROM
        results.push({ name: m[1], origin: m[3].trim(), length: m[4].trim() });
      }
    }
    return results;
  } catch { return []; }
}

/** ====== Recent Projects ====== */
const RECENT_KEY = 'ht32.recentProjects';
const RECENT_MAX = 10;

async function removeRecentProject(ctx: vscode.ExtensionContext, folderPath: string): Promise<void> {
  const list = (ctx.globalState.get<string[]>(RECENT_KEY, [])).filter(p => p !== folderPath);
  await ctx.globalState.update(RECENT_KEY, list);
  if (list.length === 0) { await vscode.commands.executeCommand('setContext', 'ht32.hasRecent', false); }
  _recentTree?.refresh();
}

async function addRecentProject(ctx: vscode.ExtensionContext, folderPath: string): Promise<void> {
  const list = (ctx.globalState.get<string[]>(RECENT_KEY, [])).filter(p => p !== folderPath);
  list.unshift(folderPath);
  await ctx.globalState.update(RECENT_KEY, list.slice(0, RECENT_MAX));
  await vscode.commands.executeCommand('setContext', 'ht32.hasRecent', true);
  _recentTree?.refresh();
}

function pruneRecentProjects(ctx: vscode.ExtensionContext): string[] {
  const all  = ctx.globalState.get<string[]>(RECENT_KEY, []);
  const live = all.filter(p => fs.existsSync(p));
  if (live.length !== all.length) { ctx.globalState.update(RECENT_KEY, live); }
  return live;
}

/** Create or update a .ht32vs project file and set it as active in .vscode/settings.json.
 *  Format: { "projects": ["Project_AP", "Project_IAP"] }
 *  Merges with existing list so previously added dirs are preserved.
 *  Returns the full path of the .ht32vs file. */
function writeOrUpdateProjectFile(bgParentDir: string, bgDirs: string[], projectName: string): string {
  const ht32wsPath = path.join(bgParentDir, projectName + '.ht32vs');
  let prevProjects: string[] = [];
  if (fs.existsSync(ht32wsPath)) {
    prevProjects = parseHt32vsFile(ht32wsPath)?.projects ?? [];
  }
  const merged = [...new Set([...prevProjects, ...bgDirs])];
  fs.writeFileSync(ht32wsPath, JSON.stringify({ projects: merged }, null, 2), 'utf8');

  // Write ht32.activeProjectFile into .vscode/settings.json so TreeView filters correctly
  // after the next openFolder (or immediately if already in bgParentDir).
  const settingsPath = path.join(bgParentDir, '.vscode', 'settings.json');
  let settings: any = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
  }
  settings['ht32.activeProjectFile'] = projectName + '.ht32vs';
  try {
    fs.mkdirSync(path.join(bgParentDir, '.vscode'), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  } catch {}

  return ht32wsPath;
}

class ProjectTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _em = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._em.event;

  private root?: string;
  private projects: ProjectEntry[] = [];
  private _clangdActiveBgDir = '';
  private _loading = false;

  setRoot(r: string | undefined) {
    this.root = r;
    if (r) { this._initClangdFromFile(r); } else { this._clangdActiveBgDir = ''; }
  }
  getRoot() { return this.root; }

  setClangdActive(bgDir: string) {
    if (this._clangdActiveBgDir === bgDir) return;
    this._clangdActiveBgDir = bgDir;
    this._em.fire();
  }

  private _initClangdFromFile(root: string) {
    try {
      const clangdPath = path.join(root, '.clangd');
      const content = fs.readFileSync(clangdPath, 'utf8');
      const match = content.match(/CompilationDatabase:\s*(\S+)/);
      if (!match) return;
      const bgName = match[1].replace(/\\/g, '/').split('/').pop();
      if (bgName) this._clangdActiveBgDir = path.join(root, bgName);
    } catch { /* non-critical */ }
  }

  setLoading(v: boolean) {
    this._loading = v;
    this._em.fire();
  }

  refresh() {
    this._loading = false;
    if (!this.root) { this._em.fire(); return; }
    this.projects = this.scanProjects(this.root);
    this._em.fire();
  }

  private scanProjects(root: string): ProjectEntry[] {
    const parent = bgParent(root);
    if (!fs.existsSync(parent)) return [];
    // Read directly from settings.json to avoid VS Code config API cache lag after update().
    const wsRoot = computeWsOpenRoot(root);
    let _settingsData: any = {};
    try { _settingsData = JSON.parse(fs.readFileSync(path.join(wsRoot, '.vscode', 'settings.json'), 'utf8')); } catch {}
    const activeBg: string = _settingsData['ht32.activeBuildGen'] || '';
    // If ht32.activeProjectFile is set, read the .ht32vs file and filter to listed projects only.
    let wsAllowedDirs: Set<string> | undefined;
    let wsProjectOrder: string[] | undefined;
    const _activeFile: string | undefined = _settingsData['ht32.activeProjectFile'];
    if (_activeFile) {
      const _ht32wsPath = path.isAbsolute(_activeFile) ? _activeFile : path.join(parent, _activeFile);
      const _ws = parseHt32vsFile(_ht32wsPath);
      if (_ws && Array.isArray(_ws.projects) && _ws.projects.length > 0) {
        wsProjectOrder = _ws.projects.filter((p: unknown): p is string => typeof p === 'string');
        wsAllowedDirs = new Set(wsProjectOrder);
      }
    }
    let dirs: string[];
    try {
      const allBgDirs = fs.readdirSync(parent).filter(d => isBgDir(parent, d));
      dirs = allBgDirs
        .filter(d =>
          (!activeBg || d === activeBg) &&
          (!wsAllowedDirs || wsAllowedDirs.has(d)));
      // Safety net: if filters produce no results but project dirs exist on disk,
      // fall back to showing all (stale activeBuildGen or .ht32vs name mismatch).
      if (dirs.length === 0 && allBgDirs.length > 0) {
        dirs = allBgDirs;
        wsProjectOrder = undefined;
      }
      if (wsProjectOrder) {
        // Sort by .ht32vs projects[] order; dirs not in the list fall to the end alphabetically
        const orderMap = new Map(wsProjectOrder.map((p, i) => [p, i]));
        dirs.sort((a, b) => (orderMap.get(a) ?? 9999) - (orderMap.get(b) ?? 9999) || a.localeCompare(b));
      } else {
        dirs.sort((a, b) => (a === BG_BASE || a === BG_BASE_OLD) ? -1 : (b === BG_BASE || b === BG_BASE_OLD) ? 1 : a.localeCompare(b));
      }
    } catch { return []; }

    return dirs.map(dirName => {
      const buildGenDir = path.join(parent, dirName);
      let meta: Meta | undefined;
      let files: string[] = [];

      const metaFile = path.join(buildGenDir, 'project.meta.json');
      if (fs.existsSync(metaFile)) {
        try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as Meta; } catch {}
      }
      if (!meta) {
        const ccFile  = path.join(buildGenDir, 'compile_commands.json');
        const srcFile = path.join(buildGenDir, 'sources.list');
        if (fs.existsSync(ccFile)) {
          try {
            const arr = JSON.parse(fs.readFileSync(ccFile, 'utf8')) as any[];
            files = [...new Set(arr.map((x: any) => path.relative(root, x.file)))].sort();
          } catch {}
        } else if (fs.existsSync(srcFile)) {
          files = fs.readFileSync(srcFile, 'utf8').split(/\r?\n/).filter(Boolean);
        }
      }

      // 顯示名稱：直接用目錄名稱
      const displayName = dirName;

      // MCU 型號：來自 project.settings.json
      const bgS = readProjectSettings(buildGenDir);
      const mcu = bgS.deviceName || bgS.mcu;
      const isLibrary = meta?.isLibrary ?? false;

      return { buildGenDir, dirName, displayName, mcu, isLibrary, meta, files };
    });
  }

  async expandAll(treeView: vscode.TreeView<vscode.TreeItem>) {
    try {
      for (const proj of this.projects) {
        const groupNames = proj.meta?.groups
          ? Object.keys(proj.meta.groups)
          : this.inferGroupNames(proj.files);
        for (const g of groupNames) {
          const item = new vscode.TreeItem(g, vscode.TreeItemCollapsibleState.Expanded);
          item.id = `${proj.buildGenDir}::${g}`;
          (item as any).contextValue = 'group';
          await treeView.reveal(item, { expand: true, focus: false, select: false });
        }
      }
    } catch { /* ignore */ }
  }

  getTreeItem(el: vscode.TreeItem) { return el; }

  getChildren(el?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
    if (!this.root) {
      if (this._loading && !el) {
        const item = new vscode.TreeItem('Loading project...', vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('loading~spin');
        return Promise.resolve([item]);
      }
      return Promise.resolve([]);
    }

    // 根層：.vscode 節點（顯示 .ht32vs 檔名）+ 每個 build-gen*/ 專案節點
    if (!el) {
      const items: vscode.TreeItem[] = [];
      const vscodeDir = path.join(this.root!, '.vscode');
      if (fs.existsSync(vscodeDir)) {
        let _activeFile = '';
        try { _activeFile = JSON.parse(fs.readFileSync(path.join(computeWsOpenRoot(this.root!), '.vscode', 'settings.json'), 'utf8'))['ht32.activeProjectFile'] || ''; } catch {}
        const _rootLabel = _activeFile ? path.basename(_activeFile, '.ht32vs') : '.vscode';
        const vscodeItem = new vscode.TreeItem(_rootLabel, vscode.TreeItemCollapsibleState.Expanded);
        vscodeItem.contextValue = _activeFile ? 'vscodeRoot' : 'vscodeRootFolder';
        vscodeItem.id = vscodeDir;
        vscodeItem.iconPath = new vscode.ThemeIcon('folder-library');
        items.push(vscodeItem);
      }
      items.push(...this.projects.map(proj => {
        const item = new vscode.TreeItem(proj.displayName, vscode.TreeItemCollapsibleState.Expanded);
        item.contextValue = 'project';
        item.id = proj.buildGenDir;
        item.iconPath = new vscode.ThemeIcon(proj.isLibrary ? 'package' : 'circuit-board');
        const isClangdActive = this.projects.length > 1 && proj.buildGenDir === this._clangdActiveBgDir;
        const descParts = [proj.mcu, proj.isLibrary ? 'lib' : '', isClangdActive ? '● clangd' : ''].filter(Boolean);
        if (descParts.length) item.description = descParts.join(' · ');
        item.tooltip = proj.buildGenDir + (isClangdActive ? '\n● clangd active' : '');
        return item;
      }));
      return Promise.resolve(items);
    }

    // .vscode 節點 → 直接子 .json 檔
    if ((el as any).contextValue === 'vscodeRoot' || (el as any).contextValue === 'vscodeRootFolder') {
      const vscodeDir = el.id!;
      let jsonItems: vscode.TreeItem[] = [];
      try {
        jsonItems = fs.readdirSync(vscodeDir)
          .filter(f => f.endsWith('.json') && fs.statSync(path.join(vscodeDir, f)).isFile())
          .sort()
          .map(f => {
            const fullPath = path.join(vscodeDir, f);
            const it = new vscode.TreeItem(f, vscode.TreeItemCollapsibleState.None);
            it.id = fullPath;
            it.contextValue = 'configFile';
            it.resourceUri = vscode.Uri.file(fullPath);
            it.command = { command: 'vscode.open', title: 'Open', arguments: [it.resourceUri] };
            return it;
          });
      } catch {}
      return Promise.resolve(jsonItems);
    }

    if (this.projects.length === 0) return Promise.resolve([]);

    // 專案節點 → group 節點
    if ((el as any).contextValue === 'project') {
      const proj = this.projects.find(p => p.buildGenDir === el.id);
      if (!proj) return Promise.resolve([]);
      return Promise.resolve(this.buildGroupItems(proj));
    }

    // group 節點 → file 節點（id 格式：'buildGenDir::groupName'）
    if ((el as any).contextValue === 'group') {
      const sep = (el.id || '').indexOf('::');
      if (sep < 0) return Promise.resolve([]);
      const buildGenDir = el.id!.slice(0, sep);
      const groupName   = el.id!.slice(sep + 2);
      const proj = this.projects.find(p => p.buildGenDir === buildGenDir);
      if (!proj) return Promise.resolve([]);
      const files = this.getFilesOfGroup(proj, groupName);
      // meta.groups paths are relative to project root (grandparent of build-gen dir),
      // which is always path.dirname(path.dirname(buildGenDir)) in both old and new layout.
      const fileBase = path.dirname(path.dirname(buildGenDir));
      return Promise.resolve(files.map(f => {
        const it = new vscode.TreeItem(path.basename(f), vscode.TreeItemCollapsibleState.None);
        it.id           = `${buildGenDir}::${groupName}::${f}`;
        it.contextValue = f.toLowerCase().endsWith('.ld') ? 'linkerFile' : 'file';
        it.resourceUri  = vscode.Uri.file(path.resolve(fileBase, f));
        it.tooltip      = path.resolve(fileBase, f);
        const descParts: string[] = [];

        const fo = proj.meta?.fileOptions?.[f];
        if (fo?.exclude) {
          it.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
          descParts.push('[excluded]');
        } else {
          const tags: string[] = [];
          if (fo?.xo)  tags.push('xo');
          if (fo?.rom) tags.push('rom');
          if (tags.length) descParts.push(`[${tags.join(',')}]`);
        }
        if (descParts.length) it.description = descParts.join(' ');

        if (!/\.(o|a|obj|lib)$/i.test(f)) {
          it.command = { command: 'vscode.open', title: 'Open', arguments: [it.resourceUri] };
        }
        return it;
      }));
    }

    return Promise.resolve([]);
  }

  private buildGroupItems(proj: ProjectEntry): vscode.TreeItem[] {
    const groupNames = (proj.meta?.groups
      ? Object.keys(proj.meta.groups)
      : this.inferGroupNames(proj.files)
    ).filter(g => !g.startsWith('__')) // guard against any future internal __ groups
     .sort((a, b) => (a === 'Linker' ? 1 : b === 'Linker' ? -1 : 0));
    return groupNames.map(g => {
      const item = new vscode.TreeItem(g, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = 'group';
      item.id = `${proj.buildGenDir}::${g}`;
      return item;
    });
  }

  private inferGroupNames(files: string[]): string[] {
    const seen = new Set<string>();
    for (const f of files) seen.add(f.includes('/') ? f.split('/')[0] : '(root)');
    return Array.from(seen);
  }

  private getFilesOfGroup(proj: ProjectEntry, groupName: string): string[] {
    if (proj.meta?.groups?.[groupName]) return proj.meta.groups[groupName];
    return proj.files.filter(f => {
      const first = f.includes('/') ? f.split('/')[0] : '(root)';
      return first === groupName;
    });
  }
}

/** ====== Recent Projects Tree View ====== */
class RecentTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _em = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._em.event;

  constructor(private readonly _ctx: vscode.ExtensionContext) {}

  refresh() { this._em.fire(); }

  getTreeItem(el: vscode.TreeItem) { return el; }

  getChildren(): Thenable<vscode.TreeItem[]> {
    const recents = pruneRecentProjects(this._ctx);
    return Promise.resolve(recents.map(p => {
      let label: string;
      let icon: vscode.ThemeIcon;
      if (p.toLowerCase().endsWith('.ht32vs')) {
        label = path.basename(p, '.ht32vs');
        icon  = new vscode.ThemeIcon('folder-library');
      } else {
        // Legacy folder entry
        const wsName = path.basename(p);
        label = wsName.toLowerCase() === 'ht32_vscode' ? path.basename(path.dirname(p)) : wsName;
        icon  = new vscode.ThemeIcon('folder');
      }
      const it = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      it.id           = `recent::${p}`;
      it.contextValue = 'recentProject';
      it.description  = p;
      it.iconPath     = icon;
      it.tooltip      = p;
      it.command      = { command: 'ht32.openRecentProject', title: 'Open', arguments: [p] };
      return it;
    }));
  }
}

/** ====== DFP pack update ====== */

const HOLTEK_PACK_BASE = 'https://www.holtek.com.tw/pack';
let _extracting: Promise<void> | null = null;
const DFP_CHECK_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** HTTPS GET with redirect following (301-308) and 15s timeout. Returns response body as Buffer.
 *  extraHeaders are forwarded on every hop. */
function httpsGet(url: string, redirectsLeft = 5, extraHeaders: Record<string, string> = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': 'ht32-vscode', ...extraHeaders },
    }, res => {
      if (res.statusCode && res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location) {
        if (redirectsLeft <= 0) { res.resume(); return reject(new Error('Too many redirects')); }
        resolve(httpsGet(new URL(res.headers.location, url).toString(), redirectsLeft - 1, extraHeaders));
        res.resume();
        return;
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('Request timed out')));
  });
}

/** Fetch the pack list from Holtek.pidx.
 *  Returns one entry per pack with the latest version and download URL. */
async function fetchHoltekPidx(): Promise<{ name: string; download_url: string; version: string }[]> {
  const buf = await httpsGet(`${HOLTEK_PACK_BASE}/Holtek.pidx`);
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' }).parse(buf.toString('utf8'));
  const entries: any[] = doc?.index?.pindex?.pdsc ?? [];
  const list = Array.isArray(entries) ? entries : [entries];
  return list
    .filter((e: any) => e.vendor && e.name && e.version)
    .map((e: any) => {
      const fileName = `${e.vendor}.${e.name}.${e.version}.pack`;
      return { name: fileName, download_url: `${HOLTEK_PACK_BASE}/${fileName}`, version: e.version };
    });
}

/** Download a URL to a local file. */
async function downloadFileTo(url: string, destPath: string): Promise<void> {
  const buf = await httpsGet(url);
  fs.writeFileSync(destPath, buf);
}

/** Extract any .pack files in extPath/dfp/ that haven't been extracted yet. */
async function extractDfpPacksIfNeeded(extPath: string): Promise<void> {
  if (_extracting) return _extracting;
  _extracting = _doExtractDfpPacks(extPath).finally(() => { _extracting = null; });
  return _extracting;
}
async function _doExtractDfpPacks(extPath: string): Promise<void> {
  const dfpDir = path.join(extPath, 'dfp');
  let packs: string[];
  try { packs = fs.readdirSync(dfpDir).filter(f => /^Holtek\..+\.pack$/i.test(f)); }
  catch { return; }

  const pending = packs.filter(packFile => {
    const m = /^Holtek\.(.+?)\.([\d.]+)\.pack$/i.exec(packFile);
    if (!m) return false;
    const [, packName, version] = m;
    return !fs.existsSync(path.join(dfpDir, 'Holtek', packName, version, `Holtek.${packName}.pdsc`));
  });

  if (pending.length === 0) return;

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'HT32: Initializing DFP data',
    cancellable: false,
  }, async (progress) => {
    for (let i = 0; i < pending.length; i++) {
      const packFile = pending[i];
      const m = /^Holtek\.(.+?)\.([\d.]+)\.pack$/i.exec(packFile)!;
      const [, packName, version] = m;
      const targetDir = path.join(dfpDir, 'Holtek', packName, version);
      progress.report({ message: `${packFile} (${i + 1}/${pending.length})` });
      logInfo(`[DFP] Extracting ${packFile} → Holtek/${packName}/${version}/`);
      const tempDir = targetDir + '._tmp';
      try {
        if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        fs.mkdirSync(tempDir, { recursive: true });
        new AdmZip(path.join(dfpDir, packFile)).extractAllTo(tempDir, true);
        fs.renameSync(tempDir, targetDir);
        logInfo(`[DFP] Extracted: ${packFile}`);
      } catch (e: any) {
        logError(`[DFP] Failed to extract ${packFile}: ${e?.message ?? e}`);
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }
      progress.report({ increment: 100 / pending.length });
      await new Promise<void>(r => setImmediate(r));
    }
  });

  _pdscRawCache.clear();
  _mcuCfgResultCache.clear();
  _internalFlmCache.clear();
  clearSvdCache();
}

/** Download and extract missing DFP packs from Holtek's website. */
async function updateDevicePacks(extPath: string, showProgress: boolean): Promise<boolean> {
  const dfpDir = path.join(extPath, 'dfp');
  fs.mkdirSync(dfpDir, { recursive: true });

  // Fetch latest pack list from Holtek.pidx.
  let pidxList: { name: string; download_url: string; version: string }[];
  try { pidxList = await fetchHoltekPidx(); }
  catch (e: any) {
    logError(`[DFP] fetchHoltekPidx failed: ${e?.message ?? e}`);
    return false;
  }
  if (pidxList.length === 0) {
    logError('[DFP] fetchHoltekPidx returned no entries — check Holtek.pidx structure or network.');
    if (showProgress) vscode.window.showWarningMessage('HT32: Could not retrieve pack list from Holtek. Check Output for details.');
    return false;
  }

  const latestByName = new Map<string, { name: string; download_url: string; version: string }>();
  for (const f of pidxList) {
    const m = /^Holtek\.(.+?)\.([\d.]+)\.pack$/i.exec(f.name);
    if (!m) continue;
    const existing = latestByName.get(m[1]);
    if (!existing || semverCmp(f.version, existing.version) > 0) latestByName.set(m[1], f);
  }

  const localFiles = fs.existsSync(dfpDir) ? fs.readdirSync(dfpDir) : [];

  // Build map of local latest version per pack name.
  const localLatestByName = new Map<string, string>();
  for (const n of localFiles) {
    const m = /^Holtek\.(.+?)\.([\d.]+)\.pack$/i.exec(n);
    if (!m) continue;
    const [, packName, version] = m;
    const cur = localLatestByName.get(packName);
    if (!cur || semverCmp(version, cur) > 0) localLatestByName.set(packName, version);
  }

  // Only download if Holtek has a newer version than what is already local.
  const missing = [...latestByName.values()].filter(f => {
    if (fs.existsSync(path.join(dfpDir, f.name))) return false;
    const localV = localLatestByName.get(f.name.match(/^Holtek\.(.+?)\.([\d.]+)\.pack$/i)![1]);
    return !localV || semverCmp(f.version, localV) > 0;
  });
  if (missing.length === 0) { logInfo('[DFP] All packs up to date.'); return true; }

  const run = async (progress?: vscode.Progress<{ message?: string; increment?: number }>) => {
    let succeeded = 0, failed = 0;
    for (let i = 0; i < missing.length; i++) {
      const f = missing[i];
      progress?.report({ message: `${f.name} (${i + 1}/${missing.length})` });
      logInfo(`[DFP] Downloading ${f.name}…`);
      try {
        await downloadFileTo(f.download_url, path.join(dfpDir, f.name));
        logInfo(`[DFP] Downloaded ${f.name}`);
        succeeded++;
      } catch (e: any) {
        logError(`[DFP] Failed to download ${f.name}: ${e?.message ?? e}`);
        failed++;
      }
      progress?.report({ increment: 100 / missing.length });
    }
    if (succeeded > 0) {
      await extractDfpPacksIfNeeded(extPath);
      vscode.window.showInformationMessage(
        `HT32: ${succeeded} pack(s) installed successfully.${failed > 0 ? ` ${failed} failed — see Output.` : ''}`
      );
    } else if (failed > 0) {
      vscode.window.showWarningMessage(`HT32: All ${failed} pack download(s) failed. Check Output for details.`);
    }
    return succeeded > 0;
  };

  if (showProgress) {
    return vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'HT32: Downloading Device Packs',
      cancellable: false,
    }, run);
  }
  return run();
}

/** Background check for DFP pack updates (24h cooldown). */
async function checkDfpPackUpdatesInBackground(extPath: string, ctx: vscode.ExtensionContext): Promise<void> {
  const lastCheck = ctx.globalState.get<number>('ht32.dfpLastCheck', 0);
  if (Date.now() - lastCheck < DFP_CHECK_COOLDOWN_MS) return;
  const ok = await updateDevicePacks(extPath, false).catch(() => false);
  // Update timestamp even on empty pidxList to avoid hammering the server on every startup.
  await ctx.globalState.update('ht32.dfpLastCheck', Date.now());
}

function fetchMarketplaceVersion(extensionId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      filters: [{ criteria: [{ filterType: 7, value: extensionId }] }],
      flags: 512
    });
    const req = https.request({
      hostname: 'marketplace.visualstudio.com',
      path: '/_apis/public/gallery/extensionquery',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json;api-version=3.0-preview.1',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Marketplace returned HTTP ${res.statusCode}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          const version: string | undefined = json.results?.[0]?.extensions?.[0]?.versions?.[0]?.version;
          version ? resolve(version) : reject(new Error('Extension not found on Marketplace'));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('Request timed out')));
    req.write(body);
    req.end();
  });
}
