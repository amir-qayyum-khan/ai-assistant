@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
for /f %%v in ('node -p "process.versions.node.split(\".\")[0]"') do set NODEMAJOR=%%v
if %NODEMAJOR% LSS 20 goto nonode
if not exist node_modules (
  echo First run: please run "npm install" in this folder once, then start again.
  pause
  exit /b 1
)
node scripts\launcher.mjs
if errorlevel 1 pause
exit /b %errorlevel%
:nonode
echo AI Assistant needs Node.js 20 or newer.
echo Please install it from https://nodejs.org and then run this again.
pause
exit /b 1
