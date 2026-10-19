@echo off
setlocal
chcp 65001 >nul
if "%~1"=="" (
  echo Usage: Upgrade-Windows.cmd "C:\old\service-windows-inner.local.json" ["C:\local\maintenance.local.json"]
  exit /b 2
)
pushd "%~dp0"
call Prepare-Windows-Service.cmd
if errorlevel 1 exit /b 1
if "%~2"=="" (
  "%~dp0runtime\node.exe" "%~dp0service\cli.mjs" upgrade --config "%~1" --apply
) else (
  "%~dp0runtime\node.exe" "%~dp0service\cli.mjs" upgrade --config "%~1" --maintenance "%~2" --apply
)
if errorlevel 1 exit /b 1
"%~dp0runtime\node.exe" "%~dp0service\cli.mjs" open --config "%~1"
exit /b %errorlevel%
