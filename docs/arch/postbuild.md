# Post-Build 處理架構

轉換完成後，`project.settings.json` 的 `postBuildCmd` 欄位存放 shell 指令；
tasks.json 再依此欄位決定是否產生 Compile / Post-Build / Build compound 結構。

---

## 來源一：uVision (`uv2make.ts`)

### 讀取

`extractUvAfterMakeCmd()` 從 `.uvprojx` XML 的 `AfterMake/UserProg1Name`、`UserProg2Name` 讀取，  
`RunUserProg` = `1` 才處理；`fromelf` 指令直接略過（GCC Makefile 已由 objcopy 產 `.bin`）。

最多兩條指令，都有效時以 `&&` 串接。

### Keil 變數替換

| Keil 變數 | 展開為 |
|-----------|--------|
| `!L` / `#L` | 輸出 `.axf` 完整路徑 |
| `@L` | 輸出 `.axf`（不含副檔名） |
| `$J` | projDir 絕對路徑 |
| `$D` | device name（由 PDSC 解析） |

### 轉換規則（`translateKeilPostBuildCmd()`）

**1. `fromelf --bin` — 略過**

Keil 用此指令產生 `.bin`，GCC Makefile 已由 `arm-none-eabi-objcopy` 處理，直接回傳 `''`。

**2. `cmd /C copy /Y "!L.bin" <dst>` — 路徑翻譯**

- `!L.bin` / `#L.bin` → `Project_xxx/build/TARGET.bin`（相對 `HT32_VSCode/`）
- `<dst>`：原 Keil 路徑（相對 `MDK_ARMv5/`）→ 轉換為相對 `HT32_VSCode/`
- 含空格路徑自動加引號
- 目的目錄不存在 → 轉換時發出 `ConversionWarning`（Problems 面板）
- 其他 `cmd /C` 語法（非 copy / src 非 `[!#]L.bin`）→ 略過

**3. `.bat` / `.exe` 腳本 — 路徑翻譯 + vsc 模式**

原始格式：`<bat> <mode> @L <icName>`

翻譯後：`<wsRoot-relative-bat> vsc <targetName> <icName>`

- 第一個 token 轉成相對 `HT32_VSCode/` 路徑
- `vsc` 取代原 `keil` 模式參數
- `<icName>`（原第 4 個 token）中 `$D` → 實際 device name
- Holtek 官方 `afterbuild.bat` 已內建 `vsc` 模式

**4. 裸 system command — 略過**

第一個 token 無 `/` 或 `\`（無目錄成分），直接回傳 `''`。

---

## 來源二：HT32-IDE (`ht32ide2make.ts`)

### 讀取

`parseCProjectFile()` 從 `.cproject` 的 `postbuildStep` 屬性取得原始字串。

### 轉換（`buildHt32IdePostBuildCmd()`）

替換 Eclipse CDT 變數：

| CDT 變數 | 展開為 |
|----------|--------|
| `${BuildArtifactFileBaseName}` | outputName |
| `${IC_NAME}` | icName（來自 `<ic name=…>`） |
| `${ProjName}` | projectName |

第一個 token 的處理分兩種情況：

| 情況 | 範例 | 處理 |
|------|------|------|
| 有路徑分隔符（相對路徑） | `..\..\afterbuild.bat` | `path.resolve(buildDir, rawPath)` → 絕對路徑 |
| 無路徑分隔符（bare 命令） | `arm-none-eabi-objcopy.exe` | 原樣保留（不做 resolve） |

**bare 命令不能做 `path.resolve`**：`buildDir = projectDir/HT32/`，resolve 後會得到 `…/HT32/arm-none-eabi-objcopy.exe`，接著 `resolveHt32IdePostBuildPath` 再轉成相對路徑 `..\HT32-IDE\Project_xx\HT32\arm-none-eabi-objcopy.exe`，導致 PowerShell 找不到該路徑。

- `ht32ide` mode 替換為 `vsc`

### 路徑相對化（`resolveHt32IdePostBuildPath()`）

轉換時 wsRoot（`HT32_VSCode/`）未知，分兩步：

1. `buildHt32IdePostBuildCmd()` → 有路徑的 token 已為**絕對路徑**；bare 命令原樣
2. 外層取得 wsRoot 後呼叫 `resolveHt32IdePostBuildPath()` → 有路徑者轉為 wsRoot-relative；bare 命令直接回傳原字串（同樣以無路徑分隔符判斷）

---

## 特殊情況：`--symdefs`（`uv2make.ts`）

偵測到 Keil `--symdefs` 旗標時，自動在 `outDirAbs`（`Project_xxx/`）產生 `gen_syms_ld.bat`：

```bat
@echo off
set "ELF=%~dp0build\TARGET.elf"
set "OUT=%~dp0build\<symsBase>.ld"
powershell -NoProfile -Command "... arm-none-eabi-nm ... → symbol linker script ..."
```

- bat 使用 `%~dp0` 定位 ELF，無需 cwd 假設
- `symdefsPostBuildCmd = cmd /c "gen_syms_ld.bat"（outDirAbs-relative）`
- `finalPostBuildCmd = uvPostBuildCmd && symdefsPostBuildCmd`（兩者都有效時）
- 轉換時同時發出 ConversionWarning 提示依存專案需引入此 `.ld` 作為 linker script

---

## Bat 搬移（`relocateBatToWsRoot()`）

Convert 時，若 bat 路徑位於**來源專案目錄**（uV：`MDK_ARMv5/`；HT32-IDE：`HT32-IDE/`）之下，  
自動 copy 到 `HT32_VSCode/` 並將 `postBuildCmd` 路徑更新為 `HT32_VSCode/` 相對路徑。

- 判斷條件：`path.relative(srcRoot, batDir)` 不以 `..` 開頭
  - uV：`srcRoot = projDir`（MDK_ARMv5/）
  - HT32-IDE：`srcRoot = path.dirname(projectDir)`（HT32-IDE/）
- `Tools/` 等**同層兄弟目錄**不會被誤判（`relFromSrc` 以 `..` 開頭）
- `HT32_VSCode/` 外部的共用 bat（例如絕對路徑指向他處）不動

時序：copy → 回傳新 dest → 算 wsRoot-relative → 存入 `postBuildCmd`。

---

## 已知限制（待處理）

### Sibling bat 未隨 primary bat 搬移

`relocateBatToWsRoot()` 目前只搬移 `postBuildCmd` 直接指向的 primary bat。  
若 primary bat 所在目錄（或其子目錄）還有其他 bat（例如 `DFUmaker_combo.bat`、`srec_make_combo.bat`），  
這些 bat **不會**一起被 copy 到 `HT32_VSCode/`，會留在原來的 HT32-IDE / MDK_ARMv5 目錄下。

受影響的情況：
- `HT32-IDE\GNU_ARM\` 下有多個 bat
- `HT32-IDE\Tools\` 等子目錄下有多個 bat

後續 `syncAfterBuildBats` 的 sibling 掃描因為在 `HT32_VSCode/` 找不到這些 bat，  
會從 bundle 複製新版本而非使用已存在的舊版本，行為上等同於全新安裝 bundle bat，但原有的客製化內容會遺失。

**修法方向**：`relocateBatToWsRoot` copy primary bat 時，同時掃描來源目錄，  
將其中屬於 bundle 的 bat 一併 copy 到 `HT32_VSCode/`。需要傳入 `extensionPath` 以取得 bundle 清單。

---

## AfterBuild Sync（`syncAfterBuildBats()`）

**Convert uV / HT32-IDE 完成後**（`runAfterBuildSync()`），對 `postBuildCmd` 指向的 bat 進行版本比對：

| 情況 | 動作 |
|------|------|
| bat 不存在 | 從 `afterbuild/` bundle 複製 |
| bat 存在且 `$Rev::` ≤ `MAX_REPLACEABLE_REV` | backup → 以 bundle 取代，migrate 使用者自訂區段 |
| bat 存在且 `$Rev::` > `MAX_REPLACEABLE_REV` | 跳過（使用者已升版） |
| bat 名稱不在 bundle 清單 | 跳過 |

**Sibling bat 掃描**：primary bat 目錄下若有其他屬於 bundle 的 bat（`DFUmaker_combo.bat`、`srec_make_combo.bat`），  
依相同規則一併處理（這些 bat 通常由 afterbuild 間接呼叫，不直接出現在 `postBuildCmd`）。

---

## 儲存

`postBuildCmd` 寫入 `project.settings.json`（兩條路徑共用）。

```jsonc
// project.settings.json
{
  "postBuildCmd": "..\\Tools\\afterbuild_ap.bat vsc IAP_AP HT32F52352"
}
```

使用者亦可透過 **Settings WebView → Build → Post-Build Command** 手動編輯。

---

## tasks.json 產生（`ht32-project-assistant-for-vs-code.ts`）

### 有 `postBuildCmd` 時：Compile / Post-Build / Build compound

```
Build X
  dependsOn: ["Compile X", "Post-Build X"]
  dependsOrder: sequence
  group: { kind: 'build', isDefault: true }

Compile X          ← make only，type: process，有 GCC problemMatcher
  args: [-j, -C, <bgCwd>]

Post-Build X       ← bat / cmd，type: shell，cwd: ${workspaceFolder}
  command: <wrapPostBuildCmd(postBuildCmd)>
  problemMatcher: []
  presentation: { reveal: always, panel: dedicated, clear: false }
```

### 無 `postBuildCmd` 時：單一 Build task

```
Build X            ← make，type: process，有 GCC problemMatcher
  args: [-j, -C, <bgCwd>]
  group: { kind: 'build', isDefault: true }
```

### `wrapPostBuildCmd()` 邏輯

```
已有 "cmd" 開頭   → 原樣輸出（不重複加）
第一個 token 為 .bat → 加上 "cmd /c"（PowerShell 需要）
其他（exe / 系統命令） → 原樣輸出
```

Post-Build task 的 `cwd` 固定為 `${workspaceFolder}`（= `HT32_VSCode/`），與 bat 內 `%~dp0` 導向一致。

---

## 多專案（Build All）

多個 `build-gen` 子目錄時，每個 `Build X` 已內含 Post-Build；
`Build All` 直接 dependsOn 各 `Build X`，不需重複處理 post-build。

---

## 相關函式

| 函式 | 位置 | 說明 |
|------|------|------|
| `extractUvAfterMakeCmd()` | `uv2make.ts` | 從 `.uvprojx` XML 讀取 AfterMake，過濾 fromelf，呼叫下方函式 |
| `translateKeilPostBuildCmd()` | `uv2make.ts` | 單條 Keil 指令翻譯 |
| `relocateBatToWsRoot()` | `uv2make.ts` | bat 在來源專案目錄下時 copy 到 HT32_VSCode/ |
| `buildHt32IdePostBuildCmd()` | `ht32ide2make.ts` | HT32-IDE CDT 變數替換 + bat 路徑轉絕對 |
| `resolveHt32IdePostBuildPath()` | `ht32ide2make.ts` | 絕對 bat 路徑 → wsRoot-relative（含 relocate） |
| `wrapPostBuildCmd()` | `ht32-project-assistant-for-vs-code.ts` | .bat 自動加 `cmd /c` |
| `runAfterBuildSync()` | `ht32-project-assistant-for-vs-code.ts` | convert 完成後呼叫，讀取所有 bgDir 的 postBuildCmd 並執行 sync |
| `syncAfterBuildBats()` | `afterbuildSync.ts` | 版本比對、更新、sibling 掃描（由 runAfterBuildSync 呼叫） |

---

## 不支援的語法（uVision 路徑）

以下 Keil post-build 語法目前**不翻譯**（回傳 `''`）：

- `fromelf --i32 / --vhx / --elf` 等非 bin 格式
- `cmd /C copy` 以外的 `cmd /C` 指令（`del`、`mkdir`、`echo` …）
- `!L`/`#L` 的 `.axf` 本體（非 `.bin`）

若有需要，請手動編輯 `project.settings.json` 的 `postBuildCmd` 欄位。
