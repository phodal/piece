@echo off
setlocal

set "REPO_ROOT=%~dp0"
set "PIECE_GRADLE_WRAPPER=%REPO_ROOT%piece-core\gradlew.bat"
call "%PIECE_GRADLE_WRAPPER%" %*
exit /b %ERRORLEVEL%
