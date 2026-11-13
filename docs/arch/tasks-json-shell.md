# tasks.json Task 執行類型設計決策

## 問題

工作區路徑含有 PowerShell 特殊字元（如 `(~!%^)`）時，VS Code 的 `type: 'shell'` task 會把整條指令拼成字串丟給 PowerShell 解析，雙引號也擋不住這些字元：

```
make -j -C "E:\FWLib_V1.21.1(~!%^)\Project\build-gen"
~!%^ : 無法辨識 '~!%^' 詞彙...
```

## 各 Task 的選擇

| Task | 類型 | 理由 |
|---|---|---|
| Build / Compile | `type: 'ht32-build'`（CustomExecution） | extension 自己 spawn make，可在同一個 terminal 顯示 error/warning 統計行 |
| Clean | `type: 'process'` | 不需要統計，直接 spawn |
| Kill OpenOCD | `type: 'shell'` + `cmd.exe` | 指令含 `2>nul & exit 0`（shell 語法） |
| Post-Build | `type: 'shell'` | 使用者自訂指令，必須支援任意 bat / shell 語法 |
| pyOCD Download | `type: 'shell'` + `quoting: 'strong'` | 所有路徑以 `{ value, quoting: 'strong' }` 包裝 |
| OpenOCD Download / OpenOCD-keep | `type: 'shell'` + `quoting: 'strong'` | 同上 |

## ht32-build CustomExecution 架構

Build / Compile task 使用自訂類型 `ht32-build`，由 extension 在 `activate()` 裡透過 `vscode.tasks.registerTaskProvider('ht32-build', ...)` 提供執行邏輯。

**任務定義欄位**（寫進 tasks.json）：

| 欄位 | 說明 |
|---|---|
| `make` | make 執行檔完整路徑（或 `'make'`） |
| `cwd` | build-gen 目錄的絕對路徑（由 `generateTasksAndLaunchAndMakefile` 產生，每次開專案更新） |
| `args` | make 參數陣列，不含 `-C`（cwd 由 spawn 設定） |
| `extraPath` | make dir + gcc dir 的實際路徑，spawn 時加到 PATH 前面 |

**resolveTask 流程**：VS Code 讀到 `type: 'ht32-build'` → 呼叫 provider 的 `resolveTask()` → 回傳帶 `CustomExecution` + `BuildPseudoterminal` 的 `vscode.Task`。

**BuildPseudoterminal**（`src/ht32-project-assistant-for-vs-code.ts`）：
- `open()`: spawn make，逐行 pipe stdout/stderr 到 terminal，計算 `file:line:col: error/warning:` 格式的行數
- make 結束後：若 exit code 非 0 或收到 signal（使用者取消），顯示紅色 "Build cancelled/failed" 統計行；否則依 error/warning 數顯示紅/黃/綠
- `on('error')`: spawn 失敗（ENOENT/EACCES）時顯示錯誤訊息並以 exit 1 關閉 terminal
- `close()`: 設 `_cancelled = true` 後 kill make；close handler 讀 `_cancelled` 而非 signal（Windows kill() 不送 signal，signal 永遠為 null）
- label 三態：`_cancelled` → "Build cancelled"、exit≠0 → "Build failed"、成功 → "Build complete"

**VS Code problem matcher**：tasks.json 裡的 inline `problemMatcher`（`makeGccProblemMatcher`）由 VS Code task engine 從 JSON 獨立套用，不受 `resolveTask()` 回傳的 task 影響。

`fileLocation` 設為 `'absolute'`（非 `['autoDetect', cwd]`）。原因：`BuildPseudoterminal.open()` 會在輸出每行前呼叫 `toAbsLine()`，將 GCC 診斷行的相對路徑（如 `../Src/main.c:10:5: error:`）轉換成絕對路徑後再寫入 terminal。如此可正確導覽到 workspace 外的檔案（例如 FWLib library 目錄），且不依賴 VS Code 展開 `${workspaceFolder}` 變數（CustomExecution 不保證展開）。

## 為何 Clean 不用 ht32-build

Clean 不需要統計 error/warning，維持 `type: 'process'` 更簡單。

## 注意

`cwd` 與 `extraPath` 是 build 當時的絕對路徑，tasks.json 由每次開啟專案時的 `generateTasksAndLaunchAndMakefile` 重新產生，不需要手動維護。`.vscode/` 整個目錄在 `.gitignore` 中，不會提交到版本庫。
