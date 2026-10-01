@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"

rem ============================================================
rem  DeadlockLingua - 手动打开翻译悬浮窗(不需要启动游戏)
rem  双击即可。窗口已在运行时不会有第二个(脚本内有互斥锁)。
rem  只开悬浮窗不开桥时,窗口会显示"桥离线"。
rem ============================================================

echo [LCT] 正在打开翻译悬浮窗...
start "" powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0scripts\overlay_window.ps1"
exit /b 0
