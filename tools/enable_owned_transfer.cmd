@echo off
chcp 65001 >nul
setlocal
set "AIC_ENABLE_SCRIPT=%~dp0enable_owned_transfer.mjs"
set "AIC_ENABLE_RECIPIENT="
if not exist "%~dp0mac-recipient.txt" exit /b 1
set /p AIC_ENABLE_RECIPIENT=<"%~dp0mac-recipient.txt"
powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; $env:PSModulePath=$PSHOME+'\Modules'; $filter='Name='+[char]39+'node.exe'+[char]39; $pattern='cli\.mjs'+[char]34+'?\s+start\s+--config'; $items=@(Get-CimInstance Win32_Process -Filter $filter | Where-Object { $_.ExecutablePath -and $_.CommandLine -match $pattern }); if($items.Count -eq 0){ Write-Host 'Please open the AIConnector Windows dashboard first.'; exit 1 }; $node=$items[0].ExecutablePath; & $node $env:AIC_ENABLE_SCRIPT --recipient-text $env:AIC_ENABLE_RECIPIENT --human; exit $LASTEXITCODE"
set "AIC_ENABLE_EXIT=%ERRORLEVEL%"
if not "%AICONNECTOR_ENABLE_NO_PAUSE%"=="1" pause
exit /b %AIC_ENABLE_EXIT%
