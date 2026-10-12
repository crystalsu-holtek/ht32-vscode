# conf/Settings.ini 使用時機

`conf/Settings.ini` 是 bundled 設定檔，結構與 HT32-IDE 的同名檔完全相同，方便隨 HT32-IDE 新版同步更新。

---

## 內容結構

```ini
[HLM_WORK_AREA]
HT32F52231_41 = 0x20000000, 0x1000
HT32F49310    = 0x20000000, 0x18000
...
```

每一行格式：`MCU型號 = 起始位址, 安全 SRAM 大小`

---

## 三個使用場景

### 1. OpenOCD HLM Flash Algorithm WORKAREASIZE

**位置**：`generateTasksAndLaunchAndMakefile()` → `buildOpenOcdServerConfigs()` → `selectHlmConfig()`

**用途**：OpenOCD 需要在 MCU SRAM 裡放 HLM（Host-side Load Module）。  
Settings.ini 提供每顆 MCU 的安全 SRAM 起始位址與大小，轉換成 `WORKAREASIZE` 參數寫入 `launch.json`：

```json
"serverArgs": [
  "-c", "set HLM_WORK_AREA 0x20000000",
  "-c", "set WORKAREASIZE 0x1000",
  ...
]
```

**適用系列**：全系列（STD + 49x），不限系列。

---

### 2. RAM 大小 patch（Create Project）

**位置**：`createProject.ts` → `patchLinkerMemory()` → `resolveRamLength()`

**用途**：Create Project 需要知道目標 MCU 的 RAM 大小來 patch linker script。  
查詢順序：**Settings.ini 優先 → PDSC fallback**。

Settings.ini 提供的是 HLM 可安全使用的 SRAM 範圍，對多數 MCU 等同全部 SRAM，但對少數有保留區的 MCU（如 IAP 設計），此值可能小於 PDSC 標示的實體 RAM。

**適用系列**：全系列。

---

### 3. `_estack` 上限 cap（scatter 路徑）

**位置**：`uv2make.ts` → `generateLinkerScript()` → `patchLdStackTop()`

**用途**：當 scatter 檔指定的 RAM 大小超過 Settings.ini 的安全值（例如 MCU 有多塊 SRAM 但 HLM 只能用第一塊），  
`patchLdStackTop` 把 `_estack` / `__StackTop` 的 `LENGTH(RAM)` 替換成 Settings.ini 的安全大小，
確保 SP 不超過 SRAM 安全邊界，避免 OpenOCD 初始化時 "Failed to read memory" 錯誤。

**必要前提**：`scatter2ld` 必須輸出 expression 形式的 `_estack`（`ORIGIN(RW_IRAM1) + LENGTH(RW_IRAM1) - 16`），
而非 absolute 數值；`patchLdStackTop` 的 regex 才能匹配。

**適用系列**：全系列，但最常見於 49x（HT32F493x5 RAM 實體 224KB，安全值 96KB）。

---

## 查詢優先順序（RAM 解析）

```
Settings.ini [HLM_WORK_AREA] <MCU型號>
     ↓ 找不到
PDSC <memory name="IRAM1" ...>
     ↓ 找不到
保留原始 scatter / .cproject 指定的值
```

---

## 與 HT32-IDE 同步

Settings.ini 與 HT32-IDE 的同名檔結構完全相同，升級 HT32-IDE 時可直接比對 diff 並更新此檔。  
詳見 `arch/maintenance.md` — 新版 HT32-IDE 更新流程。
