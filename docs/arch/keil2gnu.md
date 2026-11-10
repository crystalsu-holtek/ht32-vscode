# keil2gnu 組語轉換

`keil2gnu()` 將 Keil armasm 語法的 `.s` 檔轉為 GNU assembler 語法。  
轉換流程：pre-process 行接續符（`\\\n`）→ 逐行解析指令 → 遞迴轉換 `INCLUDE` → `injectStartupInit()` 補齊 GNU 啟動序列（.data copy、.bss 清零、`__libc_init_array`）。  
輸出開頭固定加 `.syntax unified`（啟用 Thumb2 UAL 語法）。

## 指令對應

| Keil armasm | GNU as | 說明 |
|---|---|---|
| `;/* … */`、`; * …` | `/* … */`（去掉 `;`） | C block comment 行保留 `/* */` 格式 |
| `; comment` | `/* comment */` | 行首注解（與 template 風格一致） |
| `code ; comment` | `code /* comment */` | inline 行尾注解 |
| `name EQU value` | `.equ name, value` | 只發 `.equ`，不發 `#define`；條件組譯改用 `.if` 直接讀 `.equ` 值 |
| `AREA STACK, NOINIT, READWRITE` | `.section ".stack","aw",%nobits` + 完整 GCC 標籤 | 見「STACK/HEAP 完整 GCC 格式」 |
| `AREA HEAP, NOINIT, READWRITE` | `.section ".heap","aw",%nobits` + 完整 GCC 標籤 | 同上 |
| `AREA RESET, CODE/DATA, READONLY` | `.section .isr_vector,"a",%progbits` | Vector table 特例 |
| `AREA x, CODE, READONLY`（簡單名稱） | `.section .x,"ax",%progbits` | 具名可執行段 |
| `AREA x, CODE, READONLY`（`\|...\|`） | `.text` | 複雜名稱 fallback |
| `AREA x, DATA, READONLY`（簡單名稱） | `.section .x,"a",%progbits` | 具名唯讀段 |
| `AREA x, DATA, READONLY`（`\|...\|`） | `.section .rodata` | 複雜名稱 fallback |
| `AREA x, DATA, READWRITE` | `.data` | 可讀寫資料段 |
| `AREA x, NOINIT, READWRITE` | `.bss` | 其他未初始化資料段 |
| `AREA x, ..., ALIGN=n` | `.balign (1<<n)` | ALIGN=3 → `.balign 8` |
| `DCD val` | `.long val` | 32-bit 資料（原為 `.word`，改為 `.long` 與 template 一致） |
| `DCW val` | `.hword val` | 16-bit 資料 |
| `DCB val` | `.byte val` | 8-bit 資料 |
| `SPACE n` | `.if n > 0` / `.space n` / `.endif` | 保留 n bytes；`.if` guard 避免 n=0 時 GAS 警告 |
| `ALIGN` | `.balign 4` | 4-byte 對齊（無參數） |
| `ALIGN n` | `.balign n` | n-byte 對齊 |
| `PRESERVE8` | `.balign 8` | 8-byte stack 對齊提示 |
| `THUMB` | `.thumb` | 切換到 Thumb 指令集 |
| `EXPORT sym` | `.global sym` | 對外公開（`__Vectors` 自動 rename，見下） |
| `EXPORT sym [WEAK]` | `.weak sym` + `.global sym` | 弱符號 |
| `IMPORT sym` | `.extern sym` | 外部符號引用 |
| `PROC` | 移除（保留前面的 label） | 函式開始標記 |
| `ENDP` | 移除 | 函式結束標記 |
| `END` | 移除 | 檔案結束標記 |
| `INCLUDE file` | `.include "file_gcc.s"` | 引入另一個組語檔（遞迴轉換後存 `_gcc.s`） |
| `INCBIN file` | `.incbin "file"` | 嵌入二進位檔；`.axf.bin` 自動對應 sibling GCC 輸出 |

## 條件組譯

`:DEF:` 條件（與 `-D` flag 連動）仍用 C preprocessor，其他算術條件改用 GAS 指令。  
keil2gnu 以 `condStack: ('def' | 'if')[]` 追蹤 IF 嵌套型別，確保 ELIF/ELSE/ENDIF 與最近的 IF 配對：

| Keil armasm | 輸出（`condStack` top = `'def'`） | 輸出（`condStack` top = `'if'` 或空） |
|---|---|---|
| `IF :DEF:sym` | `#ifdef sym`（push `'def'`） | — |
| `IF :LNOT::DEF:sym` | `#ifndef sym`（push `'def'`） | — |
| `IF sym=val`（算術）| — | `.if sym == val`（push `'if'`） |
| `IF cond` | — | `.if cond`（push `'if'`） |
| `ELIF cond` | `#elif cond` | `.elseif cond` |
| `ELSE` | `#else` | `.else` |
| `ENDIF` | `#endif`（pop） | `.endif`（pop） |

> **切換原因**：`.equ` 值只在 GAS symbol table，C preprocessor 不認識 `.equ`，`#if .equ值` 永遠為 0；`.if` 直接讀 symbol table，行為正確。  
> **副作用**：移除所有 `#define` 重複輸出，`.equ` 單獨即可。  
> **condStack 設計**：Keil `:DEF:` 展開為 `#ifdef`（C preprocessor），算術條件展開為 `.if`（GAS）。兩者不可混用 ELSE/ENDIF，故以 stack 追蹤型別，讓 ELIF/ELSE/ENDIF 自動選擇正確指令。

## 運算子

| Keil armasm | GNU / C |
|---|---|
| `a:SHL:b` | `a << b` |
| `a:SHR:b` | `a >> b` |
| `a:OR:b` | `a \| b` |
| `a:AND:b` | `a & b` |
| `a:EOR:b` | `a ^ b` |
| `:NOT:a` | `~a` |
| `a<>b` | `a != b` |

---

## STACK / HEAP 完整 GCC 格式

Keil AREA STACK/HEAP 只有 `Stack_Mem SPACE Stack_Size` / `__initial_sp` 等 label。  
keil2gnu 轉換後輸出完整 GCC-style 格式（Stack Analysis 所需 label 全部在此注入）。

### AREA STACK → 輸出

```asm
    .section ".stack","aw",%nobits   ← aw,%nobits 必要（見「.stack/.heap 必要條件」）
    .align  3
    .globl  __StackTop
    .globl  __StackLimit
    .globl  __HT_check_sp
__HT_check_sp:
__StackLimit:
    .if     Stack_Size
    .space  Stack_Size
    .endif
    .size __StackLimit, . - __StackLimit
__StackTop:
    .size __StackTop, . - __StackTop
```

### AREA HEAP → 輸出

```asm
    .section ".heap","aw",%nobits
    .align  3
    .globl  __HeapBase
    .globl  _end
    .globl  __HeapLimit
    .globl  __HT_check_heap
__HT_check_heap:
__HeapBase:
_end:
    .if     Heap_Size
    .space  Heap_Size
    .endif
    .size __HeapBase, . - __HeapBase
__HeapLimit:
    .size __HeapLimit, . - __HeapLimit
```

### 跳過的 Keil label

下列 label 在 Keil 原始碼裡出現但在 GCC 格式不需要（或已被上方取代），keil2gnu 自動跳過：

`Stack_Mem`、`__initial_sp`、`__heap_base`、`Heap_Mem`、`__heap_limit`、`__HT_check_sp`（部分 FWLib 版本已有此 label）、`__HT_check_heap`

### `__initial_sp` 改名

| 位置 | 原 | 改 |
|------|----|----|
| DCD 操作數（向量表第一項） | `__initial_sp` | `__StackTop` |
| `IF USE_STACK_ON_TOP = 1` 內的 EQU 名稱 | `__initial_sp EQU 0x20000000 + …` | `.equ __StackTop, 0x20000000 + …` |

---

## Vector table 格式

| 項目 | Keil | keil2gnu 輸出 |
|------|------|--------------|
| 符號名稱 | `__Vectors` | `__interrupt_vector_cortex_m` |
| 型別 | （無） | `.type __interrupt_vector_cortex_m, %object` |
| `EXPORT __Vectors` | `.global __Vectors` | `.global __interrupt_vector_cortex_m` |
| 第一項 | `DCD __initial_sp` | `.long __StackTop` |
| 其餘項 | `DCD handler` | `.long handler` |

> `__interrupt_vector_cortex_m` 為 CMSIS 標準名稱。  
> `.type %object`（非 `%function`）：向量表是資料陣列，`injectStartupInit` Step 6 的 `%function` 注入會排除此 label。

---

## siData 參照 block

每個有 AREA STACK 的 startup 檔，keil2gnu 在 `.section ".stack"` 前注入：

```asm
/* start address for the initialization values of the .data section. defined in linker script */
    .word  _sidata
/* start address for the .data section. defined in linker script */
    .word  _sdata
/* end address for the .data section. defined in linker script */
    .word  _edata
/* start address for the .bss section. defined in linker script */
    .word  _sbss
/* end address for the .bss section. defined in linker script */
    .word  _ebss
```

這些 `.word` 在 `.text` section（AREA STACK 前尚無具名 section），確保 linker 一定解析這些符號。

---

## handleKeilAsm Rule 1：startup template 或 keil2gnu 的選擇

符合 `startup_xxx_NN[_suffix].s` 的檔案依以下優先順序決定輸出：

1. **有 `INCLUDE` 指令** → 強制走 `keil2gnu()` + `injectStartupInit()`  
   原因：template 只有 `patchStartupFromKeil`（同步 Stack/Heap 大小），無法保留 `INCLUDE`。
2. **無 `INCLUDE`，找到 FWLib GCC template** → `patchStartupFromKeil`（同步 Stack/Heap）
3. **無 `INCLUDE`，找到 bundled template** → `patchStartupFromKeil`（同步 Stack/Heap）
4. **找不到任何 template** → `keil2gnu()` + `injectStartupInit()`

> `keil2gnu` 路徑的輸出與 template 路徑的輸出格式一致（同樣有完整 GCC 標籤、`.long`、`.if` 等），但**內容**保留 Keil 原始碼的自訂內容（BootProcess、INCLUDE、自訂向量等）。

---

## startup `.stack`/`.heap` section 必要條件

**三個條件缺一不可**：
1. `.section ".stack","aw",%nobits`：`a` = SHF_ALLOC（沒有此 flag → section 不貢獻 output section 大小，`--print-memory-usage` 看不到 stack）；`%nobits` = SHT_NOBITS（沒有 → SHT_PROGBITS 把 stack 空間寫進 ELF，浪費 Flash LMA）
2. linker script 有 `KEEP(*(.stack))`：否則 `--gc-sections` 丟棄
3. linker script 有對應的 `.stack : { ... } >RAM` output section

**各路徑如何保證**：

| 路徑 | 如何產生 `"aw",%nobits` |
|------|------------------------|
| `keil2gnu()` AREA STACK/HEAP | 直接輸出 `"aw",%nobits` |
| `patchStartupFromKeil`（template 路徑） | template 為 `"w"`，`syncStackHeap()` patch 為 `"aw",%nobits` |
| `ht32ide2make.ts patchStartupFiles()` | HT32-IDE startup `"w"` → `"aw",%nobits` |
| `createProject.ts` | 複製 FWLib startup 後 patch `"w"` → `"aw",%nobits` |

> template 本身儲存的是 `"w"`（方便閱讀），runtime 才 patch 成最終形式。  
> keil2gnu 路徑不經過 patch，所以必須直接輸出最終形式 `"aw",%nobits`。

patch regex 統一格式：`/\.section\s+"\.stack"\s*,\s*"w"(?:\s*,\s*%nobits)?/g` → `'.section ".stack","aw",%nobits'`

---

## keil2gnu fallback — `injectStartupInit()` 補齊 GNU startup 序列

**Step 1 — 移除 Keil .bss Stack/Heap label**  
Keil startup 有 `Stack_Mem`/`__initial_sp`/`__heap_base`/`Heap_Mem`/`__heap_limit` 等 label。keil2gnu 已在 AREA STACK/HEAP 處理中跳過這些 label（輸出 GCC 標準 label 取代）。Step 1 作為安全網，移除任何殘留。

**Step 2 — 向量表第一項 `__initial_sp` → `__StackTop`**  
keil2gnu 在 DCD/EQU 處理時已將 `__initial_sp` 改名為 `__StackTop`，Step 2 作為安全網處理可能的殘留。  
（舊版曾改為 `_estack`；`_estack` 在 `USE_STACK_ON_TOP=0` 時未定義，為 bug，已修正。）

**Step 3 — 注入 .data / .bss 初始化 + SystemInit + `__libc_init_array`**  
Keil startup 的 Reset_Handler 直接呼叫 `SystemInit` → `main`，沒有 GNU 必要的啟動序列。注入順序比照 HT32-IDE GNU startup：
1. Copy `.data`（`_sidata` → `_sdata`..`_edata`，FLASH LMA → RAM VMA）
2. Zero-fill `.bss`（`_sbss`..`_ebss`）
3. Call `SystemInit`（若原本有的話）
4. Call `__libc_init_array`（C++ 靜態建構子）

> 重複注入防護：檢查 `LoopCopyDataInit` 是否已存在（原為 `_sdata`，但 keil2gnu 現在已 emit `.word _sdata`，改用 `LoopCopyDataInit` 避免誤判）。

**Step 4 — 移除 `__MICROLIB` block**  
Keil 的 `#ifdef __MICROLIB` 包含 `__user_initial_stackheap`，引用已移除的 Stack_Mem/Heap_Mem，在 GNU 會造成 undefined symbol 錯誤。

**Step 5 / Step 6 in code — `.type label, %function`**  
見下節 Vector table Thumb LSB。

**適用路徑**：僅 `handleKeilAsm` keil2gnu fallback（Rule 1 有 INCLUDE / 找不到 template；Rule 3 找不到同名 FWLib GCC startup）。FWLib 原生 GCC startup 和 HT32-IDE startup 已內建這些序列，不需要此步驟。

---

## Vector table Thumb LSB — keil2gnu fallback 須加 `.type %function`

**根本原因**：GNU assembler 的 `.thumb_func` 只放 `$t` mapping symbol，**不設 `STT_FUNC` 型別**。GNU linker 對 `R_ARM_ABS32` 只在 symbol 型別為 `STT_FUNC` 時才自動加 bit 0（Thumb interworking）。若型別為 NOTYPE，`.long Reset_Handler` 儲存偶數位址 → Cortex-M0+ 讀 reset vector 時 EPSR.T=0 → HardFault。

`injectStartupInit()` Step 6 在 `.text`/`.isr_vector` section 的每個 function label 前插入：

```typescript
if (inTextSection && /^\w[\w$]*:$/.test(t)) {
  const labelName = t.slice(0, -1);
  // __interrupt_vector_cortex_m 是資料 object，不加 %function
  if (labelName !== '__interrupt_vector_cortex_m') {
    final.push(`\t.type\t${labelName}, %function`);
    final.push('\t.thumb_func');
  }
}
```

> `__interrupt_vector_cortex_m` 本身由 keil2gnu 輸出 `.type …, %object`，injectStartupInit 不覆蓋。

**不受影響的路徑**（原始碼已含 `.type %function`）：
- Keil startup 符合 `startup_xxx_NN.s` → 使用 FWLib/bundled template
- HT32-IDE 轉換 → 使用 Holtek GCC `.S` 原始檔
- Create Project → FWLib/bundled template

**診斷方式**：
```bash
readelf -x .isr_vector HT32.elf   # offset 4 應為奇數 (e.g. b9 00 00 00)
readelf -s startup.o | grep Reset  # 應為 FUNC type，st_value 奇數
```
