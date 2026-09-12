@echo off
chcp 65001 >nul 2>nul
rem ============================================================
rem  Babel Tower launcher (v3)
rem  1. Start local translation bridge (core\bridge_server.js)
rem  2. (optional) add -game to also launch Deadlock
rem  Usage:
rem    StartDeadlock.bat            start bridge only
rem    StartDeadlock.bat -game      start bridge + launch game
rem ============================================================
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "WITH_GAME=0"
if /i "%~1"=="-game" set "WITH_GAME=1"
if /i "%~1"=="--with-game" set "WITH_GAME=1"

rem ---- localized messages (variables avoid codepage issues inside blocks) ----
set "MSG_NONODE=未找到 Node.js。请安装 Node.js 18+,或把便携版放到 portable-node\node.exe"
set "MSG_ALREADY=桥已在运行: http://127.0.0.1:8791"
set "MSG_KILL=端口 8791 被占用但桥健康检查未通过,正在清理残留进程并重启..."
set "MSG_START=正在启动本地翻译桥..."
set "MSG_OK=桥启动成功: http://127.0.0.1:8791"
set "MSG_FAIL=桥启动失败!请查看 logs\bridge.log 或桥窗口排查原因。"
set "MSG_FAIL2=常见原因: 端口被占用 / config.json 语法错误 / Node 版本过低。"
set "MSG_READY=桥已就绪。从 Steam 启动 Deadlock 即可。"
set "MSG_GAME=需要连游戏一起启动时使用: StartDeadlock.bat -game"
set "MSG_DONE=完成。游戏内按 Enter 打开聊天,输入 /tr 打开设置。"
set "MSG_LAUNCH=正在启动 Deadlock..."
set "MSG_LOG=桥日志: logs\bridge.log"
set "MSG_CLOSE=桥在最小化窗口 LinguaChatBridge 中运行,关闭该窗口即停止桥"

rem ---- locate node ----
set "NODE_EXE="
if exist "portable-node\node.exe" (
    set "NODE_EXE=%~dp0portable-node\node.exe"
) else (
    where node >nul 2>nul
    if not errorlevel 1 (
        for /f "delims=" %%i in ('where node') do set "NODE_EXE=%%i"
    )
)
if not defined NODE_EXE (
    echo [LCT] %MSG_NONODE%
    pause
    exit /b 1
)

rem ---- bridge already running? (health check) ----
set "BRIDGE_OK=0"
call :health_check
if "%BRIDGE_OK%"=="1" (
    echo [LCT] %MSG_ALREADY%
    goto game
)

rem ---- port occupied but bridge not responding? kill stale process ----
netstat -ano | findstr /c:":8791 " | findstr /i "LISTENING" >nul 2>nul
if not errorlevel 1 (
    echo [LCT] %MSG_KILL%
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:":8791 " ^| findstr /i "LISTENING"') do (
        taskkill /f /pid %%p >nul 2>nul
    )
    ping -n 2 127.0.0.1 >nul
)

rem ---- start bridge (hidden background process + log file) ----
if not exist "logs" mkdir "logs"
echo [LCT] %MSG_START%
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%NODE_EXE%' -ArgumentList 'core\bridge_server.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden"

rem ---- wait and verify (max ~15s) ----
set "BRIDGE_OK=0"
for /l %%i in (1,1,15) do (
    ping -n 2 127.0.0.1 >nul
    call :health_check
    if "!BRIDGE_OK!"=="1" goto verified
)
:verified
if "!BRIDGE_OK!"=="1" (
    echo [LCT] %MSG_OK%
) else (
    echo [LCT] %MSG_FAIL%
    echo [LCT] %MSG_FAIL2%
    pause
)

:game
if "%WITH_GAME%"=="1" (
  echo [LCT] %MSG_LAUNCH%
  start "" "steam://rungameid/1422450"
) else (
  echo [LCT] %MSG_READY%
  echo [LCT] %MSG_GAME%
)
echo [LCT] %MSG_LOG%
echo [LCT] %MSG_DONE%
endlocal
exit /b 0

:health_check
set "BRIDGE_OK=0"
where curl >nul 2>nul
if errorlevel 1 (
    powershell -NoProfile -Command "try{$r=Invoke-WebRequest -Uri 'http://127.0.0.1:8791/api/v1/health' -UseBasicParsing -TimeoutSec 2; exit 0} catch { exit 1}" >nul 2>nul
    if not errorlevel 1 set "BRIDGE_OK=1"
) else (
    curl -s -m 2 "http://127.0.0.1:8791/api/v1/health" >nul 2>nul
    if not errorlevel 1 set "BRIDGE_OK=1"
)
exit /b 0
