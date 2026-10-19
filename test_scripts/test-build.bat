@ECHO OFF
SETLOCAL
CD /D "%~dp0"

ht32vs-make.exe "E:\HT32_STD_5xxxx_FWLib_V1.21.1_9874\example\ADC\AnalogWatchdog\HT32_VSCode\Project_50452.ht32vs" -o test.log

IF %ERRORLEVEL% NEQ 0 (
    ECHO [Failed] exit code %ERRORLEVEL%
    EXIT /B %ERRORLEVEL%
)

ECHO [Done]
