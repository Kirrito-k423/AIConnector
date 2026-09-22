@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
if errorlevel 1 exit /b 2
if not exist "reports" mkdir "reports"
if not exist "reports" exit /b 2
set "AICONNECTOR_SCRIPT=%~dp0Probe.ps1"
set "AICONNECTOR_STARTUP_LOG=%~dp0reports\startup-%RANDOM%-%RANDOM%.txt"
set "AICONNECTOR_EXIT=0"
set "AICONNECTOR_MODE=Scan"
if "%AICONNECTOR_REQUEST_WRITE%"=="1" set "AICONNECTOR_MODE=Write"
set "AICONNECTOR_EXPECTED_HASH=__PROBE_SHA256__"
if /I "%~1"=="--diagnose" goto diagnose

rem The release builder pins the script hash here. Source-tree runs skip this step.
powershell.exe -NoLogo -NoProfile -Command "$env:PSModulePath=$PSHOME+'\Modules'; $ErrorActionPreference='Stop'; if($env:AICONNECTOR_EXPECTED_HASH -notmatch '^[a-f0-9]{64}$'){exit 0}; try { $hash=(Get-FileHash -LiteralPath $env:AICONNECTOR_SCRIPT -Algorithm SHA256).Hash; if($hash -ne $env:AICONNECTOR_EXPECTED_HASH){Write-Output 'CHECKSUM_MISMATCH: script differs from this package. No execution.'; exit 4}; $policy=Get-ExecutionPolicy; $machine=Get-ExecutionPolicy -Scope MachinePolicy; $user=Get-ExecutionPolicy -Scope UserPolicy; $zone=Get-Content -LiteralPath $env:AICONNECTOR_SCRIPT -Stream Zone.Identifier -ErrorAction SilentlyContinue; if($policy -eq 'RemoteSigned' -and $machine -eq 'Undefined' -and $user -eq 'Undefined' -and ($zone -match '^ZoneId=[34]$')){Write-Output 'This downloaded unsigned script is blocked by RemoteSigned.'; Write-Output 'Package checksum matches. This is an integrity check, not a digital signature.'; Write-Output 'If you trust this download and your environment permits it, allow ONLY Probe.ps1.'; $answer=Read-Host 'Remove its download mark and continue in this run? [Y/N]'; if($answer -ne 'Y'){Write-Output 'CANCELLED: no files or policies changed.'; exit 3}; Unblock-File -LiteralPath $env:AICONNECTOR_SCRIPT; Write-Output 'Download mark removed from Probe.ps1 only. Execution policy unchanged.' }; exit 0 } catch { Write-Output 'STARTUP_CHECK_FAILED: unable to verify or prepare the bundled script.'; exit 4 }"
set "AICONNECTOR_EXIT=%ERRORLEVEL%"
if not "%AICONNECTOR_EXIT%"=="0" goto diagnose

echo Running all configured checks. Individual failures will be recorded.
if /I "%~1"=="-PromptToken" goto interactive
powershell.exe -NoLogo -NoProfile -File "%AICONNECTOR_SCRIPT%" -Mode %AICONNECTOR_MODE% -Node windows-inner %* >"%AICONNECTOR_STARTUP_LOG%" 2>&1
set "AICONNECTOR_EXIT=%ERRORLEVEL%"
goto probe_done

:interactive
echo Interactive token entry requested. Tokens are not saved. >"%AICONNECTOR_STARTUP_LOG%"
powershell.exe -NoLogo -NoProfile -File "%AICONNECTOR_SCRIPT%" -Mode %AICONNECTOR_MODE% -Node windows-inner %*
set "AICONNECTOR_EXIT=%ERRORLEVEL%"

:probe_done
if not "%AICONNECTOR_EXIT%"=="0" goto diagnose
type "%AICONNECTOR_STARTUP_LOG%"
echo.
echo Probe command completed. Send the single report ZIP printed above.
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
if "%AICONNECTOR_EXIT%"=="0" goto finish_log
powershell.exe -NoLogo -NoProfile -NonInteractive -Command "try { Add-Type -AssemblyName System.IO.Compression; $p=[IO.Path]::ChangeExtension($env:AICONNECTOR_STARTUP_LOG,'.zip'); $f=[IO.File]::Create($p); $z=New-Object IO.Compression.ZipArchive($f,[IO.Compression.ZipArchiveMode]::Create); try { $e=$z.CreateEntry('startup.txt'); $s=$e.Open(); try { $b=[IO.File]::ReadAllBytes($env:AICONNECTOR_STARTUP_LOG); $s.Write($b,0,$b.Length) } finally { $s.Dispose() } } finally { $z.Dispose(); $f.Dispose() }; Write-Output ('Send this startup report: '+$p) } catch { Write-Output 'Could not pack startup log; keep the TXT file.' }"
:finish_log
echo Startup log: "%AICONNECTOR_STARTUP_LOG%"
if not defined AICONNECTOR_NO_PAUSE pause
exit /b %AICONNECTOR_EXIT%
