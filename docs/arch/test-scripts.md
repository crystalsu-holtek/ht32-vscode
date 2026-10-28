# 測試腳本（test_scripts/）

現有腳本：`test-helpers.js`、`test-mcu.js`、`test-create-project.js`、`create-prj.js`、`test-compile.js`、`ht32vs-make.js`、`batch-convert-htide.js`、`clean-prj.js`、`clean-vscode-templates.bat`。

FWLib 路徑清單共用同一個 ini：`test_scripts/fwlib-paths.ini`。所有腳本都需先 `npm run compile` 編譯 TypeScript。

> **注意：** `test-mcu.js` 複製了 extension 內部的 `selectTargetCfg` / `parseMcuCfg` / `selectInternalFlm` / `flmToHlm` 邏輯，修改主程式時必須同步更新 `test-mcu.js`。

---

## 完整測試流程

```bash
# 1. MCU 靜態覆蓋率（不需 FWLib，最快）
node test_scripts/test-mcu.js

# 2. Create Project wizard 測試（獨立，不影響 convert 流程）
node test_scripts/test-create-project.js --lib 5xxxx

# 3. 清場：還原 FWLib examples 乾淨狀態（刪 MDK_ARMv5/HT32-IDE/HT32_VSCode 等）
node test_scripts/clean-prj.js --lib 5xxxx

# 4. 建立 IDE project 檔（STD 系列跑 _CreateProject.bat；49x 無此步驟）
node test_scripts/create-prj.js --lib 5xxxx

# 5. 轉換 + 編譯（不帶 --create，假設 Step 4 已完成）
node test_scripts/test-compile.js --lib 5xxxx
```

---

## 腳本定位比較

| 腳本 | 速度 | 需要 FWLib | 需要 GCC | 適合時機 |
|------|------|-----------|---------|---------|
| test-helpers.js | — | — | — | 共用驗證函式庫（被 import，不直接執行）|
| test-mcu.js | 快 | 不需要 | 不需要 | 修改 HLM/cfg/OpenOCD 相關 |
| test-create-project.js | 中 | 需要 | 預設需要（`--no-compile` 跳過）| 修改 createProject.ts |
| create-prj.js | 中 | 需要 | 不需要 | test-compile.js 前置：建立 STD example 專案 |
| test-compile.js | 慢 | 需要 | 需要 | 修改 uv2make.ts / ht32ide2make.ts |
| **ht32vs-make.js** | 慢 | 需要 | 需要 | 用 `.ht32vs` 批次 build 已存在的 VS Code 專案；完整走 Open Project 流程 |
| batch-convert-htide.js | 中 | 需要 | 不需要 | 快速批次轉換 HT32-IDE，不編譯 |
| clean-prj.js | 快 | 需要 | 不需要 | 測試前清場 |

---

## test-mcu.js — MCU 靜態覆蓋率（PDSC 反向查 OpenOCD 資源）

以 PDSC 為唯一真相來源，對每個 MCU 反向確認 OpenOCD 資源是否齊全。不需要 FWLib，純靜態分析。

輸出欄位：Device / Core / PDSC Flash（algorithm 範圍）/ FLM / Target CFG / WorkArea / WA src / Issues

**Issues 欄說明：**

| Issue | 意義 |
|-------|------|
| `no-PDSC-flash` | PDSC 找不到 flash algorithm |
| `no-FLM` | 無法從 PDSC 選出 FLM |
| `no-HLM` | FLM 對應的 `.HLM` 不在 `FlashLoader/` |
| `no-MCUcfg` | `openocd/MCU/<device>.cfg` 不存在 |
| `no-WorkArea` | Settings.ini 與 PDSC IRAM1 均無 WORKAREASIZE |
| `cfg-start-mismatch` | MCU cfg 的 Flash 起始位址與 PDSC IROM1.start 不符 |
| `size-mismatch` | MCU cfg 的 Flash 大小與 PDSC IROM1.size 不符（可能是 PDSC 或 cfg 任一方有誤，見下方說明） |
| `pdsc-incl-opt` | PDSC IROM1.size 包含 option page 但 cfg 已扣除，兩者不一致（PDSC authoring error） |
| `cfg-incl-opt` | cfg.flash 為 2 的次方，表示 cfg（與 PDSC）均未扣除 option page（cfg authoring error） |

**主要邏輯（與主程式同步）：**
- `parseMcuCfg` → Flash/Option 位址從 **PDSC algorithm** 讀取
- `selectInternalFlm` → 從 PDSC 找 FLM 名稱（按 flash 大小匹配）
- `flmToHlm` → FLM→HLM extension swap，確認 `.HLM` 在 `FlashLoader/` 存在
- `hasMcuCfg` → `openocd/MCU/<device>.cfg` 是否存在
- `parseMcuCfgFile` → 讀取 cfg 的 pageSize/Flash/Option，與 PDSC IROM1 做一致性比對

**cfg-size-mismatch / pdsc-incl-opt / cfg-incl-opt 判斷邏輯：**

標準系列（IROM1.start=0）的最後一個 page 是 option bytes，PDSC 慣例是 IROM1.size 已預先扣掉該 page（如 0x7C00 = 32KB − 1KB），cfg.flash 同樣已扣除。

| 狀況 | PDSC IROM1 | cfg.flash | 判斷 |
|------|-----------|-----------|------|
| 正常 | 0x7C00（非 2 次方） | 0x7C00 | OK |
| `pdsc-incl-opt` | 0x8000（2 次方，含 option） | 0x7C00（已扣） | PDSC 有問題，cfg 正確 |
| `cfg-incl-opt` | 0x8000 | 0x8000（未扣） | cfg 有問題（PDSC 與 cfg 一致但均未扣） |
| `size-mismatch` | 任意 | 對不上 | 資料不一致（需查 datasheet 確認哪方有誤） |

49x 系列（IROM1.start=0x08000000）的 option bytes 在獨立位址（0x1FFFF800），flash 不含 option page，故 `cfg.flash == IROM1.size` 直接相等，不減 pageSize。

**為何無法自動生成 MCU cfg：**

自動生成 `openocd/MCU/<device>.cfg` 需要三個欄位：flash 起始位址、flash 大小、pageSize（erase sector size）。前兩者可從 PDSC IROM1 取得，但 **pageSize 無法從靜態資料推算**：

- PDSC 無 pageSize 欄位
- 相同 flash 大小的不同系列可能有不同 pageSize（例如同為 32KB：HT32F52331=0x200，HT32F52231=0x400）
- FLM（Keil flash algorithm）在執行時期讀取 MCU 硬體的 **PSSR（Page Size Status Register）**暫存器動態取得，並非寫死在二進位中
- 因此沒有可靠的靜態方式推算缺少 cfg 的裝置之 pageSize；需查 datasheet 或參考同系列已有 cfg 的型號

Warning(!) = PDSC 無 flash info **或** 任一 OpenOCD 資源缺少 **或** PDSC 與 cfg 資料不一致。

```bash
node test_scripts/test-mcu.js
```

---

## test-create-project.js — Create Project 完整性

對每個 FWLib 的每個 MCU 呼叫 `generateProjectFiles()`，逐層驗證。**五層全部預設開啟**，只有明確下 `--no-xxx` 才跳過。支援 Ctrl+C 中斷（等目前工作完成後結束）。

| 層 | 內容 | 跳過 flag |
|----|------|-----------|
| 第一層（靜態）| FWLib 資源存在性（mk 檔、linker.ld、RAM/Flash 查得到）| `--no-static` |
| 第二層（產生）| 實際呼叫 generateProjectFiles，驗證 startup/linker/Makefile 正確性 | `--no-generate` |
| 第三層（編譯）| 執行 make，確認可成功編譯 | `--no-compile` |
| 第四層（heap/stack）| 修改 Stack_Size/Heap_Size 後驗證 RAM usage 正確變化 | `--no-heap-stack` |
| 第五層（lib 模式）| 每個 FWLib 取一 MCU 測試 lib 模式產生 | `--no-lib` |

```bash
node test_scripts/test-create-project.js                   # 全部 FWLib，五層全測
node test_scripts/test-create-project.js --lib 5xxxx       # 指定 FWLib（在 ini 中搜尋）
node test_scripts/test-create-project.js --mcu 6624*       # 只測特定 MCU（支援 * ? 萬用字元）
node test_scripts/test-create-project.js --no-compile      # 跳過第三層 make
node test_scripts/test-create-project.js --no-heap-stack   # 跳過第四層
node test_scripts/test-create-project.js --no-lib          # 跳過第五層
node test_scripts/test-create-project.js --workers 4       # 並行數（預設有編譯=2，無編譯=4）
```

---

## create-prj.js — 批次執行 _CreateProject.bat（STD 系列前置步驟）

對 STD FWLib 每個 example **sequential** 執行 `_CreateProject.bat`，建立 MDK_ARMv5 + HT32-IDE 專案檔。Sequential 執行是為了避免多個 bat 並行競爭 FWLib root 的 `gsar.exe`（race condition）。完成後再用 `test-compile.js`（不帶 `--create`）進行轉換 + 編譯。

```bash
node test_scripts/create-prj.js --lib 5xxxx    # 指定 FWLib
node test_scripts/create-prj.js --all          # 所有 FWLib
node test_scripts/create-prj.js --filter TM    # 只建名稱完全吻合的 examples
node test_scripts/create-prj.js --limit 5
```

---

## test-compile.js — uVision / HT32-IDE 轉換 + 編譯

對 FWLib 每個 example 分別測試 uVision 和 HT32-IDE 兩條轉換路徑，再執行 make 編譯。預設**不執行** `_CreateProject.bat`，需先用 `create-prj.js` 建好專案（或加 `--create` 自動執行）。支援 Ctrl+C 中斷。

```bash
node test_scripts/test-compile.js                        # 需至少一個 option，否則印說明
node test_scripts/test-compile.js --lib 5xxxx            # 指定 FWLib（在 ini 中搜尋）
node test_scripts/test-compile.js --all                  # 掃描所有 FWLib（來自 fwlib-paths.ini）
node test_scripts/test-compile.js --mcu 6624*            # 只測特定 MCU（支援 * ? 萬用字元）
node test_scripts/test-compile.js --filter <name>        # 只跑 example 名稱完全吻合的項目
node test_scripts/test-compile.js --limit <n>            # 只跑前 n 個 examples
node test_scripts/test-compile.js --no-compile           # 只測轉換，不 make
node test_scripts/test-compile.js --create               # 執行 _CreateProject.bat（否則假設已建好）
node test_scripts/test-compile.js --variants 1           # 每個 example 只測 1 個 MCU（預設 3）
node test_scripts/test-compile.js --workers 4            # 並行 example 數（預設 4）
```

---

## batch-convert-htide.js + clean-vscode-templates.bat — 批次 HT32-IDE 轉換

兩個工具搭配使用，用於批次驗證 HT32-IDE 轉換路徑。

**`batch-convert-htide.js`**：遞迴掃描 `<examples-dir>` 下所有含 `.project` + `.cproject` 的 HT32-IDE 子目錄，逐一呼叫 `convertHt32IdeProject()`，產出結構與 extension「Convert HT32-IDE Project」完全一致。每個 example 回報 `OK` / `WARN` / `FAIL`。

```bash
node test_scripts/batch-convert-htide.js <examples-dir> [gcc-path]

# 範例
node test_scripts/batch-convert-htide.js E:\HT32F493x5_FWLib_V1.2.1\project\ht32f49395_sk\examples
node test_scripts/batch-convert-htide.js E:\FWLib\examples "C:\gcc\bin\arm-none-eabi-gcc.exe"
```

**`clean-vscode-templates.bat`**：讀取 `fwlib-paths.ini`，清除各 FWLib template 目錄（STD `project_template/IP/{Example|Template|Template_USB}/HT32_VSCode/`、49x `project/ht32f49*/templates/HT32_VSCode/`）中 extension 自動產生的檔案，只保留 `project.meta.json` / `project.settings.json` 兩個專案檔。具體動作：刪除 `.vscode/`、刪除 `Project/` 及 `Project_*/` 內所有非 `.json` 檔（Makefile、.ld、.s 等）、移除 `project.settings.json` 中的 `postBuildCmd` 欄位。

```bat
test_scripts\clean-vscode-templates.bat
```

**典型工作流程**：
```
batch-convert-htide.js <dir>        ← 批次轉換，確認輸出正確
clean-vscode-templates.bat          ← 清除產出，template 回到只剩兩個 JSON
```

---

## test-helpers.js — 共用輸出驗證函式庫

供 `test-compile.js` 與 `test-create-project.js` 共用，**不可直接執行**。所有函式只讀取 extension 產生的檔案（startup .s、linker .ld）並回傳問題字串陣列，不重複 extension 的轉換邏輯。

| 函式 | 說明 |
|------|------|
| `checkThumbLsbFile(path)` | startup .s 的 Reset_Handler 是否標記 `.type %function`（缺少→HardFault）|
| `checkThumbLsbInDir(dir)` | 掃描目錄下所有 `startup_*.s` 的 Thumb LSB |
| `checkStartupSections(path, content?)` | startup .s 的 `.heap`/`.stack` 區段是否有 `"aw",%nobits`；`content` 選填，避免重複讀檔 |
| `checkStartupSectionsInDir(dir)` | 掃描目錄下所有 startup 的 `"aw",%nobits` |
| `checkLinkerStd(ldPath, startupDir)` | STD linker：有無 `KEEP(*(.heap))`/`KEEP(*(.stack))`、`__StackTop`、`__HT_check_sp` |
| `checkLinker49x(ldPath)` | 49x linker：有無 `._user_heap_stack`、`__StackTop`、`__HT_check_sp` |
| `checkLinker49xHeapSize(ldPath, minHeapSize)` | 49x linker：`_Min_Heap_Size` 數值是否 ≥ 門檻（`minHeapSize=0` 表示跳過數值比對）|
| `readLdSym(content, sym)` | 從 LD 文字讀取 `sym = val;`，回傳整數或 null |
| `readStartupEquFromDir(dir, sym)` | 從 startup .s 的 `.equ` 讀取符號值 |
| `readHeapStackSizes(dir, ldPath)` | 自動偵測 STD/49x，回傳 `{ heap, stack }` 位元組數（用於 RAM delta 驗證）|
| `parseRamFromMakeOutput(stdout, stderr)` | 從 `--print-memory-usage` 輸出解析 RAM 位元組數 |

**修改時機**：當 extension 改變 startup .s / linker 格式時，同步更新對應的 check 函式。

---

## clean-prj.js — 清除 example 產出（測試前清場）

**STD 系列**：執行 `_ClearProject.bat`（刪 MDK_ARMv5、HT32-IDE 等 IDE 目錄）＋ 額外刪 `HT32_VSCode/`、`.vscode/`、`.clangd/`。  
**49x 系列**：直接刪 `HT32_VSCode/`、`.vscode/`、`.clangd/`（無 bat）。

```bash
node test_scripts/clean-prj.js --lib 5xxxx    # 指定 FWLib
node test_scripts/clean-prj.js --all          # 所有 FWLib
node test_scripts/clean-prj.js --filter uart  # 只清名稱吻合的 examples
node test_scripts/clean-prj.js --limit 5
```

---

## ht32vs-make.js — CLI 批次 build（Open Project 流程）

讀取 `.ht32vs` 專案檔，對每個 build-gen 目錄走完整的 Open Project 三步驟，再執行 make。

**三步驟與 `initProjectsFromMeta` 完全一致：**

| 步驟 | 函式 | 說明 |
|------|------|------|
| 1 | `buildMakefileText(...)` | 從 `project.settings.json` 產生完整 Makefile skeleton |
| 2 | `refreshDerivedFiles(bgDir, meta, { gccPath, onWarn })` | 寫 SRCS/rules/lists/compile_commands.json |
| 3 | `writeCCDbFromLists(...)` | 以解析後的 GCC 路徑覆寫 compile_commands.json |

> **重要**：所有邏輯使用 extension 自身匯出的函式，不另行實作。VS Code 的 `showWarningMessage` 與 `ht32.gccPath` 設定透過 `onWarn` / `gccPath` opts 注入，由 CLI 改為寫到 log。

```bash
# Usage
ht32vs-make.exe <project.ht32vs> [options]

# Options
-o <file>      輸出 log 到檔案（同時印到 stdout）
--no-regen     跳過 Makefile 重建（使用現有 Makefile）
--no-compile   只重建 Makefile，不執行 make
-j <n>         make 並行 jobs 數
```

**進入點**：`test_scripts/ht32vs-make.js`；以 `pkg` 打包成 `afterbuild/ht32vs-make.exe`（Windows x64）。

---

## 已知風險：高負載下 uvprojx 讀取時機問題

**現象**：test-compile.js 全量測試（~166 examples 並行）時，偶發 `undefined reference to 'XXX'`，重測即 OK。

**根本原因**：`--create` 模式下，`_CreateProject.bat` exit 後立刻轉換。在高系統負載下，Windows batch 啟動的子 process（`gsar.exe` 等）雖已讓 bat exit，但 file system buffer 尚未完全 flush，轉換讀到不完整的 uvprojx（缺少某些 source file 項目）。

**處理方式**：改用 `create-prj.js` 先建好（sequential，與 `test-compile.js` 分離執行）可根本避免此問題。或降低 `--workers` 數量；重測通常也可解。
