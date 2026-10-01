@echo off
rem ============================================================
rem  DeadlockLingua - Install auto-start (double-click to run)
rem  Registers the local bridge to start at Windows login and
rem  exit automatically when Deadlock closes.
rem ============================================================
cd /d "%~dp0"
echo [DeadlockLingua] Installing auto-start...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\autostart.ps1" -Action Install
echo.
echo Done. Now you can just launch Deadlock from Steam.
echo Uninstall anytime with remove-autostart.bat
pause
