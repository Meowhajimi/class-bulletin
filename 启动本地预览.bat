@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ============================================
echo   启动本地预览（不需要联网就能看网站）
echo ============================================
echo.
echo   启动后浏览器打开：http://127.0.0.1:8787/
echo   管理页：          http://127.0.0.1:8787/admin.html
echo.
echo   要让同学用手机看，用启动后打印的那个 http://10.x 地址。
echo   停止：在本窗口按 Ctrl+C
echo.

python serve.py --lan

pause
