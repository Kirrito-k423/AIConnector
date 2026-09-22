@echo off
setlocal
set "AICONNECTOR_REQUEST_WRITE=1"
call "%~dp0Run-Windows.cmd" -PromptToken %*
exit /b %ERRORLEVEL%
