[English](https://ht32-holtek.github.io/ht32-vscode/) | [繁體中文](https://ht32-holtek.github.io/ht32-vscode/README_TRAD) | [简体中文](https://ht32-holtek.github.io/ht32-vscode/README_SIMP)

# Holtek HT32 VS Code Extension

Holtek HT32 系列 Cortex-M 微控制器（M0+/M3/M4）專用 VS Code 擴充功能。支援匯入 Keil uVision 與 HT32-IDE 專案，或從頭建立新專案，並透過 **pyOCD**（預設）或內建 OpenOCD 實現一鍵編譯、燒錄與除錯。

---

<br>

## 功能簡介

<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/overview.jpg" width="800" style="border:1px solid #ccc; border-radius:4px; padding:3px;">

| # | 區域 | 說明 |
|---|------|------|
| **1** | HT32 活動列圖示 | 點擊開啟 HT32 面板 |
| **2** | 專案檔案樹 | 原始碼群組：右鍵可新增/移除檔案與群組 |
| **3** | 工具列 | 快速操作按鈕：**編譯**、**清除建置輸出**、**燒錄**、**除錯**、**開啟設定** 等<br>工具列最右側的 **`···`（更多動作）** 按鈕內含 **開啟專案**、**關閉專案** 與 **建立專案** |
| **4** | 編輯器 | 主程式碼編輯區：顯示任何開啟中的原始檔 |
| **5** | Configuration Wizard 控制項 | 開啟含有 Configuration Wizard 語法的檔案時出現於右上角<br>**預覽圖示**：可直接開啟視覺化精靈<br>**Text Editor ▼** 下拉選單：可切換文字編輯器與精靈視圖 |
| **6** | 底部面板 | **Problems**：編譯錯誤與警告<br>**Output**：擴充功能與除錯器 log<br>**Debug Console**：除錯輸出<br>**Terminal**：Make 編譯的原始輸出 |

---

<br>

## 功能特色

| 功能 | 說明 |
|------|------|
| **建立新專案** | 精靈式專案產生器，支援 HT32 FWLib（標準系列與 49x 系列） |
| **匯入 uVision** | 匯入 Keil `.uvprojx` / `.uvmpw` 專案，自動產生 Makefile、連結腳本、clangd 設定 |
| **匯入 HT32-IDE** | 匯入一個或多個 Eclipse CDT `.project`/`.cproject` 專案資料夾 |
| **編譯 / 清除** | 一鍵或工具列按鈕；支援複合式 Post-Build 任務 |
| **除錯** | Cortex-Debug + pyOCD（預設）或內建 OpenOCD；支援 Flash & Debug 或 Attach 模式 |
| **燒錄** | 透過 pyOCD 或內建 OpenOCD 燒錄韌體；支援 CMSIS-DAP（e-Link32）、J-Link、ST-Link |
| **專案設定** | 提供編譯器旗標、除錯介面、Post-Build 指令的 WebView 設定面板 |
| **專案檔案樹** | 原始碼群組檢視，支援新增/移除檔案與群組 |
| **設定精靈** | HT32 設定檔視覺化編輯器（`conf.h`、`usbdconf.h`、`startup.s`），相容 Keil 精靈語法 |
| **Code Intelligence (clangd)** | 自動產生 `.clangd` 與各專案獨立的 `compile_commands.json` |

---

<br>

## 安裝需求

| 項目 | 說明 |
|------|------|
| 作業系統 | Windows x64 |
| VS Code | 1.106.3 以上 |
| 除錯器 | Holtek e-Link32 Pro / Lite；支援 J-Link、ST-Link |
| FWLib | 需要 |

> **OpenOCD**：已內建<br>
> **pyOCD**：首次使用時自動安裝<br>
> **GCC 工具鏈**：擴充功能啟動時自動偵測；找不到時透過 winget 自動安裝（**需 GCC 8 以上**）<br>
> **相依擴充功能**：安裝時自動一併安裝 **Cortex-Debug**（除錯介面）與 **Holtek HT32 Configuration Wizard**（[設定精靈](https://marketplace.visualstudio.com/items?itemName=holtek.ht32-config-vscode)）。

> 💡 **提示：** 當 VS Code 在**右下角**彈出通知詢問是否安裝缺少的元件（擴充功能、GCC 工具鏈、pyOCD），請點選 **Install**。

<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/install_tip.jpg" width="400" style="border:1px solid #ccc; border-radius:4px; padding:3px;">

---

<br>

## 安裝擴充功能

**方法一：從 .vsix 安裝**

1. VS Code → 擴充功能 → `...` → **Install from VSIX...**
2. 選取 `ht32-vscode-x.x.x.vsix`
> **注意：** 安裝完成後請點選右下角提示的 **Reload Window** 重新載入視窗。

> **注意：** VS Code 會自動從 Marketplace 尋找並安裝擴充功能的相依套件。
> 若相依套件尚未發布至 Marketplace，安裝將會失敗。

<table><tr>
<td><img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/1.jpg" width="350" style="border:1px solid #ccc; border-radius:4px; padding:3px;"></td>
<td><img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/2.jpg" width="350" style="border:1px solid #ccc; border-radius:4px; padding:3px;"></td>
</tr></table>

---

<br>

**方法二：從 Marketplace 安裝**

1. 擴充功能搜尋欄輸入 `Holtek HT32 VS Code Extension`（或直接搜尋 `holtek` / `ht32` 即可找到）
2. 點擊 **Install**
> **注意：** 安裝完成後請點選右下角提示的 **Reload Window** 重新載入視窗。

<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/3.jpg" width="300" style="border:1px solid #ccc; border-radius:4px; padding:3px;">

---

<br>

**方法三：從 HT32 面板更新（已安裝舊版時）**

HT32 面板下方的**更新擴充功能**區塊提供兩個入口：

| 按鈕 | 說明 |
|------|------|
| **線上更新** | 自動從 Marketplace 下載最新版本並安裝 |
| **從 VSIX 安裝** | 手動選取 `.vsix` 檔案安裝指定版本 |

> **注意：** 安裝完成後請點選右下角提示的 **Reload Window** 重新載入視窗。

---

<br>

## 介面介紹

安裝後，左側**活動列**出現 **HT32 圖示**，點擊展開 HT32 面板。

**專案未開啟時**，主畫面依序顯示建立與開啟專案的按鈕、查看說明文件的連結、轉換 uVision 與 HT32-IDE 專案的按鈕，以及更新裝置套件（線上更新、從 Pack 檔案安裝）與更新擴充功能（線上更新、從 VSIX 安裝）的快速入口。若曾開啟過專案，下方會列出最近開啟清單，點擊即可直接開啟。

<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/4-t.jpg" width="300" style="border:1px solid #ccc; border-radius:4px; padding:3px;">

---

<br>

**工具列按鈕（專案載入後顯示）：**

| 按鈕 | 功能 |
|------|------|
| 編譯 | 編譯 |
| 除錯 | 透過 pyOCD 或 OpenOCD 啟動 Cortex-Debug 除錯（Flash & Debug 或 Attach 模式） |
| 清除建置輸出 | 刪除 `build/` 輸出目錄 |
| 燒錄 | 燒錄韌體（不啟動除錯） |
| 清除 Flash | 清除整顆晶片的 Flash（chip erase） |
| 開啟設定 | 開啟專案設定 |
| 產生編譯與除錯設定 | 重新產生 `tasks.json` 與 `launch.json` |

**`···`（更多動作）** 選單另外包含：

| 項目 | 功能 |
|------|------|
| 建立專案 | 開啟建立專案精靈 |
| 開啟專案 | 開啟 `.ht32vs` 專案檔 |
| 關閉專案 | 關閉目前載入的專案 |

<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/more_actions.jpg" width="300" style="border:1px solid #ccc; border-radius:4px; padding:3px;">

---

<br>

**專案檔案樹**顯示原始碼群組結構，方便管理專案檔案。

<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/5-1.jpg" width="300" style="border:1px solid #ccc; border-radius:4px; padding:3px;"><br>

將滑鼠移至根節點即可顯示兩個按鈕：**新增子專案（新建）** 與 **新增子專案（現有）**：

| 按鈕 | 功能 |
|------|------|
| **新增子專案（新建）** | 執行精靈，在同一資料夾建立新子專案 |
| **新增子專案（現有）** | 從同一資料夾選取已轉換或建立的專案 |

<br>

## 右鍵選單

| 對象 | 操作 |
|------|------|
| 樹狀根節點（`.ht32vs`） | 重新命名專案檔 |
| 子專案節點 | 上移、下移、在檔案總管開啟資料夾、移除專案（從清單移除）、新增群組 |
| 群組 | 新建檔案、加入現有檔案、新增群組（在此群組下新增子群組）、移除 / 刪除... |
| 檔案 | 檔案設定...（排除編譯 / Execute-only / ROM region）、移除 / 刪除... |
| Linker 檔案（`.ld`） | 移除 / 刪除... |

<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/12.jpg" width="300" style="border:1px solid #ccc; border-radius:4px; padding:3px;"><br>
---

<br>

## 專案檔案（.ht32vs）

每個 HT32 專案都會對應一個 **`.ht32vs` 專案檔**（儲存在 `HT32_VSCode/` 內）。此檔案記錄此專案包含哪些子專案目錄，在轉換或建立專案後自動產生。

### 開啟專案

| 方式 | 說明 |
|------|------|
| **雙擊 `.ht32vs`** | 在檔案總管雙擊 `.ht32vs` 檔案，直接開啟專案 |
| **開啟專案** | 透過歡迎畫面的 **開啟專案** 按鈕、`···` 選單或 `HT32: 開啟專案` 指令瀏覽並開啟 `.ht32vs` 專案檔 |
| **最近的專案** | 點擊最近開啟清單中的任一項目（專案未開啟時顯示） |

### 管理子專案

一個 `.ht32vs` 可包含多個子專案目錄（例如 `Project_IAP` 與 `Project_AP`），可隨時新增或移除。所有子專案必須位於**同一個 `HT32_VSCode/` 資料夾**下。

| 操作 | 方式 |
|------|------|
| **新增子專案（新建）** | 將滑鼠移至根節點 → **新增子專案（新建）** — 執行建立專案精靈，新增子專案。精靈中的**專案資料夾**固定為目前已開啟的專案資料夾，無法變更。 |
| **新增子專案（現有）** | 將滑鼠移至根節點 → **新增子專案（現有）** — 從同一資料夾中選取已轉換或建立的專案 |
| **移除子專案** | 在專案節點按右鍵 → **移除專案**，從清單中移除（磁碟上的檔案不會刪除）。僅剩一個子專案時無法執行。 |
| **上移 / 下移** | 在專案節點按右鍵 → **上移** 或 **下移**，調整子專案在 **Build All** 時的編譯順序。 |

當目前只有**一個**子專案，新增第二個時將提示輸入**多專案檔名**（預設為專案根目錄名稱）。確認後產生：

<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/5-2.jpg" width="800" style="border:1px solid #ccc; border-radius:4px; padding:3px;"><br>
<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/5-3.jpg" width="300" style="border:1px solid #ccc; border-radius:4px; padding:3px;"><br>

| 檔案 | 內容 | 說明 |
|------|------|------|
| `ProjectA.ht32vs` | `{ "projects": ["ProjectA"] }` | 僅包含 ProjectA 的單一專案檔 |
| `ProjectB.ht32vs` | `{ "projects": ["ProjectB"] }` | 僅包含 ProjectB 的單一專案檔 |
| `MyProject.ht32vs` | `{ "projects": ["ProjectA", "ProjectB"] }` | 包含兩個子專案的多專案檔 |

#### 目錄結構

```
MyProject/
└── HT32_VSCode/
    ├── ProjectA.ht32vs          ← 單一專案視圖
    ├── ProjectB.ht32vs          ← 單一專案視圖
    ├── MyProject.ht32vs         ← 多專案視圖（使用中）
    ├── ProjectA/
    │   ├── Makefile
    │   └── ...
    └── ProjectB/
        ├── Makefile
        └── ...
```

---

<br>

## 建立新專案

> 使用前請先從 Holtek 官網下載並準備好 HT32 FWLib。

1. HT32 面板 → **建立專案**
2. 依精靈步驟選擇：

| 步驟 | 內容 |
|------|------|
| ① | 選擇 **HT32 FWLib 根目錄** |
| ② | 選擇 **MCU 型號** |
| ③ | 選擇輸出類型：**可執行檔 (.elf)** 或 **程式庫 (.a)** |
| ④ | 輸入**專案名稱**和儲存位置 |

> **程式庫 (.a)：** 產生靜態函式庫而非可執行檔。建立後只有一個空的 `.c` 檔作為起點——加入你的原始碼並實作函式庫內容即可。

<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/6-t.jpg" width="450" style="border:1px solid #ccc; border-radius:4px; padding:3px;">

<br>

**目錄結構**

```
MyProject/                 ← 使用者命名的專案資料夾
└── HT32_VSCode/           ← VS Code workspace root
    ├── .clangd            ← 開啟專案時自動產生（clangd 設定）
    ├── .vscode/
    │   ├── tasks.json
    │   ├── launch.json
    │   └── settings.json
    ├── <projectName>.ht32vs
    └── <projectName>/     ← 名稱來自精靈中輸入的專案名稱
        ├── Makefile
        ├── sources.list
        ├── compile_commands.json
        ├── *.json
        ├── src/           ← 使用者原始碼
        │   ├── main.c
        │   ├── ht32fxxxx_it.c
        │   ├── system_ht32fxxxx.c
        │   ├── ht32fxxxx_conf.h
        │   └── ht32_op.c
        └── GNU_ARM/       ← 自動產生的 GCC 支援檔案
            ├── startup_ht32fxxxx_gcc_xx.s
            ├── linker.ld
            └── ht32_stack_analysis.c
```

> **注意：工作區信任** — 若 VS Code 以受限模式開啟資料夾，將顯示通知：*「You are in Restricted Mode」*，請點選 **Trust** 以啟用編譯與除錯功能。

<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/22.jpg" width="400" style="border:1px solid #ccc; border-radius:4px; padding:3px;">

---

<br>

## 匯入 Keil uVision 專案

1. HT32 面板 → **轉換 uVision 專案**
2. 選取 `.uvprojx`（單一專案）或 `.uvmpw`（多專案）

`.uvmpw` 可**一次轉換所有子專案**，每個子專案各產生一個獨立的目錄，目錄名稱即為 `.uvprojx` 的檔名。

**自動產生：**

- `Makefile`、linker script（`.ld`）、`startup_xxx_gcc.s`（共用檔位於 `GNU_ARM/`）
- `compile_commands.json`、`tasks.json`、`launch.json`、`settings.json`

**`.uvprojx` 單一專案** — 共用檔輸出至 `HT32_VSCode/GNU_ARM/`；Makefile 與中繼資料輸出至 `HT32_VSCode/Project/`

**`.uvmpw` 多專案** — 每個子專案各一個目錄，目錄名稱取自 `.uvprojx` 檔名（例如 `Project_IAP.uvprojx` + `Project_AP.uvprojx`）：

<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/7.jpg" width="300" style="border:1px solid #ccc; border-radius:4px; padding:3px;">

```
<ProjectRoot>/
├── MDK_ARMv5/             ← 原始 Keil 專案
└── HT32_VSCode/           ← VS Code workspace root
    ├── .vscode/
    │   ├── tasks.json
    │   ├── launch.json
    │   └── settings.json
    ├── GNU_ARM/           ← 共用：startup .s、linker script、ht32_op.c、syscalls.c、ht32_stack_analysis.c
    ├── Project_IAP/       ← 取自 uvprojx 檔名
    │   ├── Makefile
    │   ├── compile_commands.json
    │   └── *.json
    └── Project_AP/
        ├── Makefile
        ├── compile_commands.json
        └── *.json
```

---

<br>

**轉換警告**（如 Keil 預編譯 `.lib` 無法用於 GCC 工具鏈）會顯示在 VS Code **問題（Problems）**面板中。

<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/18.png" width="600" style="border:1px solid #ccc; border-radius:4px; padding:3px;">

> **工作區信任** — 若 VS Code 以受限模式開啟資料夾，擴充功能將顯示通知：*「This workspace is in Restricted Mode. Please trust the workspace to enable all features.」*，請點選 **Trust Workspace** 以啟用編譯與除錯功能。

---

<br>

## 匯入 HT32-IDE 專案

1. HT32 面板 → **轉換 HT32-IDE 專案**
2. 選取一個或多個包含 `.project` / `.cproject` 的**專案資料夾**

每個選取的資料夾各自轉換為 `HT32_VSCode/` 內的獨立目錄，共用 `HT32_VSCode/GNU_ARM/` 存放 startup、linker script 與自動產生的 C 檔案。產生的資料夾結構及**專案樹**組織方式，與匯入 uVision 專案相同。

> **工作區信任** — 若 VS Code 以受限模式開啟資料夾，擴充功能將顯示通知：*「This workspace is in Restricted Mode. Please trust the workspace to enable all features.」*，請點選 **Trust Workspace** 以啟用編譯與除錯功能。

---

<br>

## 建置

- 點擊工具列的 **編譯**
- 或按 `Ctrl+Shift+B`（直接執行預設建置任務 **Build (make)**）

<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/8.jpg" width="500" style="border:1px solid #ccc; border-radius:4px; padding:3px;">

多專案時，工具列的 **編譯**、**除錯**、**清除建置輸出**、**燒錄** 按鈕會彈出**快速選取清單**讓使用者選擇要操作哪個子專案。**編譯** 與 **清除建置輸出** 另有 **全部 Build** / **全部 Clean** 選項，可依序處理所有子專案。編譯順序與**專案樹**的排列順序相同，可在專案節點上按右鍵 **上移 / 下移** 調整。

<br>

也可在「專案設定」中設定 **Post-Build** 命令，Build 成功後自動執行（例如 CRC 計算）。Post-Build 命令的工作目錄為 `HT32_VSCode/`（`${workspaceFolder}`）。

<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/9.jpg" width="300" style="border:1px solid #ccc; border-radius:4px; padding:3px;">

---

<br>

## 清除

- 點擊工具列的 **清除建置輸出**，或按 **Ctrl+Alt+C**
- 刪除 `HT32_VSCode/Project/build/`（或 `HT32_VSCode/Project_xxx/build/`）目錄下所有編譯輸出

---

<br>

## 燒錄與除錯

> **Cortex-Debug** 為相依套件，安裝本擴充功能時會自動一併安裝。

燒錄與除錯皆透過同一**除錯伺服器**執行，可在**設定 → 除錯器 → 除錯伺服器** 切換：

| 除錯伺服器 | 說明 |
|-----------|------|
| **PyOCD**（預設） | 免安裝驅動；首次使用時自動安裝 |
| **OpenOCD** | 已內建；可作為備選方案 |

> 若使用 J-Link 搭配 OpenOCD，Windows 需將驅動更換為 WinUSB；搭配 pyOCD 則保留原廠驅動即可。

所有相關設定詳見「[專案設定 → 除錯器 分頁](#除錯器-分頁)」。

### 燒錄韌體（Download）

> 需要連接支援的除錯器（CMSIS-DAP / J-Link / ST-Link）

1. 確認除錯器已連接並驅動正常
2. 點擊工具列的 **燒錄**，或按 **Ctrl+Alt+D**
3. 韌體自動燒錄，終端機顯示進度

### 清除 Flash（Erase Flash）

清除整顆晶片的 Flash，不燒錄新韌體。適用於現有韌體損壞或需要完全清除的情況。

1. 確認除錯器已連接
2. 點擊工具列的 **清除 Flash**

<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/10.jpg" width="500" style="border:1px solid #ccc; border-radius:4px; padding:3px;">

### 除錯（Debug）

1. 點擊工具列的 **除錯**
2. 自動編譯、燒錄，並開始除錯

### Attach（附接到執行中的目標）

適用於目標板已經在執行（不需要重新燒錄）的情況，例如觀察特定狀態下的程式行為。

1. 確認目標板已上電並執行
2. 按 **F5** 或開啟**執行和除錯**（Ctrl+Shift+D）
3. 從下拉選單選擇 **HT32 PyOCD Attach**（或 **HT32 OpenOCD Attach**）

> 附加模式不會編譯也不會燒錄，直接附接到執行中的目標，不會重置目標。

| 模式 | 說明 |
|------|------|
| HT32 PyOCD Debug | 編譯→燒錄→啟動除錯 |
| HT32 PyOCD Attach | 不燒錄，直接附接到執行中的目標 |
| HT32 OpenOCD Debug | 編譯→燒錄→啟動除錯 |
| HT32 OpenOCD Attach | 不燒錄，直接附接到執行中的目標 |

<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/11.jpg" width="700" style="border:1px solid #ccc; border-radius:4px; padding:3px;">

---

<br>

## Cortex-Debug 操作說明

Cortex-Debug 是本擴充功能的除錯介面，負責提供中斷點管理、變數觀察、記憶體視窗與周邊暫存器查看等功能。

### 除錯工具列

除錯啟動後，畫面上方出現浮動工具列：

| 按鈕 | 快捷鍵 | 說明 |
|------|--------|------|
| Continue / Pause（繼續／暫停） | F5 | 程式暫停時顯示 Continue（繼續執行至下一中斷點）；執行中時顯示 Pause（手動暫停），**同一按鈕切換** |
| Step Over（不進入） | F10 | 執行下一行，不進入呼叫的函式內部 |
| Step Into（進入） | F11 | 進入下一個函式內部 |
| Step Out（跳出） | Shift+F11 | 跳出目前函式，返回呼叫端 |
| Restart（重新開始） | — | 重新燒錄並從頭開始除錯 |
| Stop（停止） | Shift+F5 | 停止除錯工作階段 |

---

### 中斷點（Breakpoints）

- 在程式碼行號左側**點一下**，出現紅點即為設定中斷點；再點一下取消
- **條件中斷點**：在紅點上按右鍵 → **Edit Breakpoint**，可輸入觸發條件（例如 `i == 10`）

---

### 變數觀察（Watch）

左側**執行和除錯**面板的 **WATCH** 區塊可監視任意運算式：

1. 點擊「**＋**」
2. 輸入變數名稱或 C 運算式（例如 `myVar`、`buf[0]`、`*(uint32_t*)0x20000000`）
3. 每次除錯器暫停時自動更新數值

---

### 記憶體視窗（Memory View）

在 **MEMORY** 面板點擊「**＋**」新增記憶體視窗，需依序完成**兩步輸入**：

| 步驟 | 彈出視窗說明 | 輸入內容 | 範例 |
|------|------------|---------|------|
| ① | 起始位址（Enter address to watch） | 要監視的記憶體起始位址（hex） | `0x20000000` |
| ② | 顯示長度（Enter a hex/dec constant or a C-expression for size） | 要顯示的 byte 數量 | `256`、`0x100`、`sizeof(myBuf)` |

> **注意：** 第二個彈出視窗詢問的是**顯示長度**（要顯示幾個 byte），並非第二個位址。  
> 長度可輸入十進位（`256`）、十六進位（`0x100`），或 C 運算式（`sizeof(myBuf)`、`MY_BUF_SIZE`）——Cortex-Debug 會透過除錯器求值後決定顯示範圍。

**切換顯示格式：** Memory View 上方工具列可切換資料寬度

| 按鈕 | 格式 | 說明 |
|------|------|------|
| `1` | Byte | 每格 8-bit |
| `2` | HWord | 每格 16-bit |
| `4` | Word | 每格 32-bit |
| `8` | DWord | 每格 64-bit |

**刪除記憶體視窗：** 點擊 Memory View 標題旁的 **×** 即可移除。

---

### 周邊暫存器（Peripherals）

左側面板的 **PERIPHERALS** 依據 SVD 檔列出所有 MCU 周邊暫存器，展開任一 IP 節點即可即時讀取其暫存器值。

#### IP Clock 尚未開啟時的讀取失敗

展開某個 IP 時，Cortex-Debug 會立即嘗試讀取該 IP 的所有暫存器。若韌體尚未對該 IP 開啟時鐘，硬體會拒絕存取，Output 面板將出現：

```
Error: Failed to read memory at 0x4xxxxxxx
```

**原因：** HT32 的每個 IP 都有獨立的 APB/AHB 時鐘閘控，未開啟時對應的記憶體映射暫存器無法讀取。

**解決方式：**

| 情況 | 做法 |
|------|------|
| 程式還沒執行到時鐘初始化 | 先讓程式跑過 `RCU_APBxPeripClockConfig(RCU_APBx_Periph_XXX, ENABLE)` 再展開 |
| 不需要查看這個 IP | 將節點**收合**，避免錯誤訊息持續出現 |
| 想在一開始就能看到 | 在 `main()` 最前面加入對應 IP 的時鐘開啟，或在時鐘初始化處設中斷點，停下後再展開 |

> 這是正常的硬體行為，不是除錯器或擴充功能的問題。

---

### 呼叫堆疊（Call Stack）

左側面板的 **CALL STACK** 顯示目前的函式呼叫鏈，點擊任一層可在編輯器跳至對應位置並查看該層的區域變數。

---

### 反組譯（Disassembly）

在程式碼編輯區按右鍵 → **Open Disassembly View**，可查看對應的組合語言指令，配合 Step Into 使用可追蹤至指令層級。

---

<br>

## Stack Usage Analysis（堆疊使用分析）

**HT32 Stack Usage Analysis** 顯示於**執行和除錯**（Run & Debug）側邊欄，每次除錯器暫停（中斷點、單步、手動暫停）時自動更新，功能等同於 Keil 的堆疊分析視窗。

### 面板欄位說明

| 欄位 | 說明 |
|------|------|
| **目標** | ELF 檔名（輸出名稱） |
| **堆疊頂端位址（起始）** | 堆疊頂端（最高位址） |
| **堆疊底端位址（末端/上限）** | 堆疊底端（堆疊限制位址） |
| **堆疊大小** | 堆疊總大小 |
| **目前使用量** | 最近一次除錯器暫停時的堆疊使用量 |
| **尖峰使用量** | 最高堆疊使用量（需啟用 watermark 追蹤，見下方說明） |
| **尖峰位址** | 最高使用量發生的記憶體位址 |

<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/21.jpg" width="700" style="border:1px solid #ccc; border-radius:4px; padding:3px;">


### 啟用尖峰（watermark）追蹤

預設 **尖峰使用量** 欄位顯示提示訊息。若需顯示實際峰值：

1. 在 `ht32f5xxxx_conf.h`（或 `ht32f1xxxx_conf.h`）中將 `HTCFG_STACK_USAGE_ANALYSIS` 設為 `1`；49x 系列請在 conf.h 中手動新增此定義
2. 在啟動時呼叫一次 `StackUsageAnalysisInit(0)`（RTOS scheduler 或主迴圈之前）

```c
#include "ht32_stack_analysis.h"

int main(void) {
    StackUsageAnalysisInit(0);   // 將未使用的堆疊空間填入特定 pattern，供峰值追蹤使用
    // ... 其餘初始化
}
```

兩個條件缺一不可；若未滿足，**尖峰使用量** 欄位會顯示提示訊息而非數值。

---

<br>

## 專案設定

點擊工具列的 **開啟設定** 開啟設定面板，面板分為四個分頁：

### 編譯器 分頁

| 設定項目 | 說明 |
|----------|------|
| 優化等級 | `-O0` / `-O1` / `-O2` / `-O3` / `-Os`（預設）/ `-Og` |
| Debug 資訊 | `-g3`（預設，完整 debug）/ `-g`（標準）/ `-g1`（僅行號）/ `-g0`（無，release 用）|
| 浮點 ABI | `soft`（M0/M3）/ `softfp` / `hard`（M4F） |
| FPU | `none` / `fpv4-sp-d16`（M4F）/ `fpv5-sp-d16`（M7）/ `fpv5-d16`（M7） |
| 連結期最佳化 | 啟用 `-flto` |
| Include 路徑 | 所有 `-I` 搜尋路徑，寫入 `includes.list`；轉換時自動填入，可在此新增額外路徑 |
| C 定義 | 前置處理器定義，寫入 `defines.list`；轉換時自動填入，可在此新增額外定義 |
| ASM 定義 | 組譯器前置處理器定義，寫入 `adefines.list`；轉換時自動填入，可在此新增額外定義 |
| 額外 CFLAGS | 附加編譯旗標，例如 `-DDEBUG` |

<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/15-1.jpg" width="500" style="border:1px solid #ccc; border-radius:4px; padding:3px;">
<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/15-2.jpg" width="500" style="border:1px solid #ccc; border-radius:4px; padding:3px;">

---

<br>

### 連結器 分頁

| 設定項目 | 說明 |
|----------|------|
| 移除無用程式碼 | 啟用 `-ffunction-sections -fdata-sections -Wl,--gc-sections`（預設開啟）— 移除未使用的函式與資料 |
| C 執行期程式庫 | `nano`（newlib-nano）/ `nosys`（不使用 syscalls）— 可同時勾選 |
| nano printf 支援浮點數 | 啟用浮點 printf（`-u _printf_float`） |
| nano scanf 支援浮點數 | 啟用浮點 scanf（`-u _scanf_float`） |
| 程式庫 (-l) | 要連結的函式庫名稱。輸入名稱時不需加 `lib` 前綴，例如輸入 `MyDSP`，GCC 會在搜尋路徑中尋找 `libMyDSP.a`。若要直接加入預建 `.a` 檔（不透過搜尋路徑），請在工程視圖的群組上按右鍵，選擇**加入檔案至群組**。 |
| 搜尋路徑 (-L) | GCC 搜尋函式庫的目錄（`-L"dir"`）。將含有 `.a` 檔的資料夾加入此處，再於上方 程式庫 (-l) 填入對應的庫名。 |
| 額外 LDFLAGS | 直接傳給連結器的附加旗標。常見用途：`-Wl,--wrap=FunctionName`（攔截並替換特定函式）、`-Wl,--defsym=__heap_size=0x400`（覆蓋連結器符號值）。完整選項請參考 [GNU ld manual](https://sourceware.org/binutils/docs/ld/)。 |
| Linker Script | 連結腳本路徑（相對於 build 目錄） |

<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/15-3.jpg" width="500" style="border:1px solid #ccc; border-radius:4px; padding:3px;">

---

<br>

### 除錯器 分頁

| 設定項目 | 說明 |
|----------|------|
| **除錯伺服器** | **`PyOCD`**（預設）/ `OpenOCD` |
| 除錯介面 | `CMSIS-DAP`（e-Link32）/ `J-Link` / `ST-Link` |
| 探針序號 | 指定探針序號（空白 = 自動） |
| 探針速度 | 傳輸速率 kHz（空白 = 介面預設） |
| 除錯等級 | 1~4 逐漸詳細（預設 1）|
| DFP 路徑 | 自訂 DFP 路徑 |
| SVD 檔案 | 周邊暫存器 SVD 檔案（空白 = 自動偵測） |
| 抹除模式 | `erase_sector`（預設）/ `erase_chip` |
| Smart Flash | （僅 PyOCD）跳過未更動頁面，加速重複燒錄； |
| Flash Loader | 附加外部 Flash Loader（例如 SPI Flash） |

<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/17.jpg" width="500" style="border:1px solid #ccc; border-radius:4px; padding:3px;">
<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/16.png" width="500" style="border:1px solid #ccc; border-radius:4px; padding:3px;">

> 若使用 J-Link 搭配 OpenOCD，Windows 需將驅動更換為 WinUSB。切換後 SEGGER 工具（Keil、J-Flash 等）將無法辨識 J-Link，還原方式為重新安裝 SEGGER J-Link Software。搭配 pyOCD 則無需更換驅動。

---

<br>

### 建置 分頁

| 設定項目 | 說明 |
|----------|------|
| 輸出檔名 | 自訂輸出檔名（留空則沿用轉換時的名稱） |
| 建置後指令 | Build 後執行的命令（工作目錄：`${workspaceFolder}` = `HT32_VSCode/`） |

<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/15-4.jpg" width="500" style="border:1px solid #ccc; border-radius:4px; padding:3px;">

<br>

### 通用 區塊

顯示於 Settings 面板下方，所有專案區塊之後。設定儲存於 VS Code 機器設定（User Settings），所有專案共用。

| 設定項目 | 說明 |
|----------|------|
| 除錯前先建置 (F5) | 取消勾選後，F5 直接燒錄並啟動除錯，不重新編譯（預設：勾選） |
| GCC 路徑 (arm-none-eabi-gcc) | `arm-none-eabi-gcc` 路徑（空白 = 自動偵測） |
| OpenOCD 路徑 | OpenOCD 路徑（空白 = 使用內建 OpenOCD） |

<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/15-5.jpg" width="500" style="border:1px solid #ccc; border-radius:4px; padding:3px;">

---

<br>

## 設定精靈（Configuration Wizard）

**Holtek HT32 Configuration Wizard** 為相依擴充功能，安裝 Holtek HT32 VS Code Extension 時會自動一併安裝，提供 HT32 韌體設定檔的視覺化圖形編輯介面，相容 Keil MDK Configuration Wizard 語法。

### 支援的設定檔

| 檔案 | 用途 |
|------|------|
| `ht32fxxxx_conf.h` | Retarget（printf/scanf 輸出埠、鮑率、函式庫啟用） |
| `system_ht32fxxxx_NN.c` | 時鐘設定（PLL、HSE/HSI、HCLK、WDT） |
| `ht32fxxxx_NN_usbdconf.h` | USB 端點設定 |
| `startup_ht32fxxxx_NN.s` | Stack / Heap 大小 |

### 開啟方式

**方法一 — 編輯器標題按鈕（推薦）：**  
開啟支援的檔案（`.h`、`.c`、`.s`）後，點擊編輯器右上角的 **Open in Holtek Configuration Wizard** 按鈕即可切換為 Wizard 視圖；點擊 **Reopen as source file** 切換回文字編輯。

<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/20.jpg" width="700" style="border:1px solid #ccc; border-radius:4px; padding:3px;">

**方法二 — 右鍵選單：**  
在左側**檔案總管**面板中對 `.h`、`.c`、`.s` 檔案按右鍵 → **Open in Holtek Configuration Wizard**

**方法三 — 命令面板：**  
`Ctrl+Shift+P` → **HT32: Open in Holtek Configuration Wizard**

### 控制項類型

| 類型 | 說明 |
|------|------|
| Checkbox（`<q>`） | 切換開關 |
| Dropdown（`<o>` 含選項） | 從預定義清單選擇 |
| Number（`<o>` 含範圍） | 在允許範圍內輸入數值 |
| Enable Section（`<e>`） | 主開關，控制整組設定的啟用／停用 |
| Heading（`<h>`） | 可摺疊群組 |

---

<br>

## Code Intelligence（clangd）

匯入或建立專案後，開啟專案時自動為每個專案產生 `.clangd` 與獨立的 `compile_commands.json`，提供完整的程式碼智慧辨識支援。多專案時，在專案樹點選任意節點，`.clangd` 會自動切換至該專案的 `compile_commands.json`。

<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/13.jpg" width="700" style="border:1px solid #ccc; border-radius:4px; padding:3px;">
<img src="https://raw.githubusercontent.com/ht32-holtek/ht32-vscode/main/media/14.jpg" width="700" style="border:1px solid #ccc; border-radius:4px; padding:3px;">


---

<br>

## 指令（Ctrl+Shift+P → "HT32"）

| 指令 | 說明 |
|------|------|
| `HT32: 建立專案` | 開啟建立專案精靈 |
| `HT32: 開啟專案` | 瀏覽並開啟 `.ht32vs` 專案檔 |
| `HT32: 轉換 uVision 專案` | 匯入 Keil `.uvprojx` / `.uvmpw` |
| `HT32: 轉換 HT32-IDE 專案` | 匯入 Eclipse CDT `.project` |
| `HT32: 編譯` | 執行建置任務 |
| `HT32: 燒錄` | 燒錄韌體 |
| `HT32: 清除 Flash` | 清除整顆晶片的 Flash（chip erase） |
| `HT32: 除錯` | 啟動除錯工作階段 |
| `HT32: 清除建置輸出` | 清除編譯輸出 |
| `HT32: 開啟設定` | 開啟專案設定 |
| `HT32: 產生編譯與除錯設定` | 重新產生 `tasks.json` 與 `launch.json` |
| `HT32: 重新產生 compile_commands.json` | 重新產生供 clangd 使用的 `compile_commands.json`；多專案工作區會顯示 QuickPick，可選擇單一專案或 **All Projects** |
| `HT32: 重新產生 Makefile` | 從 `project.meta.json` 重新產生 `Makefile`；多專案工作區會顯示 QuickPick，可選擇單一專案或 **All Projects** |
| `HT32: 關閉專案` | 關閉目前載入的專案 |
| `HT32: 清除最近專案` | 清除最近開啟清單 |
| `HT32: 重新整理堆疊使用分析` | 手動重新整理 Stack Usage Analysis 面板 |
| `HT32: 更新擴充功能（線上）` | 從 VS Code Marketplace 檢查新版本並自動安裝 |
| `HT32: 從 VSIX 安裝擴充功能` | 開啟檔案選擇器，安裝本機 `.vsix` 套件 |
| `HT32: 更新裝置套件（線上）` | 從 Holtek 官網下載並安裝缺少的 DFP packs |
| `HT32: 從 Pack 檔案安裝裝置套件` | 開啟檔案選擇器，安裝一個或多個本機 `.pack` 檔案 |

> **注意：** Device Pack 的用途是讓 pyocd 認識原本不支援的 MCU 型號，只對使用 **pyocd** 的 debug 設定有效。若使用 OpenOCD，它有自己的內建腳本，安裝 Pack 不會有任何影響。

---

<br>

## 第三方授權

內建與自動安裝元件的授權資訊請參閱 `THIRD_PARTY_LICENSES.md`。

---

<br>

## 授權

Proprietary — 請參閱 `LICENSE`

