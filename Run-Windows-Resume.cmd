@echo off
setlocal
call "%~dp0Run-Windows-Write.cmd" -ResumeUploads %*
exit /b %ERRORLEVEL%
