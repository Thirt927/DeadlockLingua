@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"

rem ============================================================
rem  DeadlockLingua - open the translation overlay WITHOUT the game.
rem  overlay_window.ps1 holds a single-instance mutex, so launching a
rem  second copy makes it exit silently: you would then see neither the
rem  window, nor the tray icon, nor the hotkey. So kill any running
rem  overlay instance first, then start a fresh one.
rem ============================================================

echo [LCT] 正在打开翻译悬浮窗...

rem ---- kill any existing overlay instance (never self) ----
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -match 'overlay_window\.ps1' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>nul
ping -n 2 127.0.0.1 >nul

start "" powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0scripts\overlay_window.ps1"
exit /b 0