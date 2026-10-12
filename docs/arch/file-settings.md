# Per-file Settings（檔案級別設定）

每個檔案可獨立設定三個選項，儲存於 `project.meta.json` 的 `fileOptions` 欄位：

| 選項 | meta.json key | 說明 |
|------|--------------|------|
| Exclude from build | `exclude: true` | 檔案保留在 TreeView（groups），不編譯（從 sources.list / Makefile SRCS 移除）|
| Execute-only | `xo: true` | 對此 `.c` 加 `-mpure-code`（防逆向，需 MPU 配合）|
| ROM Region | `rom: { origin, length }` | 將此 `.c` 的 `.text*/.rodata*` 放到指定 ROM region |

---

## meta.json 格式

```json
{
  "fileOptions": {
    "Project/user/icode.c": { "xo": true },
    "Project/user/main.c":  { "exclude": true },
    "Project/user/spim_code.c": { "rom": { "origin": "0x90000000", "length": "0x01000000" } }
  }
}
```

路徑格式：`{bgDirName}/{wsRoot相對路徑}`，正斜線，與 `groups` 的路徑格式相同。

---

## UI 操作

右鍵 TreeView 檔案節點 → **File Settings...**  
以迴圈式 QuickPick 呈現目前狀態（`$(check)` = 已啟用）：

- `Exclude from build`
- `Execute-only (-mpure-code)`
- `ROM: <region name>` → 展開 region 選單（從 linker script 解析 ROM region）
- `Apply` → 存檔並重產 Makefile

---

## Makefile 效果

`refreshDerivedFiles` 讀 `fileOptions` 後，透過 `generateCompileRuleSection(buildRelPaths, extraFlagsMap)` 重產 Makefile 的編譯規則區：

- **excluded**：從 `sources.list` 移除，不出現在 `SRCS`
- **xo**：為該檔案產生獨立的 `make` compile rule，加 `EXTRA_FLAGS = -mpure-code`
- **rom**：`patchLinkerScriptRom()` 在 linker script 插入對應的 MEMORY region 與 SECTIONS block

---

## ROM Region 機制（`patchLinkerScriptRom`）

1. 移除所有先前由 extension 插入的 `HT32ROM_*` MEMORY 行與 `.ht32rom_*` SECTIONS block
2. 解析 linker script 現有 MEMORY regions（`origin → name` Map），避免重複新增
3. 對新 region 以 hex 寫入 MEMORY（插在 RAM 之前）；已有同 origin 的 region 直接重用其名稱（如 SPIM）
4. 在 `.text` section 前插入 output section：`.ht32rom_<name> : { *<file>.o(.text* .rodata*) } > <region>`

---

## TreeView 視覺標示

| 狀態 | icon | description |
|------|------|-------------|
| excluded | `ThemeIcon('circle-slash', disabledForeground)` | `[excluded]` |
| xo | 原始 file type icon | `[xo]` tag |
| rom | 原始 file type icon | `[rom]` tag |

---

## Convert 時自動讀取

### Convert uVision

從 `.uvprojx` 的 `FileOption` XML 節點自動讀取：

| Keil XML 屬性 | 對應設定 |
|--------------|---------|
| `IncludeInBuild = 0` | `exclude: true` |
| `useXO = 1` | `xo: true` |
| `RVCTCodeConst = 5` | `rom`（查 `extractOcrRvctMap()` 取 IROM2 位址）|

### Convert HT32-IDE

從 `.cproject` XML 自動讀取（`parsePerFileSettings()`）：

| HT32-IDE XML | 對應設定 |
|-------------|---------|
| `<entry excluding="main.c" name="user"/>` in `<sourceEntries>` | `exclude: true` |
| `<fileInfo resourcePath="user/icode.c">` 內 compiler option value 含 `-mpure-code` | `xo: true` |
| — | ROM region 不支援自動讀取（HT32-IDE 直接寫在 linker.ld，轉換時原樣複製）|

#### HT32-IDE `.cproject` 格式說明

**Exclude from build** 使用 `<sourceEntries>` 的 `excluding` attribute，格式為 `|` 分隔的檔名清單：
```xml
<sourceEntries>
  <entry excluding="main.c|another.c" flags="VALUE_WORKSPACE_PATH|RESOLVED"
         kind="sourcePath" name="user"/>
</sourceEntries>
```
`name="user"` 對應 TreeView group 名稱（case-insensitive 比對）。

**Execute-only** 使用 `<fileInfo>` 節點，在 per-file 的 compiler other flags 中加 `-mpure-code`：
```xml
<fileInfo resourcePath="user/icode.c" ...>
  <tool ...>
    <option superClass="...c.compiler.other" value="-c -MD ... -mpure-code" .../>
  </tool>
</fileInfo>
```

---

## 各路徑支援對照表

| 設定 | Convert uVision | Convert HT32-IDE | 手動（UI）|
|------|:--------------:|:---------------:|:---------:|
| Exclude from build | ✅ 自動讀取 | ✅ 自動讀取 | ✅ |
| Execute-only | ✅ 自動讀取 | ✅ 自動讀取 | ✅ |
| ROM Region | ✅ 自動讀取 | — (已在 linker.ld) | ✅ |
