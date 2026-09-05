@echo off
REM AI17Z launcher.
REM
REM What a Start Menu shortcut points at. An installed copy must never require
REM anybody to know that "npm run dev" exists, so this is the whole interface:
REM one thing to double-click that starts AI17Z and opens it.
REM
REM It finds the data directory before handing over. The program directory is
REM replaced on every upgrade; the data directory is not, which is why storage,
REM browser profiles and the environment file live there and not here.

setlocal EnableDelayedExpansion
set "AI17Z_HOME=%~dp0"

REM Where the owner told the installer to put their data.
REM
REM A file written by the installer rather than a path baked into this script,
REM because this script is replaced on every upgrade and that choice is not.
REM Falling back to the default keeps an installation that predates the setting
REM working exactly as it did.
set "AI17Z_DATA=%LOCALAPPDATA%\AI17Z"
if exist "%AI17Z_HOME%data-location.txt" (
  set /p AI17Z_DATA=<"%AI17Z_HOME%data-location.txt"
)
REM An empty or whitespace-only file would otherwise resolve to the program
REM directory, which is the one place this must never write.
if "!AI17Z_DATA!"=="" set "AI17Z_DATA=%LOCALAPPDATA%\AI17Z"

if not exist "!AI17Z_DATA!" mkdir "!AI17Z_DATA!"
if not exist "!AI17Z_DATA!\storage" mkdir "!AI17Z_DATA!\storage"
if not exist "!AI17Z_DATA!\browser-profiles" mkdir "!AI17Z_DATA!\browser-profiles"

REM Both spellings, because an installation predating the rename still reads the
REM old names and an explicit value must win either way.
set "AI17Z_STORAGE_DIR=!AI17Z_DATA!\storage"
set "XBAM_STORAGE_DIR=!AI17Z_DATA!\storage"
set "AI17Z_BROWSER_PROFILE_DIR=!AI17Z_DATA!\browser-profiles"
set "XBAM_BROWSER_PROFILE_DIR=!AI17Z_DATA!\browser-profiles"
set "AI17Z_ENV_FILE=!AI17Z_DATA!\.env"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%AI17Z_HOME%launch-ai17z.ps1"
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
  echo.
  echo   AI17Z did not start. The message above says why.
  echo   For a fuller check, use "AI17Z diagnostics" in the Start Menu.
  echo.
  pause
)

endlocal
exit /b %EXITCODE%
