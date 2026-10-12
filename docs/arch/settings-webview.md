# Settings Webview — 所有選項的資料流對照表

Settings Webview 的每個選項儲存在 `project.settings.json`，儲存後透過兩條路徑反映到輸出檔：

1. **`regenAllMakefileFlags`** → `regenerateMakefileFlags` → Makefile / compile_commands.json
2. **`generateTasksAndLaunchAndMakefile`** → tasks.json / launch.json / pyocd.yaml

---

## Compiler 分頁

| 設定 | Makefile | compile_commands.json | 備註 |
|---|---|---|---|
| optimizationLevel | ✅ | ✅ | |
| debugInfo | ✅ | ✅ | |
| fpu / floatAbi | ✅ | ✅ | |
| includePaths | ✅ | ✅ | via includes.list（writeCCDbFromLists 讀 list） |
| cDefs | ✅ | ✅ | via defines.list |
| aDefs | ✅ | — | ASM only |
| useLto | ✅ | — | -flto 同時加進 CFLAGS 和 LDFLAGS |
| extraCFlags | ✅ | — | by design：任意 flags 無法放入 lists |

---

## Linker 分頁

| 設定 | Makefile | compile_commands.json | 備註 |
|---|---|---|---|
| gcSections | ✅ | ✅ | CFLAGS：-ffunction-sections -fdata-sections；LDFLAGS：-Wl,--gc-sections |
| useNano / useNosys | ✅ | — | LDFLAGS only |
| printfFloat / scanfFloat | ✅ | — | LDFLAGS -u _printf_float / -u _scanf_float |
| extraLibs / extraLibNames / extraLibPaths | ✅ | — | LDFLAGS only |
| extraLDFlags | ✅ | — | LDFLAGS only |
| linkerScripts | ✅ | — | 存於 project.meta.json，不在 ProjectSettings |

---

## Debugger 分頁

| 設定 | tasks.json | launch.json / pyocd.yaml | 備註 |
|---|---|---|---|
| serverType | ✅ pyocd/openocd 分支 | ✅ | 決定整條下載 + debug 路徑 |
| debugInterface | ✅ interfaceCfgPath | ✅ configFiles | OpenOCD only |
| adapterSerial | ✅ pyocd `--probe` / OpenOCD `adapter serial` | ✅ | 空字串 = 自動選 |
| adapterSpeed | ✅ pyocd `--frequency`（kHz×1000）/ OpenOCD `adapter speed`（kHz） | ✅ | |
| openocdDebugLevel | ✅ pyocd `-v`/`-vv` + OpenOCD `-d1`/`-d3`/`-d4` | ✅ serverArgs | level 2 = 預設，不加旗標 |
| eraseMode | ✅ pyocd `--no-erase` / OpenOCD `flash write_image`（無 erase） | — | none 時 pyocd.yaml 仍設 `erase: sector` |
| smartFlash | ✅ pyocd.yaml `smart_flash:` | — | PyOCD only |
| flashLoaders | ✅ pyocd_user.py / OpenOCD HLM | — | SPIM extra loaders |
| svdFile | — | ✅ 直接使用或自動從 DFP 查找 | |
| dfpPath | — | ✅ SVD 自動查找的 search path | 不影響 pyocd `--pack`（一律用 bundled） |
| outputName | ✅ ELF 路徑（effectiveTargetName） | ✅ executable 欄位 | |
| postBuildCmd | ✅ Post-Build task（.bat 自動加 cmd /c） | — | |

---

## Build 分頁

| 設定 | Makefile | tasks.json / launch.json | 備註 |
|---|---|---|---|
| outputName | ✅ TARGET := | ✅ executable 欄位 | 同時影響 Debugger 的 ELF 路徑 |
| postBuildCmd | — | ✅ Post-Build task | .bat 自動加 cmd /c |
