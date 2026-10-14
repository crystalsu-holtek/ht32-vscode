# 維護手冊

## 新增 MCU 支援

只需加檔案，通常不需改 source code。  
Flash 位址與 FLM 選擇全從 DFP PDSC 讀取，**PyOCD 路徑不需要 HLM 或 MCU cfg**：

| 檔案 | 路徑 | 必要性 |
|---|---|---|
| `.pack` 檔 | `dfp/Holtek.{DFPName}.{版號}.pack` | **必要**（所有路徑）|
| Settings.ini 條目 | `conf/Settings.ini` → WORKAREASIZE | **必要**（OpenOCD）|
| 內部 Flash HLM | `openocd/FlashLoader/{Device}_{sizeKB}.HLM` | OpenOCD 專用 |
| MCU cfg | `openocd/MCU/{DeviceName}.cfg` | OpenOCD 專用 |
| Target cfg | `openocd/scripts/target/HLM{suffix}.cfg` | OpenOCD（新架構時）|

`.pack` 下載來源（Holtek 官網）：

- Pack 清單與最新版號：`https://www.holtek.com.tw/pack/Holtek.pidx`
- 下載 URL 格式：`https://www.holtek.com.tw/pack/Holtek.{DFPName}.{版號}.pack`

Extension 在背景自動從 `Holtek.pidx` 取得所有 pack 清單與最新版號並下載（`updateDevicePacks`）；`dfp/Holtek/{PackName}/{版號}/` 解壓目錄為 runtime 自動產生，不需手動建立。

### OpenOCD Target cfg（新架構時）

**若新 MCU 是 Cortex-M4 且支援 SWO：**  
Target cfg 的 `target create` 之後須加：
```tcl
tpiu create $_CHIPNAME.tpiu -dap $_CHIPNAME.dap -ap-num 0 -baseaddr 0xE0040000
```
cortex-debug v1.12+ 的 `swoConfig.source = "probe"` 使用 `tpiu names`，
沒有這行就會報 `Could not find TPIU/SWO names`。

**所有 target cfg 的 `reset_config` 不可加 `connect_assert_srst`：**
```tcl
# 正確
reset_config srst_only srst_push_pull srst_nogate

# 禁止
reset_config srst_only srst_push_pull connect_assert_srst srst_nogate
```
`connect_assert_srst` 讓 OpenOCD `init` 連線時 assert SRST（硬體 reset）；
`openOCDLaunchCommands` 的 override 在 init 之後才執行，已來不及，
導致 Attach 時 MCU 被 reset 而非停在 current PC。  
Debug 的 reset 由 `postLaunchCommands: monitor reset halt` 明確發出，不依賴 init 時的 SRST。

已加入：`HLM490x1.cfg`, `HLM491x3.cfg`, `HLM493x5.cfg`  
不加：`HLMm0x.cfg`（M0/M0+ 無 ITM）  
不加：`HLMm3x.cfg`（HT32F1xxxx M3 有 ITM core 且有 TRACESWO 功能與 `DBTRACE` 暫存器，但 JTDO/TDO 腳**未接出 package**；manual 列出 JTCK/JTMS/JTDI 但無 JTDO，也無任何 GPIO 對應 SWO）

**HT32F49x SWO 硬體確認（三個系列均已查 User Manual）：**

| 系列 | Manual | SWO 腳 | 確認內容 |
|---|---|---|---|
| HT32F490x1 | HT32F49041 UM v1.10 | **PB3** | 文件明列 "SWD and SWO"；pin table PB3 欄有 SWO |
| HT32F491x3 | HT32F49153/63 UM v1.10 | **PB3** | pin table PB3 欄有 JTDO/SWO；有獨立 TPIU 章節 |
| HT32F493x5 | HT32F49365/95 UM v1.00 | **PB3** | `PB3/JTDO/TRACESWO`；有 TRACE_MODE 暫存器 |

| 腳位 | 功能 |
|---|---|
| `PB3` | `JTDO / TRACESWO`（SWO 輸出，與 JTAG TDO 共用；三系列相同） |
| `PE2` | `TRACECK`（ETM synchronous trace clock，493x5 確認） |
| `PE3–PE6` | `TRACED[0–3]`（ETM synchronous trace data，493x5 確認） |

Trace 模式由 `DBGMCU->CR` 的 `TRACE_IOEN`（bit 5）與 `TRACE_MODE[1:0]`（bit 7:6）控制：

| `TRACE_MODE` | 模式 | 使用腳位 |
|---|---|---|
| `00` | Asynchronous（SWO）| `TRACESWO`（PB3）only |
| `01` | Synchronous，無 data | — |
| `10` | Synchronous + CK | `TRACECK` + `TRACESWO` |
| `11` | Synchronous + CK + D[0:3] | `TRACECK` + `TRACED[0:3]` |

ITM/SWO 日常使用選 `TRACE_MODE=00`，由 OpenOCD `tpiu init` 在 debug session 開始時自動設定，無需手動配置。

---

## HT32-IDE 改版時的更新流程

| 資源 | 位置 | 動作 |
|---|---|---|
| `.pack` 檔 | `dfp/Holtek.HT32_DFP.{新版號}.pack` | **新建 pack**：從 HT32-IDE DFP 資料夾打包（含 .pdsc、Flash/*.FLM、SVD/）；舊版 pack 保留不刪（semver 選最新）|
| Settings.ini | `conf/Settings.ini` | 直接複製（與 HT32-IDE 相同格式，含 WORKAREASIZE）|
| Flash Loader HLM | `openocd/FlashLoader/` | OpenOCD 專用：直接複製新增的 .HLM |
| MCU cfg | `openocd/MCU/` | OpenOCD 專用：直接複製 |
| OpenOCD 執行檔 | `openocd/bin/` | 有更新才複製 |
| Target / Interface cfg | `openocd/scripts/` | 通常**不需要**，除非新架構 |

---

## Bundled Templates 更新（`templates/`）

Extension 在 `templates/` 內 bundle 了各標準系列的 `project_template/IP/Example/GNU_ARM/` 樣板，供客戶使用舊版 FWLib（缺少 `project_template/` 目錄）時 fallback 使用。

目錄名 = familyTag（Windows FS 大小寫不敏感）。

### Extension 實際使用的檔案

| 路徑 | 用途 |
|---|---|
| `{familyTag}/GNU_ARM/startup_ht32Xxxxx_gcc_NN.s` | startup（多個 variant，對應不同 flash/ram 分組）|
| `{familyTag}/GNU_ARM/ht32_op.c` | IAP / option bytes（`handleKeilAsm` Rule 2 複製）|
| `{familyTag}/GNU_ARM/ht32_op2.c` | 進階 option bytes（部分 MCU 有，如 F4xxxx）|
| `{familyTag}/GNU_ARM/linker.ld` | linker script template |
| `{familyTag}/main.c` | 範例 main |
| `{familyTag}/ht32XXXXX_01_it.c` | interrupt handler 範例 |
| `{familyTag}/system_ht32Xxxxx_NN.c` | system init（多個 variant）|
| `{familyTag}/ht32XXXXX_conf.h` | FWLib 功能設定 header |
| `{familyTag}/ht32XXXXX_NN_usbdconf.h` | USB 設定 header（1～3 個 variant）|
| `{familyTag}/ht32_can_config.h` | CAN 設定 header（F4xxxx / F5xxxx）|
| `GNU_ARM/syscalls.c` | newlib syscall stubs（各系列共用，非 fallback，每次都用）|
| `GNU_ARM/ht32_stack_analysis.c` | Stack Analysis 輔助（各系列共用，非 fallback，每次都用）|

### 同目錄內 Extension 不使用的檔案

下列檔案是直接從 FWLib 整個目錄複製過來的，extension 不會讀取，升版時可忽略：

`*.mk`、`Project_*.uvprojx`、`*_DebugSupport.ini`、`afterbuild.bat`、`makefile`、`objcopy.txt`、`linker_oldversion.ld`、`linker_readme.txt`、`readme.txt`

### 何時需要更新

| 觸發條件 | 需更新的內容 |
|---|---|
| FWLib 升版，`project_template/IP/Example/GNU_ARM/` 有改動 | 對應系列的 `templates/{familyTag}/GNU_ARM/`（startup .s、ht32_op.c、ht32_op2.c（若存在）、linker.ld）|
| FWLib 升版，`project_template/IP/Example/` 範例檔有改動 | 對應系列的 `templates/{familyTag}/`（main.c、*_it.c、conf.h 等）|
| 新增系列（例如新的 L 系列晶片）| 新增對應 `templates/{newTag}/GNU_ARM/` 目錄並複製樣板（pack 清單由 `Holtek.pidx` 自動取得，不需改程式碼）|
| `ht32_stack_analysis.c` / `syscalls.c` 有改動 | `templates/GNU_ARM/`（共用，各系列皆用）|

### 更新步驟（升版現有系列）

1. 從最新 FWLib 找到 `project_template/IP/Example/GNU_ARM/` 目錄
2. 複製需要更新的檔案到對應的 `templates/{familyTag}/GNU_ARM/`
3. 若 example 樣板檔（main.c 等）也有更新，同步複製到 `templates/{familyTag}/`
4. 執行 `npm run compile` 確認無誤
5. 執行 `node test_scripts/test-create-project.js` 確認資源完整性

### 新增系列步驟

以 `HT32F7xxxx`（familyTag = `f7xxxx`）為例：

**來源**（FWLib 根目錄）：
```
{fwlib}/project_template/IP/Example/GNU_ARM/   ← GNU_ARM 檔案
{fwlib}/project_template/IP/Example/           ← 範例樣板
```

**目的地**（extension 根目錄）：
```
templates/f7xxxx/GNU_ARM/   ← GNU_ARM 檔案
templates/f7xxxx/           ← 範例樣板
```

**必須複製的檔案（extension 實際使用）：**

| 來源路徑（相對 Example/） | 目的地 | 說明 |
|---|---|---|
| `GNU_ARM/startup_ht32f7xxxx_gcc_*.s` | `f7xxxx/GNU_ARM/` | startup（所有 variant）|
| `GNU_ARM/linker.ld` | `f7xxxx/GNU_ARM/linker.ld` | linker script |
| `GNU_ARM/ht32_op.c` | `f7xxxx/GNU_ARM/ht32_op.c` | option bytes |
| `GNU_ARM/ht32_op2.c` | `f7xxxx/GNU_ARM/ht32_op2.c` | 若存在才複製 |
| `main.c` | `f7xxxx/main.c` | |
| `system_ht32f7xxxx_*.c` | `f7xxxx/` | system init（所有 variant）|
| `ht32f7xxxx_*_it.c` | `f7xxxx/` | interrupt handler |
| `ht32f7xxxx_conf.h` | `f7xxxx/` | FWLib config header |
| `ht32f7xxxx_*_usbdconf.h` | `f7xxxx/` | USB config（1～3 個 variant）|
| `ht32_can_config.h` | `f7xxxx/` | CAN config（若存在才複製）|

> familyTag 規則：`library/HT32F7xxxx_Driver` → `f7xxxx`（取 `F7` 後接 `xxxx`，全小寫）。

> Fallback 只用於舊版 FWLib 缺失的情況；新版 FWLib 完整時，extension 優先使用 FWLib 自身的檔案，bundled 版本不會被採用。因此更新 bundled templates 的優先級低於更新 DFP / Settings.ini。

---

## Release 到 VS Code Marketplace

### 平台關係

Microsoft 收購歷史造成多平台並存：

| 平台 | 網址 | 用途 |
|------|------|------|
| Azure | portal.azure.com | 雲端基礎設施（與 Extension 發布無關） |
| Azure DevOps | dev.azure.com | 原 Visual Studio Team Services，2018 改名；PAT token 在此申請 |
| GitHub | github.com | 2018 年 Microsoft 以 75 億美元收購，獨立運營 |
| VS Code Marketplace | marketplace.visualstudio.com | Extension 發布平台，身份驗證綁 Azure DevOps PAT |

VS Code Extension 發布路徑：**Microsoft 帳號 → Azure DevOps 組織 → PAT → vsce publish**

### Azure DevOps PAT（用於 vsce 發布）

前提：需先在 `https://aex.dev.azure.com/signup` 建立 Azure DevOps 組織。

1. 前往 `https://dev.azure.com`（不是 portal.azure.com）
2. 右上角頭像 → **Personal access tokens**
3. New Token：
   - Organization：**All accessible organizations**
   - Scopes：Custom defined → **Marketplace → Manage**
4. 複製 token
5. 登入 vsce：
   ```
   vsce login holtek
   ```
   或每次帶 token：
   ```
   vsce publish -p <TOKEN>
   ```

> 若 Azure DevOps 無法建立組織（Continue 無反應），可改用 Marketplace 網頁直接上傳 `.vsix`：
> `marketplace.visualstudio.com/manage/publishers/holtek` → **+ New extension**

### GitHub PAT（用於 git push）

1. GitHub → Settings → Developer settings → Personal access tokens
2. 選 **Tokens (classic)** 或 **Fine-grained tokens**
   - Classic：勾 `repo`，對帳號下所有 repo 有效
   - Fine-grained：指定特定 repo → Contents: Read and write（較安全）
3. 複製 token（只顯示一次）
4. 使用方式：
   ```
   git remote set-url origin https://<TOKEN>@github.com/<org>/<repo>.git
   ```

本專案 token 寫在 `push_docs.bat` 的 remote URL 中。

---

## 參考

### openocd/scripts/ 最小結構

標準 OpenOCD 所附帶的 board/chip/cpu 等數百個 cfg 已全部移除，只保留 HT32 所需：

```
scripts/
  interface/
    cmsis-dap.cfg   ← e-Link32 Pro（預設）
    htlink.cfg      ← e-Link32 Pro / Lite
    stlink.cfg      ← ST-Link
    jlink.cfg       ← J-Link
  target/
    HLMm0x.cfg      ← Cortex-M0
    HLMm3x.cfg      ← Cortex-M3 / HT32F1xxxx
    HLM490x1.cfg    ← Cortex-M4（有 tpiu create）
    HLM491x3.cfg    ← Cortex-M4（有 tpiu create）
    HLM493x5.cfg    ← Cortex-M4（有 tpiu create）
    swj-dp.tcl      ← 被所有 HLM cfg source，必要
    readme.txt
```

### Bundled GNU Make 4.4.1

`bin/win32-x64/make.exe` 為 GNU Make 4.4.1（2023），來源：`mbuilov/gnumake-windows`（GitHub）standalone exe，無需額外 DLL。

**必要原因**：支援 `$(file <filename)` 函式（GNU Make 4.0 新增）。舊版 Make 3.81（2006）不支援此語法。

### 測試腳本（test_scripts/）

詳見 [test-scripts.md](test-scripts.md)。