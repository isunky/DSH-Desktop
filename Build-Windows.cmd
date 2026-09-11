@echo off
setlocal
chcp 65001 >nul
title DeepSeek Harness Desktop - Windows Build

where pwsh.exe >nul 2>nul
if errorlevel 1 (
  echo PowerShell 7.2 or newer is required.
  echo Download it from: https://github.com/PowerShell/PowerShell/releases
  echo.
  pause
  exit /b 1
)

pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Build-Windows.ps1" %*
set "BUILD_EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%BUILD_EXIT_CODE%"=="0" (
  echo Build did not complete. Review the error above.
) else (
  echo Build succeeded. Press any key to close this window.
)
pause >nul
exit /b %BUILD_EXIT_CODE%
