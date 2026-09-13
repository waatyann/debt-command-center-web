@echo off
setlocal
title Debt Command Mobile Web App
cd /d "%~dp0"

echo ==============================================
echo Debt Command Mobile Web App - Setup and Start
echo ==============================================
echo.
echo Current folder:
echo %CD%
echo.

where node.exe >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found.
    echo Please install Node.js and restart Windows.
    echo.
    pause
    exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm.cmd was not found.
    echo Please reinstall Node.js.
    echo.
    pause
    exit /b 1
)

echo Node version:
node.exe -v
echo npm version:
call npm.cmd -v
echo.

if not exist "package.json" (
    echo [ERROR] package.json was not found.
    echo Do not run this file from inside the ZIP.
    echo Extract the ZIP first, then run it again.
    echo.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo First setup is starting.
    echo This may take several minutes.
    echo Do not close this window.
    echo.
    call npm.cmd install
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install failed.
        echo A log file may exist in this folder or npm cache.
        echo Please take a photo of this window and send it.
        echo.
        pause
        exit /b 1
    )
)

echo.
echo Starting the app...
echo The browser will open in a few seconds.
echo Keep this black window open while using the app.
echo.

start "" cmd /c "ping 127.0.0.1 -n 6 >nul & start http://localhost:3000"
call npm.cmd run dev -- -H 0.0.0.0

echo.
echo The app has stopped.
pause
