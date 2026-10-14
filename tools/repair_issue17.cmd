@echo off
chcp 65001 >nul
setlocal
set "AIC_REPAIR_SCRIPT=%~dp0repair_issue17.mjs"
powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; $env:PSModulePath=$PSHOME+'\Modules'; $filter='Name='+[char]39+'node.exe'+[char]39; $pattern='cli\.mjs'+[char]34+'?\s+start\s+--config'; $items=@(Get-CimInstance Win32_Process -Filter $filter | Where-Object { $_.ExecutablePath -and $_.CommandLine -match $pattern }); if($items.Count -eq 0){ Write-Host 'Please open the AIConnector Windows dashboard first.'; exit 1 }; & $items[0].ExecutablePath $env:AIC_REPAIR_SCRIPT; exit $LASTEXITCODE"
set "AIC_REPAIR_EXIT=%ERRORLEVEL%"
if not "%AICONNECTOR_REPAIR_NO_PAUSE%"=="1" pause
exit /b %AIC_REPAIR_EXIT%
