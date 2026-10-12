# Library Linking — 兩種引入方式

HT32-IDE `.cproject` 有兩種不同機制可以引入外部 library，轉換器需全部支援。

---

## 方式一：直接路徑（`linker.otherobjs` → `LIBS`）

### HT32-IDE 設定位置

**Linker → Other objects**

```xml
<option ... superClass="...cpp.linker.otherobjs" valueType="userObjs">
  <listOptionValue builtIn="false" value="../../../Src_IAP/USBBufCheck_Lib_49xxx_GNU.a"/>
</option>
```

### 特性

- 檔名**不需要** `lib` 前綴
- 強制 static link（直接指定 `.a` 檔案路徑）
- GCC 命令列：直接附加檔案路徑，不用 `-l` / `-L`

```makefile
LIBS := ../../Src_IAP/USBBufCheck_Lib_49xxx_GNU.a

$(BUILD)/$(TARGET).elf: $(OBJ) $(LIBS) | $(BUILD)
	@"$(CC)" $(CFLAGS) $(OBJ) $(LIBS) -o "$@" $(LDFLAGS)
```

### 轉換流程

```
.cproject linker.otherobjs (.a)
  → parseCProjectFile() → extraLibFiles[] (resolved absolute)
  → buildProjectMeta()  → groups["Libraries"][]
  → project.meta.json   → groups.Libraries
  → refreshDerivedFiles() → buildRelPaths → libFiles → LIBS :=
```

### 實際案例

`HT32F493x5_FWLib / application / IAP_HID / IAP_HID_III`  
`→ Src_IAP/USBBufCheck_Lib_49xxx_GNU.a`

---

## 方式二：名稱 + 搜尋路徑（`linker.libs` + `linker.paths` → `LDFLAGS`）

### HT32-IDE 設定位置

**Linker → Libraries (-l)** 和 **Library search path (-L)**

```xml
<option ... superClass="...cpp.linker.libs" valueType="libs">
  <listOptionValue builtIn="false" value="HoltekPDF32"/>
</option>
<option ... superClass="...cpp.linker.paths" valueType="libPaths">
  <listOptionValue builtIn="false" value="&quot;D:\path\to\lib&quot;"/>
</option>
```

### 特性

- GCC 搜尋 `lib<Name>.a` 或 `lib<Name>.so`（**需要 `lib` 前綴**）
- 優先找 `.so`，找不到才找 `.a`
- 指定搜尋目錄，不寫死檔案路徑

```makefile
LDFLAGS += -lHoltekPDF32 -L"D:/path/to/lib"
```

### 轉換流程

```
.cproject cpp.linker.libs  → extraLibNames[] → project.settings.json extraLibNames
.cproject cpp.linker.paths → extraLibPaths[] → project.settings.json extraLibPaths
  → regenerateMakefileFlags() → LDFLAGS
  → Settings Webview "Extra Libraries" (-l / -L) 可編輯
```

### 實際案例

`HT32_STD_5xxxx_FWLib / application / DataLoggerLCD`  
`→ -lHoltekPDF32 -L"D:\HT32_STD_5xxxx_FWLib_V1.3.2_6448\..."`

---

## 兩種方式的差異對照

| | 直接路徑（otherobjs） | 名稱 + 搜尋路徑（libs + paths） |
|---|---|---|
| HT32-IDE 設定 | Other objects | Libraries (-l) + Library search path (-L) |
| 檔名限制 | 無（任意命名） | 必須是 `lib<Name>.a` |
| 連結方式 | 直接路徑，強制 static | 搜尋目錄，dynamic 優先 |
| Makefile 位置 | `LIBS :=`（直接附加） | `LDFLAGS`（`-l` / `-L`） |
| 儲存位置 | `project.meta.json` groups["Libraries"] | `project.settings.json` extraLibNames/Paths |
| Settings Webview | TreeView 顯示（可 Add/Delete） | "Extra Libraries" — **兩個獨立清單**（-l / -L 各自 Add/Delete） |

---

## 解析注意事項

### c.linker vs cpp.linker

HT32-IDE 會在 `c.linker` 和 `cpp.linker` 兩個 tool 中各放一份 option，且
`libs`/`paths`/`otherobjs` 的實際值通常只在 **cpp.linker** 中。

舊版只用 `findOpt(allLdOpts, ...)` 會找到 c.linker 的空值就停止，導致 cpp.linker 的值被忽略。

**正確做法**：對列表型 option 一律用 `filter` + `flatMap` + `Set` 收集全部：

```ts
const extraLibNames = [...new Set(allLdOpts
  .filter((o: any) => String(o.superClass ?? '').includes('linker.libs'))
  .flatMap((o: any) => listValues(o)))];
```

Boolean option 用 `some()`：

```ts
const useNano = allLdOpts.some((o: any) =>
  String(o.superClass ?? '').includes('linker.usenewlibnano') && o.value === 'true');
```

### c.compiler vs cpp.compiler

同樣的問題存在於 compiler 的 defines / include paths，一律從 c.compiler + cpp.compiler 合併讀取。

---

### extraLibPaths：PARENT-n-PROJECT_LOC 自動搜尋

HT32-IDE `.cproject` 的 `-L` 路徑有時是開發者機器的**舊版絕對路徑**，換版本後路徑不存在。HT32-IDE 能找到 library 是因為其 linked resources 使用 `PARENT-n-PROJECT_LOC` 相對機制，等同自動搜尋專案上層目錄。

**我們的做法**（`parseHt32IdeProject`）：對每個 `extraLibNames` 中的 library，若現有 `extraLibPaths` 裡都找不到 `lib<Name>.a`，就往 `projectDir` 上層最多 6 層搜尋，找到後加入 `extraLibPaths`：

```ts
for (const libName of extraLibNames) {
  const alreadyCovered = extraLibPaths.some(p => fs.existsSync(join(p, `lib${libName}.a`)));
  if (alreadyCovered) continue;
  // 往上搜尋 lib<Name>.a（對應 PARENT-1 ~ PARENT-6-PROJECT_LOC）
  let dir = projectDir;
  for (let n = 0; n < 6; n++) {
    if (fs.existsSync(join(dir, `lib${libName}.a`))) { extraLibPaths.push(dir); break; }
    dir = path.dirname(dir);
  }
}
```

**extraLibPaths 儲存格式**（`ht32-project-assistant-for-vs-code.ts`）：
- 路徑存在 → 轉為相對 `bgDir`（Makefile cwd）的路徑，例如 `../..`
- 路徑不存在（stale）→ 保留原始絕對路徑，由 user 在 Settings Webview 手動修正

實際案例：`DataLoggerLCD` cproject 存了 `V1.3.2_6448` 舊路徑 → stale 保留 + PARENT-2 找到 `V1.16.1_8761/...DataLoggerLCD(V1.2) - ht32-ide` → 轉為 `../..`；GCC 透過 `../..` 找到 `libHoltekPDF32.a`。
