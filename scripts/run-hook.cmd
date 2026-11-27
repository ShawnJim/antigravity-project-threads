@echo off
setlocal

set "HANDLER=%~dp0hook-handler.mjs"

where node >nul 2>nul
if not errorlevel 1 (
  call node "%HANDLER%" %*
  if not errorlevel 1 exit /b 0
)

for %%N in (
  "%ProgramFiles%\nodejs\node.exe"
  "%LOCALAPPDATA%\Programs\nodejs\node.exe"
  "%ProgramFiles(x86)%\nodejs\node.exe"
  "%LOCALAPPDATA%\Volta\bin\node.exe"
) do (
  if exist "%%~N" (
    "%%~N" "%HANDLER%" %*
    if not errorlevel 1 exit /b 0
  )
)

if defined NVM_SYMLINK if exist "%NVM_SYMLINK%\node.exe" (
  "%NVM_SYMLINK%\node.exe" "%HANDLER%" %*
  if not errorlevel 1 exit /b 0
)

if defined ANTIGRAVITY_USER_DATA_DIR if exist "%ANTIGRAVITY_USER_DATA_DIR%\bin\agy-node.cmd" (
  call "%ANTIGRAVITY_USER_DATA_DIR%\bin\agy-node.cmd" "%HANDLER%" %*
  if not errorlevel 1 exit /b 0
)

if exist "%APPDATA%\Antigravity\bin\agy-node.cmd" (
  call "%APPDATA%\Antigravity\bin\agy-node.cmd" "%HANDLER%" %*
  if not errorlevel 1 exit /b 0
)

where agy-node >nul 2>nul
if not errorlevel 1 (
  call agy-node "%HANDLER%" %*
  if not errorlevel 1 exit /b 0
)

set "ELECTRON_RUN_AS_NODE=1"
for %%A in (
  "%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe"
  "%ProgramFiles%\Antigravity\Antigravity.exe"
) do (
  if exist "%%~A" (
    "%%~A" "%HANDLER%" %*
    if not errorlevel 1 exit /b 0
  )
)

if /i "%~1"=="Stop" (
  echo {"decision":"stop"}
) else if /i "%~1"=="PreToolUse" (
  echo {"decision":"allow"}
) else (
  echo {}
)
exit /b 0
