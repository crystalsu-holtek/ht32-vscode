# Debug Session 架構 — servertype 比較

## 三種 servertype 模式

Extension 支援三種模式，透過 Settings Webview → Debugger → **Debug Server** 切換，
對應 `project.settings.json` 的 `serverType` 欄位（`"pyocd"` / `"openocd"`，預設 `"pyocd"`）。

切換後執行 **HT32: Generate Build & Debug Config** 重新產生 `tasks.json` / `launch.json`。

---

### `servertype: "pyocd"`（預設）

cortex-debug 管理 pyocd-gdbserver 生命週期。pyocd 透過 CMSIS-Pack DFP 直接讀取 FLM，
不依賴 HLM 或 OpenOCD MCU cfg。

**Flash & Debug 流程（F5）：**
```
preLaunchTask: Build & Download <suffix>  ← Build → pyocd flash
  Build <suffix>：make -j
  Download <suffix>：
  └─ pyocd flash -t <targetId> --pack <dfp.pack> [--config pyocd.yaml] <elf>
     [pyocd_user.py] will_connect / did_connect（同 Download 流程）
     只燒有 FlashRegion 的區段，ELF 中的 .extflash 若無對應 loader 直接跳過
cortex-debug spawn pyocd-gdbserver（serverpath + targetId + serverArgs）
  serverArgs: --pack <dfp.pack> [--config pyocd.yaml] [--probe <serial>] [-v] [-v -v]
[pyocd_user.py] will_connect：設定 RAM work area
  ├─ 有 SPIM loader：從 DFP pack zip 解壓 FLM → 以 FlashRegion 動態註冊 EXT 位址
  └─ 無 SPIM loader：只設 RAM work area（不做其他處理）
GDB 連線（preLaunchCommands 執行）
[pyocd_user.py] did_connect：print 各 flash region 對應的 loader 名稱
  格式：[pyocd_user] Flash Loader: <name> @ 0x<start>-0x<end>  <algo>
  algo 來源：EXT region = FLM 檔名；內部 flash = (DFP pack built-in)
loadFiles: [] → GDB 不執行 load（韌體已由 preLaunchTask 燒錄完成）
postLaunchCommands:
  monitor reset halt       ← reset + halt
  monitor arm semihosting enable
runToEntryPoint: "main"
[extension] onDidStartDebugSession → workbench.view.debug
```

> **pyocd debug 使用 `loadFiles: []`，GDB 不執行 `load`**。
> 韌體燒錄由 `preLaunchTask`（`pyocd flash`）完成，`pyocd flash` 直接讀 ELF，
> 只對有 FlashRegion 的區段發出 DAP write，無 ext loader 時 `.extflash` 自動跳過。

**Attach 流程：**
```
cortex-debug spawn pyocd-gdbserver（同上，但 serverArgs 額外加 -O connect_mode=attach）
GDB attach（不燒錄）
preAttachCommands: set mem inaccessible-by-default off / set remotetimeout 300
postAttachCommands: monitor halt / monitor arm semihosting enable
overrideResetCommands: monitor reset halt / tbreak *main
  ↑ cortex-debug 執行完後自動加 continue，不需明確寫（不同於 external attach）
```

> **Attach 不能 reset 的設計：`-O connect_mode=attach`**
>
> `pyocd.yaml` 固定寫入 `connect_mode: under-reset`，這讓 pyocd 在連線時 assert nRESET line，
> 確保 debug 啟動時 MCU 從乾淨狀態開始。但若 attach 也走這個流程，MCU 會被強制 reset，
> 破壞正在執行的狀態，失去 attach 的意義。
>
> 解法：attach 的 serverArgs 額外加 `-O connect_mode=attach`，
> 這個 CLI 選項優先於 yaml 設定，pyocd 連線時完全不碰 reset line，MCU 繼續執行。
>
> Debug 和 Attach 共用同一份 `pyocd.yaml`（`connect_mode: under-reset`），
> 差異只在 serverArgs 是否帶 `-O connect_mode=attach`。

**Download（獨立燒錄，不 debug）：**
```
pyocd flash -t <targetId> --pack <dfp.pack> [--config pyocd.yaml] [-v|-v -v] <elf>
[pyocd_user.py] 同上 will_connect / did_connect
```

**為何不用 GDB `load`：**

ELF 若含 `.extflash` section，GDB `load` 會把整段資料（可能 2MB+）透過 GDB remote protocol
傳給 pyocd-gdbserver。pyocd 的 default memory map 在 hook 階段**不含** ext flash region，
資料會以 `16+download` 進度大量輸出（socket transfer，無實際 DAP write，但視覺上噪音嚴重）。

改用 `pyocd flash` 作為 preLaunchTask，直接讀 ELF，只燒有 FlashRegion 的區段，
`.extflash` 若無 loader 靜默跳過，無任何 `16+download` 訊息。

**`pyocd_user.py` 重新產生時機：**

`generateTasksAndLaunchAndMakefile()` 被呼叫時（包含 Convert、Open Project、Generate Build & Debug Config、Create Project），
`pyocd_user.py` 與 `pyocd.yaml` 都會重新寫入。現有檔案不會自動更新，需手動觸發上述操作。

**EXT flash（SPIM）支援：**
- `pyocd.yaml`：`connect_mode: under-reset`、`smart_flash`、`erase`、`user_script: pyocd_user.py`
  - `erase` 值對應：`erase_sector` → `sector`、`erase_chip` → `chip`、`none` → `skip`
  - **注意**：`pyocd.yaml` 的 `erase` 設定實測無效（官方文件 `chip_erase: chip` 亦同），原因不明。
  - erase_chip 時改由 Download task CLI 直接傳 `--erase=chip`，這是唯一有效的方式。
- `pyocd_user.py`（extension 自動產生）：
  - `will_connect`：設定 RAM work area；有 loader → 解壓 FLM 並以 `FlashRegion` 動態註冊；無 loader → 移除 EXT flash region
  - `did_connect`：`print` 所有 flash region 對應的 Flash Loader 名稱（stdout，不受 log level 控制）

**`WORK_AREA_SIZE` 計算邏輯（`pyocd_user.py` 的 `will_connect`）：**

```
conf/Settings.ini [SRAM] → PDSC IRAM1 size → 0x20000（最終 fallback）
```

- `Settings.ini` 目前只有 49x 系列與少數特例；STD 系列不在其中
- STD 系列走 PDSC IRAM1（如 HT32F52341 = 8KB → `0x2000`）
- 設定值必須 ≤ 實際 RAM 大小；否則 FLM 存取超出 RAM 範圍 → BusFault → DHCSR FAULT ACK

**launch.json 關鍵欄位：**
**Debug launch.json 關鍵欄位：**
```json
{
  "servertype": "pyocd",
  "overrideGDBServerStartedRegex": "GDB[ -][Ss]erver.*[Ll]istening.*[Pp]ort[: ]+[0-9]+",
  "targetId": "ht32f49395_100lqfp",
  "serverpath": "<pyocd.exe 絕對路徑>",
  "serverArgs": ["--pack", "<dfp.pack>", "--config", "<pyocd.yaml>", "--probe", "<serial>"],
  "loadFiles": [],
  "preLaunchCommands": ["set mem inaccessible-by-default off", "set remotetimeout 300"],
  "postLaunchCommands": ["monitor reset halt", "monitor arm semihosting enable"],
  "overrideResetCommands": ["monitor reset halt"],
  "preLaunchTask": "Build & Download <suffix>"
}
```

**Attach launch.json 關鍵欄位：**
```json
{
  "servertype": "pyocd",
  "request": "attach",
  "serverArgs": ["--pack", "<dfp.pack>", "--config", "<pyocd.yaml>", "--probe", "<serial>", "-O", "connect_mode=attach"],
  "loadFiles": [],
  "preAttachCommands": ["set mem inaccessible-by-default off", "set remotetimeout 300"],
  "postAttachCommands": ["monitor halt", "monitor arm semihosting enable"],
  "overrideResetCommands": ["monitor reset halt", "tbreak *main"]
}
```

> **`rtos` 欄位**：pyocd launch config **不加** `"rtos": "FreeRTOS"`。該欄位是 cortex-debug 針對 OpenOCD 設計的，pyocd 透過自身 RTOS plugin 自動偵測，詳見 `arch/rtos.md`。

---

### `servertype: "openocd"`

cortex-debug 完全管理 OpenOCD 生命週期。OpenOCD 跑在 cortex-debug 建立的 **gdb-server** terminal 中，
每次 F5 重新建立（不 reuse）。

> **`connect_assert_srst` 不放在 HLM cfg 的原因：**
> 若 HLM cfg 含 `connect_assert_srst`，OpenOCD 在 `init` 連線時會 assert SRST（硬體 reset），
> 這個動作在 `openOCDLaunchCommands` 的 override 之前發生，導致 attach 時 MCU 被 reset。
> 解法：cfg 只用 `srst_nogate`；debug 的 reset 靠 `postLaunchCommands: monitor reset halt` 處理。

**Flash & Debug 流程（F5）：**
```
preLaunchTask: Build & Download <suffix>  ← Build → Download（Download 內含 Kill OpenOCD）
  Build <suffix>：make -j（含 Post-Build）
  Download <suffix>：Kill OpenOCD → openocd → init → reset halt → [erase] → write → reset run → exit
    ↑ Kill 確保 probe 無人佔用；exit 後 probe 釋放
    erase_sector：init → reset halt → ht_flash write_image erase <elf> → reset run → exit
    erase_chip： init → reset halt → ht_flash erase_chip → ht_flash write_image <elf> → reset run → exit
      ↑ 兩者皆採分離流程以保持一致性，不使用 program 指令。
        原因：program 內部寫死 flash write_image erase（sector erase），
        若搭配 ht_flags erase_chip 會產生雙重 erase → algorithm execution error。
cortex-debug spawn OpenOCD（serverpath + configFiles + openOCDPreConfigLaunchCommands + openOCDLaunchCommands）
  openOCDPreConfigLaunchCommands（在 configFiles 之前）：hlm_SRAM / hlm_loader / set WORKAREASIZE
  openOCDLaunchCommands（在 configFiles 之後）：adapter serial / reset_config / set_expected_name / echo sentinel
[extension] registerDebugAdapterTrackerFactory → onWillStartSession → focus gdb-server terminal
GDB 連線（loadFiles:[] — 不 load，韌體已由 Download task 燒好）
postLaunchCommands:
  monitor reset halt
  monitor arm semihosting enable
runToEntryPoint: "main"
[extension] onDidStartDebugSession → workbench.view.debug
```

**Attach 流程：**
```
cortex-debug spawn 新 OpenOCD（每次 attach 重新建立）
[extension] onWillStartSession → focus gdb-server terminal
GDB attach（不燒錄）
postAttachCommands: monitor halt / monitor arm semihosting enable
overrideResetCommands: monitor reset halt / tbreak *main（cortex-debug 自動加 continue）
[extension] onDidStartDebugSession → workbench.view.debug
```

**terminal focus 機制：**
- `registerDebugAdapterTrackerFactory('cortex-debug')` → `onWillStartSession`：
  - 在 cortex-debug adapter 啟動瞬間觸發（早於 download）
  - 若 `gdb-server` terminal 已存在（第二次+）→ 立即 `show(false)`
  - 若尚未建立（第一次）→ 每 100ms 輪詢，最多 3 秒，terminal 出現後立即 `show(false)`

**`overrideGDBServerStartedRegex` 設計：**
```
openOCDLaunchCommands 最後加：echo HT32_VSCode:OCD_READY
overrideGDBServerStartedRegex: "HT32_VSCode:OCD_READY"
```
cortex-debug spawn OpenOCD 後等此 sentinel 才讓 GDB 連線，timing 正確，probe 無關。

**Attach 流程：**
```
cortex-debug spawn 新 OpenOCD（每次 attach 都重新建立）
[extension] onWillStartSession → focus gdb-server terminal
GDB attach（不燒錄）
postAttachCommands: monitor halt / monitor arm semihosting enable
overrideResetCommands: monitor reset halt / tbreak *main（cortex-debug 自動加 continue）
```

**launch.json 關鍵欄位（Debug）：**
```json
{
  "servertype": "openocd",
  "overrideGDBServerStartedRegex": "HT32_VSCode:OCD_READY",
  "serverpath": "<ext>/openocd/bin/openocd.exe",
  "configFiles": ["...", "..."],
  "openOCDPreConfigLaunchCommands": ["hlm_SRAM ...", "hlm_loader ...", "set WORKAREASIZE ..."],
  "openOCDLaunchCommands": ["adapter serial ...", "reset_config ...", "set_expected_name ... SkipReadID", "echo HT32_VSCode:OCD_READY"],
  "loadFiles": [],
  "postLaunchCommands": ["monitor reset halt", "monitor arm semihosting enable"],
  "preLaunchTask": "Build & Download <suffix>"
}
```

---

### `servertype: "external"`

Extension 透過 task 管理 OpenOCD 生命週期。**GDB server（OpenOCD）由 task 啟動**，
韌體燒錄由 Download task 完成（`openocd program ... reset exit`），GDB 不執行 `load`。

**Task 結構：**

| Task | 說明 | presentation |
|------|------|-------------|
| `Compile <suffix>` | `make -j` | `reveal:always, panel:dedicated, clear:true` |
| `Post-Build <suffix>` | `.bat` 後處理腳本 | `reveal:always, panel:dedicated, clear:false` |
| `Build <suffix>` | compound：Compile → Post-Build | `reveal:always, panel:dedicated, clear:true` |
| `Clean <suffix>` | `make clean` | `reveal:always, panel:dedicated, clear:false` |
| `Kill OpenOCD` | `taskkill /F /IM openocd.exe /T` | `reveal:never, panel:shared, close:true` |
| `Download <suffix>` | Kill OpenOCD → OpenOCD 燒錄（`program ... reset exit`） | `reveal:always, panel:dedicated, clear:true` |
| `OpenOCD <suffix>` | isBackground GDB server（Debug/Attach 共用）| `reveal:always, panel:dedicated, clear:true, focus:true` |
| `Build & Download <suffix>` | F5 preLaunchTask：Build → Download → OpenOCD（sequence） | — |
| `Attach <suffix>` | Attach preLaunchTask：Kill OpenOCD → OpenOCD（sequence） | — |

> `Build All` / `Clean All` compound tasks 只在多個子專案（`Project_xxx/`）時產生。

**Flash & Debug 流程（F5）：**
```
preLaunchTask: Build & Download <suffix>  ← Build → Download → OpenOCD-keep 背景啟動
  Build <suffix>：make -j（含 Post-Build）
  Download <suffix>：Kill OpenOCD → openocd program <elf> reset exit
  OpenOCD <suffix>（isBackground）：Kill OpenOCD → openocd（長跑 GDB server）
    beginsPattern: "Open On-Chip Debugger"
    endsPattern:   "HT32_VSCode:READY"（VS Code 等這行才允許 GDB 連線）
    ↑ 注意：openocd 指令後不可加 init，加了會使 endsPattern 不如預期觸發
GDB 連線（loadFiles:[] — 不 load，韌體已由 Download 燒好）
postLaunchCommands: monitor reset halt / monitor arm semihosting enable
runToEntryPoint: "main"
```

**Attach 流程：**
```
preLaunchTask: Attach <suffix>  ← Kill OpenOCD → OpenOCD-keep（重啟 GDB server）
GDB attach（不燒錄）
postAttachCommands: monitor halt / monitor arm semihosting enable
overrideResetCommands:  monitor reset halt / tbreak *main / continue
overrideRestartCommands: monitor reset halt / tbreak *main / continue
  ↑ external attach 的 reset/restart 需明確加 continue（cortex-debug 對 external 不自動加）
```

**`overrideGDBServerStartedRegex` 設計：**
```
openOCDLaunchCommands 加：echo HT32_VSCode:READY
overrideGDBServerStartedRegex: "HT32_VSCode:READY"
```
VS Code isBackground task 的 `endsPattern` 同樣等這行，timing 一致。

**launch.json 關鍵欄位（Debug）：**
```json
{
  "servertype": "external",
  "gdbTarget": "localhost:3333",
  "overrideGDBServerStartedRegex": "HT32_VSCode:READY",
  "loadFiles": [],
  "postLaunchCommands": ["monitor reset halt", "monitor arm semihosting enable"],
  "preLaunchTask": "Build & Download <suffix>"
}
```

**launch.json 關鍵欄位（Attach）：**
```json
{
  "servertype": "external",
  "request": "attach",
  "gdbTarget": "localhost:3333",
  "overrideGDBServerStartedRegex": "HT32_VSCode:READY",
  "postAttachCommands": ["monitor halt", "monitor arm semihosting enable"],
  "overrideResetCommands": ["monitor reset halt", "tbreak *main", "continue"],
  "overrideRestartCommands": ["monitor reset halt", "tbreak *main", "continue"],
  "preLaunchTask": "Attach <suffix>"
}
```

---

## Debug Level 對照表

Settings Webview → Debugger → **Debug Level**（`openocdDebugLevel`，1–4，預設 **1**）

| Level | Syslog 等級 | pyocd gdbserver / flash | OpenOCD |
|-------|------------|-------------------------|---------|
| **1（預設）** | **WARNING** | **—（pyocd 預設）** | **`-d1`** |
| 2 | INFO | `-v` | —（OpenOCD 預設）|
| 3 | DEBUG | `-v -v` | `-d3` |
| 4 | DEBUG IO | `-v -v` | `-d4` |

**設計原則：**
- Level 1 為 extension 預設：pyocd 無 flag（WARNING，progress bar 可見）；OpenOCD 用 `-d1`
- Level 2（INFO）為進階偵錯用；pyocd 加 `-v`；OpenOCD 無 flag（OpenOCD 預設即 INFO）
- Level 0 已移除：pyocd 的 `-q` 會壓制 GDB server 啟動訊息，導致 cortex-debug 無法偵測到 port 而 timeout
- pyocd progress bar 只在 level 1（無 `-v`）時可見；加 `-v` 後 INFO 訊息會淹沒 progress bar
- `pyocd_user.py` 的 `print()` 輸出走 stdout，**不受 log level 控制**，任何 level 都會顯示
- pyocd level 3 和 4 效果相同（pyocd DEBUG 已是最高等級），但 OpenOCD `-d3`/`-d4` 有差異

---

## 根本差異：三種模式比較

| | `pyocd`（預設）| `openocd` | `external` |
|-|----------------|-----------|-----------|
| Flash 工具 | pyocd + FLM（DFP pack）| OpenOCD + HLM | OpenOCD + HLM |
| Server 管理者 | cortex-debug | cortex-debug | extension task（VS Code task）|
| 燒錄方式 | `pyocd flash`（Download task）| `openocd program`（Download task）| `openocd program`（Download task）|
| `loadFiles: []` | ✓（GDB 不 load）| ✓（GDB 不 load）| ✓（GDB 不 load）|
| EXT flash | `pyocd_user.py` FlashRegion 動態註冊 | `hlm_loader` 預先設定 | `hlm_loader` 預先設定 |
| MCU cfg 依賴 | 不需要 | 需要（`openocd/scripts/`）| 需要 |
| HLM 依賴 | 不需要 | 需要（`hlm_loader`）| 需要 |
| Download task | `pyocd flash`（獨立，無需 Kill）| Kill → OpenOCD（`program reset exit`）| Kill → OpenOCD（`program reset exit`）|

---

## Debug / Attach / Reset / Restart 行為比較

### F5 Debug（launch）

| 項目 | pyocd | openocd | external |
|------|-------|---------|----------|
| preLaunchTask | Build & Download → pyocd flash | Build & Download → Kill + openocd program | Build & Download → Build + Download + OpenOCD-keep |
| GDB load | `loadFiles:[]`，不 load | `loadFiles:[]`，不 load | `loadFiles:[]`，不 load |
| postLaunchCommands | `monitor reset halt` + semihosting | `monitor reset halt` + semihosting | `monitor reset halt` + semihosting |
| runToEntryPoint | main | main | main |
| GDB server 管理 | cortex-debug 管理 pyocd-gdbserver | cortex-debug 管理 OpenOCD | isBackground task 啟動 OpenOCD（GDB 連 localhost:3333）|

### Attach

| 項目 | pyocd | openocd | external |
|------|-------|---------|----------|
| preLaunchTask | 無 | 無（cortex-debug 啟動新 OpenOCD）| Kill OpenOCD → OpenOCD-keep 背景 |
| postAttachCommands | `monitor halt` + semihosting | `monitor halt` + semihosting | `monitor halt` + semihosting |
| overrideResetCommands | `monitor reset halt`, `tbreak *main` | `monitor reset halt`, `tbreak *main` | `monitor reset halt`, `tbreak *main`, `continue` |
| overrideRestartCommands | —（與 reset 相同）| —（與 reset 相同）| `monitor reset halt`, `tbreak *main`, `continue` |

### Reset 按鈕（cortex-debug 工具列）

cortex-debug 在 `overrideResetCommands` 執行完後會**自動加一個 `continue`**（Debug 和 Attach 皆然）。

| 情境 | 行為 |
|------|------|
| pyocd Debug | `overrideResetCommands:` `monitor reset halt`（+ cortex-debug 自動 continue）|
| pyocd Attach | `monitor reset halt`, `tbreak *main`（+ cortex-debug 自動 continue）→ 停在 main |
| openocd Debug | 無 overrideResetCommands，cortex-debug 預設行為 |
| openocd Attach | `monitor reset halt`, `tbreak *main`（+ cortex-debug 自動 continue）→ 停在 main |
| external Debug | 無 overrideResetCommands，cortex-debug 預設行為 |
| external Attach | `monitor reset halt`, `tbreak *main`, `continue`（使用者確認，手動加 continue）→ 停在 main |

### Restart 按鈕（extension 攔截）

所有 `cortex-debug` session 的 Restart 按鈕由 extension 攔截，改為 **stop + `startDebugging(savedConfig)`**。
`savedConfig` 在 `stopDebugging` 之前從 `session.configuration` 讀取，保留原始 `request: "launch"` 或 `"attach"`。

| 情境 | 實際行為 |
|------|----------|
| pyocd Debug restart | stop → pyocd-gdbserver 結束 → F5（Build & Download）→ 新 session |
| pyocd Attach restart | stop → pyocd-gdbserver 結束 → 無 preLaunchTask → 直接 attach |
| openocd Debug restart | stop → OpenOCD 結束 → F5（Build & Download = Kill + re-flash）→ 新 OpenOCD → 新 session |
| openocd Attach restart | stop → OpenOCD 結束 → cortex-debug 啟動新 OpenOCD → attach |
| external Debug restart | stop → OpenOCD 繼續跑 → F5（Build + Download + OpenOCD-keep）→ re-flash + 重連 |
| external Attach restart | stop → OpenOCD 繼續跑 → Attach preLaunchTask（Kill + OpenOCD-keep）→ attach |

---

## `buildOpenocdServerConfigs()` 函式說明（servertype: openocd 專用）

接收 `bgPreConfigCmds` 並自動分割：

| 來源 | 目的地 |
|------|--------|
| `adapter serial/speed` | `openOCDLaunchCommands`（configFiles 之後）|
| `hlm_SRAM / hlm_loader / ht_flags / set WORKAREASIZE` | `openOCDPreConfigLaunchCommands`（configFiles 之前）|

分割原因：`hlm_SRAM / hlm_loader` 必須在 target cfg source 之前定義。

---

## 支援的 Debug Adapter 特性

### 快速比較表

| 特性 | CMSIS-DAP (e-Link32) | ST-Link/V2 | JLink |
|------|----------------------|------------|-------|
| OpenOCD driver | `cmsis-dap` | `hla` (High Level Adapter) | `jlink` |
| Transport | `swd`（自動）| `hla_swd`（需明確 select）| `swd`（需明確 select，預設 JTAG）|
| DAP 控制層 | OpenOCD 直接存取 | ST-Link 韌體內部管理 | OpenOCD 直接存取 |
| USB serial | 有（可區分多台）| V2 通常沒有；V2-1/V3 有 | 有（可區分多台）|
| nRESET 接線 | 排線已接，reset 正常 | 排線已接，reset 正常 | 排線不一定接，未接 → debug 不停在 main |
| Windows driver | HID（內建，免安裝）| WinUSB（ST-Link Utility 自動安裝）| 需用 Zadig 換 WinUSB，否則 OpenOCD 無法存取 |
| probe / `dap info` | 支援 `dap info` | 不支援（DAP 由韌體管理）| 支援 `dap info` |
| interface cfg | `cmsis-dap.cfg` / `htlink.cfg` | `stlink.cfg` | `jlink.cfg` |

---

### CMSIS-DAP（e-Link32 Pro / Lite）

- `adapter driver cmsis-dap`，transport `swd` 由 OpenOCD 自動處理
- 不需要在 cfg 明確寫 `transport select`
- Windows HID driver 內建，零設定
- e-Link32 排線已含 nRESET，`monitor reset halt` 正常
- 有 USB serial，多台可區分
- probe 可用 `swj_newdap` + `dap create` + `dap info` 取得 DPIDR

---

### ST-Link

- `adapter driver hla`，transport 必須明確寫 `transport select hla_swd`
- DAP 由 ST-Link 韌體內部管理，OpenOCD 不可直接建立 DAP tap
  - `swj_newdap` 對 HLA 必須是 no-op（`using_hla` 分支）
  - `dap create` / `dap info` 均不支援，改用 `targets` 指令查詢目標狀態
- probe 指令：使用 `HLMm0x.cfg`（含 `hla_target`）+ `init` + `targets` + `arp_examine` + `mdw 0xE000ED00`
  - `targets`：確認 ST-Link 與 OpenOCD 連線正常，取得目標 state
  - `HT32M0.cpu arp_examine`：觸發 target examination（不 halt，瞬間完成）；少了這步 target 停在 "unknown" state，`mdw` 無法讀取記憶體
  - `mdw 0xE000ED00`：讀 CPUID 暫存器，輸出 `0xe000ed00: 410cc601`；bits[15:4] = PartNo，0xC60 = M0+、0xC23 = M3、0xC24 = M4
  - 注意：`mdw` 不可包在 `catch {}` 中，否則輸出被吞，只剩 `0`（catch 回傳碼）
- ST-Link/V2（獨立器）：通常**無 USB serial number** → Settings Webview 顯示 `(no serial)`，多台無法區分
- ST-Link/V2-1（板載，如 Nucleo）、ST-Link/V3：有 USB serial，可區分

---

### JLink

- `adapter driver jlink`，預設 transport 為 **JTAG**，必須在 cfg 明確寫 `transport select swd`
  - 若未加：`swj_newdap` 進入 else 分支 → `shutdown` → OpenOCD 啟動即結束
- Windows 上 SEGGER 安裝的是自家 `jlink.sys`，libusb 無法存取
  - 必須用 **Zadig** 將 driver 換成 WinUSB 才能讓 OpenOCD 存取 JLink
  - 換後 Keil / J-Flash 等 SEGGER 工具失效；還原方式：裝置管理員刪除 driver → 重插
- nRESET（SRST）連線：JLink 排線**不一定接** nRESET
  - 未接 → `monitor reset halt` 無效 → debug 後 PC 留在 HLM loader RAM → 不停在 main
  - 解法：確認 JLink 排線 nRESET 腳（10-pin 第10腳 / 20-pin 第15腳）有接到目標板 RESET
- 有 USB serial，多台可區分

---

## Debug Session 生命週期 — Focus 切換機制

### Debug 開始 → 切到 Run & Debug sidebar

`onDidStartDebugSession`：所有 `type === 'cortex-debug'` 的 session 啟動時，執行 `workbench.view.debug`。  
session.id 同時加入 `ourDebugSessionIds` 追蹤集合。

### Debug 結束 → 切回 HT32 panel

`onDidTerminateDebugSession`：session.id 在追蹤集合中時，切回 HT32 panel。

**關鍵問題**：VS Code 在 debug session 結束時會自動切回 Explorer，時間點在我們的事件處理之後。  
**解法**：兩段 `setTimeout`（300ms + 700ms）各執行一次 focus，確保蓋過 VS Code 的自動切換：

```typescript
const focusHt32 = () => {
    vscode.commands.executeCommand('workbench.view.extension.ht32Assistant');
    vscode.commands.executeCommand('ht32ProjectView.focus');
};
setTimeout(focusHt32, 300);
setTimeout(focusHt32, 700);
```

**追蹤範圍**：所有 cortex-debug session（不限透過 `ht32.startDebug` 啟動），直接 F5 也有效。

**Log 確認**：HT32 Output Channel 會輸出 `[debug] terminate session=... tracked=true/false`，可用來排查 session 是否被正確追蹤。
