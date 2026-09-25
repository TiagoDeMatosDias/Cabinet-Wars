@echo off
rem Windows: installs dependencies, builds the client and starts the Cabinet Wars server, then
rem opens the browser. Double-click this file, or run start.bat in a terminal. To use another port:
rem   set PORT=8788
rem   start.bat
setlocal
cd /d "%~dp0"
title Cabinet Wars

where node >nul 2>nul
if errorlevel 1 (
  rem Node installs into Program Files; a window opened before installing may not know it yet.
  if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
)
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo ERROR: Node.js was not found. Install Node 22 or newer from https://nodejs.org
  echo        ^(the "LTS" Windows installer^), then run start.bat again.
  echo.
  pause
  exit /b 1
)

rem The rest is the same on every system: scripts\start.mjs.
node scripts\start.mjs %*
if errorlevel 1 (
  echo.
  echo Cabinet Wars stopped with an error ^(see above^).
  pause
  exit /b 1
)
endlocal
