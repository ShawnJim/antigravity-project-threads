@echo off
if exist "%APPDATA%\Antigravity\bin\agy-node.cmd" (
  call "%APPDATA%\Antigravity\bin\agy-node.cmd" "%~dp0hook-handler.mjs" %*
  exit /b %ERRORLEVEL%
)
if exist "%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe" (
  set ELECTRON_RUN_AS_NODE=1
  "%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe" "%~dp0hook-handler.mjs" %*
  exit /b %ERRORLEVEL%
)
if exist "%ProgramFiles%\Antigravity\Antigravity.exe" (
  set ELECTRON_RUN_AS_NODE=1
  "%ProgramFiles%\Antigravity\Antigravity.exe" "%~dp0hook-handler.mjs" %*
  exit /b %ERRORLEVEL%
)
where agy-node >nul 2>nul && (
  call agy-node "%~dp0hook-handler.mjs" %*
  exit /b %ERRORLEVEL%
)
node "%~dp0hook-handler.mjs" %*
