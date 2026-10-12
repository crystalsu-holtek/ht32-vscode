# 輸出目錄結構與檔案說明

## 輸出目錄結構

所有 VS Code 相關產出集中在 `HT32_VSCode/` 子目錄，與 `MDK_ARMv5/`、`HT32-IDE/` 等並列。VS Code 以 `HT32_VSCode/` 作為 workspace root。

```
PROJECT_ROOT/
├── MDK_ARMv5/            ← Keil 專案
├── HT32-IDE/             ← HT32-IDE 專案
└── HT32_VSCode/          ← VS Code workspace root（VS Code 開啟此目錄）
    ├── .vscode/
    │   ├── tasks.json
    │   ├── launch.json
    │   └── settings.json
    ├── GNU_ARM/          ← startup .s 檔（來自 FWLib 複製 + patch）
    │   └── startup_ht32f5xxxx_gcc_01.s
    └── Project/          ← 主 build 目錄（Project_iap/ 等為多專案）
        ├── Makefile
        ├── linker.ld     ← 實際保留原始檔名（e.g. HT32F12345_FLASH.ld）
        ├── sources.list
        ├── includes.list
        ├── defines.list
        ├── adefines.list
        ├── project.meta.json   ← 含 ldFile 欄位記錄實際 linker script 檔名
        ├── project.settings.json
        ├── compile_commands.json
        └── build/        ← make 輸出
```

**關鍵函式**：
- `bgParent(root)` — 回傳 Project 的父目錄（`HT32_VSCode/`）
- `computeWsOpenRoot(root)` — 回傳 VS Code workspace 應開啟的目錄（`HT32_VSCode/`）
- `bgRel` — workspace root 到 bgParent 的相對路徑（空字串）

---

## Project/ 各檔案說明

| 檔案 | 用途 | 更新時機 |
|------|------|---------|
| `Makefile` | `make` 編譯主體：TARGET、CFLAGS、LDFLAGS、每個源文件的獨立規則 | 轉換時產生；TreeView 變動時 patch SRCS/OBJ/規則區段 |
| linker script | GNU LD linker script，含 FLASH/RAM 地址與大小；**保留原始檔名**（e.g. `linker.ld`、`HT32F12345_FLASH.ld`）；檔名記錄於 `project.meta.json` 的 `ldFile` 欄位 | 只在轉換時產生 |
| `sources.list` | 源文件路徑清單（相對 Project/，`\n` 分隔）。**Makefile 不讀**（SRCS 硬寫）；extension `refreshDerivedFiles()` 讀取以 patch Makefile SRCS / compile_commands | 轉換 + TreeView 變動時重寫 |
| `includes.list` | include 路徑清單（空格分隔 `-I"path"`）。**Makefile 以 `$(file <includes.list)` 讀取**（需 GNU Make 4.0+）；extension `refreshDerivedFiles()` 讀取以產生 compile_commands | 轉換時寫入；每次 `refreshDerivedFiles` 更新 |
| `defines.list` | C compiler preprocessor define 清單（空格分隔 `-DFOO`）。**Makefile 以 `$(file <defines.list)` 讀取**；`DEFS := $(file <defines.list)` 展開後加入 CFLAGS 與 ASFLAGS | 轉換時寫入；Settings Webview 的 `cDefs` 更新時重寫 |
| `adefines.list` | 組語專屬 preprocessor define 清單（空格分隔 `-DFOO`）。**Makefile 以 `$(file <adefines.list)` 讀取**；`ADEFS := $(file <adefines.list)` 只附加到 ASFLAGS，不影響 CFLAGS。標準系列含 `USE_HT32_CHIP=X`，49x 系列為空。空檔案 = 空字串 = 不影響編譯 | 轉換時寫入（即使為空）；Settings Webview 的 `aDefs` 更新時重寫；`regenerateMakefileFlags` 升級舊 Makefile 時自動建立 |
| `project.meta.json` | TreeView 資料來源：`{ projectName, groups: { "GroupName": ["rel/path/..."] } }`，路徑相對 workspace root | 轉換 + TreeView 變動時更新 |
| `project.settings.json` | Per-project 設定 + conversion metadata：optimizationLevel / floatAbi / fpu / specs / extraCFlags / extraLDFlags / debugInterface / flashLoaders / includePaths / **cDefs / aDefs** / **mcu / targetName / ramOrigin / ramLength / deviceName / fwlibSeries / outputType**（粗體為 conversion metadata，原存於 `build.meta.json`；`cDefs` / `aDefs` 為 defines 快照，Settings Webview 編輯後寫回對應 .list 檔）| 轉換時寫入；Settings Webview 存檔時更新 |
| `compile_commands.json` | Clang Compilation Database，給 clangd IntelliSense 使用；`make` 不讀此檔。每個 Project/ 各自有一份，包含完整 gcc 路徑、`--target=arm-none-eabi`、`-isystem` 旗標。**`.vscode/compile_commands.json` 不再產生**；clangd 讀取哪一份由 `.clangd` 的 `CompilationDatabase` 決定（TreeView 點選時切換）。 | 轉換 + TreeView 變動時重寫 |
| `startup_ht32f5xxxx_gcc_NN.s` | GNU 格式啟動碼，定義 Stack_Size / Heap_Size，放入 `.stack`/`.heap` section | 只在轉換時從 FWLib 複製並 patch（`"aw",%nobits`；uVision 另外 sync Keil EQU 值） |
| `ht32_op.c` / `ht32_op2.c` | Holtek option byte 程式，從 template 複製（`handleKeilAsm` Rule 2，正則 `/^ht32_op.*\.s$/i`）；`ht32_op2.c` 僅部分 MCU 存在 | 只在轉換時產生（uVision，遇到對應 `.s` 時）|
| `build/` | make 輸出目錄：`.o` 物件檔 + `<OutputName>.elf` | make 執行時產生 |

### 檔案依賴關係

```
uvprojx / .cproject / Create Project
  └─ converter ──────┬─ Makefile                ← make 編譯（SRCS 硬寫；INCS/DEFS 讀 list）
                     ├─ linker_script.ld
                     ├─ sources.list             ← extension refreshDerivedFiles()
                     ├─ includes.list            ← Makefile $(file <) + extension compile_commands
                     ├─ defines.list             ← Makefile $(file <)；Settings Webview cDefs 更新時重寫
                     ├─ adefines.list            ← Makefile $(file <) → ADEFS → ASFLAGS；Settings Webview aDefs 更新時重寫
                     ├─ project.meta.json        ← TreeView
                     ├─ project.settings.json    ← generateTasksAndLaunchAndMakefile() + Settings Webview
                     └─ compile_commands.json    ← IntelliSense

TreeView add/remove
  └─ persistMeta() ──────┬─ project.meta.json (重寫)
                         └─ refreshDerivedFiles()
                               ├─ sources.list      (重寫)
                               ├─ Makefile          (patch SRCS/OBJ/規則)
                               └─ compile_commands.json (重寫，讀 includes.list)
```

---

## VS Code 設定（Ctrl+, 搜尋 HT32）

### 機器設定（全域共用，存於 VS Code User settings）

| 設定 | 說明 | 預設 |
|------|------|------|
| `ht32.gccPath` | arm-none-eabi-gcc 路徑 | 自動偵測 |
| `ht32.makePath` | make 路徑（進階；一般使用 bundled make） | 自動偵測 |
| `ht32.openocdPath` | OpenOCD 路徑（空 = 用內建） | 空 |

### Per-project 設定（存於 `HT32_VSCode/Project*/project.settings.json`，透過 HT32 Settings WebView 編輯）

| 設定 | 說明 | 預設 |
|------|------|------|
| `optimizationLevel` | -O 旗標（O0/O1/O2/O3/Os/Og） | Os |
| `floatAbi` | soft / softfp / hard | soft |
| `fpu` | none / fpv4-sp-d16 / fpv5-sp-d16 / fpv5-d16 | none |
| `specs` | nano / standard / nosys | nano |
| `debugInterface` | e-Link32 Pro / e-Link32 Lite / ST-Link / J-Link | e-Link32 Pro |
| `dfpPath` | DFP 根目錄（自動查找 SVD 用） | 空 |
| `svdFile` | SVD 路徑（空 = 從 DFP 自動查找） | 空 |
| `extraCFlags` | 附加到 CFLAGS 的額外旗標 | 空 |
| `extraLDFlags` | 附加到 LDFLAGS 的額外旗標（如 -u _printf_float） | 空 |
| `includePaths` | include 路徑清單（bgDir-relative，含 `../` 時表示 workspace 外；跨 drive 才用絕對路徑） | 空 |
| `flashLoaders` | 外部 Flash Loader 清單（SPIM HLM + start/end） | 空 |

---

## build.meta.json 整合進 project.settings.json

`build.meta.json` 與 `project.settings.json` 都放在 `Project/` 下，整合為單一檔案降低讀寫複雜度。

`ProjectSettings` 型別含 7 個原 `build.meta.json` 欄位：`mcu`、`targetName`、`ramOrigin`、`ramLength`、`deviceName`、`fwlibSeries`、`outputType`。

三條轉換路徑（uv2make / ht32ide2make / createProject）寫入 `project.settings.json` 時，連同原 `build.meta.json` 的欄位一併寫入。不再另建 `build.meta.json`。

**向下相容**：`readProjectSettings()` 讀到 `mcu` 欄位缺失時，嘗試讀 `build.meta.json` 並 merge（供舊版轉換的專案使用）。

---

## .list 檔設計

三條轉換路徑（uVision / HT32-IDE / Create Project）統一寫出四個 list 檔：`sources.list`、`includes.list`、`defines.list`、`adefines.list`。

**Makefile 讀取機制**：
```makefile
INCS  := $(file <includes.list)   # GNU Make 4.0+ 純 Make 函式，不依賴 shell
DEFS  := $(file <defines.list)
ADEFS := $(file <adefines.list)   # 組語專屬 defines；空檔案 = 空字串 = 不影響編譯
```
`$(file <filename)` 在 Windows 上不需要 sh.exe（Makefile 設 `SHELL := cmd.exe`，`$(shell cat)` 失效），因此需要 GNU Make 4.0+（bundled make.exe 為 4.4.1）。`adefines.list` 不存在時 GNU Make 回傳空字串（不報錯）；`regenerateMakefileFlags` 升級舊 Makefile 時會自動插入 `ADEFS` 行並建立空檔。

**SRCS 保持 hardcode 的原因**：
1. Make 用空白分隔字詞，含空格的路徑放進 SRCS 會被切斷
2. 每個 source 需要一個獨立的 explicit compile rule，由 extension 在轉換 / TreeView 變動時產生

**各 list 檔的讀取者**：

| 檔案 | Makefile | extension |
|------|----------|-----------|
| `sources.list` | ✗ | `refreshDerivedFiles()` 讀取以 patch Makefile SRCS + compile_commands |
| `includes.list` | ✓ `$(file <)` → `INCS` → CFLAGS + ASFLAGS | `refreshDerivedFiles()` 讀取以產生 compile_commands |
| `defines.list` | ✓ `$(file <)` → `DEFS` → CFLAGS + ASFLAGS | `writeCCDbFromLists()` 讀取；Settings Webview `cDefs` 存檔時重寫 |
| `adefines.list` | ✓ `$(file <)` → `ADEFS` → **ASFLAGS only** | `writeCCDbFromLists()` 讀取（合併 defines.list 給 clangd）；Settings Webview `aDefs` 存檔時重寫 |

**`regenerateMakefileFlags` 的 .list 更新規則**：
- `includePaths` 非 undefined → 重寫 `includes.list`
- `cDefs` 非 undefined → 重寫 `defines.list`
- `aDefs` 非 undefined → 重寫 `adefines.list`
- 三者均傳 undefined 時（例如只改 optimizationLevel）不動 .list 檔案

---

## 路徑正規化規則

所有轉換路徑（uVision / HT32-IDE / Create Project）遵守以下路徑格式，確保跨機器可攜性：

| 欄位 | 基準 | 格式 | 來源函式 |
|------|------|------|---------|
| `project.meta.json` groups | workspace root（`HT32_VSCode/` 父目錄） | 相對路徑，`../` 表示 workspace 外（FWLib 等）；僅跨 drive 才用絕對 | `buildProjectMeta()` / `uv2make metaGroups` |
| `project.settings.json` includePaths | bgDir（`Project/`） | 相對路徑，`../` 表示 bgDir 外；僅跨 drive 才用絕對 | 三條路徑轉換器寫入時以 `path.relative(bgDir, abs)` 正規化 |
| `sources.list` | bgDir | 相對路徑（bgDir-relative），由 `refreshDerivedFiles()` 從 `meta.groups` 轉換而來 | `refreshDerivedFiles()` |
| `includes.list` | bgDir | `-I"bgDir-relative-path"` 格式 | 轉換器初始寫入；Settings Webview 更新時由 `regenerateMakefileFlags()` 重寫 |

**設計原則**：`project.meta.json` 用 wsRoot-relative 讓 TreeView 可定位原始碼；`sources.list` / `includes.list` 用 bgDir-relative 讓 Makefile 以 `$(file <)` 直接讀取。`refreshDerivedFiles()` 是兩者之間的橋梁，負責將 wsRoot-relative（含 `../`）或絕對路徑統一轉換成 bgDir-relative。

**跨 drive 例外**：`path.relative()` 在 Windows 跨磁碟時回傳絕對路徑，此時直接保留絕對路徑。Create Project 對跨 drive 直接 throw error。
