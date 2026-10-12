# Create Project — 索引

`src/tools/createProject.ts` — 從 FWLib template 建立新的 GNU ARM 專案。

---

## 入口

```
HT32: Create Project（ht32.createProject）
  └─ openCreateProjectPanel()     ← Webview wizard UI
       └─ onGenerate callback
            └─ generateProjectFiles()   ← 主要產生邏輯
                 └─ generateTasksAndLaunchAndMakefile()  ← 寫 tasks.json / launch.json
```

---

## Wizard 流程

1. 選 FWLib Root → `detectFwlibSeries()` 判斷系列（std-5xxxx / std-4xxxx / std-1xxxx / 49x-490/491/493）；判斷邏輯先看目錄名稱，再掃 `library/HT32*xxxx_Driver/` 是否存在，不依賴 `project_template/`
2. 列出 MCU 選單：
   - 標準系列 → `listStdMcus()`：掃 `project_template/IP/Example/GNU_ARM/*.mk`，每個 `.mk` 一個 chip；**`project_template/` 不存在時 fallback 到 bundled `templates/{familyTag}/GNU_ARM/*.mk`**
   - 49x 系列 → `list49xMcus()`：掃 `libraries/cmsis/.../startup/gcc/linker/*_FLASH.ld`，再掃 device header 取得封裝選項
3. 填寫 Project Name / Project Folder / Output Type
4. Generate → `generateProjectFiles()`

---

## 產出目錄結構

```
{projectFolder}/
└── HT32_VSCode/
    └── {projectName}/          ← bgDir
        ├── GNU_ARM/
        │   ├── startup_*.s     ← 複製自 FWLib + patch
        │   ├── linker.ld       ← 複製自 FWLib + patch
        │   └── ht32_stack_analysis.c
        ├── src/                ← 使用者可編輯的源碼
        │   ├── main.c
        │   ├── *_it.c / *_int.c
        │   ├── system_*.c
        │   └── conf.h / ...
        ├── Makefile
        ├── sources.list
        ├── includes.list
        ├── defines.list
        ├── adefines.list
        ├── compile_commands.json
        ├── project.meta.json
        └── project.settings.json
```

---

## 各系列依賴來源

> 詳細的逐檔清單（startup / linker / driver / system / conf.h / board support / syscalls）  
> → **[fwlib-deps.md — Create Project 節](fwlib-deps.md#create-project)**

---

## `.mk` 的角色（標準系列）

標準系列以 `parseMkFile()` 讀 `{chipSuffix}.mk`，作為 driver 清單、startup 檔名、define、htChipNum 的唯一依據。  
→ **[fwlib-deps.md — .mk 檔的角色](fwlib-deps.md#mk-檔的角色標準系列)**

**.mk 檔不含 group 資訊。** driver 清單以 `$(HT32_LIB_PATH)xxx.c` 條目打平列出，沒有分組標記。  
因此 TreeView 的 group 分配（User / Config / CMSIS / Library / Utilities）是 `generateProjectFiles()` 裡的 hardcoded 邏輯，以 filename pattern 判斷：

| Group | 分配邏輯 |
|-------|---------|
| User | `copiedUserSrcs`（main.c / *_it.c 等），排除 Config set |
| Config | `ht32_op.c` + `confHFile`（ht32fXxxxx_conf.h）+ `usbdConfHFile` |
| CMSIS | `systemFileForMeta`（system_ht32*.c）+ startup .s |
| Library | 其餘 `fwlibSrcs`（driver .c，含 ht32_retarget.c / ht32_serial.c）|
| Utilities | `fwlibSrcs` 中路徑以 `utilities/` 開頭者 |

已知問題（待修）：
- startup .s 應放 GNU_ARM group，目前誤放在 CMSIS
- ht32_retarget.c / ht32_serial.c 應放 Retarget group，目前在 Library
- ht32_board_config.h 已複製至 src/ 但未加入 Config group

---

## startup .s 與 linker.ld patch

複製後套用以下 patch：

- `"w"` → `"aw",%nobits`（SHF_ALLOC，讓 `--print-memory-usage` 計入 RAM）
- `Heap_Size = 0` 保留不動（`MIN_HEAP_SIZE = 0`，不強制最小值）
- `patchLdMemory()`：填入 PDSC / Settings.ini 的正確 RAM/Flash 大小，再呼叫 `patchLdStackSections()`

各路徑 patch 函式對照表與 49x heap/stack 設計原則  
→ **[ARCHITECTURE.md — Startup / Linker Script Patch 函式](../ARCHITECTURE.md#startup--linker-script-patch-函式)**  
→ **[linker-startup.md](linker-startup.md)**

---

## FWLib bat 整合

`_CreateProjectConfig.bat` 已加入 `HT32_VSCode` 支援：以 gsar 替換 `project.meta.json` 與 `project.settings.json` 中的 placeholder，可在 FWLib example 目錄下直接產生專案，不需要 extension wizard。  
→ **[fwlib-bat-integration.md](fwlib-bat-integration.md)**

---

## MCU RAM / Flash 大小查詢順序

1. `conf/Settings.ini` `[SRAM]` 區段（`lookupSramFromSettings`）→ 僅 RAM
2. bundled PDSC（`lookupMemoryFromPdsc`）→ RAM + Flash
3. template linker.ld 原始 placeholder

→ **[settings-ini.md](settings-ini.md)**

---

## 多系列與 FPU 判斷

`detectFpuPresentFromHeader()` 掃 device header 判斷是否有硬體 FPU；結果影響 Makefile `-mfpu` / `-mfloat-abi`、compile_commands.json、project.settings.json 中的 `fpu` 欄位。  
→ **[fpu_present.md](fpu_present.md)**

---

## 產出順序與 settings source of truth

`generateProjectFiles()` 內部固定順序：

1. 計算 FPU / MCU / include / define 等所有參數
2. **`writeProjectSettings()`** — 寫入 `project.settings.json`（含 `extraCFlags: existing || '-std=gnu11'`）
3. **`computeProjectLists()`** — 從 FWLib 路徑計算 `allSrcs` / `incsStr` / `defsStr`
4. **`buildMakefileFromProjectSettings(readProjectSettings(bgDir), { srcs, linkerScripts, ... })`** — 從已寫入的 settings 生成 Makefile
5. 寫 `sources.list` / `includes.list` / `defines.list` / `adefines.list`
6. `writeCCDbFromLists()` → `compile_commands.json`
7. `project.meta.json`

Makefile 完全反映 `project.settings.json`，與 Convert uVision 路徑（`buildMakefileFromProjectSettings`）行為一致。
