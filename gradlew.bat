@echo off
setlocal

set "REPO_ROOT=%~dp0"
set "PIECE_GRADLE_WRAPPER=%REPO_ROOT%piece-core\gradlew.bat"
cd /d "%REPO_ROOT%piece-core" || exit /b 1
call "%PIECE_GRADLE_WRAPPER%" %*
exit /b %ERRORLEVEL%
