# Toolchain 搜尋策略

## 設計原則

1. **永遠回傳絕對路徑或 undefined**，絕不回傳裸名稱（如 `arm-none-eabi-gcc`）。裸名稱無法區分「找到了但沒有路徑」與「根本沒找到 fallback」，讓 Makefile CC 產生歧義。
2. **找不到就顯示警告通知**，不強迫安裝。使用者主動點選「Install via winget」才執行安裝；按 X 關閉則靜默略過，等下次開啟專案再提示。
3. **不做深度遞迴掃描**。掃描 `Program Files` 深度 6 會阻塞 activation 數分鐘，造成「Makefile 尚未產生就按 Build」的競態問題。改為固定已知路徑 + `where`/`which`。

## 統一入口：`resolveToolchain()`

make / gcc / pyocd 三項工具全部由 `resolveToolchain()` 統一解析，呼叫方只需一次呼叫：

```typescript
const { makePathFull, makeExe, gccPath, pyocdPath } =
  await resolveToolchain(root, bgFullDirs, onInstalled);
```

- **gcc 或 make 缺失**：顯示單一 warning，列出所有缺失工具，使用者點選後執行 `onInstalled`
- **pyocd**：依 bgFullDirs 中的 `serverType` 決定是否檢查，自動安裝（不另外提示）
- `initProjectsFromMeta` 不呼叫 `resolveToolchain`，找不到 gcc 時以裸名稱 fallback，不顯示通知

## arm-none-eabi-gcc 搜尋順序

Settings key：`ht32.gccPath`（VS Code User Settings，Global）

| 優先順序 | 路徑 / 方式 |
|---|---|
| 1 | User Settings → `ht32.gccPath`（需通過 `verifyExe` 確認是 arm-none-eabi-gcc） |
| 2 | `where arm-none-eabi-gcc`（Windows）/ `which`（Unix）→ 取第一行絕對路徑 |
| 3 | HT32-IDE xPack（Windows）：掃描 `C:\Program Files (x86)\Holtek HT32 Series\HT32-IDE\xPack\` 和 `C:\Program Files\Holtek...\xPack\`，找 `arm-gnu-toolchain*` 子目錄，**semver 排序取最新版** |
| 4 | Arm 官方安裝程式（Windows）：`findArmGccShallow()` 掃描 4 個根目錄（`C:\Program Files\Arm`、`C:\Program Files (x86)\Arm`、`C:\Program Files\Arm GNU Toolchain`、`C:\Program Files (x86)\Arm GNU Toolchain`），深度 3，**版本號排序取最新** |
| 5 | Unix 固定路徑：`/usr/bin/arm-none-eabi-gcc`、`/usr/local/bin/arm-none-eabi-gcc`、`/opt/arm-none-eabi/bin/arm-none-eabi-gcc` |
| 找到後 | in-session memory cache（`_gccPathCache`）；auto-detect 結果 cache；user settings 路徑每次直接讀取，不走 cache |
| 找不到 | `resolveToolchain` 顯示 warning 並提供 winget 安裝 `Arm.GnuArmEmbeddedToolchain`；`initProjectsFromMeta` 用裸名稱 `arm-none-eabi-gcc` fallback |

## GNU make 搜尋順序

Settings key：`ht32.makePath`（VS Code User Settings，Global）；workspace cache：`ht32.tools.makePath`（`.vscode/settings.json`）

| 優先順序 | 路徑 / 方式 |
|---|---|
| 1 | User Settings → `ht32.makePath`（`resolveToolchain` 直接讀，不呼叫 `locateMake()`） |
| 2 | `.vscode/settings.json` → `ht32.tools.makePath`（`ensureToolchain` 找到後自動 cache） |
| 3 | bundled make（Windows）：`{extensionPath}/bin/win32-x64/make.exe` |
| 4 | 已安裝的 LLVM-MinGW（Windows winget）：`%LOCALAPPDATA%\Microsoft\WinGet\Packages\MartinStorsjo.LLVM-MinGW*\*\bin\make.exe` |
| 5 | Unix 固定路徑：`/usr/bin/make`、`/bin/make`、`/usr/local/bin/make`、`which make` |
| 找不到 | `resolveToolchain` 顯示 warning 並提供 winget 安裝 `MartinStorsjo.LLVM-MinGW.UCRT`；tasks.json 用裸名稱 `make` fallback；`makefile.makePath` 不寫入 |

## pyOCD 搜尋順序

僅在專案的 `serverType === 'pyocd'` 時才檢查。

| 優先順序 | 路徑 / 方式 |
|---|---|
| 1 | 系統 PATH（`pyocd --version` 成功）→ 回傳 `undefined`（cortex-debug 自行找） |
| 2 | bundled uv 安裝目錄：`uv tool dir --bin` → `pyocd.exe` |
| 找不到 | 詢問使用者是否安裝（Install / Not Now）→ 確認後透過 bundled `uv tool install pyocd` 安裝 |

## 通知觸發時機

gcc / make 缺失 warning 在以下兩個時間點各觸發一次（場景不重疊，不會重複通知）：

| 時間點 | 觸發條件 | 負責範圍 |
|---|---|---|
| **extension 啟動**（300ms 後）| 偵測到 HT32 專案（`hasHint`）**且 tasks.json 已存在** | 補漏：tasks.json 存在時 `generateTasksAndLaunchAndMakefile` 被跳過，此處確保使用者曾按 X 略過安裝仍能收到通知 |
| **`generateTasksAndLaunchAndMakefile`** | tasks.json 不存在、Convert uVision / HT32-IDE、所有轉換流程 | 涵蓋初次設定與所有轉換流程 |

啟動時的 warning 包含 pyocd（若專案使用 pyocd backend）；使用者點選 Install 後才執行安裝。

## tasks.json PATH 組成規則

找到絕對路徑的工具，其 bin 目錄才會加進 task 的 PATH env：
- make：若為 bundled，以 `${config:ht32.internal.extensionRoot}/bin/win32-x64` 表示（升版後不需重新 generate）
- gcc：直接用絕對路徑的 `dirname`
- 若工具在系統 PATH（`where` 找到），tasks 直接繼承 `${env:PATH}`，不額外插入

## Settings Webview — GCC Path 欄位 placeholder

Settings Webview 的「GCC Path」輸入框以 `placeholder` 顯示 `locateArmGcc()` 自動偵測到的路徑，
而不是把偵測結果填入 `value`。設計意圖：

- **欄位為空** = 使用自動偵測（每次 build 時 `locateArmGcc()` 動態查，同 session 有 memory cache）
- **欄位有值** = 固定使用使用者明確指定的路徑（存入 User Settings `ht32.gccPath`）
- **placeholder 顯示偵測路徑** = 讓使用者知道「現在自動偵測到這個」，但不強迫存入設定

### 資料流

```
openSettingsPanel()
  └─ await locateArmGcc()               ← 呼叫時機：Settings 面板開啟時
       └─ _locateArmGccInner()          ← 依搜尋順序找第一個可用的
  └─ detectedGccPath 傳入 buildHtml()
       └─ HTML: placeholder="${detectedGccPath ?? 'Leave empty to auto-detect'}"
```

`locateArmGcc()` 有 module-level cache（`_gccPathCache`），auto-detect 結果 cache 在 session 內只搜尋一次。若 `ht32.gccPath` 有值，每次呼叫都直接讀取 user settings，不走 cache（確保使用者改設定後立即生效）。

### 存檔行為（Settings Webview save）

使用者按 Save 時，`gccPath` 欄位的值（可能為空字串）寫入 User Settings（Global scope）：

```typescript
// settingsWebview.ts: writeMachineSettings()
await cfg.update('gccPath', s.gccPath || undefined, ConfigurationTarget.Global);
```

- 空字串 → `undefined` → 從 User Settings 刪除此 key → 回到自動偵測模式
- 有值 → 寫入 `ht32.gccPath`（Global）→ `locateArmGcc()` step 1 命中，直接使用

## makefile.makePath 寫入規則

`writeMakefileToolsSettings` 只在 make 有**完整絕對路徑**時才寫 `makefile.makePath`。
找不到 make 時刪除此 key（讓 Makefile Tools extension 用它自己的預設值或顯示自己的錯誤）。
永遠不寫入裸 `"make"`——那會讓 Makefile Tools 在沒有系統 make 的機器上靜默失敗。

## GCC 版本警告

`locateArmGcc()` 找到 gcc 後呼叫 `warnIfGccTooOld(exe)`：

- 解析 `arm-none-eabi-gcc --version` 輸出，以 `) X.Y.Z` pattern 抓主版本號（fallback 到 `\b(\d+)\.\d+\.\d+\b`）
- 主版本 < 8 時，output channel 顯示 `logWarn` 並彈出 `showWarningMessage`
- `_warnedGccPaths`（`Set<string>`）記錄已警告過的路徑，同一路徑在 session 內只警告一次，避免每次 settings save 都重複彈出通知

## GCC / binutils 最低版本需求

| Flag | 最低版本 | 說明 |
|------|---------|------|
| `-mcpu`, `-mthumb`, `-mfpu`, `-mfloat-abi` | GCC 4+ | ARM 基本選項 |
| `-Os/O0..O3`, `-g/-g3` | GCC 4+ | 最佳化與 debug |
| `-ffunction-sections`, `-fdata-sections` | GCC 4+ | Dead code elimination |
| `-std=gnu11` | GCC 4.7+ | C11 |
| `-flto` | GCC 4.6+ | Link-time optimization |
| `-mpure-code` | GCC 6+ | Execute-only（Cortex-M） |
| `-std=c++17` | GCC 7+ | C++17 |
| `--print-memory-usage` | binutils 2.26（GCC 6 世代） | 編譯後顯示 RAM/Flash 使用量 |
| `--no-warn-rwx-segments` | binutils 2.39（GCC 12+） | 已有 guard，不支援就不加 |
| **`-ffile-prefix-map`** | **GCC 8+** | DWARF 路徑正規化，支援移動專案後 debug |

**最嚴格限制為 `-ffile-prefix-map`，因此本 extension 要求 GCC 8 以上。**
