@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
    echo Install Node.js, then open this launcher again.
    goto failed
)
if not exist "node_modules\pyodide\pyodide.mjs" goto install
if not exist "node_modules\@o.z\ngspice-wasm\ngspice.js" goto install
goto build

:install
call npm.cmd ci --ignore-scripts --no-audit --no-fund
if errorlevel 1 goto failed

:build
node build.mjs
if errorlevel 1 goto failed
node preview.mjs --open
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo CircuitBench could not start. See the message above.
pause
exit /b 1
