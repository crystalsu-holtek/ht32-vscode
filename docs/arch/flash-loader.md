# Flash Loader 架構

## 設計原則：FLM-first

Flash loader 設定以 **FLM（CMSIS-Pack Flash Algorithm）為唯一識別碼**，儲存於 `project.settings.json`。  
OpenOCD 需要的 HLM 由 `flmToHlm()` 在執行時反查，不存在時 logWarn 並跳過（不 crash）。  
PyOCD 直接從 DFP pack 取 FLM，完全不依賴 HLM。

---

## Flash / Option 位址來源

**全部從 PDSC `<algorithm>` 讀取**（`parseMcuCfg()` 已改為 PDSC-based）：

```xml
<algorithm name="Flash/HT32F493x5_512.FLM" start="0x08000000" size="0x00080000" .../>
<algorithm name="Flash/HT32F_OPT.FLM"      start="0x1FF00000" size="0x00001000" .../>
```

- `parseMcuCfg(deviceName, extPath)` 透過 `getAllPdscPaths()` 掃描所有 DFP 版本（union，newest-first），找 device 對應的 algorithm：
  - 非 EXT / 非 OPT → internal flash（flashStart / flashEnd）
  - 含 `OPT` → option bytes（optStart / optEnd）
- 不再讀 `openocd/MCU/*.cfg`；MCU cfg 只有 OpenOCD 執行時（`buildHlmPreConfigCmds`）才間接用到（透過 HLM 路徑）

---

## 內部 Flash Loader 選擇

`selectInternalFlm(deviceName, flashSizeBytes, extPath)` 從 PDSC 找 internal flash FLM：

1. 掃 `getAllPdscPaths()`（全版本 union）
2. 找到 device block → 收集所有 `<algorithm>`
3. 過濾掉 EXT（SPIM）和 OPT
4. 比對 algo.size ≈ flashSizeBytes → 回傳 FLM basename（如 `HT32F493x5_512.FLM`）
5. 找不到回傳 `undefined`（不 fallback）

---

## FLM → HLM 反查（OpenOCD 專用）

`flmToHlm(flmBasename, loaderDir)` 在 `buildHlmPreConfigCmds()` 內呼叫：

| FLM pattern | 轉換規則 |
|---|---|
| `HT32Fxxx_NNN.FLM`（internal flash）| 直接換副檔名 `.FLM` → `.HLM`，確認檔案存在 |
| `HT32Fxxx_EXT_TYPEn_REAMPn_GENERAL.FLM`（SPIM）| `findSpimHlmForFlm()`：REAMP{n} → GRMP{n} pattern match |
| 找不到對應 HLM | 回傳 `undefined`，`buildHlmPreConfigCmds()` logWarn 並跳過該 loader |

---

## `flashLoaders` 格式（`project.settings.json`）

```json
[{ "flm": "HT32F493x5_EXT_TYPE2_REAMP0_GENERAL.FLM",
   "start": "0x08400000", "end": "0x093FFFFF", "enabled": true }]
```

key 為 `flm`（FLM basename），不再是 `hlm`。

---

## Settings Webview — Flash Loaders 面板

- **Available FLM dropdown**：從 `buildFlmAddrMap()` 取得，只列 **SPIM EXT** FLM（掃所有 DFP PDSC，union，不依賴 HLM 存在）；Internal Flash 不出現在 dropdown
- **Auto section（read-only）**：`computeAutoLoadersForBg()` → `parseMcuCfg()` 取 flash range → `selectInternalFlm()` 找 FLM → 顯示 FLM 名稱去副檔名
- **顯示**：一律去掉副檔名，value 仍存完整 FLM basename（含 `.FLM`）
- **address auto-fill**：`buildFlmAddrMap()` 回傳 `flm → {start, end}`，從 PDSC 取得

---

## 外部 SPIM Flash Loader 偵測邏輯

每次 `generateTasksAndLaunchAndMakefile`（Convert / Generate Build Config）都執行：

1. **取 primary flash 範圍**：`parseMcuCfg(deviceName, extPath)` 從 PDSC 讀 flashStart/flashEnd/optStart/optEnd
2. **掃 LD MEMORY block**：`ldUncoveredFlashAddrs()` 找 `(rx)` region（有 `r`、無 `w`）中不在 primary 或 option 範圍內的 ORIGIN → `uncoveredAddrs: Set<number>`
3. **過濾已覆蓋**：從 `project.settings.json` 的 `flashLoaders` 中 `enabled !== false` 條目移除已覆蓋位址
4. **結果**：
   - `uncoveredAddrs.size === 0`：不問
   - `uncoveredAddrs.size > 0`：檢查 `flashLoadersExplicit` → 呼叫 `selectSpimFlm()` → QuickPick

### `flashLoadersExplicit` 判斷

`project.settings.json` 中 `flashLoaders` **key 存在**（包含 `[]`）即視為使用者已明確設定，跳過 auto-detect。

| 狀態 | key 存在？ | 行為 |
|---|---|---|
| 從未設定（first convert） | 否 | 執行 auto-detect |
| 使用者選了 loader | 是（有值）| 直接使用 |
| 使用者在 Settings Webview 清空 | 是（`[]`）| 跳過，不再詢問 |

**注意**：`writeProjectSettings`（extension 內部呼叫）在 `flashLoaders` 為空時**不寫入該 key**，避免「預設空值」被誤判為使用者明確設定。只有 Settings Webview 存檔時傳入 `{ keepEmptyFlashLoaders: true }`，才會保留 `[]`。

### `selectSpimFlm()` 優先順序

1. **FLM keyword 自動配對**（uVision 路徑）：從 `.uvoptx` 讀 FLM hint，match `flmKey`（`TYPE{n}_REAMP{n}`）→ 自動選擇
2. **單一選項**：過濾後只剩 1 個符合 start addr 的 FLM → 自動選擇
3. **QuickPick**：多個選項 → 顯示 QuickPick（顯示 FLM 名稱去副檔名）

選擇結果存入 `project.settings.json` 的 `flashLoaders`（`flm` 欄位）。

### Template-based 模式的 MEMORY region 去重（49x 系列）

49x FWLib template（`HT32F49395_FLASH.ld`）已包含 `SPIM (rx) : ORIGIN = 0x08400000`。  
若 scatter 檔也有同位址的 exec region（如 `LR_EXTFLASH 0x08400000`），`buildFromTemplate` 會：

1. 掃描 template 現有 MEMORY region，建立 `ORIGIN → regionName` map
2. Extra region 若 ORIGIN 已在 template 中 → **跳過插入**（不產生重複 MEMORY 行）
3. 對應 `customSection`（如 `.extflash`）的 `ldMem` **remap** 到 template 既有名稱（`SPIM`）

---

## OpenOCD launch 參數格式

```
hlm_SRAM <RAMstart> <workAreaSize>
set WORKAREASIZE <workAreaSize>
hlm_loader /abs/path/FlashLoader/<device>.HLM <flashStart> <flashEnd>
hlm_loader /abs/path/FlashLoader/HT32F_OPT.HLM <optStart> <optEnd>
```

- **workAreaSize**：來自 `conf/Settings.ini`（`parseMcuCfg()` 不再負責此項）
- **HLM 路徑**：absolute path，由 `flmToHlm()` 反查後組合
- HLM 不存在時：logWarn 跳過，`hlm_loader` 命令不產生

---

## PyOCD 路徑（不依賴 openocd/）

| 功能 | 依賴 |
|---|---|
| FLM 選擇 | PDSC `<algorithm>`（DFP） |
| Flash 位址 | PDSC `<algorithm>` start/size |
| SPIM FLM | PDSC → `pyocd_user.py` 從 pack 提取 |
| MCU cfg | **不需要** |
| HLM | **不需要** |

`generatePyocdFiles()` 直接用 `Flash/<flm>` 組 pack 內路徑，不做 HLM→FLM 轉換。

---

## Flash & Debug 任務觸發機制（`isBackground` + `endsPattern`）

Debug 流程分兩個任務：

```
Build & Download (debug)
  ├── Build (debug)
  ├── Kill OpenOCD
  └── Download (keep OpenOCD)   ← isBackground: true，長駐程式
        ↓
        cortex-debug launch config (preLaunchTask)
```

VS Code 透過 `problemMatcher.background` 持續掃描 terminal 輸出：

```json
"background": {
  "activeOnStart": true,
  "beginsPattern": "Open On-Chip Debugger",
  "endsPattern":   "HT32_VSCode:READY"
}
```

- `beginsPattern` 匹配 → 任務「進行中」
- `endsPattern` 匹配 → 任務「準備好」→ 通知 cortex-debug 可以開始連 GDB stub

### OpenOCD init 指令與 echo 的角色

```
program Project_xxx/build/HT32.elf
  └─ OpenOCD 自動輸出 "** Programming Finished **"

reset run
  └─ MCU 從 flash 正常開機（無輸出）

echo HT32_VSCode:READY
  └─ terminal 出現此字串 → endsPattern 觸發 → cortex-debug 開始連線
```

`echo` 是 OpenOCD Tcl 指令，字串含空格必須用 `{...}` 包住。  
`endsPattern` 放在 `reset run` 之後，確保 MCU 已從 flash 正常執行才讓 cortex-debug 連入。
