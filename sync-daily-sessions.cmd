@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
if exist "%LOCALAPPDATA%\Python\bin\python.exe" (
    "%LOCALAPPDATA%\Python\bin\python.exe" "%SCRIPT_DIR%sync_daily_sessions.py" %*
    exit /b %ERRORLEVEL%
)
python "%SCRIPT_DIR%sync_daily_sessions.py" %*
exit /b %ERRORLEVEL%
