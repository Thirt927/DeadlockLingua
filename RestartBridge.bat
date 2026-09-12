@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
call "%~dp0StopBridge.bat"
echo Starting DeadlockLingua bridge...
call "%~dp0StartDeadlock.bat"
