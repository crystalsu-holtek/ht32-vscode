# 維護手冊

## 新增 MCU 支援

只需加檔案，通常不需改 source code。  
Flash 位址與 FLM 選擇全從 DFP PDSC 讀取，**PyOCD 路徑不需要 HLM 或 MCU cfg**：

| 檔案 | 路徑 | 必要性 |
|---|---|---|
| DFP PDSC / FLM | `dfp/Holtek/HT32_DFP/{版號}/` | **必要**（所有路徑）|
| `.pack` 檔 | `dfp/Holtek.{DFPName}.{版號}.pack` | **必要**（pyOCD）|
| Settings.ini 條目 | `conf/Settings.ini` → WORKAREASIZE | **必要**（OpenOCD）|
| 內部 Flash HLM | `openocd/FlashLoader/{Device}_{sizeKB}.HLM` | OpenOCD 專用 |
| MCU cfg | `openocd/MCU/{DeviceName}.cfg` | OpenOCD 專用 |
| Target cfg | `openocd/scripts/target/HLM{suffix}.cfg` | OpenOCD（新架構時）|

`.pack` 的命名格式：`Holtek.{DFPName}.{版號}.pack`，例如：
- `Holtek.HT32_DFP.1.0.79.pack`（標準系列，所有 STD MCU）
- `Holtek.HT32F493x5_DFP.1.0.6.pack`（49x 特定系列）

打包方式（PowerShell）：
```powershell
Add-Type -Assembly "System.IO.Compression.FileSystem"
[System.IO.Compression.ZipFile]::CreateFromDirectory($src, $dest)
```
其中 `$src` 為 `dfp/Holtek/HT32_DFP/{版號}/` 目錄，`$dest` 為 `dfp/Holtek.HT32_DFP.{版號}.pack`。

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
| DFP PDSC + FLM | `dfp/Holtek/HT32_DFP/{新版號}/` | **新建版號資料夾，複製 .pdsc 和 Flash/*.FLM**（Flash 位址/FLM 選擇來源）|
| SVD 檔 | `dfp/Holtek/HT32_DFP/{新版號}/SVD/` | 複製至同一版號資料夾 |
| `.pack` 檔（pyOCD）| `dfp/Holtek.HT32_DFP.{新版號}.pack` | **新建 pack**：用 PowerShell ZipFile 將新版號 DFP 資料夾打包；舊版 pack 保留不刪（pyOCD 按版號選最新）|
| Settings.ini | `conf/Settings.ini` | 直接複製（與 HT32-IDE 相同格式，含 WORKAREASIZE）|
| Flash Loader HLM | `openocd/FlashLoader/` | OpenOCD 專用：直接複製新增的 .HLM |
| MCU cfg | `openocd/MCU/` | OpenOCD 專用：直接複製 |
| OpenOCD 執行檔 | `openocd/bin/` | 有更新才複製 |
| Target / Interface cfg | `openocd/scripts/` | 通常**不需要**，除非新架構 |

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
| 新增系列（例如新的 L 系列晶片）| 新增對應 `templates/{newTag}/GNU_ARM/` 目錄並複製樣板 |
| `ht32_stack_analysis.c` / `syscalls.c` 有改動 | `templates/GNU_ARM/`（共用，各系列皆用）|

### 更新步驟

1. 從最新 FWLib 找到 `project_template/IP/Example/GNU_ARM/` 目錄
2. 複製需要更新的檔案到對應的 `templates/{familyTag}/GNU_ARM/`
3. 若 example 樣板檔（main.c 等）也有更新，同步複製到 `templates/{familyTag}/`
4. 執行 `npm run compile` 確認無誤
5. 執行 `node test_scripts/test-create-project.js` 確認資源完整性

> Fallback 只用於舊版 FWLib 缺失的情況；新版 FWLib 完整時，extension 優先使用 FWLib 自身的檔案，bundled 版本不會被採用。因此更新 bundled templates 的優先級低於更新 DFP / Settings.ini。

---

## openocd/scripts/ 最小結構（2026-05-08 清理後）

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

## pyOCD 架構說明

### pyOCD 自動偵測 / 安裝（`findOrInstallPyocd()`）

Extension 啟動時（`generateTasksAndLaunchAndMakefile()` 偵測到任一 project 的 `serverType === 'pyocd'`）：

1. 檢查 `pyocd --version`（PATH 中是否已有）→ 有則直接用，不設 `serverpath`（cortex-debug 自動找）
2. 查 bundled `uv.exe`（`bin/win32-x64/uv.exe`）→ 執行 `uv tool dir --bin` 取得 bin 目錄 → 檢查其中是否有 `pyocd.exe`
3. 若都沒有 → 跳出 Progress Notification，執行 `uv tool install pyocd` 自動安裝（timeout 3 分鐘）
4. 找到的 `pyocd.exe` 絕對路徑設為 cortex-debug 的 `serverpath`

**bundled uv**：`bin/win32-x64/uv.exe`（與 GNU Make 放在同一目錄）

### pack 檔選取（`findPacksForDevice()`）

pyOCD 透過 `--pack` 取得 PDSC 與 FLM，extension 自動從 `dfp/` 根目錄掃描 `.pack` 檔：

- 格式：`Holtek.{DFPName}.{版號}.pack`
- 優先選特定系列（`HT32F493x5_DFP` 等，prefix 較長者優先），再 fallback 到 `HT32_DFP`
- 同系列多版本並存時選最新（semver 排序）
- 所有選中的 pack 透過多個 `--pack` 參數傳給 cortex-debug

### 產生的設定檔

`generateTasksAndLaunchAndMakefile()` 在 pyOCD 模式下，於 `HT32_VSCode/{bg}/` 目錄額外產生：

| 檔案 | 說明 |
|---|---|
| `pyocd.yaml` | `user_script: pyocd_user.py`（有 SPIM loader 時才加；無 SPIM 則為空 yaml）|
| `pyocd_user.py` | 僅在有外部 SPIM Flash Loader 時產生；用 `will_connect` hook 注入 EXT FlashRegion |

`pyocd_user.py` 注意事項：
- 必須純 ASCII（pyOCD 在 Windows 以系統編碼讀取，中文會失敗）
- FLM 從 `.pack` ZIP 解壓到 temp 檔再傳給 `FlashRegion(flm=...)`
- 使用 `will_connect(board)` hook，**不用** `did_init_target`（Flash instance 版本相容問題）

### serverType 設定

`project.settings.json` 的 `serverType` 欄位（由 Settings Webview 設定）：
- `"openocd"`（預設）：走 OpenOCD 路徑，需 HLM / MCU cfg / Settings.ini WORKAREASIZE
- `"pyocd"`：走 pyOCD 路徑，需 `.pack` 檔，不需 HLM / MCU cfg

---

## 測試腳本（test_scripts/）

詳見 [test-scripts.md](test-scripts.md)。

---

## ht32.internal.extensionRoot

`generateTasksAndLaunchAndMakefile()` 產生的 `tasks.json` / `launch.json` 內，所有指向 extension 內部資源的路徑（OpenOCD exe、cfg 檔、HLM loader、pyOCD --pack 參數、bundled make 目錄）均使用 VS Code 變數：

```
${config:ht32.internal.extensionRoot}
```

VS Code 在執行 task / launch 時動態展開為實際的 extensionPath（含版號目錄），因此 extension 升版後**不需重新執行「Generate Build & Debug Config」**，tasks / launch 自動套用新路徑。

### 寫入時機

Extension `activate()` 時比對現有值，只有 extensionPath 改變（即升版後首次啟動）才呼叫 `globalCfg.update()`，平常開 VS Code 不寫入。

### 儲存位置

Machine-scoped setting（`package.json` 中宣告 `"scope": "machine"`），寫入 VS Code User `settings.json`（`%APPDATA%\Code\User\settings.json`）。Machine scope 不會被 VS Code Settings Sync 跨機器同步。

### 注意事項

- `pyocd_user.py` 內的 pack 路徑仍使用實際絕對路徑（pyocd 直接讀取，不經 VS Code 變數展開）
- 使用者自訂的 `ht32.openocdPath` / `ht32.makePath` 不受影響，仍以實際路徑優先

---

## Bundled GNU Make 4.4.1

`bin/win32-x64/make.exe` 為 GNU Make 4.4.1（2023），來源：`mbuilov/gnumake-windows`（GitHub）standalone exe，無需額外 DLL。

**必要原因**：支援 `$(file <filename)` 函式（GNU Make 4.0 新增）。舊版 Make 3.81（2006）不支援此語法。

---

## Microsoft 平台關係與 Token 申請流程

### 平台關係

Microsoft 收購歷史造成多平台並存：

| 平台 | 網址 | 用途 |
|------|------|------|
| Azure | portal.azure.com | 雲端基礎設施（與 Extension 發布無關） |
| Azure DevOps | dev.azure.com | 原 Visual Studio Team Services，2018 改名；PAT token 在此申請 |
| GitHub | github.com | 2018 年 Microsoft 以 75 億美元收購，獨立運營 |
| VS Code Marketplace | marketplace.visualstudio.com | Extension 發布平台，身份驗證綁 Azure DevOps PAT |

VS Code Extension 發布路徑：**Microsoft 帳號 → Azure DevOps 組織 → PAT → vsce publish**

### GitHub PAT 申請（用於 git push）

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

### Azure DevOps PAT 申請（用於 vsce 發布 VS Code Marketplace）

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
