# FWLib bat 整合分析 — HT32_VSCode 專案產生

## 背景

Holtek STD FWLib 的 `_CreateProject.bat` 系統可為同一個 example 同時產生多個 IDE 的專案檔。  
`HT32_VSCode` 已作為新 IDE 選項加入，完全在 bat + gsar 架構下執行（不牽涉 Node.js runtime）。

---

## FWLib 專案產生架構

```
_CreateProject.bat
  └─ 複製 _CreateProjectScript.bat 到 example 目錄後執行
       ├─ 讀取 _CreateProjectConfig.bat（IDE / IC 選擇）
       ├─ 從 project_template/IP/<PRO_TYPE>/<IDE>/ 複製模板
       ├─ gsar 字串替換（IC、ROM/RAM、include、define、linker）
       ├─ 呼叫 _ProjectSource.bat（共用 extra source 注入）
       ├─ 呼叫 _ProjectSource_ht32ide.bat（HT32-IDE 專用 extra source 注入）
       └─ 呼叫 _ProjectSource_vscode.bat（HT32_VSCode 專用 extra source 注入）[新增]
```

---

## HT32_VSCode Project 目錄的檔案

| 類型 | 檔案 | 誰產生 | 說明 |
|------|------|--------|------|
| json | `project.meta.json` | **bat 複製 template + gsar** | TreeView groups/files，source of truth |
| json | `project.settings.json` | **bat 複製 template + gsar** | MCU/device/RAM/include/define 等 metadata |
| list | `sources.list` | extension（`initProjectsFromMeta`）| meta.json groups 展開的路徑 |
| list | `includes.list` | extension（`initProjectsFromMeta`）| settings.includePaths 展開的 `-Ipath` |
| list | `defines.list` | extension（`initProjectsFromMeta`）| settings.cDefs 展開的 `-DXXX` |
| list | `adefines.list` | extension（`initProjectsFromMeta`）| settings.aDefs 展開的 `-DXXX`（ASM-only defines）|
| mk   | `Makefile` | extension（`initProjectsFromMeta`）| settings 展開的完整編譯規則 |
| json | `compile_commands.json` | extension（`initProjectsFromMeta`）| clangd 用，從 .list 重生 |

> **Template 只需放 2 個 json**（`project.meta.json` + `project.settings.json`）。  
> bat gsar 只修改這 2 個 json；其餘 5 個檔案由 extension 在開啟時自動產生（Makefile 不存在，或 settings/meta 比 Makefile 新時產生；其餘情況跳過）。

---

## Template 目錄結構：HT32-IDE vs HT32_VSCode

兩者平行，`HT32_VSCode/` 完全比照 `HT32-IDE/` 的 per-IC 目錄結構。  
實際路徑：`project_template/IP/Example/HT32_VSCode/`

```
IP/Example/
├── HT32-IDE/
│   ├── Project_12345/
│   │   ├── original.project    ← source <link> XML + project name
│   │   └── original.cproject   ← IC_NAME / CPU / RAM / Flash / includes / defines / linker
│   ├── Project_12364/
│   │   └── ...
│   └── GNU_ARM/
│       ├── linker.ld           ← shared linker（Flash/RAM ORIGIN placeholder）
│       └── startup_*.S         ← shared startup（Stack_Size / Heap_Size）
│
└── HT32_VSCode/                ← 平行 HT32-IDE（由 extension createProject 產出）
    ├── .vscode/                ← 共用 VS Code 設定（所有 IC 共用）
    │   ├── compile_commands.json  ← 頂層 merge 用（clangd --compile-commands-dir 指向此）
    │   ├── launch.json
    │   ├── settings.json
    │   └── tasks.json
    ├── Example.ht32vs          ← workspace 檔
    ├── GNU_ARM/                ← HT32_VSCode 自有（與 HT32-IDE GNU_ARM/ 無關）
    │   ├── linker.ld
    │   ├── startup_ht32f1xxxx_gcc_01.s
    │   ├── startup_ht32f1xxxx_gcc_03.s
    │   └── ht32_stack_analysis.c
    ├── Project_12345/          ← per-IC 目錄
    │   ├── Makefile
    │   ├── defines.list
    │   ├── adefines.list
    │   ├── includes.list
    │   ├── project.meta.json   ← 使用相對路徑（../../../library/...），跨 drive 才需絕對路徑
    │   ├── project.settings.json
    │   └── sources.list
    │   (compile_commands.json 不放入 template，由 extension 開啟時從 .list 重生)
    ├── Project_12364/
    │   └── ...
    └── Project_XXXXX/
        └── ...
```

### 路徑策略

`project.meta.json` 使用**相對路徑**（相對於 example 目錄，例如 `../../../library/...`），同一 drive 下不需要 gsar 取代。只有 FWLib 與 example 跨 drive 時才需要轉絕對路徑（少見情況，extension 開啟時可偵測並重生）。

`compile_commands.json` **不放入 template**，由 extension 在第一次開啟時呼叫 `writeCCDbFromLists()` 從 `sources.list` / `includes.list` / `defines.list` / `adefines.list` 重生，確保路徑正確。

---

## gsar 替換操作 vs 受影響 template 檔對照表

HT32_VSCode 欄位對應 `Template/HT32_VSCode/Project_XXXXX/` 或 `GNU_ARM/` 內的 template 檔案：

| # | 來源 bat | 條件 | HT32-IDE template 檔 | HT32_VSCode template 檔 |
|---|----------|------|----------------------|------------------------|
| 1 | `_CreateProjectScript.bat` | 無條件 | `Project_*/original.project` — project name | `project.meta.json` — `projectName` |
| 2 | `_CreateProjectScript.bat` | `HT_CHANGE_RO_RW=1` | `GNU_ARM/linker.ld` ORIGIN | `GNU_ARM/linker.ld` ORIGIN **+** `project.settings.json` — `ramOrigin` / `ramLength` |
| 3 | `_CreateProjectScript.bat` | `HT_CHANGE_STACK_HEAP=1` | `GNU_ARM/*.s` stack/heap size | `GNU_ARM/*.s` stack/heap size（同格式，各自套用）|
| 4 | `_CreateProjectScript.bat` | `HT_CHANGE_INCLUDE=1` | `Project_*/original.cproject` include path | `project.settings.json` — `includePaths` 追加元素 |
| 5 | `_CreateProjectScript.bat` | `HT_CHANGE_CDEFINE=1` | `Project_*/original.cproject` C define | `project.settings.json` — `cDefs` 追加元素 |
| 6 | `_CreateProjectScript.bat` | `HT_CHANGE_LINKER_SCRIPT=1` | `Project_*/original.project` + `original.cproject` | `project.settings.json` — 暫不支援（extension 由 linkerScripts 控制）|
| 7 | `_ProjectSource.bat` | `_ProjectSource.ini` 存在 | `Project_*/original.project` `<link>` XML 注入 | `project.meta.json` — 追加 file 到對應 group |
| 8 | `_ProjectSource_vscode.bat` | `_ProjectSource_vscode.ini` 存在 | — | `project.meta.json` — 追加 file 到 User 或自訂 group |

### gsar 操作完整清單

| 受影響檔案 + 欄位 | gsar 操作 | 對應 # |
|-------------------|-----------|--------|
| `project.meta.json` → `projectName` | 取代 `project_template_` 為 `parentdir_exampledir_` | #1 |
| `project.meta.json` → User group | inline `<HTGSARCONT>` anchor，追加 extra source file | #7/#8 |
| `project.meta.json` → 自訂 group | direct replace `    ]\n  },\n  "linkerScripts"` 插入新 group 並保留 pattern | #7/#8 |
| `GNU_ARM/linker.ld` → Flash ORIGIN | 取代 `ORIGIN = 0x00000000` | #2 |
| `GNU_ARM/linker.ld` → RAM ORIGIN | 取代 `ORIGIN = 0x20000000` | #2 |
| `project.settings.json` → `ramOrigin` | 取代 `"ramOrigin": "0x20000000"` | #2 |
| `GNU_ARM/*.s` → Stack_Size | 取代 `.equ    Stack_Size, 512`（同 HT32-IDE 格式）| #3 |
| `GNU_ARM/*.s` → Heap_Size | 取代 `.equ    Heap_Size, 0:x0d:x0a`（**必須加 CRLF 後綴**，否則 `0` 會部分比對 `0x40` 導致 `1024x40`）| #3 |
| `project.settings.json` → `includePaths` | inline `<HTGSARCONT>` anchor（anchor：`"../../../../../utilities"`），迴圈追加；**gsar 不支援目錄萬用字元，需 `FOR /D %%D IN (HT32_VSCode\Project_*)` 包裹** | #4 |
| `project.settings.json` → `cDefs` | inline `<HTGSARCONT>` anchor（anchor：`"USE_HT32_DRIVER",`），迴圈追加；同上需 `FOR /D` 包裹 | #5 |
| `project.settings.json` → `ramOrigin` | 取代 `"ramOrigin": "0x20000000"`；同上需 `FOR /D` 包裹 | #2 |

### JSON `<HTGSARCONT>` 注入機制（inline 模式）

與 HT32-IDE 的 `_IAR_INCLUDE_REPLACE_` 相同概念，但因 JSON 不允許尾隨逗號，使用 inline 模式：

```
Step 1  anchor 插入：gsar "known_string" → "known_string<HTGSARCONT>"
Step 2  迴圈注入：gsar "<HTGSARCONT>" → ",\n    \"new_value\"<HTGSARCONT>"
Step 3  cleanup：gsar "<HTGSARCONT>" → ""
```

0 個 extra 時：cleanup 直接移除 anchor，JSON 不變。

### `_ProjectSource_vscode.ini` 格式（type 61/62/63）

```ini
REM  格式：GroupName, type, path\, filename, IC_match
REM  type 61 = .c, 62 = .s, 63 = .cpp

User, 61, ..\, myfile.c
User, 61, ..\..\..\shared\src\, shared.c, *
User, 61, ..\..\..\shared\src\, shared.c, 12345

MyGroup, 61, ..\, group_file.c
```

`path\` 為相對於 project.meta.json 的父目錄（即 example 目錄）的路徑。

---

## bat 修改記錄（2026-07-17）

> 所有修改均同步至三個系列：`1xxxx` / `4xxxx` / `5xxxx`

| 檔案 | 動作 | 修改內容 |
|------|------|----------|
| `_CreateProjectScript.bat` | **修改** | ① `IDE9` / `IDE_VSCODE` 偵測與顯示<br>② XCOPY HT32_VSCode per-IC 目錄、GNU_ARM/*.s、linker.ld、ht32_stack_analysis.c、.vscode/、`%IC_NAME%.ht32vs`<br>③ `projectName` gsar（複用 `HT32IDE_PNAME`）<br>④ BaseSET：GNU_ARM/*.ld ORIGIN gsar + ramOrigin JSON gsar<br>⑤ MemSET：GNU_ARM/*.s Stack_Size/Heap_Size gsar<br>⑥ IncludeSET：inline anchor + 迴圈注入 + cleanup<br>⑦ CdefineSET：inline anchor + 迴圈注入 + cleanup<br>⑧ 末尾呼叫 `_ProjectSource_vscode.bat` |
| `_ProjectSource.bat` | **修改** | ① 對所有 `HT32_VSCode\Project_*` 的 `project.meta.json` 插入 `<HTGSARCONT_GROUP>` anchor；`SET CURRENT_GROUP_VSCODE=0` 初始化<br>② `%%j LEQ 5` group 建立 block：新 group 時用 `<HTGSARCONT_GROUP>` 插入含 sentinel `""` 的 group<br>③ User 和非 User `else` block 末尾：對 `project.meta.json` 注入 file path<br>④ 末尾 cleanup：移除 `<HTGSARCONT>`、sentinel `""`、`<HTGSARCONT_GROUP>` anchor<br>→ **結果**：`_ProjectSource.ini` type 1/2/3 entries 現在也注入至 `project.meta.json` 對應 group（同 HT32-IDE 行為） |
| `_ProjectSource_vscode.bat` | **新增** | 讀 `_ProjectSource_vscode.ini`；支援 User group（type 61/62/63）和非 User 自訂 group（`<HTGSARCONT_GROUP>` 機制）注入至 `project.meta.json` |
| `_ClearProject.bat` | **修改** | ① Echo 列表加入 `.\HT32_VSCode`、`.clangd`<br>② IDE 資料夾刪除迴圈加入 `ELSE IF "%%~nxd"=="HT32_VSCode" (RD /s /q %%d)`<br>③ Delete Batch File 段落前加入 `del .\.clangd /Q /F`<br>→ 整個 `HT32_VSCode\`（含所有 `Project_XXXXX\` 和 `*.ht32vs`）和 example root 的 `.clangd` 一起刪除 |
| `_ProjectConfigScript.bat` | **修改** | `:DELPROJ` 子程序加入 `rmdir /s /q HT32_VSCode\Project_%2 1> nul 2>&1`<br>→ 修正 `_ProjectConfig.ini` 指定特定 MCU 時，不支援的 MCU 其 `HT32_VSCode\Project_XXXXX\` 資料夾未被刪除的 bug |
| `_CreateProjectScript.bat`（補修）| **修改** | ① `.ht32vs` XCOPY 從 `*.ht32vs` 改為 `%IC_NAME%.ht32vs`<br>→ IC_NAME 指定特定 MCU 時只複製對應的 `.ht32vs`，不再複製所有 IC 的 `.ht32vs`<br>② `project.settings.json` 所有 7 個 gsar 指令（ramOrigin、IncludeSET×3、CdefineSET×3）從直接指定 `HT32_VSCode\Project_*\...` 改為 `FOR /D %%D IN (HT32_VSCode\Project_*) DO (gsar ... %%D\project.settings.json ...)`<br>→ **gsar 不支援目錄路徑中的萬用字元**（`Project_*\`），直接用會靜默失敗，必須用 FOR /D 逐目錄展開<br>③ `Heap_Size` gsar pattern 加 `:x0d:x0a` 後綴（4 個啟動檔案 gsar 全部修正）<br>→ 防止 `0` 部分比對 `0x40` 造成 `Heap_Size, 1024x40` 錯誤 |

### `_ProjectSource.bat` — `_ProjectSource.ini` type 1 → VSCode 注入說明

`_ProjectSource.ini` 的 type 1（`.c`）/ type 2（`.s`）/ type 3（`.cpp`）entries 原本只注入至 Keil/GNU/EWARM/SES/HT32-IDE 的專案檔，本次修改同步注入至 `project.meta.json` 的對應 group。

#### 關鍵澄清：不需要 `_ProjectSource_vscode.ini`

`_ProjectSource.bat` 的 `else` branch（處理 User 之外的 group）本來就負責所有 IDE，HT32-IDE 在同一個 else branch 被處理，無需 `_ProjectSource_ht32ide.ini`。VSCode 的 type 1 注入也加在同一個 else branch 內，而非依賴 `_ProjectSource_vscode.ini`。  
`_ProjectSource_vscode.ini`（type 61/62/63）是給 **VSCode 專屬** extra file 使用的，由獨立的 `_ProjectSource_vscode.bat` 處理。

#### 5 個 Change 組

| Change | 位置 | 動作 |
|--------|------|------|
| **Change 1** | group 建立迴圈之前 | `SET CURRENT_GROUP_VSCODE=0` 初始化；**不再插入 `<HTGSARCONT_GROUP>` anchor**（改為 direct replace，見「非 User group 注入改為 direct replace」段落）|
| **Change 3** | `%%j LEQ 5` group 建立 block（HT32-IDE gsar 之後） | group 名稱改變時：先清除舊 `<HTGSARCONT>`（sentinel 空填充），再 direct replace `    ]\n  },\n  "linkerScripts"` 插入新 group（含 sentinel `""`）|
| **Change 4** | User group `else` block 末尾 | `FOR /D %%D IN (HT32_VSCode\Project_!m!)` 逐目錄：gsar `<HTGSARCONT>` → `,\n      "path/file"<HTGSARCONT>` |
| **Change 5** | 非 User group `else` block 末尾（同上 replace_all） | 同 Change 4，適用於非 User group（`CURRENT_GROUP_VSCODE != %%i` 已由 Change 3 切換 group） |
| **Change 6+7** | HT32-IDE `HTGSARCONT_GROUP` cleanup 之後、`DEL gsar.exe` 之前 | 四步 cleanup（見下） |

#### Sentinel `""` 機制（非 User group leading comma 問題）

直接用 `[<HTGSARCONT>]` 作為 group template 時，第一個 file 的 gsar 會產生：

```json
"GroupName": [,"file"<HTGSARCONT>]   ← 無效 JSON（leading comma）
```

改用 sentinel `""` 作為第一個元素：

```json
"GroupName": [
  ""<HTGSARCONT>
]
```

第一個 file 注入後：

```json
"GroupName": [
  "","file"<HTGSARCONT>
]
```

#### Change 6+7 — 三步 Cleanup

```bat
FOR /D %%D IN (HT32_VSCode\Project_*) DO (
REM 步驟1：移除剩餘的 <HTGSARCONT>（0個extra時：空group的anchor）
gsar.exe -s"<HTGSARCONT>" -r"" %%D\project.meta.json -o 1> nul 2>&1
REM 步驟2：移除 sentinel + 後方空白（非空 group：["","file"] → ["file"]）
gsar.exe -s":x22:x22,:x0a      " -r"" %%D\project.meta.json -o 1> nul 2>&1
REM 步驟3：移除尾端 sentinel（空 group：[""\n      ] → [""]，再由步驟1清掉anchor後剩[""]）
gsar.exe -s":x0a      :x22:x22" -r"" %%D\project.meta.json -o 1> nul 2>&1
)
```

> 原本有步驟4「移除 `<HTGSARCONT_GROUP>` anchor」，已隨 direct replace 改法一起移除。

| 情況 | 步驟執行效果 |
|------|------------|
| group 有 1+ 個 file | 步驟1移除 `<HTGSARCONT>`，步驟2移除 `"",\n      `，結果 `["file1","file2",...]` |
| group 有 0 個 file（group 建立但沒有 file 進來） | 步驟1移除 `<HTGSARCONT>`，步驟3移除 `\n      ""`，結果 `[]`（空 array，合法 JSON） |

---

### `_ProjectConfigScript.bat` `:DELPROJ` 修正說明

`_ProjectConfigScript.bat` 負責讀取 `_ProjectConfig.ini`，將未列入的 MCU 對應檔案刪除：

```bat
:DELPROJ
IF !%1!==0 (
  del /S Project_%2*.* %2.mk 1> nul 2>&1      ← 刪 *.ht32vs（/S 跨子目錄）
  rmdir /s /q HT32-IDE\Project_%2 1> nul 2>&1  ← 刪 HT32-IDE 對應資料夾
  rmdir /s /q HT32_VSCode\Project_%2 1> nul 2>&1  ← [新增] 刪 HT32_VSCode 對應資料夾
)
```

原本 `del /S Project_%2*.*` 會刪掉 `HT32_VSCode\Project_XXXXX.ht32vs`（因為 `/S` 跨子目錄），但 `HT32_VSCode\Project_XXXXX\` **資料夾本身**未被 `rmdir` 處理，導致只刪了 `.ht32vs` 檔、沒刪資料夾。

### `.ht32vs` XCOPY 設計

template 目錄下放 per-IC 的 `Project_XXXXX.ht32vs`，`_CreateProjectScript.bat` 用 `XCOPY *.ht32vs` 全部複製到 `HT32_VSCode/`，不做 rename。  
`_ProjectConfigScript.bat` 的 `:DELPROJ` 透過 `del /S Project_%2*.*` 刪除 `_ProjectConfig.ini` 未列入之 IC 對應的 `.ht32vs`，與其他 IDE 的清理機制相同。

---

## gsar 限制：目錄萬用字元不生效

gsar 支援**檔名**萬用字元（`startup_ht32*.s`、`*.ewp`），但**不支援目錄路徑**中的萬用字元（`HT32_VSCode\Project_*\file.json`）。

直接使用 `HT32_VSCode\Project_*\project.settings.json` 會靜默失敗（exit code 0，不報錯），導致 includes / defines / ramOrigin 完全未被套用。

正確做法：用 `FOR /D` 先展開目錄，再逐一呼叫 gsar：

```bat
FOR /D %%D IN (HT32_VSCode\Project_*) DO (
gsar.exe -s"..." -r"..." %%D\project.settings.json -o 1> nul 2>&1
)
```

`project.meta.json` 的 gsar（`projectName`）使用 `HT32_VSCode\Project_*\project.meta.json` 同樣會失敗，但因為 meta.json 的 projectName 是用 `FOR /D` + per-IC 目錄名稱動態構成的，已在實作中迴避此問題。

---

## bat 修改記錄（2026-07-22）

> 所有修改均同步至三個系列：`1xxxx` / `4xxxx` / `5xxxx`

| 檔案 | 動作 | 修改內容 |
|------|------|----------|
| `_ProjectSource.bat` | **bug 修正** | ① `VscUk` 路徑轉換修正（見下）<br>② 移除 `%%j=="52"` branch 中誤植的 VSCode 注入<br>③ 非 User group 注入改為 direct replace（見下）|
| `_CreateProjectScript.bat` | **bug 修正** | ① `HT_CHANGE_INCLUDE` VSCode 注入加 `../` 前綴（見下）<br>② `.ht32vs` XCOPY 從 `*.ht32vs` 改為 `Project_*.ht32vs`（排除 `Template.ht32vs`）|

### `_ProjectSource.bat` — VscUk 路徑轉換修正

#### 根本原因

`_ProjectSource.ini` 的 PATH（如 `..\src\card\`）是**相對 Keil project 資料夾**（`MDK_ARMv5/`）的路徑，比 example root 深 1 層。轉成 UNIX 後 `Uk=../src/card/`。

extension 讀 `project.meta.json` 的路徑時，是以 **example root** 為基準（e.g., `src/card/desfire_cli.c`），在生成 `sources.list` 時再加 `../../` 前綴（相對 `HT32_VSCode/Project_xxx/` build 目錄）。

若直接把 `!Uk!!l!`（= `../src/card/desfire_cli.c`）注入到 `project.meta.json`，extension 會加上 `../../` 變成 `../../../src/card/desfire_cli.c`，多跳一層到 `NFCReader/src/card/`，路徑不存在。

#### 修正邏輯

在 User group 與非 User group 各加一個 `VscUk` 換算（strip 一個 leading `../`）：

```bat
SET "VscUk=!Uk!"
IF "!VscUk:~0,3!" == "../" SET "VscUk=!VscUk:~3!"
```

然後所有注入至 `project.meta.json` 的地方改用 `!VscUk!!l!`：

| Keil PATH | `Uk` | `VscUk` | meta.json 注入 | extension 加 `../../` | 實際路徑（從 build dir）|
|-----------|------|---------|----------------|----------------------|------------------------|
| `..\src\card\` | `../src/card/` | `src/card/` | `src/card/desfire_cli.c` | `../../src/card/desfire_cli.c` | example root `src/card/` ✓ |
| `..\..\..\..\library\` | `../../../../library/` | `../../../library/` | `../../../library/file.c` | `../../../../../library/file.c` | FWLib `library/` ✓ |

> **VscUk 公式正確性**：`HT_EXTRA_INCLUDE` PATH 相對 Keil project 資料夾（`MDK_ARMv5/`），比 example root 深 1 層，所以 strip 恰好一個 `../` 就是 example-root-relative 路徑。多層 `../` 的情況（如 `../../../../library/`）同樣只 strip 一個，得到正確的 3 層 `../../../library/`。

#### 移除誤植的 `%%j=="52"` VSCode 注入

上一次 `replace_all:true` 編輯誤將 VSCode 注入加進 `%%j == "52"`（HT32-IDE 專用 ASM type）branch 內。此 branch 只應處理 HT32-IDE `.cproject`，與 VSCode 無關。已從 User group 和非 User group 的 `%%j=="52"` branch 中移除。

---

### `_CreateProjectScript.bat` — `HT_CHANGE_INCLUDE` VSCode include path 路徑層數修正

#### 根本原因

`_ProjectConfig.bat` 的 `HT_EXTRA_INCLUDE`（如 `..\inc;..\lib\cli\inc;`）路徑是**相對 IDE project 資料夾**（`MDK_ARMv5/`）的。轉 UNIX 後 `UNIX_PATH=../inc`。

各 IDE 的注入方式與對應路徑深度：

| IDE | 注入方式 | build dir 深度（相對 example root）| 需幾層 `../` |
|-----|---------|-----------------------------------|--------------------|
| Keil | `!UNIX_PATH!` 直插 uvprojx（`MDK_ARMv5/`）| `MDK_ARMv5/`（1 層）| `../inc` = 1 層 = example root `inc/` ✓ |
| HT32-IDE | `../../!UNIX_PATH!` → `../../../inc` | `HT32-IDE/Project_xxx/Debug/`（3 層）| `../../../inc` = 3 層 = example root `inc/` ✓ |
| VSCode（修正前）| `!UNIX_PATH!` → `../inc` | `HT32_VSCode/Project_xxx/`（2 層）| `../inc` = 1 層 = `HT32_VSCode/inc`（不存在）✗ |
| VSCode（修正後）| `../!UNIX_PATH!` → `../../inc` | `HT32_VSCode/Project_xxx/`（2 層）| `../../inc` = 2 層 = example root `inc/` ✓ |

#### 修正（line 537）

```bat
REM Before（錯誤）：
gsar.exe -s"<HTGSARCONT>" -r",:x0a    :x22!UNIX_PATH!:x22<HTGSARCONT>" %%D\project.settings.json -o 1> nul 2>&1

REM After（正確）：
gsar.exe -s"<HTGSARCONT>" -r",:x0a    :x22../!UNIX_PATH!:x22<HTGSARCONT>" %%D\project.settings.json -o 1> nul 2>&1
```

此修正與 HT32-IDE line 534 的 `../../!UNIX_PATH!` 類比：HT32-IDE 加 2 個 `../`（多 1 層的 build subdir），VSCode 加 1 個 `../`（沒有 build subdir，從 Project_xxx/ 本身執行）。

---

### `_ProjectSource.bat` — 非 User group 注入改為 direct replace

#### 根本原因

原本設計：在 group 建立迴圈前，先對每個 `project.meta.json` 插入 `<HTGSARCONT_GROUP>` anchor（搜尋 `    ]\n  },\n  "linkerScripts"` 並替換為加上 anchor 的版本），然後 group 建立時搜尋 `<HTGSARCONT_GROUP>` 來插入新 group。

**問題**：`project.meta.json` 是從 template 複製而來，template 裡沒有 `<HTGSARCONT_GROUP>` 字串。anchor 插入那步雖然有 gsar 執行，但 gsar 找不到 `<HTGSARCONT_GROUP>` 就靜默失敗，導致後續的 group 建立 gsar 同樣找不到，非 User group 完全沒有被注入。

#### 修正邏輯：direct replace

移除 anchor 插入步驟，group 建立時直接搜尋 `project.meta.json` 末尾固定存在的 pattern 並替換：

```bat
REM Before（錯誤）：搜尋不存在的 <HTGSARCONT_GROUP>
gsar.exe -s"<HTGSARCONT_GROUP>" -r",...<HTGSARCONT_GROUP>" %%D\project.meta.json -o 1> nul 2>&1

REM After（正確）：直接 replace 末尾固定 pattern
gsar.exe -s"    ]:x0a  },:x0a  :x22linkerScripts" -r"    ],:x0a    :x22%%i:x22: [:x0a      :x22:x22<HTGSARCONT>:x0a    ]:x0a  },:x0a  :x22linkerScripts" %%D\project.meta.json -o 1> nul 2>&1
```

替換結果（以 `lib-card` 為例）：

```json
    "vscode": [...],        ← 末尾 ] 被加上逗號
    "lib-card": [
      ""<HTGSARCONT>        ← 新 group，含 sentinel + HTGSARCONT
    ]
  },
  "linkerScripts": [        ← 同樣 pattern 保留，供下一個 group 繼續 replace
```

多個 group 時，每次 group 建立都搜尋同一個 pattern（前一個 group 的 `    ]` + `\n  },\n  "linkerScripts"`），連鎖插入，JSON 全程合法。

#### cleanup 簡化

移除原本的「步驟4：移除 `<HTGSARCONT_GROUP>` anchor」，因為 anchor 不再被插入，cleanup 只剩三步：

```bat
FOR /D %%D IN (HT32_VSCode\Project_*) DO (
gsar.exe -s"<HTGSARCONT>" -r"" %%D\project.meta.json -o 1> nul 2>&1
gsar.exe -s":x22:x22,:x0a      " -r"" %%D\project.meta.json -o 1> nul 2>&1
gsar.exe -s":x0a      :x22:x22" -r"" %%D\project.meta.json -o 1> nul 2>&1
)
```

---

### `_CreateProjectScript.bat` — `.ht32vs` XCOPY 修正

template 目錄（`project_template/IP/<PRO_TYPE>/HT32_VSCode/`）內同時存有 per-IC 的 `Project_XXXXX.ht32vs` 與共用的 `Template.ht32vs`。原本 `XCOPY *.ht32vs` 會把兩者都複製到 example 的 `HT32_VSCode/`，導致 `Template.ht32vs` 出現在專案中。

改為 `XCOPY Project_*.ht32vs` 只複製 per-IC 的 workspace 檔，與其他 IDE（如 HT32-IDE）只複製對應 IC 檔案的行為一致：

```bat
REM Before（錯誤）：
XCOPY /-Y /Q "...\HT32_VSCode\*.ht32vs" ".\HT32_VSCode\" < dummyn.txt 1> nul 2>&1

REM After（正確）：
XCOPY /-Y /Q "...\HT32_VSCode\Project_*.ht32vs" ".\HT32_VSCode\" < dummyn.txt 1> nul 2>&1
```

---

## gsar 特殊字元參考

| 字元 | gsar 轉義 |
|------|-----------|
| `"` | `:x22` |
| newline | `:x0a` |
| carriage return | `:x0d` |
| TAB | `:x09` |

---

## 分析來源

- `project_template/Script/_CreateProjectScript.bat`：主要 gsar 操作全覽（已修改加入 HT32_VSCode）
- `project_template/Script/_ProjectSource.bat`：共用 extra source 注入機制（已修改加入 type 61/62/63）
- `project_template/Script/_ProjectSource_ht32ide.bat`：HT32-IDE 專用 extra source（讀 `_ProjectSource_ht32ide.ini`）
- `project_template/Script/_ProjectSource_vscode.bat`：**新增**，HT32_VSCode 專用 extra source（讀 `_ProjectSource_vscode.ini`）
- `project_template/IP/Template/HT32-IDE/Project_12345/original.project`：source `<link>` XML 格式（PARENT-N-PROJECT_LOC）
- `project_template/IP/Template/HT32-IDE/Project_12345/original.cproject`：IC metadata、USE_HT32_CHIP、RAM/Flash size
- `project_template/IP/Template/GNU_ARM/12345.mk`：per-IC Makefile template（ARM_CORE / CHIP_NAME / STARTUP / SOURCE_NAME_PATH）
- `project_template/IP/Template/HT32-IDE/GNU_ARM/linker.ld`：linker script template（reuse for HT32_VSCode）
- `project_template/IP/Template/HT32_VSCode/Project_12345/project.meta.json`：VSCode TreeView 來源（`projectName` 為 gsar 替換目標）
- `project_template/IP/Template/HT32_VSCode/Project_12345/project.settings.json`：VSCode 設定（`ramOrigin`、`includePaths`、`cDefs` 為 gsar 替換目標）

---

## 49x 系列差異

> 以 `HT32F493x5_FWLib_V1.2.1_172` 為例，代表 example：`project/lvgl/3d_printer_rtos8`

### 目錄結構差異

STD 系列的 script 和 template 集中在 **FWLib 根目錄下的 `project_template/`**，  
49x 系列**每個 example 有自己的 `.prj/` 子目錄**，分別放：

```
3d_printer_rtos8/
├── .prj/
│   ├── Script/
│   │   ├── _CreateProjectScript.bat   ← example 專屬（複製到 example 根目錄執行）
│   │   ├── _ProjectSource.bat
│   │   ├── _ProjectSource_vscode.bat  ← [新增]
│   │   ├── _ClearProject.bat
│   │   └── gsar.e_x_e
│   └── Template/
│       ├── HT32-IDE/
│       │   ├── Project_49395/
│       │   └── GNU_ARM/
│       └── HT32_VSCode/               ← [新增]
│           ├── GNU_ARM/
│           │   ├── linker.ld
│           │   ├── startup_ht32f493x5.s
│           │   └── ht32_stack_analysis.c
│           └── Project_49395/
│               ├── project.meta.json
│               └── project.settings.json
└── _ProjectConfig.bat                 ← example 專屬設定（heap/stack/include/define）
```

### 49x 與 STD 的主要 bat 行為差異

| 項目 | STD 系列 | 49x 系列 |
|------|----------|----------|
| Flash ORIGIN | `0x00000000` | `0x08000000` |
| Stack/Heap 位置 | startup `.s` 的 `.equ Stack_Size` / `.equ Heap_Size` | linker `.ld` 的 `_Min_Stack_Size` / `_Min_Heap_Size` |
| MemSET gsar 目標 | `GNU_ARM/*.s`（兩個值）| `GNU_ARM/*.ld`（兩個值；`.s` gsar 不適用） |
| Stack/Heap 值格式 | hex（`0x200`）| decimal（`2048`）— GNU ld 接受 decimal |
| `HT_HEAP_SIZE` 預設 | `0x10000`（hex）| `65536`（decimal）— template 預設 `0x10000`，gsar 搜尋此值 |
| `_ProjectSource.bat` 呼叫方式 | 由 `_CreateProjectScript.bat` CALL | 同 STD |
| `_ProjectSource_vscode.bat` 呼叫方式 | 由 `_CreateProjectScript.bat` CALL | 同 STD |
| `_CreateProjectScript.bat` 來源 | `project_template/Script/` 複製 | `.prj/Script/` 複製 |
| template 來源 | `project_template/IP/<PRO_TYPE>/` | `.prj/Template/` |

### 49x MemSET — linker.ld stack/heap gsar

```bat
rem 49x startup .s 沒有 .equ Stack_Size，不用改 .s
gsar.exe -s"_Min_Heap_Size = 0x10000;"  -r"_Min_Heap_Size = %HT_HEAP_SIZE%;"  ht32-ide\GNU_ARM\*.ld -o 1> nul 2>&1
gsar.exe -s"_Min_Stack_Size = 0x800;"   -r"_Min_Stack_Size = %HT_STACK_SIZE%;" ht32-ide\GNU_ARM\*.ld -o 1> nul 2>&1
gsar.exe -s"_Min_Heap_Size = 0x10000;"  -r"_Min_Heap_Size = %HT_HEAP_SIZE%;"  HT32_VSCode\GNU_ARM\*.ld -o 1> nul 2>&1
gsar.exe -s"_Min_Stack_Size = 0x800;"   -r"_Min_Stack_Size = %HT_STACK_SIZE%;" HT32_VSCode\GNU_ARM\*.ld -o 1> nul 2>&1
```

### 49x BaseSET — Flash ORIGIN 差異

49x flash 在 `0x08000000`（Cortex-M4 STM-like mapping），非 STD 的 `0x00000000`：

```bat
gsar.exe -s"ORIGIN = 0x08000000" -r"ORIGIN = %HT_ROM_START%" HT32_VSCode\GNU_ARM\*.ld -o 1> nul 2>&1
```

---

## bat 修改記錄（2026-07-23）— 49x 系列

> 49x 系列每個 example 的 `.prj/Script/` 獨立修改，不影響 STD 系列

| 檔案 | 動作 | 修改內容 |
|------|------|----------|
| `.prj/Script/_CreateProjectScript.bat` | **修改** | ① `IDE9` / `IDE_VSCODE` 偵測與顯示<br>② XCOPY `HT32_VSCode` per-IC 目錄、`GNU_ARM/`（含 `ht32_stack_analysis.c`）、`.vscode/`、`%IC_NAME%.ht32vs`<br>③ `projectName` gsar<br>④ BaseSET：`HT32_VSCode\GNU_ARM\*.ld` Flash ORIGIN gsar（`0x08000000`）+ `ramOrigin` JSON gsar<br>⑤ MemSET：`HT32_VSCode\GNU_ARM\*.ld` `_Min_Stack_Size` / `_Min_Heap_Size` gsar（注意：49x 改 `.ld` 不改 `.s`）<br>⑥ IncludeSET：`project.settings.json` inline `<HTGSARCONT>` anchor + 迴圈注入（`../!UNIX_PATH!`）+ cleanup<br>⑦ CdefineSET：`project.settings.json` inline anchor + 迴圈注入 + cleanup<br>⑧ 末尾呼叫 `_ProjectSource_vscode.bat`<br>⑨ 移除孤立 `)` |
| `.prj/Script/_ProjectSource.bat` | **修改** | 同 STD 系列邏輯：VscUk 轉換、user/非 user group 注入至 `project.meta.json`；direct replace `<HTGSARCONT>` 機制相同 |
| `.prj/Script/_ProjectSource_vscode.bat` | **新增** | 同 STD 系列：讀 `_ProjectSource_vscode.ini` type 61/62/63，注入至 `project.meta.json` |
| `.prj/Script/_ClearProject.bat` | **修改** | ① 刪除清單加入 `HT32_VSCode`、`.clangd`<br>② 刪除迴圈加入 `HT32_VSCode` 資料夾<br>③ 加入 `del .\.clangd`、`del .\_ProjectSource_vscode.bat` |
| `_ProjectConfig.bat`（example root）| **修改** | `HT_CHANGE_INCLUDE=0` 保持不變（Keil/HT32-IDE 靠自訂 gsar），在 HT32-IDE include cleanup 之後補加 VSCode 的 include 注入（`<HTGSARCONT>` 機制，重用 `HT_EXTRA_INCLUDE2`） |

### `_ProjectConfig.bat` — 自訂 include 模式的 VSCode 補注入

某些 49x example（如 `lvgl/3d_printer_rtos8`）設定 `HT_CHANGE_INCLUDE=0`，自行在 `_ProjectConfig.bat` 用多個 gsar 處理 Keil 和 HT32-IDE 的 include（`HT_EXTRA_INCLUDE` + `HT_RTOS_INCLUDE5/6` 組合）。加 VSCode 支援時在 HT32-IDE cleanup 之後補加：

```bat
REM VSCode project.settings.json — 重用 HT_EXTRA_INCLUDE2（= HT_HT32_INCLUDE，含 FreeRTOS）
FOR /D %%D IN (HT32_VSCode\Project_*) DO (
gsar.exe -s":x22../../../../ht32f493x5_board:x22" -r":x22../../../../ht32f493x5_board:x22<HTGSARCONT>" %%D\project.settings.json -o 1> nul 2>&1
)

for %%I in (!HT_EXTRA_INCLUDE2!) do (
SET "UNIX_PATH=%%I"
SET "UNIX_PATH=!UNIX_PATH:\=/!"
FOR /D %%D IN (HT32_VSCode\Project_*) DO (
gsar.exe -s"<HTGSARCONT>" -r",:x0a    :x22../!UNIX_PATH!:x22<HTGSARCONT>" %%D\project.settings.json -o 1> nul 2>&1
)
)

FOR /D %%D IN (HT32_VSCode\Project_*) DO (
gsar.exe -s"<HTGSARCONT>" -r"" %%D\project.settings.json -o 1> nul 2>&1
)
```

路徑換算：`HT_HT32_INCLUDE` 相對 `mdk_v5/`（1 層），`project.settings.json` 在 `HT32_VSCode/Project_*/`（2 層）→ 加一層 `../!UNIX_PATH!` 即可。`HT_EXTRA_INCLUDE2` 在前面 `SETLOCAL ENABLEDELAYEDEXPANSION` 區塊中已 SET，直接重用。
