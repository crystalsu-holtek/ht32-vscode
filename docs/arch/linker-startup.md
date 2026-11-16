# linker_script.ld 與 startup.s — 來源路徑、heap/stack 設計

四條路徑各自的 `.ld` 來源與 patch 流程，以及 heap/stack section 的設計決策。

---

## 1. Convert uVision（`uv2make.ts` — 內部 `generateLinkerScript`）

**情況 A：有 scatter 檔（`.sct` / `.lin`）**

```
Keil scatter → scatter2ld() → patchLdMemoryFromInfo()    (patch FLASH/RAM origin+length)
                             → patchLdStackTop()          (若 Settings.ini 有 SRAM 安全值，patch _estack)
```

`scatter2ld` 的固定 template 直接產出：`_estack`、獨立 `.heap`/`.stack` section（各含 `KEEP()`）、`PROVIDE(__StackTop)` / `PROVIDE(__HT_check_sp)`。

- **STD（預設）**：`_Min_Heap_Size = 0x0`；startup `.s` 的 `.space` 提供 `.heap`/`.stack` section，`KEEP()` 收集即可；`PROVIDE(__HT_check_sp = .)` 在 `.stack` 開頭，`PROVIDE(__StackTop = .)` 在 `.stack` 結尾，startup .s label 勝出（與 patchLdStackSections STD 完全相同的格式）
- **49x**（`templateRoot` 含 `device_support/startup/gcc`）：`_Min_Heap_Size`/`_Min_Stack_Size` 用實際值；`.heap`/`.stack` section 額外加 `. += _Min_Heap_Size`（startup 無 .space）；`__StackTop = ${estack}` 頂層強賦值；`__HT_check_sp = __StackTop - _Min_Stack_Size` section 後強賦值（49x startup 無這兩個 label）

FWLib 路徑來源：`resolveGnuArmDir()` 的輸出（`gnuArmTemplate`）；raw XML FilePath 解析，不經 normalize 二次計算，確保路徑正確。

**情況 B-STD：無 scatter（標準系列）**

```
gnuArmTemplate = {FWLib}/project_template/IP/Example/GNU_ARM/
  linker.ld（在 gnuArmTemplate 內）
  → patchLdMemoryFromInfo()    (patch FLASH/RAM)
  → patchLdStackTop()          (patch _estack，若有 Settings.ini SRAM 安全值)
  → patchLdStackSections()     (STD path：._user_heap_stack → KEEP sections；
                                 __StackTop / __HT_check_sp 由 startup .s 提供)
```

**情況 B-49x：無 scatter（49x 系列）**

```
gnuArmTemplate = {FWLib}/libraries/cmsis/cm4/device_support/startup/gcc/
  linker/<chip>_FLASH.ld（在 gnuArmTemplate/linker/ 內）
  _estack = 0x2xxxxxxx → ORIGIN(RAM) + LENGTH(RAM)  (硬編碼 → expression form)
  → patchLdMemoryFromInfo()    (patch FLASH/RAM)
  → patchLdStackTop()          (patch _estack，若有 Settings.ini SRAM 安全值)
  → sync _Min_Heap/Stack_Size  (從 Keil startup EQU 取值；不 zero out)
  → patchLdStackSections()     (is49xStyle：注入 __StackTop = _estack; __HT_check_sp = _estack - _Min_Stack_Size;)
```

找不到 FWLib linker script → throw。**但 `resolveGnuArmDir` 在 library 完全未偵測到時會先嘗試從 sources 內的 `startup_ht32(系列)xxxx_NN.s` / `system_ht32(系列)xxxx_NN.c` 推出系列，回傳 bundled template 目錄，使 `generateLinkerScript` 能拿到 `linker.ld`**（適用於 FWLib 放在非標準目錄名下的專案，如 `ARM_LIB/`）。

---

## 2. Convert HT32-IDE（`ht32ide2make.ts` — 匯出 `generateLinkerScript`）

**情況 A：`.cproject` 有 linker 路徑且檔案存在（正常路徑）**

```
FWLib 原始 .ld（STD 系列：project_template/IP/Example/GNU_ARM/linker.ld V1.01
                49x 系列：libraries/cmsis/cm4/device_support/startup/gcc/linker/<chip>_FLASH.ld）
  → patch FLASH    (只改 LENGTH≥1MB 的佔位符，49x device-specific 值不動)
  → patch RAM      (從 .cproject 取得)
  → inject end=_ebss  (若缺，補在 _ebss 之後；syscalls.c 的 _sbrk 需要此符號)
  → patchLdStackSections()
```

**情況 B：`.ld` 路徑找不到（從 sources 推 FWLib）**

```
result.sources → 推 FWLib root
STD: project_template/IP/Example/GNU_ARM/linker.ld → patchFlashRam → injectEnd → patchLdStackSections()
49x: startup/gcc/linker/<chip>_FLASH.ld → _estack hardcode→expression → patchFlashRam → injectEnd → patchLdStackSections()
找不到 → throw（無 fallback）
```

---

## 3. Create Project 標準系列（`createProject.ts`）

```
FWLib project_template/IP/Example/GNU_ARM/linker.ld (V1.01)
  複製到 HT32_VSCode/GNU_ARM/linker.ld（保留原始檔名）
  → patchLinkerMemory()
      ├─ patch FLASH  (PDSC 查詢，若有)
      ├─ patch RAM    (Settings.ini → PDSC fallback)
      └─ patchLdStackSections()
```

---

## 4. Create Project 49x（`createProject.ts`）

```
FWLib libraries/cmsis/cm4/device_support/startup/gcc/linker/<chip>_FLASH.ld
  複製到 HT32_VSCode/Project/<chip>_FLASH.ld（保留原始檔名）  (FLASH/RAM 已是正確 device-specific 值；SPIM section 原樣保留)
  → patchLinkerMemory(content, undefined, undefined)
      └─ patchLdStackSections()    (不改 FLASH/RAM)
```

---

## `patchLdStackSections()`（`uv2make.ts` export，被路徑 2/3/4 呼叫）

FWLib 原始 `.ld`（V1.01）缺少 Stack Usage 所需 symbols，且 `._user_heap_stack` 無 `KEEP()`：

| 問題 | 說明 |
|------|------|
| `._user_heap_stack { *(.heap) *(.stack) }` 無 `KEEP()` | `--gc-sections` 會丟棄；且無法 `SIZEOF(.stack)` |
| `__StackTop` / `__HT_check_sp` | stackAnalysisProvider 從 ELF `.symtab` 讀取 |

### 為何 `.heap` 也加 `KEEP()` — Keil vs GCC heap 計入 RAM 的差異

**Keil 行為**：Heap 透過 `__user_initial_stackheap` 動態配置，linker 做 dead code elimination：
- `malloc` 有被呼叫 → `__user_initial_stackheap` 被引用 → `Heap_Mem SPACE` 保留 → **計入 RAM**
- `malloc` 未被呼叫 → `__user_initial_stackheap` 無引用 → `Heap_Mem SPACE` 被 linker 移除 → **不計入 RAM**

**GCC 要達到相同效果的條件**：需要一個真正引用 `__HeapBase` / `_end` 的 `_sbrk` 實作。
當 `malloc` 被呼叫時，`_sbrk` 被 link 進來 → 引用 `__HeapBase` → `.heap` section 有 reference → GC 保留。
但 `--specs=nosys.specs`（目前 LDFLAGS）提供的 `_sbrk` 是 stub（直接回傳 -1），**完全不引用 `_end`**，
導致不論 `malloc` 有無被呼叫，`.heap` section 都沒有 reference → 若不加 `KEEP()` 就永遠被 GC 丟掉，永遠不計入 RAM。

**結論**：GCC + nosys.specs 無法自動複製 Keil「用了才計入」的行為，只能二選一：

| 做法 | 行為 |
|------|------|
| 加 `KEEP()` heap（目前做法） | heap 永遠計入 RAM，可能比 Keil 多顯示 |
| 不加 `KEEP()` heap | heap 永遠不計入 RAM（nosys `_sbrk` 無引用 `_end`） |
| 實作真正的 `_sbrk`（引用 `__HeapBase`） | 行為與 Keil 一致，但須移除 nosys.specs 提供的 stub |

**實務建議**：若確定不使用 `malloc`（例如 LVGL `LV_MEM_CUSTOM = 0`），直接把 startup `.s` 的 `Heap_Size` 設為 `0`，`.if Heap_Size` guard 會讓 `.space` 完全跳過，RAM 顯示即與 Keil 一致。

**STD 系列 startup .s（HT32-IDE / uVision FWLib GCC startup）已定義三個 symbol**：

| Symbol | 位址 | 消費者 |
|--------|------|--------|
| `__StackTop` | `.stack` section 結尾（= 初始 SP） | 向量表 word 0；Stack Analysis 面板（End） |
| `__StackLimit` | `.stack` section 開頭（與 `__HT_check_sp` 同址） | ARM/CMSIS 標準，供 MSPLIM 暫存器或軟體 stack overflow 檢查 |
| `__HT_check_sp` | `.stack` section 開頭（與 `__StackLimit` 同址） | `StackUsageAnalysisInit()` 填魔術值起點；Stack Analysis 面板（Start） |

`__StackLimit` 與 `__HT_check_sp` 指向**相同位址**，名稱不同因消費者不同：前者是 ARM 生態慣例，後者是 Holtek HT32-IDE 自訂。

**49x startup .s 未定義**這三個 symbol（使用 `_estack` 作為初始 SP）。

**`patchLdStackSections` 對 49x 補充 symbol**（直接賦值，非 `PROVIDE`）：
- `__StackTop = _estack`（直接賦值確保進 ELF symtab；`PROVIDE` 只在 object file 有 reference 時才生效，而 panel 是直接讀 ELF symtab，不產生 linker reference，故不能用 `PROVIDE`）
- `__HT_check_sp = _estack - _Min_Stack_Size`（同理）
- `__StackLimit` 不補（49x 不使用 MSPLIM 機制，不影響功能）

`patchLdStackSections` 做的事：

**STD 系列**（`._user_heap_stack { *(.heap) *(.stack) }` 風格）：
- `._user_heap_stack` 替換為 KEEP 版本；`PROVIDE` symbol 作為 fallback（startup .s 已定義時 PROVIDE 被忽略）：
  ```
  .heap  : { . = ALIGN(8); KEEP(*(.heap))  KEEP(*(.heap*))  . = ALIGN(8); } >RAM
  .stack : { . = ALIGN(8); PROVIDE(__HT_check_sp = .); KEEP(*(.stack)) KEEP(*(.stack*)) . = ALIGN(8); PROVIDE(__StackTop = .); PROVIDE(_estack = .); } >RAM
  ```

**49x 系列**（`._user_heap_stack` 含 `_Min_Heap_Size` 算術風格）：
- `._user_heap_stack` 保留不動；在 `_estack` / `_Min_Stack_Size` 定義行後補入 symbol（直接賦值）：
  ```
  __StackTop = _estack;
  __HT_check_sp = _estack - _Min_Stack_Size;
  ```
  （不用 `PROVIDE`：`PROVIDE` 只在 object file 引用該 symbol 時才生效；panel 直接讀 ELF symtab 不產生 linker reference，故必須用直接賦值確保進 symtab）

**無 `._user_heap_stack`**（scatter2ld 路徑）：
- 對現有 `*(.stack)` / `*(.heap)` 補 `KEEP()`；找不到時在 `/DISCARD/` 前注入兩個 KEEP section，**不加 symbol**

已有對應 symbol 或 KEEP 時不重複插入（idempotent）。

---

## Stack Usage 支援狀態總覽

**STD / 49x 共通設計原則**

| 系列 | `__StackTop` / `__HT_check_sp` 來源 | 方式 |
|------|--------------------------------------|------|
| STD | FWLib GCC startup .s label（向量表 word 0 一定有 `__StackTop`） | `PROVIDE` — startup strong label 勝出；若 startup 未定義則 fallback 生效 |
| 49x | LD 直接賦值 | 強賦值 — startup 無這兩個 label，且 `__StackTop` 無 C reference，PROVIDE 無效 |

| 路徑 | `__StackTop` | `__HT_check_sp` | 備註 |
|------|:-----------:|:---------------:|------|
| uVision STD — 無 scatter | ✅ startup .s / PROVIDE fallback | ✅ startup .s / PROVIDE fallback | `patchLdStackSections` STD path |
| uVision STD — 有 scatter | ✅ startup .s / PROVIDE fallback | ✅ startup .s / PROVIDE fallback | `scatter2ld` STD template（PROVIDE in .stack section，與 no-scatter 完全一致） |
| uVision 49x — 無 scatter | ✅ `patchLdStackSections` 直接賦值 | ✅ `patchLdStackSections` 直接賦值 | `_FLASH.ld` → 改 `_estack` → patch → `patchLdStackSections` is49xStyle |
| uVision 49x — 有 scatter | ✅ `scatter2ld` 頂層強賦值 | ✅ `scatter2ld` section 後強賦值 | 49x startup 無 .heap/.stack section；LD `. +=` 分配 |
| HT32-IDE STD — FWLib .ld | ✅ startup .s / PROVIDE fallback | ✅ startup .s / PROVIDE fallback | `patchLdStackSections` STD path |
| HT32-IDE 49x — FWLib .ld | ✅ `patchLdStackSections` 直接賦值 | ✅ `patchLdStackSections` 直接賦值 | `is49xStyle` 注入 |
| Create Project 標準 | ✅ startup .s / PROVIDE fallback | ✅ startup .s / PROVIDE fallback | `patchLdStackSections` STD path |
| Create Project 49x | ✅ `patchLdStackSections` 直接賦值 | ✅ `patchLdStackSections` 直接賦值 | SPIM 保留 |
