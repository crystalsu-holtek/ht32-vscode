# Extension 對 FWLib 的依賴關係

---

## Convert — 標準系列

| 檔案 | uVision | HT32-IDE |
|---|---|---|
| **startup .s** | FWLib `project_template/IP/Example/GNU_ARM/startup_xxx_gcc_NN.s`（`handleKeilAsm` Rule 1），同步 Keil Stack/Heap 大小並 patch `"aw",%nobits`；**FWLib 缺失時 fallback 到 bundled `templates/{familyTag}/GNU_ARM/`** | `.project` source 已是 GCC .s，copy 到 `GNU_ARM/` 並 patch `"aw",%nobits`（`patchStartupFiles`）|
| **ht32_op.c / ht32_op2.c** | FWLib `project_template/IP/Example/GNU_ARM/ht32_op*.c`（`handleKeilAsm` Rule 2，正則 `/^ht32_op.*\.s$/i`，同名 `.c` 取代）；**FWLib 缺失時 fallback 到 bundled `templates/{familyTag}/GNU_ARM/ht32_op*.c`** | — （專案本身已含）|
| **linker script** | `.uvprojx` scatter 檔經 `scatter2ld.ts` 轉換；找不到時從 FWLib `project_template/IP/Example/GNU_ARM/linker.ld` 取得；**FWLib 缺失時 fallback 到 bundled `templates/{familyTag}/GNU_ARM/linker.ld`** | `.cproject` 指定的 scriptfile；找不到時從 FWLib `project_template/IP/Example/GNU_ARM/linker.ld` 取得；**FWLib 缺失時 fallback 到 bundled `templates/{familyTag}/GNU_ARM/linker.ld`** |
| **syscalls.c** | `library/<series>_Driver/src/syscalls.c` 找不到時 copy bundled `templates/GNU_ARM/syscalls.c`；**純組語專案跳過** | — （專案本身已含）|
| **ht32_stack_analysis.c** | copy bundled `templates/GNU_ARM/ht32_stack_analysis.c` → `GNU_ARM/`；**純組語專案跳過** | copy bundled `templates/GNU_ARM/ht32_stack_analysis.c` → `GNU_ARM/`；**純組語專案跳過** |

> **`project_template/` 不存在時的 fallback（三條路徑均適用）**：Convert uVision 從 source 路徑反推 FWLib root，Convert HT32-IDE / Create Project 從使用者選取的 FWLib 路徑直接取得；若 `project_template/IP/Example/GNU_ARM/` 不存在，三條路徑都會自動 fallback 到 bundled `templates/{familyTag}/GNU_ARM/`。FWLib 有 `library/HT32*xxxx_Driver/` 結構即可，不一定需要 `project_template/`。

## Convert — 49x 系列

| 檔案 | uVision | HT32-IDE |
|---|---|---|
| **startup .s** | FWLib GCC template `startup_ht32f49xxx.s`，同步 Keil Stack/Heap 大小並 patch `"aw",%nobits`（`patchStartupFromKeil`） | `.project` source 已是 GCC .s（同路徑），copy 到 `GNU_ARM/` 並 patch `"aw",%nobits`（`patchStartupFiles`）|
| **ht32_op.c** | — （49x 無此檔）| — |
| **linker script** | `.uvprojx` scatter 檔經 `scatter2ld.ts` 轉換；找不到時從 FWLib `libraries/cmsis/cm4/device_support/startup/gcc/linker/<chip>_FLASH.ld` 取得 | `.cproject` 指定的 scriptfile；找不到時從 FWLib `libraries/cmsis/cm4/device_support/startup/gcc/linker/<chip>_FLASH.ld` 取得 |
| **syscalls.c** | 不需要；I/O stubs 已由 `board.c` 提供 | 不需要；I/O stubs 已由 `board.c` 提供 |
| **ht32_stack_analysis.c** | copy bundled `templates/GNU_ARM/ht32_stack_analysis.c` → `GNU_ARM/`；**純組語專案跳過** | copy bundled `templates/GNU_ARM/ht32_stack_analysis.c` → `GNU_ARM/`；**純組語專案跳過** |

> **純組語專案（例如 flash-image builder）**：不加 syscalls.c、也不加 `-specs=nano.specs`/`-specs=nosys.specs`，完全不鏈接 newlib

---

## Create Project
| 檔案 | 標準系列（1/4/5xxxx） | 49x 系列（490/491/493） |
|---|---|---|
| **startup .s** | FWLib `project_template/IP/Example/GNU_ARM/{startup}.s`，patch `"aw",%nobits`；**FWLib 缺失時 fallback 到 bundled `templates/{familyTag}/GNU_ARM/`** | FWLib `libraries/cmsis/cm4/device_support/startup/gcc/startup_ht32f49xxx.s`，patch `"aw",%nobits` |
| **ht32_op.c / ht32_op2.c** | FWLib `project_template/IP/Example/GNU_ARM/ht32_op*.c`；**FWLib 缺失時 fallback 到 bundled `templates/{familyTag}/GNU_ARM/ht32_op*.c`** | — |
| **linker script** | FWLib `project_template/IP/Example/GNU_ARM/linker.ld`，patch FLASH/RAM 大小；**FWLib 缺失時 fallback 到 bundled `templates/{familyTag}/GNU_ARM/linker.ld`** | FWLib `libraries/cmsis/cm4/device_support/startup/gcc/linker/<chip>_FLASH.ld`，patch KEEP(.heap/.stack) |
| **driver .c** | FWLib `library/<series>_Driver/src/*.c`（清單來自 `.mk`，全部加入）| FWLib `libraries/drivers/src/*.c`（掃目錄全部複製）|
| **system .c** | FWLib `project_template/IP/Example/<system_xxx>.c`；**FWLib 缺失時 fallback 到 bundled `templates/{familyTag}/`** | FWLib `libraries/cmsis/cm4/device_support/system_<family>.c` |
| **main.c / it.c** | FWLib `project_template/IP/Example/main.c` / `*_it.c`；**FWLib 缺失時 fallback 到 bundled `templates/{familyTag}/`** | FWLib `project/{chip}_sk/templates/src/*.c`（掃目錄全部複製）|
| **conf.h** | FWLib `project_template/IP/Example/ht32<family>_conf.h`；**FWLib 缺失時 fallback 到 bundled `templates/{familyTag}/`** | FWLib `project/{chip}_sk/templates/inc/*.h`（掃目錄全部複製）|
| **usbdconf.h** | FWLib `project_template/IP/Example/` 全部複製；**FWLib 缺失時 fallback 到 bundled `templates/{familyTag}/`**；TreeView 只顯示一個（見下）| — |
| **board support** | FWLib `utilities/ht32_board.c` | FWLib `project/<boardDir>/<driverFamily>_board.c`（含 syscall stubs）|
| **syscalls.c** | FWLib `library/<series>_Driver/src/syscalls.c` | 不需要；I/O stubs 已由 `board.c` 提供 |
| **ht32_stack_analysis.c** | copy bundled `templates/GNU_ARM/ht32_stack_analysis.c` → `GNU_ARM/` | 同左 |

### MCU 型號來源

| 系列 | MCU 列表來源 | 備註 |
|---|---|---|
| 標準 | `project_template/IP/Example/GNU_ARM/` 下每個 `.mk` 檔 = 一個 chip variant；**`project_template/` 不存在時 fallback 到 bundled `templates/{familyTag}/GNU_ARM/*.mk`** | 檔名即 chipSuffix（e.g. `0006.mk` → `HT32F0006`）|
| 49x | `libraries/cmsis/cm4/device_support/startup/gcc/linker/*_FLASH.ld` | 每個 `_FLASH.ld` = 一個 chip model |
| 49x（封裝選項）| `libraries/cmsis/cm4/device_support/ht32f493x5.h` 中的 `USE_HT32F49395_100LQFP` 等 `#if defined(...)` 條件 | 同一 chip model 有多種封裝（100LQFP / 64LQFP / 48QFN 等），掃描 device header 取得所有封裝選項；找不到時 fallback `_100LQFP` |

### `.mk` 檔的角色（標準系列）

`IP/Example/GNU_ARM/<chipSuffix>.mk` 是標準系列 Create Project 的唯一依據：

| `.mk` 欄位 | 用途 |
|---|---|
| `ARM_CORE` | CPU 型號（`cortex-m0` / `cortex-m3` / `cortex-m4`）→ `-mcpu` flag |
| `CHIP_NAME` | chip 短碼（例如 `61141`）→ usbdconf.h 選擇邏輯（見下）|
| `STARTUP` | startup `.s` 檔名 → 複製到 `GNU_ARM/` + patch |
| `C_OPTION += -D` | compiler defines（例如 `USE_HT32_DRIVER`、`USE_HT32F52352_SK`）→ `defines.list` |
| `S_OPTION = --defsym` | assembler defines（例如 `USE_HT32_CHIP=3`）→ `adefines.list` |
| `$(HT32_LIB_PATH)xxx.c` | 一般 driver `.c` 清單（`library/<series>_Driver/src/`）→ `sources.list` |
| `$(HT32_USB_PATH)xxx.c` | USB driver `.c` 清單（`library/HT32_USBD_Library/src/`）→ `sources.list` |
| `INCLUDE_PATH += -I` | include 路徑（含 USB）→ `includes.list` |
| `SOURCE_NAME_PATH ../system_*.c` | system `.c` 檔名 → `sources.list` |
| `SOURCE_NAME_PATH ../ht32*_it.c` | interrupt handler `.c` 檔名 → `sources.list` |

### usbdconf.h 選擇邏輯（標準系列）

部分 FWLib 的 `IP/Example/` 有多個 `usbdconf.h`（例如 5xxxx 有 `_01_` 和 `_02_`），檔案全部複製到 `src/`，但 TreeView 只顯示其中一個，選擇邏輯如下：

- 只有一個 `*_usbdconf.h` → 直接使用
- 有多個 → 讀 `library/<series>_Driver/inc/ht32f{CHIP_NAME}_libcfg.h`
  - 有 `#define LIBCFG_USBD_V2` → 顯示 `_02_usbdconf.h`
  - 否則（或找不到 libcfg.h）→ 顯示 `_01_usbdconf.h`

`libcfg.h` 是每顆 MCU 專屬的硬體功能定義檔，記錄該 chip 有哪些外設及版本。`CHIP_NAME` 來自 `.mk` 的 `CHIP_NAME =` 欄位（例如 `61141`），對應 `ht32f61141_libcfg.h`。

### FPU 判斷

三條轉換路徑（Convert uVision、Convert HT32-IDE、Create Project）均以 device header 中的 `__FPU_PRESENT` 作為最終 FPU 決策依據，覆蓋各路徑從 project 檔初始推斷的結果。

---

### Include paths 與 Defines

| 項目 | 標準系列 | 49x 系列 |
|---|---|---|
| **Include paths** | 全部從 `.mk` 的 `INCLUDE_PATH += -I` 行解析（`project_template/` 開頭的除外）| `libraries/cmsis/cm4/core_support`、`libraries/cmsis/cm4/device_support`、`libraries/drivers/inc`、`project/<driverFamily>_board` |
| **C Defines** | 全部從 `.mk` 的 `C_OPTION += -D` 行解析（例如 `USE_HT32_DRIVER`、`USE_HT32F52352_SK`）→ `defines.list` | Hardcode：`USE_<displayName>`（例如 `USE_HT32F49365_100LQFP`）、`USE_<skChipName>_SK`（例如 `USE_HT32F49395_SK`）|
| **ASM Defines** | 從 `.mk` 的 `S_OPTION = --defsym USE_HT32_CHIP=<N>` 解析 → `adefines.list`（assembler 專用，C compiler 不會看到）| Hardcode：`USE_HT32_CHIP=1` |

---

## newlib syscall 提供者

| 函式 | std 提供者 | 49x 提供者 |
|---|---|---|
| `_write` | `syscalls.c`（weak）→ `ht32_serial.c` 覆蓋 | `board.c`（強符號）|
| `_read` | `syscalls.c`（weak）| `board.c`（強符號）|
| `_close` / `_fstat` / `_isatty` / `_lseek` | `syscalls.c`（強符號）| `board.c`（強符號）|
| `_sbrk` | `syscalls.c`（含 `__HeapLimit` 上限保護）| `nosys.specs` stub（malloc 回 NULL；`%f` 輸出不確定）|

> **純組語專案（例如 flash-image builder）**：不加 syscalls.c、也不加 `-specs=nano.specs`/`-specs=nosys.specs`，完全不鏈接 newlib

---

## startup .s / linker .ld 的必要修改

三條轉換路徑（Convert uVision、Convert HT32-IDE、Create Project）寫入 `GNU_ARM/` 前都會對 `.s` 和 `.ld` 進行以下修改。

### startup .s

| 修改 | 原因 |
|---|---|
| `.section ".stack","w"` → `.section ".stack","aw",%nobits` | `SHF_ALLOC`（`a` flag）是 `--print-memory-usage` 計入 RAM 使用量的必要條件；`%nobits` 保持 NOBITS（不佔 ELF 檔案空間） |
| `.section ".heap","w"` → `.section ".heap","aw",%nobits` | 同上 |
| `.equ Heap_Size, 0` | 保留原始值，不強制最小值 |

Stack Analysis 面板需要從 ELF symtab 讀取 `__StackTop`（stack 上限）與 `__HT_check_sp`（stack 起點，填魔術值的位置）。標準系列 GCC startup 已內含這兩個 symbol（及 ARM 標準的 `__StackLimit`），不需額外處理；49x GCC startup 只定義 `_estack`，缺少這三個 symbol，因此由 `.ld` patch 補入（見下）。

### linker .ld

| 修改 | 原因 |
|---|---|
| `._user_heap_stack { *(.heap) *(.stack) }` → 拆成獨立 `.heap` / `.stack` section 並加 `KEEP()` | `--gc-sections` 會丟棄沒有 `KEEP()` 的 section；拆開後才能用 `SIZEOF(.stack)` 取得確切大小 |
| FLASH / RAM origin + length patch | template 的 LENGTH 是佔位符（通常 1024K）；需換成 PDSC / Settings.ini 的正確值。**條件**：僅在 .ld 中讀到的 `LENGTH ≥ 1MB`（1048576 bytes）時才替換，已有正確值（HT32-IDE 自訂 .ld）則原封不動。ORIGIN 刻意不改，IAP/特殊佈局可能使用非標準起始位址。RAM 有 ORIGIN offset 時，LENGTH 會自動扣掉 offset（`offset = ORIGIN - 0x20000000`）以避免 `__StackTop` 超出實體 RAM。|
| 49x：`_estack = 0x2xxxxxxx` → `_estack = ORIGIN(RAM) + LENGTH(RAM)` | 硬編碼位址與 RAM region 定義重複，不一致；改成 expression 確保永遠正確 |
| 49x：補入 `__StackTop = _estack;` 和 `__HT_check_sp = _estack - _Min_Stack_Size;` | 49x startup 未定義這兩個 symbol；Stack Analysis 面板直接讀 ELF symtab，需直接賦值（不能用 `PROVIDE`）|

---

## FWLib 命名與結構假設

Extension 直接用字串掃描 FWLib 目錄結構，以下說明每個字串的**用途**與**若改名後的影響**。


### 判斷這個 FWLib 是哪個系列

**目的**：使用者選完 FWLib 路徑後，extension 要知道這是標準系列（5xxxx/L5xxxx 等）還是 49x 系列，才能走正確的 Create Project 流程。

`detectFwlibSeries` 依序執行兩個步驟，任一步驟有結果即停止。

**Step 1：目錄名稱**（依賴 Holtek 命名慣例）

| 目錄名稱模式 | 判斷結果 |
|---|---|
| `HT32_STD_*_FWLib*`（如 `HT32_STD_5xxxx_FWLib_V1.21.1_9874`）| `'std'` |
| `HT32*49*_FWLib*`（如 `HT32F490_FWLib_V1.0.0`）| `'49x'` |
| 其他（使用者自行改名）| 無結果，進入 Step 2 |

**Step 2：內部結構**（不依賴目錄名稱，作為 fallback）

| 檢查內容 | 判斷結果 |
|---|---|
| `library/` 下有符合 `HT32[A-Za-z]+\d+xxxx_Driver` 的目錄 | `'std'` |
| `libraries/drivers/src/` 下有符合 `/^ht32\w*49/i` 的 `.c` 檔 | `'49x'` |

**兩步驟都失敗時**：使用者會看到「Cannot detect FWLib series」錯誤，Create Project 無法繼續。

---

### 產生 MCU 選單（讓使用者選晶片型號）

**目的**：Create Project 第一步讓使用者選 MCU，extension 需要知道這個 FWLib 支援哪些晶片。

**標準系列**：
| 字串 | 怎麼用 | 若改名 |
|---|---|---|
| `project_template/IP/Example/GNU_ARM/*.mk`（不存在時 fallback 到 bundled `templates/{familyTag}/GNU_ARM/*.mk`），檔名為純數字 + 字母（如 `52341.mk`、`3200S.mk`）| 每個 `.mk` = 一個 MCU；**檔名是 chip suffix**，實際 displayName 由 `resolveStdDisplayName` 決定（見下）| 若檔名加了底線、空格等，會被忽略，選單少掉這顆 MCU |

**displayName 解析（`resolveStdDisplayName`）**

`listStdMcus` 讀每個 `.mk` 的 C defines，以 `USE_MEM_xxx` 為優先：

1. `.mk` 含 `C_OPTION += -DUSE_MEM_<name>` → displayName = `<name>`（精確晶片型號）
2. 無 `USE_MEM_` → displayName = FWLib 前綴 + chipSuffix.toUpperCase()（fallback）

FWLib 前綴從 `library/HT32*_Driver` 目錄名推算：`HT32F5xxxx_Driver` → `HT32F`、`HT32L5xxxx_Driver` → `HT32L`。

| `.mk` 範例 | USE_MEM_ | displayName |
|---|---|---|
| `52341.mk` | `USE_MEM_HT32F52341` | `HT32F52341` |
| `52241.mk` | `USE_MEM_HT32L52241` | `HT32L52241`（覆蓋 family-level `USE_HT32L52231_41`）|
| `3200U.mk` | `USE_MEM_HT50L3200U` | `HT50L3200U`（HT**50** 系列，前綴與 FWLib 不同）|

`displayName` 同時用於 UI 顯示與 PDSC/Settings.ini 查詢（`generateProjectFiles` 呼叫相同的 `resolveStdDisplayName`），兩者保持一致。

**49x 系列**：
| 字串 | 怎麼用 | 若改名 |
|---|---|---|
| `libraries/cmsis/cm4/device_support/startup/gcc/linker/*_FLASH.ld` | 每個 `_FLASH.ld` = 一個 chip model（如 `HT32F49395_FLASH.ld`）；**檔名（去掉 `_FLASH.ld`）= chip model** | 若 suffix 改掉，MCU 列表為空或型號抓錯 |
| device header（`libraries/cmsis/cm4/device_support/*.h`）中的 `USE_HT32<x>_<package>` | 每個 `#define USE_HT32F49395_100LQFP` = 一個封裝選項，讓使用者選 100LQFP / 64LQFP / 48QFN 等 | 若 define 格式改變，封裝列表為空，fallback `_100LQFP` |

---

### 不可更動的目錄路徑

**標準系列**

| 路徑 | 若改動則 |
|---|---|
| `library/HT32[A-Za-z]+\d+xxxx_Driver/`（目錄命名格式）| series detection 失敗（Step 2 靠此辨識 STD 系列）|
| `library/<series>_Driver/src/` | driver .c 找不到 |
| `library/<series>_Driver/inc/` | compiler 找不到 driver header |
| `library/HT32_USBD_Library/src/` | USB driver .c 遺失（目錄名完全固定）|
| `library/HT32_USBD_Library/inc/` | USB include path 遺失 |
| `utilities/ht32_board.c` | board .c 未加入（路徑完全固定）|

**49x 系列**

| 路徑 | 若改動則 |
|---|---|
| `libraries/drivers/src/` | driver .c 遺失 |
| `libraries/drivers/inc/` | compiler 找不到 driver header |
| `libraries/cmsis/cm4/core_support/` | CMSIS core header 找不到 |
| `libraries/cmsis/cm4/device_support/` | CMSIS device header 找不到 |

---

## misc.c 的 weak patch（Stack Usage Analysis）

**問題**：FWLib 2025-12-02 以前的版本，`ht32_cm*_misc.c` 的 `StackUsageAnalysisInit` 在 GCC 分支定義為強符號（無 `__attribute__((weak))`），與 bundled `ht32_stack_analysis.c` 的強符號衝突，導致 multiple definition 連結錯誤。

**處理方式**：Convert / Open Project 時，若偵測到 misc.c 的 `@date` 欄位 ≤ 2025-12-02，自動在原始檔案加上 `weak` attribute（idempotent，不重複修改）。`ht32_stack_analysis.c` 本身維持強符號，確保 Stack Analysis 功能可正常覆蓋 misc.c 的空實作。

---

## afterbuild.bat 自動同步

### Bundled 檔案清單

Extension 的 `afterbuild/` 目錄內附帶以下檔案，**這些檔案來自 Holtek IAP 範例專案，由 VS Code Extension 負責 bundle 並在必要時同步到使用者的專案目錄**：

| 檔案 | 類型 | MAX_REPLACEABLE_REV | 說明 |
|---|---|---|---|
| `afterbuild.bat` | bat | 435 | 標準應用程式 post-build 腳本 |
| `afterbuild_ap.bat` | bat | 437 | IAP AP post-build 腳本 |
| `afterbuild_iap.bat` | bat | 358 | IAP boot post-build 腳本 |
| `DFUmaker_combo.bat` | bat | 359 | DFU 封包製作，由 afterbuild 間接呼叫 |
| `srec_make_combo.bat` | bat | 527 | combo bin 製作與 CRC，由 afterbuild 間接呼叫 |
| `TPMaker/setting_template.ini` | ini | — | TPMaker 設定樣板，由 `srec_make_combo.bat` 執行時複製為 `setting.ini`；無版本比對，以不覆蓋方式同步 |

`MAX_REPLACEABLE_REV` = extension 允許自動取代的最高 `$Rev::` 號碼（含）。磁碟上的 bat 若 `$Rev` 高於此值，視為使用者已升版，extension 不覆蓋。  
> **維護注意**：上述任何一個 bat 在 IAP 範例專案中更新時，**必須通知 VS Code Extension 開發人員**一併更新 `afterbuild/` 的 bundled 版本，並將該 bat 的 `MAX_REPLACEABLE_REV` 調高至新 `$Rev` 號碼。

---

### 觸發時機與版本比對規則

**觸發時機**：Save Settings 時，若 `postBuildCmd` 指向上述清單內的 bat。

**版本比對規則**（以 bat 內的 `$Rev::` 號碼為準）：

| 磁碟上的 bat 狀況 | 動作 |
|---|---|
| 不存在 | 直接從 bundled 複製 |
| `$Rev` ≤ `MAX_REPLACEABLE_REV`（各 bat 有獨立上限）| 備份為 `.bak` 後取代 |
| `$Rev` > 上限 | 跳過（視為使用者已自訂，不覆蓋） |
| bat 名稱不在清單內 | 完全不處理 |

Primary bat 的同層目錄也會被掃描——`DFUmaker_combo.bat` 等常與 `afterbuild_ap.bat` 同放的兄弟 bat，若名稱在清單內，套用相同規則。

**TPMaker 目錄同步**：`srec_make_combo.bat` 出現在處理結果中（無論 copied/updated/skipped）且 bat 同層的 `TPMaker/` 目錄不存在時，`afterbuild/TPMaker/` 內的檔案會補齊到該目錄，**已存在的檔案不覆蓋**（保留使用者自訂的 `setting_template.ini`）。

**取代時的 key 同步**：備份 + 取代（`$Rev` ≤ 上限）時，會從舊 bat 中尋找以下 key，若找到則將其值同步到新 bat，找不到則略過（不限定 bat 檔名，但這些 key 目前只出現在 `srec_make_combo.bat`）：

```
APSEQ  APSAVE_ENDADDR  BIN_OFFSET  CMP_RESULT  SHOW_CRC_CHECK_MSG
HEX_ENCODE  AP_ENCRYPT  AP_TPMAKER  AP_SINGLE_BIN  CRC32
```

直接複製（bat 不存在）時不做 key 同步，新 bat 使用 bundled 預設值。


