@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ============================================
echo   打包网站文件（用于上传到 Netlify）
echo ============================================
echo.
echo   这个窗口会自动切到项目目录，所以双击就能用。
echo.

python tools\package-web.py

echo.
echo ============================================
echo   下一步：
echo   1. 打开 https://app.netlify.com/drop
echo   2. 把上面生成的 class-bulletin.zip 拖进去
echo ============================================
echo.
pause
