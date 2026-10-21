@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
    echo Node.js 20 or newer is required.
    pause
    exit /b 1
)
node local-stack.cjs prepare
if errorlevel 1 goto failed
node local-stack.cjs start
if errorlevel 1 goto failed
echo Open http://127.0.0.1:4180
echo Local account details: .local\local-config.json
pause
exit /b 0
:failed
echo Check Docker Desktop and INTEGRATION-LOCAL.md.
pause
exit /b 1
