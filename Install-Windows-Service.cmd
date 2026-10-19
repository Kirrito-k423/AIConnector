@echo off
setlocal
cd /d "%~dp0"
call Prepare-Windows-Service.cmd
if errorlevel 1 exit /b %ERRORLEVEL%
if exist "runtime\node.exe" (
  "runtime\node.exe" "service\cli.mjs" install %*
) else (
  node "service\cli.mjs" install %*
)
set "AIC_EXIT=%ERRORLEVEL%"
if not "%AIC_EXIT%"=="0" if not defined AICONNECTOR_NO_PAUSE pause
exit /b %AIC_EXIT%
