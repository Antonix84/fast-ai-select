@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install.ps1" -Uninstall %*
set "CODE=%ERRORLEVEL%"
echo.
pause
exit /b %CODE%
