@echo off
setlocal
title Debt Command Mobile - Phone Test
cd /d "%~dp0"

where node.exe >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found.
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing required files...
  call npm.cmd install
  if errorlevel 1 (
    echo [ERROR] Install failed.
    pause
    exit /b 1
  )
)

echo.
echo ==============================================
echo PHONE TEST
echo ==============================================
echo.
echo 1. Connect your PC and phone to the same Wi-Fi.
echo 2. Find the IPv4 Address below.
echo 3. On your phone open:
echo    http://IPv4-ADDRESS:3000
echo.
ipconfig | findstr /i "IPv4"
echo.
echo Example: http://192.168.1.10:3000
echo.
echo Keep this window open.
echo If Windows Firewall asks, allow Private networks.
echo ==============================================
echo.

call npm.cmd run dev -- -H 0.0.0.0
pause
