# Holtek HT32 VS Code Extension — 專案架構

## 總覽

這是一個 **VS Code Extension**（TypeScript），用於輔助開發 Holtek HT32 系列 ARM Cortex-M 微控制器。核心功能是將現有 IDE 的專案格式轉換成 Makefile 流程，並整合 VS Code 的 Build / Debug 體驗。

---

## 子文件索引

| 文件 | 說明 |
|------|------|
| [arch/project-layout.md](arch/project-layout.md) | 輸出目錄結構、Project/ 各檔案說明、VS Code 設定、.list 檔設計 |
| [arch/fwlib-deps.md](arch/fwlib-deps.md) | FWLib 依賴（Convert + Create Project）、newlib syscall、各路徑產出總表 |
| [arch/create-project.md](arch/create-project.md) | Create Project wizard 流程、產出結構、各系列依賴來源索引 |
| [arch/scatter2ld.md](arch/scatter2ld.md) | scatter2ld 轉換流程、已驗證語法模式、主區選取邏輯 |
| [arch/keil2gnu.md](arch/keil2gnu.md) | keil2gnu 組語轉換、startup section 必要條件、fallback、Vector table Thumb LSB |
| [arch/flash-loader.md](arch/flash-loader.md) | Flash Loader 架構：FLM 選取（PDSC-first）、HLM 選擇（OpenOCD）、SPIM extra loader 偵測 |
| [arch/debug-session.md](arch/debug-session.md) | Debug session 架構：servertype openocd vs external 比較、cortex-debug 參數順序、已知問題 |
| [arch/linker-startup.md](arch/linker-startup.md) | linker script 四條路徑來源（scatter→原檔名.ld / STD linker.ld / 49x _FLASH.ld / Create Project）、patchLdStackSections、startup .s heap/stack section、Keil vs GCC heap 計入 RAM 差異、Stack Usage 支援總覽 |
| [arch/stack-analysis.md](arch/stack-analysis.md) | STACK USAGE 面板、Watermark 機制、DAP evaluate crash、IAP/AP MSP 來源 |
| [arch/multi-project.md](arch/multi-project.md) | 多專案支援、compile_commands.json per-project、clangd IntelliSense 切換 |
| [arch/fpu_present.md](arch/fpu_present.md) | `detectFpuPresentFromHeader`：device header `__FPU_PRESENT` 偵測機制、各路徑 search path、49x vs STD 行為差異 |
| [arch/library-linking.md](arch/library-linking.md) | HT32-IDE 兩種 library 引入方式（直接路徑 vs -l/-L）、c/cpp.linker 合併解析 |
| [arch/settings-ini.md](arch/settings-ini.md) | conf/Settings.ini 三個使用場景：HLM WORKAREASIZE、RAM patch（Create Project）、_estack 上限 cap |
| [arch/maintenance.md](arch/maintenance.md) | 新增 MCU checklist（DFP/pack/HLM/cfg）、HT32-IDE 改版流程、pyOCD 架構（uv auto-install/pack 選取/產生檔案）、測試腳本、Bundled Make、Marketplace 發布 |
| [arch/fwlib-bat-integration.md](arch/fwlib-bat-integration.md) | FWLib bat 整合分析：`_CreateProject.bat` gsar 操作、HT32-IDE vs HT32_VSCode placeholder 對照表、template 目錄規劃 |
| [arch/tasks-json-shell.md](arch/tasks-json-shell.md) | tasks.json shell 類型設計：`type: 'process'` vs `type: 'shell'` + `quoting: 'strong'`；各 task 選擇理由；路徑含特殊字元（`(~!%^)`）的 PowerShell 相容問題 |
| [arch/file-settings.md](arch/file-settings.md) | Per-file Settings（Exclude / Execute-only / ROM Region）：meta.json 格式、Makefile 效果、patchLinkerScriptRom、Convert uVision vs HT32-IDE 自動讀取差異 |
| [arch/settings-webview.md](arch/settings-webview.md) | Settings Webview 所有選項的資料流對照表：Compiler 設定 → Makefile / compile_commands.json；Debugger 設定 → tasks.json / launch.json |
| [arch/compiler-compat.md](arch/compiler-compat.md) | GCC 版本相容性設計：`--no-warn-rwx-segments` Makefile 動態偵測（`LD_NO_WARN`）、`-std=gnu11` 預設 flag 與 GCC 15 C23 bool 衝突處理 |
| [arch/rtos.md](arch/rtos.md) | FreeRTOS 自動轉換：port.c / portmacro.h include path RVDS→GCC 替換邏輯、手動處理情境 |
| [arch/toolchain.md](arch/toolchain.md) | Toolchain 搜尋策略：GCC / Make 搜尋順序、`findArmGccShallow()` shallow scan、`locateMake()` 設計、winget 安裝流程、tasks.json PATH 組成規則 |
| [arch/postbuild.md](arch/postbuild.md) | Post-Build 完整架構：uVision（`extractUvAfterMakeCmd` / `translateKeilPostBuildCmd`）、HT32-IDE（CDT 變數替換 / `resolveHt32IdePostBuildPath`）、`--symdefs` 自動產 `gen_syms_ld.bat`、tasks.json Compile / Post-Build / Build compound 結構、`wrapPostBuildCmd` .bat → `cmd /c` |
| [arch/PartialLock.md](arch/PartialLock.md) | FLASH Partial Lock — 雙專案 symdefs → .ld 轉換流程（IAP + AP 共用 Flash 分區設計） |
| [arch/test-scripts.md](arch/test-scripts.md) | 測試腳本說明：`test-mcu.js`（MCU 靜態覆蓋率）、`test-create-project.js`（四層驗證）、`test-compile.js`（轉換+編譯）及其他輔助腳本 |

---

## 目錄結構

```
ht32.vscode.solution/
├── src/                              ← TypeScript 原始碼
│   ├── ht32-project-assistant-for-vs-code.ts  ← Extension 入口（activate、commands、TreeView）
│   └── tools/
│       ├── uv2make.ts               ← Keil uVision (.uvprojx/.uvmpw) → Makefile 轉換器
│       ├── ht32ide2make.ts          ← HT32-IDE (.project/.cproject) → Makefile 轉換器
│       ├── scatter2ld.ts            ← Keil scatter (.sct/.lin) → GNU LD linker script
│       ├── createProject.ts         ← Create Project Wizard（從 FWLib template 建立新專案）
│       ├── settingsWebview.ts       ← HT32 Settings WebView（Compiler / Debugger / Build 三分頁）
│       └── toolchain.ts             ← ARM GCC / Make 自動搜尋與驗證
│
├── out/                             ← 編譯輸出（tsc → CommonJS，不進版控）
│
├── templates/
│   ├── GNU_ARM/                     ← core 共用（syscalls.c、ht32_stack_analysis.c、ht32_op.c、ht32_op2.c、linker.ld）
│   ├── F1xxxx/                      ← HT32F1xxxx（M3）：conf.h、main.c、it.c、system_*_01~03.c、usbdconf.h
│   │   └── GNU_ARM/                 ← startup_gcc_01/03.s、linker.ld、5 個 .mk（12345/12364/12366/1654/1656）、ht32_op.c
│   ├── F4xxxx/                      ← HT32F4xxxx（M4/49x）：conf.h、main.c、it.c、system_*_01.c、can_config.h、usbdconf.h
│   │   └── GNU_ARM/                 ← startup_gcc_01.s、linker.ld、42386.mk、ht32_op.c、ht32_op2.c
│   ├── F5xxxx/                      ← HT32F5xxxx（M0+）：conf.h、main.c、it.c、system_*_01~19.c、3 個 usbdconf.h
│   │   └── GNU_ARM/                 ← 16 個 startup_gcc_NN.s（01~17，跳 04）、78 個 .mk、linker.ld、ht32_op.c
│   └── L5xxxx/                      ← HT32L5xxxx（M0+）：conf.h、main.c、it.c、system_*_01.c、2 個 usbdconf.h
│       └── GNU_ARM/                 ← startup_gcc_01/02.s、linker.ld、9 個 .mk（3200U/W/X、52241 等）、ht32_op.c
│
├── conf/
│   └── Settings.ini                 ← HLM WORKAREASIZE 對照表（與 HT32-IDE plugin 相同結構）
│
├── dfp/Holtek/HT32_DFP/             ← CMSIS DFP（getAllPdscPaths 掃全部版本，多版本並存時新版優先）
│   └── 1.0.79/                      ← 目前版本（含標準系列 + 49x 系列全部 MCU）
│       ├── Holtek.HT32_DFP.pdsc     ← 標準系列 PDSC（FLM 命名、RAM/Flash 資訊、SVD 路徑）
│       ├── Holtek.HT32F423x6_DFP.pdsc  ← 49x 系列 PDSC
│       ├── SVD/                     ← ~100 個 HT32 MCU 的 SVD 檔（偵錯用）
│       └── ARM/                     ← FLM Flash Loader、Header、Startup（標準系列 + 49x）
│
├── openocd/                         ← 打包的 OpenOCD（Windows x64）
│   ├── bin/                         ← openocd.exe + libftdi1/libusb/libhidapi/libjaylink DLLs
│   ├── MCU/                         ← 各 HT32 MCU 的 .cfg（~100 個，含 Flash/Option 位址）
│   ├── FlashLoader/                 ← HLM 檔（HT32F.HLM、HT32F_OPT.HLM、49x 系列、SPIM）
│   └── scripts/
│       ├── interface/               ← htlink.cfg / jlink.cfg / stlink.cfg / cmsis-dap.cfg
│       └── target/                  ← HLMm0x.cfg / HLMm3x.cfg / HLM490x1.cfg / HLM491x3.cfg / HLM493x5.cfg
│
├── bin/win32-x64/                   ← 打包的 GNU Make 4.4.1（Windows x64）
│   └── make.exe + libiconv2/libintl3 DLLs
│
├── test_scripts/                    ← 開發用測試腳本（不打包進 .vsix）
│   ├── test-mcu.js                  ← MCU 靜態覆蓋率（cfg/HLM/WorkArea 是否齊全）
│   ├── test-create-project.js       ← Create Project 四層驗證
│   ├── test-compile.js              ← uVision/HT32-IDE 轉換 + 編譯
│   ├── batch-convert-htide.js       ← 批次 Convert HT32-IDE（搭配 fwlib-paths.ini）
│   ├── create-prj.js                ← 批次 Create Project（搭配 fwlib-paths.ini）
│   ├── clean-prj.js                 ← 清除 FWLib 下所有轉換產出（HT32_VSCode/）
│   ├── clean-vscode-templates.bat   ← 清除 FWLib template 目錄下的 .vscode/ 殘留
│   ├── fwlib-paths.ini              ← FWLib 路徑清單（test-create-project / test-compile / batch 共用）
│   ├── test-compile-report/         ← test-compile.js 的輸出報告目錄
│   └── test-mcu-report.txt          ← test-mcu.js 的覆蓋率報告
│
├── docs/                            ← 文件
│   ├── ARCHITECTURE.md              ← 本檔（索引）
│   ├── arch/                        ← 子文件（各主題詳細說明）
│   ├── user-guide.md                ← 使用手冊（繁體中文）
│   └── holtek-proj-assistant.pptx  ← 簡報（從 user-guide.md 轉換）
│
├── media/                           ← Extension icon
│   └── ht32.png / ht32.svg
│
├── package.json                     ← Extension manifest（commands、contributes.configuration）
└── tsconfig.json
```

---

## 模組職責

| 模組 | 職責 |
|------|------|
| `ht32-project-assistant-for-vs-code.ts` | Extension 主入口。負責：`activate()` 啟動、註冊所有 Commands（convert / create / build / clean / download / debug / settings）、建立 ProjectTreeView 與 RecentProjectsTreeView、`generateTasksAndLaunchAndMakefile()` 產生 `.vscode/tasks.json` + `launch.json`（含 `bgDirSuffix()` 統一命名、`htBgDir` 欄位標記）、`regenerateMakefileFlags()` 將 Settings Webview 的設定同步回 Makefile、OpenOCD 相關函式（`selectTargetCfg` / `parseMcuCfg` / `selectInternalHlm` / SPIM loader 選擇） |
| `tools/uv2make.ts` | Keil uVision `.uvprojx` / `.uvmpw` → Makefile 轉換器。解析 XML 取得 sources / includes / C defines（Cads）/ ASM-only defines（Aads）/ 記憶體配置 / scatter file / FPU 設定，呼叫 `scatter2ld` 產生 linker script，輸出 `Makefile` + `sources.list` + `includes.list` + `defines.list` + `adefines.list` + `compile_commands.json` + `project.meta.json`。`regenerateMakefileFlags()` 負責將 Settings Webview 儲存的所有設定重新寫入 Makefile（含 `cDefs`→`defines.list`、`aDefs`→`adefines.list`；接受 `cc?` 參數，傳入後同步更新 CC / AR / OBJCOPY / OBJDUMP / SIZE 五行）；舊版 Makefile 缺少 `LD_NO_WARN` 時自動補入 upgrade patch。Makefile LDFLAGS 以 `$(LD_NO_WARN)` 動態偵測 `--no-warn-rwx-segments` 支援（GCC 10/11 不支援，GCC 12+ 支援）；Windows 用 `findstr`、Unix 用 `grep`，以 `comma := ,` 解決 `$(if)` 不能含逗號的限制。**`writeCCDbFromLists(bgDir, opts)`** 是三條轉換路徑共用的 compile_commands.json 產生器，同時讀 `defines.list` + `adefines.list` 確保 clangd 看到全部 define；接受 `gccFullPath?`，傳入後自動使用完整路徑作為 compiler 並計算 `-isystem` 旗標。**`buildCCDb()`** 每個 entry 永遠插入 `--target=arm-none-eabi`，確保 clangd 以 ARM target 解析型別。**`computeIsystemPaths(gccFull)`** 從 gcc 完整路徑推算 newlib / gcc include 目錄，供 `writeCCDbFromLists` 呼叫。**`enforceMinHeap(heapSize)`** 強制最小 heap 大小（`MIN_HEAP_SIZE = 0x40`），所有路徑共用 |
| `tools/ht32ide2make.ts` | HT32-IDE `.project` / `.cproject` → Makefile 轉換器。解析 Eclipse CDT XML 取得 sources / includes / C defines / ASM-only defines（`tool.assembler` `assembler.defs`）/ 記憶體配置 / linker script，產生與 uv2make 相同格式的輸出。支援 M0/M3/M4 及 49x 系列，處理 HT32-IDE 特有的 exclude file 標記。`writeHt32IdeLists()` 分別寫入 `defines.list`（C defines）與 `adefines.list`（ASM-only defines），再由主程式呼叫 `writeCCDbFromLists()` 產生 compile_commands.json |
| `tools/scatter2ld.ts` | Keil scatter file（`.sct` / `.lin`）→ GNU LD linker script 轉換器。支援 HT32 常見配置：標準 Flash/RAM、外部 SRAM、SPIM XIP、IAP offset、Option Bytes region。不處理組語轉換（`keil2gnu()` 在 `uv2make.ts`）；本模組聚焦 scatter 語法解析與 MEMORY/SECTIONS 產生 |
| `tools/createProject.ts` | Create Project Wizard。從 bundled `templates/` 與使用者指定的 FWLib 目錄建立新的 GNU ARM 專案，產生 Makefile + linker script + startup + `project.settings.json`。支援標準系列（M0/M3/M4，讀 `.mk` template）與 49x 系列（無官方 GNU template，自產 Makefile）。包含 Settings Webview 的 recent FWLib 管理（最近 10 筆，選擇時移至首位）。寫入 .list 檔後呼叫 `writeCCDbFromLists()` 產生 compile_commands.json。Makefile 預設帶入 `extraCFlags: '-std=gnu11'`，與 Convert 路徑一致，避免 GCC 15 C23 `bool` 衝突 |
| `tools/settingsWebview.ts` | HT32 Settings WebView 面板。分三個分頁：**Compiler**（optimization / specs / extra flags / include paths）、**Debugger**（debug interface / adapter serial / Flash & SPIM loader）、**Build**（output name / GCC & OpenOCD path）。<br>Compiler 另含：C Defines → `defines.list`<br>　　　　　　　ASM Defines → `adefines.list`<br>設定儲存於 `project.settings.json`，1.5 秒 auto-save；存檔後同步重寫對應 `.list` 檔與 `compile_commands.json`。`readProjectSettings()` 含舊版欄位自動 migration。`extraCFlags` 預設值為 `'-std=gnu11'`。GCC Path 欄位以 `placeholder` 顯示 `locateArmGcc()` 自動偵測到的路徑（空白表示未偵測到）；存檔時若有設定 GCC path，同步更新 Makefile 的 CC/AR/OBJCOPY/OBJDUMP/SIZE |
| `tools/stackAnalysisProvider.ts` | Stack Usage Analysis 面板。透過 DAP `DebugAdapterTracker` 監聽 `stopped` 事件，讀取 `__StackTop` / `__HT_check_sp` / 當前 SP，計算 Used / Max / MaxAddr。支援兩種 Max 計算：session peak（最低 SP）與 paint watermark（`StackUsageAnalysisInit()` 填入 0xCDCDCDCD sentinel，掃描未被覆蓋區域）。`__StackTop` 優先讀 ELF symbol，備援 VTOR，解決 IAP/AP 場景下 Flash base 指向 bootloader 向量表的問題 |
| `tools/utils.ts` | 共用工具函式。`semverCmp(a, b)`：版本字串語義比較（支援 `1.0.76`、xPack 目錄名、pack 檔名等格式），供 DFP 多版本排序與 GCC 版本比較使用 |
| `tools/toolchain.ts` | ARM GCC 與 GNU Make 自動搜尋。**Make（Windows）**：VS Code 設定 → bundled `bin/win32-x64/make.exe`（GNU Make 4.4.1，保證支援 `$(file <...)`）→ 已安裝的 LLVM-MinGW → winget 自動安裝；Windows 不做 PATH / 系統掃描，避免搜到不支援 `$(file <...)` 的舊版本。**GCC（全平台）**：VS Code 設定 → `where`/`which` → HT32-IDE xPack 路徑 → `findArmGccShallow()`（最多 3 層 shallow scan，涵蓋 `C:\Program Files\Arm\`、`C:\Program Files (x86)\Arm\`、`C:\Program Files\Arm GNU Toolchain\`、`C:\Program Files (x86)\Arm GNU Toolchain\`；Arm 官方安裝程式版本子目錄名稱不固定，不能硬寫路徑）→ winget 安裝 `Arm.GnuArmEmbeddedToolchain`。偵測結果 in-session cache（`_gccPathCache`）；Settings WebView 開啟時以 `locateArmGcc()` 結果作為 GCC Path 欄位的 placeholder |

---

## Startup / Linker Script Patch 函式

三條轉換路徑（Convert uV / Convert HT32-IDE / Create Project）共用以下 patch 函式：

符號說明：**✓** = 標準系列與 49x 皆呼叫 ／ **標** = 僅標準系列 ／ **—** = 不呼叫

| 函式 | 所在 | 做什麼 | Convert uV | Conv. HT32-IDE | Create Project |
|---|---|---|:---:|:---:|:---:|
| `patchStartupFromKeil` | `uv2make.ts` | 讀 Keil Stack_Size/Heap_Size 同步至 GCC startup；patch `"aw",%nobits` | 標 | — | — |
| `patchStartupFiles` | `ht32ide2make.ts` | patch startup `"aw",%nobits` | — | ✓ | — |
| `patchStartupHeap` | `createProject.ts` | 若 Heap_Size=0 則設成 `MIN_HEAP_SIZE`（目前 `MIN_HEAP_SIZE = 0`，為 no-op） | — | — | ✓ ¹ |
| `patchLdStackSections` | `uv2make.ts`（export）| 拆 `._user_heap_stack` → 獨立 `.heap`/`.stack`；加 `KEEP()`（防 `--gc-sections` 丟棄）；加 `__StackTop`/`__HT_check_sp`（Stack Usage Analysis 面板） | ✓ | ✓ | ✓ |
| `patchLdStackTop` | `uv2make.ts` | 把 `LENGTH(RAM)` 換成 Settings.ini 安全值，避免 _estack 超出內部 SRAM（IAP / 外部 SRAM 場景）| ✓ | — | — |
| `patchLdMemoryFromInfo` | `uv2make.ts` | 用 uvprojx 解出的 FLASH/RAM 值 patch MEMORY block 的 ORIGIN + LENGTH | ✓ | — | — |
| `patchLdMemory` | `createProject.ts` | patch FLASH/RAM LENGTH，再呼叫 `patchLdStackSections` | — | — | ✓ |

¹ 49x 系列 FWLib GCC startup 無 `Heap_Size` 符號，`patchStartupHeap` 呼叫後為 no-op；49x Heap 由 `generateLinkerScript` 直接寫入 LD 的 `_Min_Heap_Size`（保留原始值，不強制調整）。

---

## .ht32vs 專案檔與雙擊開啟機制

### 專案檔格式

`.ht32vs` 是純 JSON 檔，記錄同一 workspace 下所有 sub-project 目錄：

```json
{ "projects": ["Project_IAP", "Project_AP"] }
```

存放於 `HT32_VSCode/`（即 VS Code workspace root）。轉換或建立專案時自動產生，之後可透過 TreeView 右鍵 Add / Remove Project 維護。

**HT32-IDE 多專案 `.ht32vs` 產生規則（依 `convResults.length`）：**
- **轉換結果 > 1**（多選或選上層資料夾，自動展開多個含 `.project`/`.cproject` 的子目錄）：為每個子專案各自產生一個只含自身的 `.ht32vs`，再產生一個涵蓋所有子專案的合併 `.ht32vs`
- **轉換結果 = 1**（直接選一個含 `.project`/`.cproject` 的目錄）：只產生一個 `.ht32vs`

合併的 `.ht32vs` 設為 `ht32.activeProjectFile`（TreeView 顯示全部子專案）。

### 雙擊開啟（Custom Editor 機制）

`package.json` 透過 `contributes.customEditors` 將 `*.ht32vs` 與 `ht32.ht32vsEditor` viewType 綁定：

```json
"customEditors": [{
  "viewType": "ht32.ht32vsEditor",
  "selector": [{ "filenamePattern": "*.ht32vs" }],
  "priority": "default"
}]
```

配合 activation event `"onCustomEditor:ht32.ht32vsEditor"`，VS Code 在任何模式（workspace 或 no-workspace）偵測到 `.ht32vs` 被開啟時，都會先啟動我們的 extension 再呼叫 `resolveCustomTextEditor`。

Extension 在 `activate()` 裡用 `CustomTextEditorProvider` 接管：

```typescript
vscode.window.registerCustomEditorProvider('ht32.ht32vsEditor', {
  async resolveCustomTextEditor(document, webviewPanel) {
    openHt32wsFile(ctx, tree, document.uri.fsPath).then(() => {
      try { webviewPanel.dispose(); } catch {}
    }).catch(() => {});
  }
} as vscode.CustomTextEditorProvider, { supportsMultipleEditorsPerDocument: false });
```

### 關鍵設計決策：fire-and-forget，不設 HTML

`resolveCustomTextEditor` 必須**立刻 return**，不能 await 任何 async 操作。原因：

1. 若在 return 前設 `webviewPanel.webview.html`，VS Code 會建立 overlay webview
2. `openHt32wsFile` 內部呼叫 `vscode.openFolder`，使視窗 reload
3. 視窗 reload 期間 VS Code 試圖存取已被回收的 overlay webview → `overlaywebview has been disposed` 錯誤，整個流程中斷

正確做法：不設任何 HTML，以 `.then()` 在背景執行 `openHt32wsFile`。VS Code 自行管理 webview 生命週期，`openFolder` 完成後 webview 自然消失。

### .ht32vs 過濾機制

TreeView、toolbar QuickPick（Build/Clean/Download）、Settings WebView、Debug 設定選擇，全部透過 `readProjectOrder(bgParentDir)` 讀取 active `.ht32vs` 的 projects 清單，並在掃描 bgDir 時套用過濾，確保只顯示 `.ht32vs` 內列出的 sub-project。

```
readProjectOrder()
  → readActiveProjectFile()   ← 從 .vscode/settings.json 讀 ht32.activeProjectFile
  → parseHt32vsFile()         ← 讀 .ht32vs JSON，相容 trailing comma
  → 回傳 string[] | undefined ← undefined 表示不過濾（Open Folder 模式）
```

各 call site 從 `readProjectOrder()` 結果自行建立 `new Set(order)` 用於過濾，或 `new Map(order.map((p,i)=>[p,i]))` 用於排序。

### Open Folder 模式 vs Open Project 模式

| | Open Folder 模式 | Open Project 模式 |
|---|---|---|
| 觸發方式 | VS Code native open / Close Project 後重開 | 雙擊 `.ht32vs` / `ht32.openProject` |
| `activeProjectFile` | 無（已清除） | 設為 `.ht32vs` 路徑 |
| TreeView root label | `.vscode` | `.ht32vs` 檔名（不含副檔名） |
| 子專案顯示 | 全部 | 僅 `.ht32vs` 列出的 |

**`ht32.closeProject`** 在關閉 folder 前會先清除 `ht32.activeProjectFile`，確保下次 native open folder 進入 Open Folder 模式（顯示全部子專案）。

**`openProjectFolderCommand`**（`ht32.openProject`）只支援新版 `HT32_VSCode/` layout；選擇後清除 `activeProjectFile` 並開啟 workspace，等同於 Open Folder 模式。

---

## 命令列表（Ctrl+Shift+P 輸入 HT32）

| 命令 | Command ID | 說明 |
|------|-----------|------|
| `HT32: Create Project` | `ht32.createProject` | 從 FWLib template 建立新 GNU ARM 專案 |
| `HT32: Open Project` | `ht32.openProject` | 開啟資料夾作為 HT32 專案 |
| `HT32: Convert uVision Project` | `ht32.convertUvision` | 轉換 Keil `.uvprojx` / `.uvmpw` → Makefile |
| `HT32: Convert HT32-IDE Project` | `ht32.convertHt32Ide` | 轉換 HT32-IDE `.project`/`.cproject` → Makefile |
| `HT32: Generate Build & Debug Config` | `ht32.generateTasksLaunch` | 重新產生 `tasks.json` / `launch.json` |
| `HT32: Build` | `ht32.build` | 執行 make 編譯 |
| `HT32: Clean` | `ht32.runClean` | 清除編譯產物 |
| `HT32: Download` | `ht32.download` | 燒錄 .elf 到目標板 |
| `HT32: Debug` | `ht32.startDebug` | 啟動 Cortex-Debug + OpenOCD |
| `HT32: Open Settings` | `ht32.openSettings` | 開啟 HT32 Settings WebView 面板 |

TreeView 右鍵選單：

| 命令 | Command ID | 說明 |
|------|-----------|------|
| `Add Group` | `ht32.treeAddGroup` | 在專案節點新增群組 |
| `Add Files to Group` | `ht32.treeAddFilesToGroup` | 新增檔案到群組 |
| `Remove from Group` | `ht32.treeRemoveGroup` / `ht32.treeRemoveFile` | 從群組移除 |
| `Delete File` | `ht32.treeDeleteFile` | 從磁碟刪除檔案（Delete 鍵） |

---

## 主要函式結構

```
activate()
  ├── 註冊所有 commands
  ├── 建立 ProjectTreeProvider + RecentTreeProvider（TreeView）
  ├── autoAttachProjectFromWorkspace()         ← 啟動時自動偵測既有專案
  └── ensureToolchain(root, extensionPath)     ← 檢查 GCC / Make 是否存在

createProject()
  └── runCreateProjectWizard() → generateProjectFiles() → generateTasksAndLaunchAndMakefile(wsOpenRoot)

convertUvision()
  └── uv2make() → generateTasksAndLaunchAndMakefile(root, { elfPath, deviceName, mcu, ramOrigin, ramLength })

convertHt32Ide()
  └── convertHt32IdeProject() → persistMeta() → generateTasksAndLaunchAndMakefile(root)

generateTasksAndLaunchAndMakefile()
  ├── 讀取 project.settings.json（per-project）+ machine settings（gcc/make/openocd path）
  ├── locateMake(extensionPath) / locateArmGcc()  ← 設定值優先，否則自動偵測
  ├── selectInterfaceCfg()               ← e-Link32 / ST-Link / J-Link
  ├── findSvdFile()                      ← 從 DFP 自動查找 SVD
  ├── bgDirSuffix(dir)                   ← 模組級函式；bg 目錄名 → config 名稱後綴（"HT32_12364" → ""，"Project_IAP" → "IAP"）
  ├── [SPIM extra loader 偵測]           ← ldUncoveredFlashAddrs() → selectSpimHlm()（見 arch/flash-loader.md）
  ├── writeMakefileToolsSettings()       → .vscode/settings.json
  ├── write tasks.json                   (Build / Clean；多 Project 時加 Build All)
  └── write launch.json                  (cortex-debug + OpenOCD；lib 模式略過)
       ├── Debug config:  request="launch"，runToEntryPoint="main"
       └── Attach config: request="attach"（不重置、不 flash、連線後保持目標當前狀態）
                          postLaunchCommands: ["monitor halt"]（確保停止）
                          htBgDir 欄位記錄所屬 bgDir（供 ht32.startDebug 過濾用，取代字串比對）

selectTargetCfg(mcu?, deviceName?)
  ├── F490x → target/HLM490x1.cfg
  ├── F491x → target/HLM491x3.cfg
  ├── F493x → target/HLM493x5.cfg
  ├── M3/M4/M7 → target/HLMm3x.cfg
  └── default → target/HLMm0x.cfg

findSvdFile(dfpPath, deviceName, extPath[, extraPdscPaths])  [uv2make.ts]
  ├── 讀 PDSC <debug svd="..."/> 屬性（device > subFamily > family，device 優先）
  ├── 搜尋順序：ht32.dfpPath → extraPdscPaths → bundled dfp（新版優先）
  ├── bundled 結果以 deviceName 為 key 快取（_svdDeviceCache）
  └── DFP 更新後 clearSvdCache() 清除快取（同 _doExtractDfpPacks 清除其他 PDSC 快取）

ProjectTreeProvider
  └── 掃描 HT32_VSCode/Project*/ 下的 project.meta.json 建立多專案樹（舊版相容：.vscode/build-gen*/）

RecentTreeProvider
  └── 顯示最近開啟的 HT32 專案（最多 10 筆，點擊後移至首位再 openFolder）
```

---

## 資料流程

```
使用者選擇專案
      │
      ├─ Keil .uvprojx ──→ uv2make.ts
      │                       │ 解析 XML (fast-xml-parser)
      │                       │ 套用 project.settings.json（optimization、specs、floatAbi 等）
      │                       ↓
      ├─ Eclipse .cproject ─→ ht32ide2make.ts → patchStartupFiles()
      │
      └─ Create Project ────→ createProject.ts（FWLib templates/ + generateProjectFiles()）
                              │
                              ↓
                    HT32_VSCode/Project*/   (新版；舊版相容：.vscode/build-gen*/)
                    ├── Makefile              (-mcpu, -O?, --specs=nano, ...)
                    ├── linker.ld             (實際保留原始檔名，記錄於 project.meta.json ldFile)
                    ├── sources.list          ┐
                    ├── includes.list         │
                    ├── defines.list          ├─ Makefile 以 $(file <) 讀取
                    ├── adefines.list         ┘  (ADEFS → ASFLAGS only)
                    ├── project.meta.json     (TreeView 資料來源)
                    ├── project.settings.json (per-project 設定 + conversion metadata，含 cDefs/aDefs)
                    └── compile_commands.json ← writeCCDbFromLists() 讀 defines.list + adefines.list 產出
                                               三條路徑均先寫 .list，再呼叫同一函式，
                                               clangd Regenerate 命令也走相同路徑
                              │
                              ↓
                    HT32_VSCode/.vscode/      (新版；舊版為 .vscode/)
                    ├── tasks.json            (Build / Clean；多專案加 Build All)
                    ├── launch.json           (cortex-debug + svdFile；lib 模式略過)
                    └── settings.json         (gcc/openocd 路徑 + clangd query-driver)
```

---

## 關鍵依賴

| 依賴 | 用途 |
|------|------|
| `fast-xml-parser` | 解析 `.uvprojx` / `.cproject`（XML） |
| `marus25.cortex-debug` | Extension dependency，提供 ARM 偵錯支援 |
| `openocd.exe`（打包） | Windows x64 pre-bundled，含各 HT32 MCU cfg |
| `make.exe`（打包） | Windows x64 pre-bundled，避免使用者手動安裝 |
| `dfp/` SVD 檔（打包） | Cortex-Debug peripheral register view 用 |

---

## Heap / Stack 設計規則

### 三大需求

1. **Heap 保留原始值**：所有路徑（Create Project、Convert uVision、HT32-IDE）均保留 FWLib 原始 Heap_Size，不做最小值強制。
2. **無雙重分配**：startup `.s` 的 `.space` 和 LD 的 `_Min_Heap_Size` 不能同時分配相同記憶體。
3. **RAM usage 計算**：`--print-memory-usage` 必須把 heap/stack 計入 RAM。  
   - 需要：startup section flag = `"aw",%nobits`（SHF_ALLOC + SHT_NOBITS）
   - 需要：LD 有 `KEEP(*(.heap))` / `KEEP(*(.stack))`（防 `--gc-sections` 丟棄）

### STD 系列 vs 49x 系列 — heap/stack 來源不同

| 面向 | STD（M0/M3/M4） | 49x（HT32F49xxx） |
|------|-----------------|-------------------|
| Heap 大小定義 | startup .s `Heap_Size EQU` + `.space` | LD `_Min_Heap_Size = 0xnnnn` |
| Stack 大小定義 | startup .s `Stack_Size EQU` + `.space` | LD `_Min_Stack_Size = 0xnnnn` |
| LD `_Min_*` | 必須 = 0x0（startup 已分配） | 即為唯一分配來源 |
| `__StackTop` symbol | startup .s 已定義；LD 以 `PROVIDE` 在 `.stack` section 結尾補 fallback | LD `patchLdStackSections` 注入 `__StackTop = _estack`（強賦值） |
| `__HT_check_sp` symbol | startup .s 已定義；LD 以 `PROVIDE` 在 `.stack` section 開頭補 fallback | LD `patchLdStackSections` 注入 `__HT_check_sp = _estack - _Min_Stack_Size`（強賦值） |

> **STD 與 49x 統一設計原則**：STD 全路徑（有無 scatter）均用 `PROVIDE`，startup .s 的 strong label 勝出；49x startup 無這兩個 label 且 `__StackTop` 無 C reference，故必須強賦值。

### 各轉換路徑對照

| 路徑 | startup 來源 | heap/stack 分配 | `__HT_check_sp` / `__StackTop` 來源 |
|------|-------------|-----------------|--------------------------------------|
| uVision STD — 無 scatter | FWLib GCC startup（keil2gnu fallback） | `.space` in startup | startup .s label（PROVIDE fallback） |
| uVision STD — 有 scatter | FWLib GCC startup（keil2gnu fallback） | `.space` in startup + scatter2ld `KEEP()` | startup .s label（PROVIDE fallback，與 no-scatter 一致） |
| uVision 49x — 無 scatter | FWLib GCC startup（Rule 3 直接複製） | LD `_Min_Heap/Stack_Size` | `_estack - _Min_Stack_Size`（強賦值） |
| uVision 49x — 有 scatter | FWLib GCC startup（Rule 3 直接複製） | scatter2ld `. += _Min_Heap/Stack_Size` | `__StackTop = _estack`；`__HT_check_sp = _estack - _Min_Stack_Size`（強賦值） |
| HT32-IDE STD | FWLib GCC startup（`patchStartupFiles`） | `.space` in startup + LD `KEEP()` | startup .s label（PROVIDE fallback） |
| HT32-IDE 49x | FWLib GCC startup（原始版，無 .heap 節） | LD `_Min_Heap/Stack_Size` | `_estack - _Min_Stack_Size`（強賦值） |
| Create Project STD | FWLib GCC startup（複製 + patch aw,%nobits） | `.space` in startup + LD `KEEP()` | startup .s label（PROVIDE fallback） |
| Create Project 49x | FWLib GCC startup（複製 + patch aw,%nobits） | LD `_Min_Heap/Stack_Size` + `patchLinkerMemory KEEP()` | `_estack - _Min_Stack_Size`（強賦值） |

### scatter2ld 路徑的 49x 偵測

`generateLinkerScript`（`uv2make.ts`）在呼叫 `scatter2ld` 前，檢查 `templateRoot` 是否包含 `device_support/startup/gcc`（49x 特有路徑），若是則傳入從 Keil `.s` `Heap_Size EQU` 解析的 `heapSize`/`stackSize`（找不到 EQU = 原始專案無 heap，維持 `undefined` → 0x0，不自行補預設值）。scatter2ld 收到非零 heapSize 時，改用 `. += _Min_Heap_Size` 分配（STD 或 heapSize=0 則保持 `_Min_* = 0x0`、僅 `KEEP`）。

### SHF_ALLOC 必要性

FWLib startup .s 預設用 `.section ".heap","w"` — 只有 SHF_WRITE，**無 SHF_ALLOC**。沒有 SHF_ALLOC 的 section 不參與 VMA 計算，`--print-memory-usage` 看不到 heap/stack，且 linker 可能把 section 放到 Flash 0x0。正確格式：`.section ".heap","aw",%nobits`（patch 由 `syncStackHeap` / `patchStartupFiles` / `patchStartupHeap` 執行）。

詳見 [`arch/linker-startup.md`](arch/linker-startup.md)。
