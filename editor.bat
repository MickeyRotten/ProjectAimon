@echo off
rem Launch the Aimon data editor: starts the Vite dev server (if not already
rem running) and opens the editor page in the default browser.

cd /d "%~dp0"

rem If the dev server is already up, don't start a second one.
curl.exe -s -o NUL http://localhost:5173/ 2>NUL
if %errorlevel%==0 goto open

echo Starting dev server...
start "Aimon dev server" /min cmd /c "npm run dev"

rem Give Vite a moment to come up.
set /a tries=0
:wait
timeout /t 1 /nobreak >NUL
curl.exe -s -o NUL http://localhost:5173/ 2>NUL
if not %errorlevel%==0 (
  set /a tries+=1
  if %tries% lss 15 goto wait
  echo Dev server did not start within 15 seconds.
  pause
  exit /b 1
)

:open
start "" http://localhost:5173/editor.html
exit /b 0
