@echo off
setlocal enabledelayedexpansion

set "INI=%~dp0fwlib-paths.ini"

for /f "usebackq tokens=* delims=" %%L in ("%INI%") do (
    set "LINE=%%L"
    if "!LINE:~0,1!" neq "#" if "!LINE!" neq "" (
        call :process "!LINE!"
    )
)
echo.
echo Done.
goto :eof

:process
set "LIB=%~1"

REM --- STD series: project_template\IP\{Example|Template|Template_USB}\HT32_VSCode ---
for %%T in (Example Template Template_USB) do (
    set "BASE=!LIB!\project_template\IP\%%T\HT32_VSCode"
    if exist "!BASE!\" (
        call :clean_base "!BASE!" "%%T"
    )
)

REM --- 49x series: project\ht32f49*\templates\HT32_VSCode ---
for /d %%B in ("!LIB!\project\ht32f49*") do (
    set "BASE=%%B\templates\HT32_VSCode"
    if exist "!BASE!\" (
        call :clean_base "!BASE!" "%%~nxB\templates"
    )
)
goto :eof

:clean_base
set "BASE=%~1"
set "LABEL=%~2"
echo [!LABEL!] !BASE!

REM 1. Delete .vscode folder
if exist "!BASE!\.vscode\" (
    rd /s /q "!BASE!\.vscode"
    echo   Deleted .vscode\
)

REM 2. Delete non-json files in Project / Project_* directories
for /d %%P in ("!BASE!\Project" "!BASE!\Project_*") do (
    for %%F in ("%%P\*.*") do (
        if /i not "%%~xF"==".json" (
            del /f /q "%%F"
            echo   Deleted: %%~nxF  [%%~dpF]
        )
    )
)

REM 3. Remove postBuildCmd from project.settings.json
for /d %%P in ("!BASE!\Project" "!BASE!\Project_*") do (
    if exist "%%P\project.settings.json" (
        powershell -NoProfile -Command ^
            "$f='%%P\project.settings.json';" ^
            "$j=Get-Content $f -Raw | ConvertFrom-Json;" ^
            "$j.PSObject.Properties.Remove('postBuildCmd');" ^
            "[IO.File]::WriteAllText($f,($j|ConvertTo-Json -Depth 10),(New-Object Text.UTF8Encoding $false))"
        echo   Cleaned postBuildCmd: %%~nxP\project.settings.json
    )
)
goto :eof
