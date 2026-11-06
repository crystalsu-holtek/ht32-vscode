# HT32-IDE 專案格式說明

HT32-IDE（Eclipse CDT）的專案由兩個檔案組成：

- **`.project`** — 專案名稱、虛擬資料夾連結（linkedResources）
- **`.cproject`** — 編譯器/連結器選項、sourceEntries（要掃描哪些資料夾）

`ht32ide2make.ts` 的 `parseHt32IdeProject()` 負責解析這兩個檔案。

---

## 三種專案結構

### 類型一：Type-1 個別 file link（`PARENT-N-PROJECT_LOC`）

Holtek 官方 FWLib 範例專案的標準格式。`.project` 裡每個 `.c/.h/.S` 逐一列出，
路徑用 Eclipse 內建的 `PARENT-N-PROJECT_LOC` 表示「往上 N 層資料夾」。

```xml
<linkedResources>
  <link>
    <name>User/main.c</name>
    <type>1</type>
    <locationURI>PARENT-2-PROJECT_LOC/Src_AP/main.c</locationURI>
  </link>
  <link>
    <name>Library/ht32f5xxxx_gpio.c</name>
    <type>1</type>
    <locationURI>PARENT-3-PROJECT_LOC/library/.../ht32f5xxxx_gpio.c</locationURI>
  </link>
</linkedResources>
```

**特徵：**
- Library 只列「這個專案用到的」Driver，不是整個 FWLib 資料夾
- 路徑是相對的，換電腦通常沒有問題

**解析方式：** `parseProjectFile()` 的 Type-1 迴圈直接處理，
用 `resolveEclipseUri()` 把 `PARENT-N-PROJECT_LOC/...` 解成絕對路徑。

---

### 類型二：Type-2 folder link + 自訂變數

多個 sub-project 共享同一份 Library/Config/Startup 的 Demo Code 常用這種格式。
`.project` 裡是整個資料夾的連結，路徑透過自訂變數（`<variableList>`）指向外部目錄。

```xml
<linkedResources>
  <link>
    <name>Library</name>
    <type>2</type>
    <locationURI>copy_PARENT/Library</locationURI>
  </link>
</linkedResources>
<variableList>
  <variable>
    <name>copy_PARENT</name>
    <value>file:/C:/Users/wurh/Desktop/BC2113_DemoCode_HT32IDE_20261008</value>
  </variable>
</variableList>
```

**特徵：**
- `copy_PARENT` 的值是寫死的絕對路徑，換電腦會失效
- 我們有 walk-up 解析邏輯（`resolveEclipseVariableValue()`）：
  從 projectDir 往上找到同名資料夾，不依賴硬編碼路徑

**解析方式：** `parseProjectFile()` 偵測到 `hasType2Links` 為 true 時，
建立 `folderLinkMap`（虛擬名稱 → 實體路徑），再對每個 sourceEntry 呼叫 `scanSourceFolder()`。

---

### 類型三：純本地資料夾（無 linkedResources）

Library/Config/Startup/User 直接是專案目錄下的真實子資料夾，
`.project` 裡完全沒有 `<linkedResources>`。
通常是客戶把整個專案打包成 self-contained 形式。

```xml
<projectDescription>
  <name>HT32F61031_TWS_Charging_Case</name>
  <!-- 完全沒有 <linkedResources> -->
</projectDescription>
```

搭配 `.cproject` 的 sourceEntries（與類型二完全相同角色）：

```xml
<sourceEntries>
  <entry name="Config"/>
  <entry name="Library" excluding="Driver/src/ht32_div.c|Driver/src/ht32_rand.c"/>
  <entry name="Startup"/>
  <entry name="User"/>
</sourceEntries>
```

**特徵：**
- 資料夾本來就在專案目錄裡，Eclipse 自己就找得到，不需要在 `.project` 裡宣告
- 完全不依賴外部路徑，換電腦沒有問題

**解析方式：** `parseProjectFile()` 偵測到 `links.length === 0`（沒有任何 linked resource）
時也進入資料夾掃描路徑，`folderLinkMap` 為空，
fallback 到 `path.join(projectDir, entry.name)` 找到本地資料夾。

---

## 對照表

| | 類型一 | 類型二 | 類型三 |
|---|---|---|---|
| `.project` 有 `<linkedResources>` | ✓ | ✓ | ✗ |
| link type | `1`（個別檔） | `2`（整個資料夾） | — |
| 路徑寫法 | `PARENT-N-PROJECT_LOC/...` | 自訂變數（如 `copy_PARENT`） | 無，本地子目錄 |
| Library 範圍 | 只列用到的 Driver | 整個 Library 資料夾 | 整個 Library 資料夾 |
| 換電腦是否有問題 | 通常沒問題 | 有問題（硬編碼絕對路徑） | 沒問題 |
| 觸發掃描的條件 | — | `hasType2Links === true` | `links.length === 0` |

---

## Post-Build 指令中的 Eclipse CDT 變數

`.cproject` 的 `postbuildStep` 屬性會包含 Eclipse CDT 內建變數，
`buildHt32IdePostBuildCmd()` 在轉換時將其替換為實際值。

| CDT 變數 | 替換後的值 | 說明 |
|---|---|---|
| `${BuildArtifactFileName}` | `<outputName>.elf` | 完整 artifact 檔名（含副檔名） |
| `${BuildArtifactFileBaseName}` | `<outputName>` | artifact 基本名稱（無副檔名） |
| `${BuildArtifactFileExtension}` | `elf` | artifact 副檔名 |
| `${ProjName}` | `<projectName>` | Eclipse 專案名稱 |
| `${IC_NAME}` | `<icName>` | HT32-IDE 專用：`.cproject` 的 `IC_NAME` macro |

典型的 post-build 指令範例：

```
arm-none-eabi-objcopy -O binary ${BuildArtifactFileName} ${BuildArtifactFileBaseName}.bin
```

替換後：

```
arm-none-eabi-objcopy -O binary HT32F61031_TWS_Charging_Case.elf HT32F61031_TWS_Charging_Case.bin
```

若替換完後仍有殘留的 `${...}` 變數（未知的 CDT 變數），
`buildHt32IdePostBuildCmd()` 會透過 `logWarn` 在 Output 面板提示，原樣保留不修改。

---

## sourceEntries 的角色

`.cproject` 的 `sourceEntries` 對類型二和類型三都是相同的角色：
定義「要掃描哪些資料夾名稱」以及「排除哪些檔案」。

```xml
<sourceEntries>
  <entry flags="VALUE_WORKSPACE_PATH|RESOLVED" kind="sourcePath" name="Library"
         excluding="Driver/src/ht32_div.c|Driver/src/ht32_rand.c"/>
</sourceEntries>
```

`excluding` 屬性用 `|` 分隔，可以是相對路徑或純檔名。
解析後存入 `excludeRelPaths`（Set），`scanSourceFolder()` 在遞迴掃描時比對跳過。

---

## wsRoot 推導規則（`computeHt32IdeWsRoot`）

`HT32_VSCode/` 輸出目錄的位置由 `computeHt32IdeWsRoot(projectDir)` 決定，
分三個分支（優先順序由上至下）：

| 分支 | 判斷條件 | wsRoot | 範例 |
|------|---------|--------|------|
| **49x** | `basename(projectDir)` 符合 `ht32-?ide` | `dirname(projectDir)` | `.../calibration/HT32-IDE` → `calibration/` |
| **STD** | `basename(dirname(projectDir))` 符合 `ht32-?ide` | `dirname(dirname(projectDir))` | `.../exDir/HT32-IDE/Project_xxx` → `exDir/` |
| **Type-3** | 其餘（純本地資料夾） | `dirname(projectDir)` | `.../SomeFolder/MyProject` → `SomeFolder/` |

`HT32_VSCode/` 建立在 `wsRoot` 下，`bgDir = wsRoot/HT32_VSCode/<ProjectName>`。

> **注意**：所有從 `bgDir` 反推 `wsRoot` 的地方（`bgDirToProjectRoot`）都依賴
> `bgDir` 在 `wsRoot` 下**恰好兩層**這個不變量。
> 若 `wsRoot` 本身命名為 `HT32_VSCode`（`bgParentIde` 有特殊處理），
> 則 `bgDir` 只在 wsRoot 下一層，反推會偏移一層。
