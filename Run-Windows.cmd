@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -File "%~dp0Probe.ps1" -Mode Scan -Node windows-inner %*
echo.
echo Reports are saved in the reports directory.
pause
