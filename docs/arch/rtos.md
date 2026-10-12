# FreeRTOS 轉換支援

## 背景

Holtek 官方 FreeRTOS 範例以兩種方式提供 portable layer：

| 類型 | 代表 FWLib | port.c 來源 | portmacro.h |
|------|-----------|------------|-------------|
| **include_port.c wrapper** | HT32F49x FWLib（49x 系列） | `include_port.c` 間接引入 GCC 版 | GCC 版，無需替換 |
| **直接引用 RVDS port.c** | STD 5xxxx FWLib FreeRTOS Template | `portable/RVDS/ARM_CMx/port.c` | ARMCC 語法，**GCC 不相容** |

---

## 自動替換：Convert uVision（`uv2make.ts`）

### source 路徑替換

在 sources loop 內，每個 `.c` 檔的 `finalRel` 套用正規表示式：

```
portable/RVDS/ARM_CMx  →  portable/GCC/ARM_CMx
```

程式碼位置：`uv2make.ts`，sources loop 中 `.s` 處理塊之後。

**效果**：`../../freertos/Source/portable/RVDS/ARM_CM4F/port.c`
→ `../../freertos/Source/portable/GCC/ARM_CM4F/port.c`

### include path 替換

在 includes 收集完成後，同樣的正規表示式套用於所有 include path：

```
portable/rvds/ARM_CMx  →  portable/GCC/ARM_CMx   (case-insensitive)
```

**原因**：RVDS 版 `portmacro.h` 含 ARMCC 專屬語法（`__forceinline`、`__asm msr …`），GCC 無法解析。替換為 GCC 版 include 目錄後，clangd 與編譯均正常。

### include_port.c 情境（49x 系列）

這類專案的 uVision sources 中已包含 `include_port.c`（wrapper，實際 `#include` GCC port.c），且 include path 已指向 GCC 目錄，所以兩段替換均為 no-op，不影響行為。

---

## 手動處理情境

**STD FWLib FreeRTOS Template**（如 `HT32_STD_5xxxx_FWLib/.../FreeRTOS/Template`）：

uVision 專案包含 `portable/RVDS/ARM_CMx/port.c`。轉換後 extension 自動替換為 `portable/GCC/ARM_CMx/port.c`，理論上可直接編譯。

若 FreeRTOS 目錄結構不含 `portable/GCC/` 對應版本（例如只解壓了部分檔案），需使用者自行補齊 GCC portable 目錄，或透過 Settings Webview 的 Include Paths 欄位手動調整。

---

## HT32-IDE 轉換（`ht32ide2make.ts`）

HT32-IDE 專案使用的 FreeRTOS portable 通常已是 GCC 版（HT32-IDE 本身以 GCC 編譯），
`ht32ide2make.ts` **不做** RVDS→GCC 替換。

---

## RTOS 偵測

Extension **不**在 `project.meta.json` 或 `project.settings.json` 儲存 `rtos` 欄位。
`generateTasksAndLaunchAndMakefile()` 動態掃描 `project.meta.json` 的 `groups` 所有檔案路徑，只要有任何路徑符合 `/freertos/i`，即視為 FreeRTOS 專案：

```typescript
const bgAllPaths = Object.values(bgMeta.groups).flat()
  .concat(Object.keys(bgMeta.fileOptions ?? {}));
bgRtos = bgAllPaths.some(p => /freertos/i.test(p)) ? 'FreeRTOS' : undefined;
```

好處：使用者在 create project 後自行加入 FreeRTOS 檔案，下次 Generate Build & Debug Config 即自動生效。

---

## launch.json — GDB Server 分流

### OpenOCD

`rtos` 欄位由 **cortex-debug** 處理，在 GDB 層解析 RTOS thread 結構。偵測到 FreeRTOS 時寫入：

```json
"rtos": "FreeRTOS"
```

### pyocd

`rtos` 欄位是 **OpenOCD 專用**，pyocd 路徑的 launch config **不加**此欄位。

pyocd 透過自身的 RTOS plugin 系統提供 thread awareness，可自動偵測 FreeRTOS，無需額外設定。
若需明確控制，可在 `pyocd.yaml` 加：

```yaml
rtos.enable: true
rtos.name: FreeRTOS   # 通常自動偵測即可
```

> **注意**：`rtos.enable: false` 實測可能無法停用自動偵測。

---

## 相關位置

- `src/tools/uv2make.ts` — sources loop `.c` 替換 / includes 替換
- `src/ht32-project-assistant-for-vs-code.ts` — `generateTasksAndLaunchAndMakefile()`，`bgRtos` 偵測與分流
- `buildPyocdServerConfigs()` — 不接受 `rtos` 參數
- `buildOpenocdServerConfigs()` — 接受 `rtos?` 參數
