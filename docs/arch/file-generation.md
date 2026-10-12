# 產出檔案的時間點

每個 build-gen 目錄下的檔案由哪些操作產出、由哪個函式負責。

## 總覽

| 檔案 | 管理者 |
|------|--------|
| `Makefile` | 初次：轉換/Create Project/Open Project（無 Makefile）；Patch：`refreshDerivedFiles` + `regenerateMakefileFlags` |
| `sources.list` | `refreshDerivedFiles`（唯一管理者） |
| `includes.list` | 轉換時；`refreshDerivedFiles`（每次呼叫都更新） |
| `defines.list` | 轉換時；`refreshDerivedFiles`（每次呼叫都更新） |
| `adefines.list` | 轉換時；`refreshDerivedFiles`（每次呼叫都更新） |
| `compile_commands.json` | `refreshDerivedFiles` + `regenAllMakefileFlags` + 獨立指令 |
| `project.meta.json` | 轉換時初次建立；`persistMeta`（有改動才呼叫） |
| `project.settings.json` | 轉換時（初次）；Settings Save |

---

## 兩個核心函式

### `refreshDerivedFiles(bgDir, meta, opts?)`

從現有的 `project.meta.json` + `project.settings.json` 重新產生所有衍生 build 檔案，**不寫 meta.json**。

產生順序：
1. `sources.list`（從 `meta.groups` 展開）
2. Makefile SRCS / OBJ / per-file compile rules（patch 現有 Makefile）
3. `regenerateMakefileFlags` → `includes.list` / `defines.list` / `adefines.list` / CFLAGS/LDFLAGS patch
4. `writeCCDbFromLists` → `compile_commands.json`
5. Linker script ROM region patch（fileOptions.rom）
6. 若 per-file rules 有變動，寫 `.needs-rebuild`
7. `opts.skipElfInvalidation` 為 false 時，刪除 stale ELF/bin/hex

呼叫時機：
- `initProjectsFromMeta`（open project，mtime check 後）
- `regenAllMakefileFlags`（Settings Save / `generateTasksAndLaunchAndMakefile`）

### `persistMeta(bgDir, meta, opts?)`

meta 內容有實際改動時使用。注入 `metaVersion`，寫回 `project.meta.json`，再呼叫 `refreshDerivedFiles`。

呼叫時機：
- TreeView：加入 / 移除 group / file，toggle xo / exclude / rom，改 linker script
- uVision / HT32-IDE 轉換後
- Create Project / Add Project 後

---

## Makefile

### 完整建立（`buildMakefileText` / `generateMakefile` / `buildMakefileFromProjectSettings`）

| 觸發 | 呼叫路徑 | 持有的 bgDir 變數 |
|------|---------|-----------------|
| uVision 轉換 | `uv2make()` → `buildMakefileFromProjectSettings(readProjectSettings(outDirAbs), { ... })` | `outDirAbs` |
| HT32-IDE 轉換 | `convertHt32IdeProject()` → `generateMakefile(result, bgDir, ...)` → `buildMakefileText({ ... })` | `bgDir` |
| Create Project | `generateProjectFiles(bgDir, ...)` → `buildMakefileFromProjectSettings(readProjectSettings(bgDir), { ... })` | `bgDir` |
| Open Project（無 Makefile，或 settings/meta/lists 任一不存在，或 settings/meta 比 Makefile 新） | `initProjectsFromMeta()` → `buildMakefileText({ ... })` | `bgDir`（loop var）；Makefile、settings、meta 全存在且 4 個 .list 存在且 Makefile 比兩個輸入檔都新時跳過 |

完整建立後，呼叫端立刻補一次 `persistMeta` 或 `refreshDerivedFiles`，patch per-file rules section（含 `--redefine-sym`、`-mpure-code` 偵測）。

#### per-file 偵測統一由 `refreshDerivedFiles` 處理

`-mpure-code`（xo 檔）等 per-file flag 偵測只在 `refreshDerivedFiles` 內做。所有觸碰 Makefile 的路徑最終都會經過 `refreshDerivedFiles`，確保偵測一致：

- 四條初次建立路徑：建立後立刻呼叫 `persistMeta`（convert/create）或 `refreshDerivedFiles`（open project）
- TreeView 操作：呼叫 `persistMeta`
- Settings Save / `generateTasksAndLaunchAndMakefile`：`regenAllMakefileFlags` → 若 `project.meta.json` 存在則呼叫 `refreshDerivedFiles`（`skipElfInvalidation: true`），同時完成 per-file rules + CFLAGS/LDFLAGS + compile_commands.json 更新

> 舊版 FWLib misc.c 相容性不再透過 per-file Makefile rule（`objcopy --redefine-sym`）處理，改為直接 patch source 檔（見 [stack-analysis.md](stack-analysis.md)）。

### Patch：SRCS + per-file compile rules（`refreshDerivedFiles`）

| 觸發 |
|------|
| 上述四條路徑的轉換完成後（立刻呼叫） |
| TreeView：加入 / 移除 group |
| TreeView：加入 / 移除 file |
| TreeView：toggle xo（`-mpure-code`）/ exclude / rom |

`refreshDerivedFiles` 內部也會呼叫 `regenerateMakefileFlags`（見下）。

若 per-file rules section 有變動，同時寫入 `.needs-rebuild` marker，下次 Build 前自動 clean rebuild。

### Patch：CFLAGS / LDFLAGS（`regenerateMakefileFlags`）

| 觸發 | 呼叫路徑 |
|------|---------|
| `refreshDerivedFiles`（step 3，每次） | 內部呼叫 |
| Settings Save | `openSettingsPanel` callback → `regenAllMakefileFlags` → `refreshDerivedFiles` → `regenerateMakefileFlags` |
| `generateTasksAndLaunchAndMakefile`（`regenMakefile: true`，預設） | → `regenAllMakefileFlags` → `refreshDerivedFiles` → `regenerateMakefileFlags` |

CFLAGS/ASFLAGS 有變動時寫入 `.needs-rebuild`，下次 Build 前刪整個 `build/`。

---

## sources.list

**唯一管理者：`refreshDerivedFiles`（step 1）**

從 `meta.groups` 展開所有非 exclude 檔案，轉換成 bgDir-relative 路徑後寫入。所有觸發路徑皆透過 `refreshDerivedFiles`，不由轉換器直接寫（轉換器寫的版本會立刻被 `refreshDerivedFiles` 覆蓋）。

> 例外：uVision 的 `writeLists()`、HT32-IDE 的 `writeHt32IdeLists()`、Create Project 的 `generateProjectFiles()` 均自行寫一次，但緊接著的 `persistMeta` → `refreshDerivedFiles` 以 `buildRelPaths` 重新算過後覆蓋。

---

## includes.list

| 觸發 | 函式 | 說明 |
|------|------|------|
| uVision 轉換 | `writeLists()` in `uv2make.ts` | `-I"path"` 格式，含 `../GNU_ARM` |
| HT32-IDE 轉換 | `writeHt32IdeLists()` in `ht32ide2make.ts` | |
| Create Project | `generateProjectFiles()` | |
| Open Project（無 Makefile，或 settings/meta/lists 任一不存在，或 settings/meta 比 Makefile 新） | `initProjectsFromMeta()` → `refreshDerivedFiles` step 3 | 從 `project.settings.json` 的 `includePaths` 重建 |
| Settings Save / `generateTasksAndLaunchAndMakefile` | `regenAllMakefileFlags` → `refreshDerivedFiles` → `regenerateMakefileFlags` | 同上 |

---

## defines.list

| 觸發 | 函式 | 說明 |
|------|------|------|
| uVision 轉換 | `writeLists()` | `-DXXX` 格式 |
| HT32-IDE 轉換 | `writeHt32IdeLists()` | |
| Create Project | `generateProjectFiles()` | |
| Open Project（無 Makefile，或 settings/meta/lists 任一不存在，或 settings/meta 比 Makefile 新） | `initProjectsFromMeta()` → `refreshDerivedFiles` step 3 | 從 `project.settings.json` 的 `cDefs` 重建 |
| Settings Save / `generateTasksAndLaunchAndMakefile` | `regenAllMakefileFlags` → `refreshDerivedFiles` → `regenerateMakefileFlags` | 同上 |

---

## adefines.list

| 觸發 | 函式 | 說明 |
|------|------|------|
| uVision 轉換 | `writeLists()` | ASM-only defines，std 系列含 `USE_HT32_CHIP=X` |
| HT32-IDE 轉換 | `writeHt32IdeLists()` | |
| Create Project | `generateProjectFiles()` | |
| Open Project（無 Makefile，或 settings/meta/lists 任一不存在，或 settings/meta 比 Makefile 新） | `initProjectsFromMeta()` → `refreshDerivedFiles` step 3 | 從 `project.settings.json` 的 `aDefs` 重建 |
| Settings Save / `generateTasksAndLaunchAndMakefile` | `regenAllMakefileFlags` → `refreshDerivedFiles` → `regenerateMakefileFlags` | 同上 |
| 舊專案升級 | `regenerateMakefileFlags()` | 若檔案不存在自動建立空檔 |

---

## compile_commands.json

**底層函式：`writeCCDbFromLists`**（讀 `sources.list` / `includes.list` / `defines.list` / `adefines.list` 合成）

| 觸發 | 呼叫路徑 |
|------|---------|
| uVision 轉換 | `buildCCDb()` in `uv2make()` |
| HT32-IDE 轉換 | `writeCCDbFromLists()` in `convertHt32IdeProject()` |
| Create Project | `writeCCDbFromLists()` in `generateProjectFiles()` |
| Open Project（無 Makefile，或 settings/meta/lists 任一不存在，或 settings/meta 比 Makefile 新） | `initProjectsFromMeta()` → `refreshDerivedFiles` step 4 |
| `refreshDerivedFiles`（step 4，每次） | `writeCCDbFromLists()` |
| `ht32.regenerateCompileCommands` 指令 | `regenerateCompileCommandsCommand()` |

每個 bgDir 有自己的 `compile_commands.json`；`regenAllMakefileFlags` 完成後另外合併成 `.vscode/compile_commands.json`（供 clangd 使用）。

---

## project.meta.json

| 觸發 | 說明 |
|------|------|
| uVision 轉換 | 初次建立 |
| HT32-IDE 轉換 | 初次建立 |
| Create Project | 初次建立 |
| `persistMeta`（每次呼叫） | 注入 `metaVersion`，把傳入的 meta 物件寫回磁碟 |

Open project 使用 `refreshDerivedFiles`（不寫 meta.json），Settings Save / `generateTasksAndLaunchAndMakefile` 使用 `regenAllMakefileFlags` → `refreshDerivedFiles`（同樣不寫 meta.json）。

**source of truth**：`meta.groups`（檔案列表）、`meta.linkerScripts`、`meta.fileOptions`（xo/exclude/rom，使用者設定）。

---

## project.settings.json

| 觸發 | 說明 |
|------|------|
| uVision / HT32-IDE / Create Project（初次） | 寫入 mcu、fpu、floatAbi、includePaths、cDefs 等 |
| Settings Save | `writeProjectSettings()` via settings webview，使用者可修改所有欄位 |
| 內部更新 | adapter serial 自動清除、flash loader 自動偵測等 |

**source of truth**：mcu/fpu/floatAbi 供 `regenerateMakefileFlags` 使用；`includePaths` / `cDefs` / `aDefs` 供 `includes.list` / `defines.list` / `adefines.list` 使用。

---

## .needs-rebuild marker

| 觸發 | 範圍 |
|------|------|
| `regenerateMakefileFlags`：CFLAGS/ASFLAGS 有變動 | 下次 Build 前刪整個 `build/` |
| `refreshDerivedFiles`：per-file rules section 有變動 | 同上 |

由 `smartRunTask`（Build 指令）在執行 make 前檢查並消費（刪除 marker + 刪 `build/`）。
