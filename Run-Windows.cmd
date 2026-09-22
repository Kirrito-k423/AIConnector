@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
if errorlevel 1 exit /b 2
if not exist "reports" mkdir "reports"
if not exist "reports" exit /b 2
set "AICONNECTOR_SCRIPT=%~dp0Probe.ps1"
set "AICONNECTOR_STARTUP_LOG=%~dp0reports\startup-%RANDOM%-%RANDOM%.txt"
set "AICONNECTOR_EXIT=0"
if /I "%~1"=="--diagnose" goto diagnose

echo Running AIConnector probe. Please wait...
powershell.exe -NoLogo -NoProfile -File "%AICONNECTOR_SCRIPT%" -Mode Scan -Node windows-inner %* >"%AICONNECTOR_STARTUP_LOG%" 2>&1
set "AICONNECTOR_EXIT=%ERRORLEVEL%"
if not "%AICONNECTOR_EXIT%"=="0" goto diagnose
type "%AICONNECTOR_STARTUP_LOG%"
echo.
echo Probe command completed. See the report path printed above.
goto finish

:diagnose
echo.
echo Collecting read-only startup diagnostics...
powershell.exe -NoLogo -NoProfile -NonInteractive -Command "$env:PSModulePath=$PSHOME+'\Modules'; $ErrorActionPreference='Continue'; Write-Output '=== AIConnector startup diagnostics ==='; Write-Output ('PowerShell: '+$PSVersionTable.PSVersion); Write-Output ('LanguageMode: '+$ExecutionContext.SessionState.LanguageMode); Write-Output ('ProbeExitCode: '+$env:AICONNECTOR_EXIT); Write-Output ('EffectivePolicy: '+(Get-ExecutionPolicy)); Get-ExecutionPolicy -List | Format-Table -AutoSize; try { Write-Output ('Signature: '+(Get-AuthenticodeSignature -LiteralPath $env:AICONNECTOR_SCRIPT -ErrorAction Stop).Status) } catch { Write-Output 'Signature: UNKNOWN' }; try { $zone=Get-Content -LiteralPath $env:AICONNECTOR_SCRIPT -Stream Zone.Identifier -ErrorAction Stop; $zoneId=@($zone | Where-Object { $_ -match '^ZoneId=' }); if($zoneId.Count -gt 0){ $zoneId | Write-Output } else { Write-Output 'ZoneId: UNKNOWN' } } catch { Write-Output 'ZoneId: unavailable (absent stream or unable to read)' }; try { Write-Output ('ScriptSHA256: '+(Get-FileHash -LiteralPath $env:AICONNECTOR_SCRIPT -Algorithm SHA256 -ErrorAction Stop).Hash) } catch { Write-Output 'ScriptSHA256: UNKNOWN' }; Write-Output 'No execution policy or file trust markers were changed.'" >>"%AICONNECTOR_STARTUP_LOG%" 2>&1
set "AICONNECTOR_DIAG_EXIT=%ERRORLEVEL%"
type "%AICONNECTOR_STARTUP_LOG%"
echo.
if not "%AICONNECTOR_EXIT%"=="0" echo Probe command FAILED. A successful network report is not confirmed.
if not "%AICONNECTOR_DIAG_EXIT%"=="0" echo Startup diagnostics also failed. Keep the error text above.
if not "%AICONNECTOR_EXIT%"=="0" goto finish
set "AICONNECTOR_EXIT=%AICONNECTOR_DIAG_EXIT%"

:finish
echo Startup log: "%AICONNECTOR_STARTUP_LOG%"
if not defined AICONNECTOR_NO_PAUSE pause
exit /b %AICONNECTOR_EXIT%
