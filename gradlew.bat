@echo off
setlocal

set "REPO_ROOT=%~dp0"
cd /d "%REPO_ROOT%piece-core"
call gradlew.bat %*
exit /b %ERRORLEVEL%
