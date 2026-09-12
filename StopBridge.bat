@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
echo Stopping DeadlockLingua bridge on port 8791...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:":8791 " ^| findstr LISTENING') do (
    taskkill /F /PID %%p >nul 2>nul
)
echo Done.
