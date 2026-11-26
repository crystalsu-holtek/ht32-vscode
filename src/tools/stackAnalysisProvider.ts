// src/tools/stackAnalysisProvider.ts
//
// Stack Usage Analysis panel — GCC/OpenOCD/VS Code equivalent of Keil's
// "View > Watch Window > HT32 Stack Usage Analysis".
//
// Principle:
//   1. __StackTop  (strong linker symbol) = ORIGIN(RAM)+LENGTH(RAM) = initial MSP
//   2. __HT_check_sp (from startup .s)   = bottom of the .stack section
//   3. StackUsageAnalysisInit() (if called) fills [__HT_check_sp, SP) with
//      0xCDCDCDCD (sentinel 0xABABABAB at bottom) — the "stack painting" technique.
//   4. This provider updates via DAP DebugAdapterTracker 'stopped' events, computes:
//        Used    = __StackTop - current_SP   (at each halt)
//        Max     = session peak (lowest SP seen), improved by paint watermark if present
//        MaxAddr = address of watermark / session-peak SP
//
// Works without painting (shows current + session-tracked max).
// With painting (HTCFG_STACK_USAGE_ANALYSIS=1) shows watermark-precise all-time max.
//
// Where the values come from — and why (IAP/AP-aware):
//   Both __StackTop and __HT_check_sp are ABS linker symbols. Reading them via GDB
//   (DAP evaluate, any context) uses var-create @ internally, which crashes the std
//   series (M0+/M3) GDB on ABS symbols. So neither is read via GDB.
//
//   __StackTop (End / initial MSP / top of RAM):
//     Primary  — ELF .symtab (read straight from session.configuration.executable).
//                Binds to the binary under debug, so it is correct for IAP/AP layouts
//                where the AP's vector table is NOT at the chip flash base, and it stays
//                consistent with __HT_check_sp (same ELF → Size never mixes two images).
//     Fallback — SCB->VTOR (0xE000ED08) → word 0 of the *active* vector table. VTOR
//                follows the running image's relocated table; every MCU we support is
//                Cortex-M0+ or above, so VTOR always exists. A fixed flash-base read is
//                deliberately NOT used: on an AP image it returns the IAP bootloader's
//                word 0 — the wrong image's stack top.
//
//   __HT_check_sp (Start / bottom of .stack): ELF .symtab only; no runtime equivalent.
//
//   $sp (current MSP): DAP evaluate context:'watch' — register expressions are safe on
//                all ARM architectures (only ABS-symbol var-create @ crashes M0+/M3).
//
//   ELF reads are cached per session (symbols don't change while debugging).

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const MAGIC_FILL     = 0xCDCDCDCD;
const MAGIC_SENTINEL = 0xABABABAB;
const WARN_PCT       = 80;   // highlight warning icon when used% >= this

interface StackStats {
  targetName:          string;          // ELF filename without extension
  stackTop:            number;          // __StackTop = initial MSP = top of RAM
  stackBottom:         number | null;   // __HT_check_sp = bottom of .stack section
  stackBottomMissing:  boolean;         // true when ELF was read but __HT_check_sp absent
  currentSP:           number;          // current $msp
  currentUsed:         number;          // __StackTop - currentSP
  sessionMax:          number;          // session peak used (lowest MSP ever seen)
  sessionMaxAddr:      number;          // MSP address at session peak
  paintMax:            number | null;   // watermark-based max (if HTCFG_STACK_USAGE_ANALYSIS=1)
  paintAddr:           number | null;   // watermark address (lowest non-magic word)
}

class StackItem extends vscode.TreeItem {
  constructor(label: string, value: string, warn = false) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    if (warn) {
      this.iconPath = new vscode.ThemeIcon(
        'warning',
        new vscode.ThemeColor('list.warningForeground'),
      );
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse a numeric address from a GDB evaluate response.
 * Handles:
 *   context:'watch'  → "536875008", "0x20001200", "0x20001200 <__StackTop>"
 *   context:'repl'   → "$1 = 536875008", "$1 = 0x20001200" (interpreter-exec console output)
 */
function parseAddr(result: string | undefined): number | null {
  if (!result) { return null; }
  // Optional "$N = " prefix from GDB console output, then hex or decimal
  const m = result.match(/(?:=\s*)?(0x[0-9a-fA-F]+|\d+)/);
  if (!m) { return null; }
  const v = parseInt(m[1], m[1].startsWith('0x') ? 16 : 10);
  return isNaN(v) ? null : v;
}

/**
 * Read an ABS symbol value from an ELF32 LE file (.symtab section).
 * Returns null if the file cannot be read or the symbol is not found.
 * Debug ELFs always have .symtab; stripped release binaries would not be debugged.
 */
function elfSymbolValue(elfPath: string, symbol: string): number | null {
  try {
    const b = fs.readFileSync(elfPath);
    // ELF32 LE: magic 0x7f 'E' 'L' 'F', class=1 (32-bit), data=1 (LE)
    if (b.length < 52 ||
        b[0] !== 0x7f || b[1] !== 0x45 || b[2] !== 0x4c || b[3] !== 0x46 ||
        b[4] !== 1    || b[5] !== 1) { return null; }

    const u16 = (o: number) => b.readUInt16LE(o);
    const u32 = (o: number) => b.readUInt32LE(o);
    const cstr = (o: number): string => {
      let e = o; while (e < b.length && b[e] !== 0) { e++; }
      return b.subarray(o, e).toString('ascii');
    };

    const shOff  = u32(32);          // e_shoff
    const shEnt  = u16(46);          // e_shentsize
    const shNum  = u16(48);          // e_shnum

    // Find .symtab section (sh_type = SHT_SYMTAB = 2)
    let symOff = 0, symSize = 0, symEnt = 0, strIdx = 0;
    for (let i = 0; i < shNum; i++) {
      const sh = shOff + i * shEnt;
      if (u32(sh + 4) === 2) {          // SHT_SYMTAB
        symOff  = u32(sh + 16);         // sh_offset
        symSize = u32(sh + 20);         // sh_size
        strIdx  = u32(sh + 24);         // sh_link → associated .strtab index
        symEnt  = u32(sh + 36);         // sh_entsize (Elf32_Sym = 16 bytes)
        break;
      }
    }
    if (!symOff || !symEnt) { return null; }

    // String table base offset
    const strOff = u32(shOff + strIdx * shEnt + 16);

    // Scan symbol table for target name
    for (let o = 0; o < symSize; o += symEnt) {
      if (cstr(strOff + u32(symOff + o)) === symbol) {
        return u32(symOff + o + 4) >>> 0;   // st_value
      }
    }
    return null;
  } catch { return null; }
}


// ── Provider ──────────────────────────────────────────────────────────────────

export class StackAnalysisProvider implements vscode.TreeDataProvider<StackItem> {
  private _change = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._change.event;

  private stats: StackStats | null = null;
  private sessionMaxUsed = 0;
  private sessionMaxAddr = 0;
  /** Cached symbols from ELF. undefined = not yet read; null = not found. */
  private elfStackTop:    number | null | undefined = undefined;
  private elfStackBottom: number | null | undefined = undefined;

  constructor(ctx: vscode.ExtensionContext) {
    ctx.subscriptions.push(
      vscode.debug.onDidStartDebugSession(() => this.onSessionStart()),
      vscode.debug.onDidTerminateDebugSession(() => this.onSessionEnd()),
    );
    // Already in debug when extension activates (e.g., window reload mid-session)
    if (vscode.debug.activeDebugSession) {
      this.onSessionStart();
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  private onSessionStart() {
    this.sessionMaxUsed = 0;
    this.sessionMaxAddr = 0;
    this.elfStackTop    = undefined;
    this.elfStackBottom = undefined;
    this.stats = null;
    this._change.fire();
    // Do NOT poll here — target is still running. Poll is driven entirely by
    // DebugAdapterTracker 'stopped' events (breakpoint, halt, step, etc.).
  }

  private onSessionEnd() {
    this.stats = null;
    this._change.fire();
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /** Resolve session.configuration.executable, expanding ${workspaceFolder}. */
  private resolveElfPath(session: vscode.DebugSession): string | undefined {
    const elfRaw = session.configuration?.executable as string | undefined;
    return elfRaw?.replace(
      /\$\{workspaceFolder\}/g,
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
    );
  }

  /**
   * Fallback for __StackTop: word 0 (initial MSP) of the *active* vector table.
   * SCB->VTOR (0xE000ED08) holds the current vector-table base; for IAP/AP the AP sets
   * VTOR to its own table, so this returns the running image's stack top (a fixed
   * flash-base read would return the IAP bootloader's instead). All supported MCUs are
   * Cortex-M0+ or above, so VTOR always exists.
   */
  private async readStackTopViaVtor(session: vscode.DebugSession): Promise<number | null> {
    try {
      const vtorRes = await session.customRequest('readMemory', {
        memoryReference: '0xE000ED08', count: 4,
      });
      const vtorBuf = vtorRes?.data ? Buffer.from(vtorRes.data as string, 'base64') : null;
      if (!vtorBuf || vtorBuf.length < 4) { return null; }
      const vtBase = vtorBuf.readUInt32LE(0) >>> 0;

      const w0Res = await session.customRequest('readMemory', {
        memoryReference: `0x${vtBase.toString(16)}`, count: 4,
      });
      const w0Buf = w0Res?.data ? Buffer.from(w0Res.data as string, 'base64') : null;
      if (!w0Buf || w0Buf.length < 4) { return null; }
      const top = w0Buf.readUInt32LE(0) >>> 0;
      // Sanity: must look like a valid RAM address (0x2xxxxxxx range)
      return (top >>> 28) === 0x2 ? top : null;
    } catch {
      return null;
    }
  }

  // ── data read (triggered by DebugAdapterTracker 'stopped' event) ──────────

  async poll() {
    const session = vscode.debug.activeDebugSession;
    if (!session) { return; }

    try {
      const elfPath = this.resolveElfPath(session);

      // ① __StackTop (End / initial MSP / top of RAM).
      //   Primary: ELF .symtab — binds to the binary under debug, so it is correct for
      //   IAP/AP (the AP's vector table is not at the chip flash base) and stays consistent
      //   with __HT_check_sp below (both from the same ELF, so Size never mixes images).
      //   Fallback: SCB->VTOR → word 0 of the active vector table (see readStackTopViaVtor).
      if (this.elfStackTop === undefined) {
        this.elfStackTop = elfPath ? elfSymbolValue(elfPath, '__StackTop') : null;
      }
      let stackTop: number | null =
        (this.elfStackTop !== null && (this.elfStackTop >>> 28) === 0x2) ? this.elfStackTop : null;

      if (!stackTop) {
        stackTop = await this.readStackTopViaVtor(session);
      }

      if (!stackTop) { return; }

      // ② MSP (Main Stack Pointer) — always use $msp so FreeRTOS task context
      //   (where $sp is PSP) still yields the correct interrupt/OS kernel stack.
      //   In single-thread projects $msp == $sp; no behavior change.
      //   context:'watch' (GDB var-create @) is safe for register expressions
      //   on all ARM architectures including M0+.
      const spRes = await session.customRequest('evaluate', {
        expression: '(unsigned int)$msp',
        context: 'watch',
      });
      const currentSP = parseAddr(spRes?.result);
      if (!currentSP || currentSP > stackTop) { return; }

      const currentUsed = stackTop - currentSP;

      // Update session peak
      if (currentUsed > this.sessionMaxUsed) {
        this.sessionMaxUsed = currentUsed;
        this.sessionMaxAddr = currentSP;
      }

      // ③ __HT_check_sp — ABS linker symbol; ALL DAP evaluate contexts in cortex-debug
      //   use var-create @ internally, which crashes std series (M0+/M3) GDB on ABS
      //   symbols.  Read from ELF symbol table instead — no GDB interaction at all.
      //   Result cached per session (symbol doesn't change while debugging).
      let stackBottom: number | null = null;
      if (this.elfStackBottom === undefined) {
        this.elfStackBottom = elfPath ? elfSymbolValue(elfPath, '__HT_check_sp') : null;
      }
      if (this.elfStackBottom !== null &&
          this.elfStackBottom < currentSP &&
          (stackTop - this.elfStackBottom) <= 2 * 1024 * 1024) {
        stackBottom = this.elfStackBottom;
      }

      // ⑥ Scan for paint watermark (enabled by HTCFG_STACK_USAGE_ANALYSIS=1)
      let paintMax: number | null = null;
      let paintAddr: number | null = null;

      if (stackBottom !== null) {
        const scanBytes = currentSP - stackBottom;
        if (scanBytes > 0 && scanBytes <= 256 * 1024) {
          try {
            const memRes = await session.customRequest('readMemory', {
              memoryReference: `0x${stackBottom.toString(16)}`,
              count: scanBytes,
            });
            if (memRes?.data) {
              const buf = Buffer.from(memRes.data as string, 'base64');
              // Sentinel must be present at bottom — confirms StackUsageAnalysisInit() ran.
              // Without it, memory is uninitialized and would falsely report 100% max.
              const hasSentinel = buf.length >= 4 &&
                                  (buf.readUInt32LE(0) >>> 0) === MAGIC_SENTINEL;
              if (hasSentinel) {
                // Scan upward from after sentinel: first non-magic word = watermark
                for (let i = 4; i + 3 < buf.length; i += 4) {
                  const val = buf.readUInt32LE(i) >>> 0;
                  if (val !== MAGIC_FILL) {
                    paintAddr = stackBottom + i;
                    paintMax  = stackTop - paintAddr;
                    break;
                  }
                }
              }
            }
          } catch { /* readMemory not supported by this debug adapter */ }
        }
      }

      const targetName = elfPath ? path.basename(elfPath, path.extname(elfPath)) : '';
      // elfStackBottom===null means ELF was read but __HT_check_sp not found (symbol missing)
      const stackBottomMissing = elfPath !== undefined && this.elfStackBottom === null;

      this.stats = {
        targetName,
        stackTop, stackBottom, stackBottomMissing,
        currentSP, currentUsed,
        sessionMax: this.sessionMaxUsed,
        sessionMaxAddr: this.sessionMaxAddr,
        paintMax, paintAddr,
      };
      this._change.fire();

    } catch {
      // Target running, or symbols not yet available — keep last known stats
    }
  }

  // ── TreeDataProvider ──────────────────────────────────────────────────────

  getTreeItem(el: StackItem): vscode.TreeItem { return el; }

  getChildren(): StackItem[] {
    if (!this.stats) {
      const label = vscode.debug.activeDebugSession
        ? vscode.l10n.t('Initializing...')
        : vscode.l10n.t('Start a debug session');
      return [new StackItem(label, '')];
    }

    const s = this.stats;
    const hex8 = (n: number) => `0x${n.toString(16).toUpperCase().padStart(8, '0')}`;

    const size    = s.stackBottom !== null ? (s.stackTop - s.stackBottom) : null;
    const pctStr  = (used: number) => size ? `${Math.round(used * 100 / size)}% [${used}]` : `[${used}]`;
    const usedPct = size ? Math.round(s.currentUsed * 100 / size) : 0;

    const items: StackItem[] = [];

    if (s.targetName) {
      items.push(new StackItem(vscode.l10n.t('Target'), s.targetName));
    }

    items.push(new StackItem(vscode.l10n.t('Stack Top Addr (Start)'), hex8(s.stackTop)));

    if (s.stackBottom !== null && size !== null) {
      items.push(new StackItem(vscode.l10n.t('Stack Bottom Addr (End/Limit)'), hex8(s.stackBottom)));
      items.push(new StackItem(vscode.l10n.t('Stack Size'),                    `${hex8(size)} [${size}]`));
    } else if (s.stackBottomMissing) {
      items.push(new StackItem(vscode.l10n.t('Stack Bottom Addr (End/Limit)'), vscode.l10n.t('[__HT_check_sp missing]'), true));
    }

    items.push(new StackItem(vscode.l10n.t('Current Usage'), pctStr(s.currentUsed), usedPct >= WARN_PCT));

    if (s.paintMax !== null) {
      const maxUsed = Math.max(s.paintMax, s.sessionMax);
      const maxAddr = (s.paintMax > s.sessionMax) ? s.paintAddr! : s.sessionMaxAddr;
      const maxPct  = size ? Math.round(maxUsed * 100 / size) : 0;
      items.push(new StackItem(vscode.l10n.t('Peak Usage'), pctStr(maxUsed), maxPct >= WARN_PCT));
      items.push(new StackItem(vscode.l10n.t('Peak Addr'),  hex8(maxAddr)));
    } else if (s.stackBottomMissing) {
      items.push(new StackItem(vscode.l10n.t('Peak Usage'), vscode.l10n.t('[__HT_check_sp missing]'), true));
    } else if (s.stackBottom !== null) {
      items.push(new StackItem(vscode.l10n.t('Peak Usage'),                         '', true));
      items.push(new StackItem(vscode.l10n.t('call StackUsageAnalysisInit(0)'),      ''));
      items.push(new StackItem(vscode.l10n.t('HTCFG_STACK_USAGE_ANALYSIS must be 1'), ''));
    }

    return items;
  }

  refresh() { this.poll(); }
}

// ── DebugAdapterTrackerFactory ────────────────────────────────────────────────
// Intercepts all DAP messages.  When the target halts ('stopped' event),
// immediately refreshes the stack analysis panel.  This replaces timer-based
// polling: the panel updates exactly at each pause (breakpoint, halt, step).

export class StackAnalysisTrackerFactory implements vscode.DebugAdapterTrackerFactory {
  constructor(private readonly provider: StackAnalysisProvider) {}

  createDebugAdapterTracker(_session: vscode.DebugSession): vscode.DebugAdapterTracker {
    return {
      onDidSendMessage: (msg: any) => {
        // DAP 'stopped' event fires whenever the target halts for any reason
        // (breakpoint, step, halt button, fault, etc.)
        if (msg?.type === 'event' && msg?.event === 'stopped') {
          this.provider.refresh();
        }
      },
    };
  }
}
