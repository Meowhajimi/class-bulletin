@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ============================================================
echo   Pre-publish check  ^(make sure this repo is safe to publish^)
echo ============================================================
echo.
echo   [1/2] Secrets / local-only files / personal info
echo.

python tools\audit-for-publish.py
set AUDIT_CODE=%errorlevel%

echo.
echo   [2/2] Text encoding ^(catch garbled Chinese^)
echo.

python tools\check_encoding.py
set ENCODE_CODE=%errorlevel%

echo.
if %AUDIT_CODE%==0 if %ENCODE_CODE%==0 (
  echo ============================================================
  echo   RESULT: OK  --  safe to make this repo public.
  echo ============================================================
) else (
  echo ============================================================
  echo   RESULT: NOT OK  --  fix the problems listed above first.
  echo ============================================================
)
echo.
echo   ^(Read the report above. Press any key to close.^)
echo.
pause
