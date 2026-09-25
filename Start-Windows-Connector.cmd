@echo off
setlocal
call "%~dp0Connector-Windows.cmd" -PromptToken -Action Watch %*
exit /b %ERRORLEVEL%
