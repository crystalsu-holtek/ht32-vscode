# STACK USAGE 面板

HT32 sidebar 的 **STACK USAGE** 面板顯示 MSP stack 的即時與歷史使用量。

## 資料來源（三個）

| 符號 / 來源 | 讀取方式 | 說明 |
|------------|---------|------|
| `$sp`（目前 MSP） | DAP evaluate `context:'watch'`（讀暫存器） | 當前 stack pointer，計算 `currentUsed = stackTop - $sp` |
| `__StackTop`（End） | **主**：ELF `.symtab`；**備援**：SCB->VTOR → 向量表 word 0 | stack 頂端 = 初始 MSP = RAM 頂端（linker script 匯出） |
| `__HT_check_sp`（Start） | ELF `.symtab` | stack 底端（linker script：`__StackTop - SIZEOF(.stack)`） |

> 兩個靜態邊界（`__StackTop` / `__HT_check_sp`）都從**正在 debug 的同一個 ELF** 讀，只有 `$sp` 是動態讀。理由與 IAP/AP 影響見下節「MSP / 向量表 word 0 / VTOR 的關係」。ELF 讀取結果在 session 內快取。

## 顯示欄位

| 欄位 | 說明 |
|------|------|
| Target | ELF 檔名（basename，不含副檔名）——從 `session.configuration.executable` 取得 |
| Stack Top Addr (Start) | `__StackTop`（stack 頂端 = 初始 MSP） |
| Stack Bottom Addr (End/Limit) | `__HT_check_sp`（stack 底端）；符號缺失時顯示 `[__HT_check_sp missing]` |
| Stack Size | `stackTop - stackBottom` |
| Current Usage | 目前使用量（`stackTop - $sp`） |
| Peak Usage | session 峰值或 watermark 峰值，取較大者；若未呼叫 `StackUsageAnalysisInit()` 顯示提示 |
| Session Peak SP | session 峰值對應的 SP 位址 |
| Watermark Max | watermark 精確峰值（需 `HTCFG_STACK_USAGE_ANALYSIS=1`） |
| Watermark Addr | watermark 對應 SP 位址 |

`sessionMax`：debug session 期間每次 halt 時追蹤的最低 MSP（`DebugAdapterTrackerFactory` 攔截 `stopped` 事件）。

## 警告圖示（三角形 `!`）觸發條件

`WARN_PCT = 80`（`src/tools/stackAnalysisProvider.ts:48`）

| 顯示位置 | 條件 | 說明 |
|---|---|---|
| Current Usage | `usedPct >= 80%` | 真正的使用率警告 |
| Peak Usage（painting 啟用） | `maxPct >= 80%` | watermark 算出的使用率 |
| Peak Usage（painting 未啟用） | **永遠顯示** | `paintMax === null` 且 `stackBottom` 有值，固定出現，提示呼叫 `StackUsageAnalysisInit()` |
| Stack Bottom / Peak | `__HT_check_sp` 缺失 | ELF 裡找不到符號 |

**判斷時間點**：每次 DAP `stopped` 事件（breakpoint / step / halt / exception）都重新計算並更新 TreeView。

**程式剛啟動**：停在第一個 breakpoint 時 `StackUsageAnalysisInit()` 尚未執行 → `paintMax === null` → Peak Usage 無條件顯示 `!`。這是**提示訊息**（提醒啟用 painting），不是真正的 stack 溢位警告。啟用 painting 並執行過 `StackUsageAnalysisInit()` 後再停下，`!` 改為依 `maxPct >= 80%` 判斷。

## Watermark 機制（`HTCFG_STACK_USAGE_ANALYSIS=1`）

使用者在 `main()` 最前面呼叫 `StackUsageAnalysisInit(0)`（由 bundled `templates/GNU_ARM/ht32_stack_analysis.c` 提供）：

```c
p    = (volatile u32 *)(&__HT_check_sp);
*p++ = 0xABABABAB;   // sentinel（標記 paint 已執行）
while (p < sp_val)
    *p++ = 0xCDCDCDCD; // magic fill（未被覆蓋 = stack 未用到此處）
```

面板讀取 `[__HT_check_sp, MSP)` 記憶體（DAP `readMemory`），掃描流程：

1. **先確認 sentinel**：`buf[0] == 0xABABABAB` → paint 已執行，才信任掃描結果；否則 `paintMax = null`（不顯示 Paint 欄位）
2. **從 sentinel 後掃描**（index 4 起）：找第一個 `≠ 0xCDCDCDCD` 的字 → `paintAddr`（stack 曾到達的最低位址）
3. `paintMax = stackTop - paintAddr`

**必要條件**：`__HT_check_sp` 需由 linker script 匯出。所有轉換路徑均透過 `patchLdStackSections()`（`uv2make.ts`）補齊此 symbol（詳見 [linker-startup.md](linker-startup.md)）。

## Max 選擇邏輯

```
maxUsed = max(sessionMax, paintMax ?? 0)
maxAddr = paintMax > sessionMax ? paintAddr : sessionMaxAddr
```

Paint watermark 比 session peak 更準確（涵蓋 debug session 開始前的啟動期間），優先使用。

## 關鍵設計決策

- **Sentinel 必須先驗證**：若 `StackUsageAnalysisInit()` 未呼叫，stack 底部是未初始化記憶體，第一個字必然不是 magic → 誤判 paintAddr = stackBottom → Max 100%。加 sentinel 檢查後，沒有 paint 就不顯示 Paint，Max 退回 sessionMax。
- **`__attribute__((noinline))`**：確保 `StackUsageAnalysisInit` 有自己的 stack frame，`mov %0, sp` 捕捉的 SP 反映 caller context，paint 不會覆蓋自己的 frame。
- **`addr` 參數的意義**：FWLib header 宣告為 `void StackUsageAnalysisInit(u32 addr)`，`addr` 是 **Keil 版本專用**，傳入 vector table 起始位址（std series = `0x00000000`，49x = `0x08000000`）。Keil 的組語實作從 `[addr]`（vector table word 0）讀出 initial MSP，存入 Watch Window 用的固定位址變數 `_StackLimit`。GCC 版本（`ht32_stack_analysis.c`）直接使用 linker symbol `__StackTop`，**不需要此參數**，實作中直接 `(void)addr` 忽略。使用者呼叫時傳 `0` 即可。

## DAP evaluate context — ABS linker symbol 在 M0+ 造成 GDB crash

`poll()` 透過 `session.customRequest('evaluate', { context: '...' })` 取得各符號值。

| context | GDB 內部指令 | std 系列（M0+/M3） | 49x（M4） |
|---------|-------------|-------------------|----------|
| `'watch'` | `var-create @ "<expr>"` | ABS symbol → **GDB crash（exit 3）** | 正常 |
| `'repl'` | `interpreter-exec console "<expr>"` | 不 crash，但純 expression 回傳 "Undefined command" | 同左 |

**根本原因**：`context: 'watch'` 讓 cortex-debug 用 `var-create @` 建立 floating watch 物件。對於 **ABS linker symbol**（`__StackTop = ORIGIN(RAM)+LENGTH(RAM)`、`__HT_check_sp = __StackTop - SIZEOF(.stack)`），這些符號只有數值、沒有記憶體位址；`p/x __StackTop` 正常，但 `var-create @ "(unsigned int)&__StackTop"` 在 std 系列（M0+/M3）GDB port 的 type resolution / memory inspection 路徑上 crash。49x（M4）碰到同樣情況僥倖成功，不受影響。

**症狀**：debug session 開始 → `stopped` 事件 → `poll()` → `var-create` crash → `GDB session ended unexpectedly. exit-code: 3`。看起來像「下載成功但 debug 無法啟動」，容易誤以為是 task/launch 設定問題（10054 socket reset）。

**最終修正方案**（各符號分別處理）：

| 符號 | 方法 | 說明 |
|------|------|------|
| `__StackTop` | **主**：ELF `.symtab`（`elfSymbolValue`）；**備援**：`readMemory` 讀 SCB->VTOR → 向量表 word 0 | 綁定正在 debug 的 binary，IAP/AP 安全；備援用 VTOR 取得**現行**向量表 base（非寫死 flash base） |
| `__HT_check_sp` | ELF `.symtab`（`elfSymbolValue`） | ABS symbol，所有架構直接讀 ELF，不經 GDB；session 內快取 |
| `$sp` | DAP evaluate `context: 'watch'` | register expression，所有架構安全 |

> **歷史**：早期 `__HT_check_sp` 在 std 系列直接 skip（不顯示 Start/Size），`__StackTop` 用 `readMemory` 讀**寫死 flash base** 的 word 0。後者在 IAP/AP 架構會讀錯（見下），故兩者皆改為以 ELF 為主。

## MSP / 向量表 word 0 / VTOR 的關係（以及為何 IAP/AP 必須讀 ELF）

三者是「同一個值在不同階段、不同地方的樣子」：

| | 是什麼 | 位置 |
|---|---|---|
| **word 0** | 向量表第 0 個 entry = 該映像的**初始 MSP**（word 1 = 初始 PC = reset handler） | 向量表 base + 0x0 |
| **VTOR** | Vector Table Offset Register，指出「現行向量表在哪」 | 固定暫存器 `0xE000ED08` |
| **MSP** | Main Stack Pointer，CPU 當下實際的堆疊指標（`$sp`） | core register |

- **Reset 當下**：硬體從**固定 boot 位址**（std = `0x0`、49x = `0x08000000`，由晶片 memory map 決定，**不是 VTOR**）載入 `MSP ← [boot_base+0]`（word 0）、`PC ← [boot_base+4]`。此刻 VTOR 還是 0，所以 `word 0 = 初始 MSP`，而 `__StackTop` 就是被放進 word 0 的值。
- **VTOR 的作用**：只決定「之後中斷/例外去哪張表抓 handler」，**不會**重新載入 MSP。

**IAP/AP 的影響**：對 AP 專案，AP 的 code flash（含向量表）在 **offset**（非晶片 flash base），`0x0` 放的是 IAP bootloader 的向量表。bootloader 用**軟體**把 `MSP` 設成 AP 的 word 0、`VTOR = AP_base`、跳進 AP。因此：

| 讀法 | 拿到什麼 | IAP/AP 正確？ |
|---|---|---|
| `[寫死 flash base + 0]`（舊作法） | **boot 表** word 0 = IAP 的初始 MSP | ❌ AP 時讀到 bootloader 的 |
| `[VTOR + 0]` | **現行表** word 0 = AP 的初始 MSP | ✅（備援用此） |
| ELF `__StackTop` | linker 給該 binary 的初始 MSP | ✅（主，且不需 target/VTOR） |

舊作法的 bug：對 AP 專案，`stackTop` 來自 IAP 向量表、`stackBottom`（`__HT_check_sp`）卻來自 AP 的 ELF，兩個邊界**來自不同 binary** → `Size`/`Used` 失準，且 `0x2xxxxxxx` sanity check 照樣通過 → **靜默錯誤**。改 ELF 為主後兩個邊界保證同源。

> 本專案支援的 MCU 全為 Cortex-M0+ 以上（皆有 VTOR），故不需處理 M0 無 VTOR 的情況；ELF 為主、VTOR 為備援即足夠。

## 舊版 FWLib 相容性修正（source patch）

### 問題

`ht32_cm*_misc.c` 在 **`@date ≤ 2025-12-02`** 的舊版 FWLib 中，GCC 路徑的 `StackUsageAnalysisInit` 使用 `__ASM volatile` 內嵌組語時有 label 重複定義等問題，導致 link 時行為不正確。

Extension 自帶的 `templates/GNU_ARM/ht32_stack_analysis.c` 提供正確實作：

```c
__attribute__((weak, noinline)) void StackUsageAnalysisInit(u32 addr) { ... }
```

但 `weak` 只在對手也是 `weak` 時 linker 才會捨棄它；misc.c 提供的是 **strong** symbol，linker 永遠選 misc.c 的壞版本。

### 解決方案：source patch（`weak` 互換）

`refreshDerivedFiles` 偵測到舊版 misc.c 時，直接修改兩個 source 檔：

| 檔案 | 修改前 | 修改後 |
|------|--------|--------|
| user project 的 misc.c | `__attribute__((noinline)) void StackUsageAnalysisInit` | `__attribute__((weak, noinline)) void StackUsageAnalysisInit` |
| user project 的 ht32_stack_analysis.c | `__attribute__((weak, noinline)) void StackUsageAnalysisInit` | `__attribute__((noinline)) void StackUsageAnalysisInit` |

結果：misc.c 變 weak、ht32_stack_analysis.c 變 strong → linker 選 ht32_stack_analysis.c ✓。clangd 同樣看到 strong symbol 在 ht32_stack_analysis.c，F12 跳到正確檔案 ✓。

**升級 FWLib 後**（舊 misc.c 換成新版）：`refreshDerivedFiles` 偵測到 misc.c 日期 > 2025-12-02，自動將 ht32_stack_analysis.c 還原為 `weak`，防止 duplicate strong symbol linker error。

> 不修改 `templates/GNU_ARM/ht32_stack_analysis.c`（bundled template），只修改 user project 下的副本。

### 相關函式（`uv2make.ts`）

| 函式 | 用途 |
|------|------|
| `miscCNeedsRedefine(absPath)` | 偵測舊版 misc.c（`@date ≤ 2025-12-02`） |
| `patchMiscCWeak(absPath)` | misc.c 加 `weak`（idempotent） |
| `ensureStackAnalysisStrong(absPath)` | ht32_stack_analysis.c 移除 `weak`（idempotent） |
| `ensureStackAnalysisWeak(absPath)` | ht32_stack_analysis.c 還原 `weak`（idempotent） |

### 偵測邏輯（`miscCNeedsRedefine`）

```typescript
export function miscCNeedsRedefine(absPath: string): boolean {
  if (!/ht32_cm[0-9a-z+]*_misc\.c$/i.test(absPath)) { return false; }
  const head = fs.readFileSync(absPath, { encoding: 'utf8' }).slice(0, 1024);
  const m = head.match(/@date\s+\$Date::\s*(\d{4}-\d{2}-\d{2})/);
  return !!m && m[1] <= '2025-12-02';
}
```

每次 `refreshDerivedFiles` 即時讀取，不儲存到 `project.meta.json`。

### 涵蓋路徑

均透過 `refreshDerivedFiles`：
- uVision / HT32-IDE / Create Project 轉換後，`persistMeta` → `refreshDerivedFiles`
- Open Project → `initProjectsFromMeta` → `refreshDerivedFiles`（mtime check 後）
- TreeView 操作（加入/移除 group/file、toggle xo…）→ `persistMeta` → `refreshDerivedFiles`
- Settings Save / `generateTasksAndLaunchAndMakefile` → `regenAllMakefileFlags` → `refreshDerivedFiles`（`skipElfInvalidation: true`）

### `.needs-rebuild` 機制

`refreshDerivedFiles` 比較舊 rules section 與新 rules section。若有差異（`-mpure-code` 等 per-file flag 變動），寫入 `buildGenDir/.needs-rebuild`，下次 Build 前強制 clean rebuild。

> source patch（`weak` 互換）直接修改 `.c` 檔，make 自動偵測 source 變更並重新編譯，不依賴 `.needs-rebuild`。

## 未呼叫 `StackUsageAnalysisInit()` 時的行為

Stack analysis 分兩層，`StackUsageAnalysisInit()` 只影響第二層：

**第一層（永遠有效）**
- `Used` = `__StackTop - $sp`，每次 halt 即時計算
- `Max` = debug session 內追蹤到的 `sessionMax`（記錄最低 SP）

**第二層（需要 `StackUsageAnalysisInit()`）**
- 函式在啟動時把 `[__HT_check_sp, SP)` 填成 `0xCDCDCDCD`，底部放 sentinel `0xABABABAB`
- `poll()` 掃描此區段，找第一個非 magic 字 = 歷史最深 SP（`paintAddr`）
- `paintMax = __StackTop - paintAddr`，涵蓋 debug session 開始**前**的啟動期間

未呼叫時：`paintMax = null`，不顯示 `Paint: watermark active`，`Max` 退回 `sessionMax`。`sessionMax` 只反映「debugger 已連接後」的峰值，若程式在接 debugger 前已深度使用 stack，這段峰值不會被記錄。
