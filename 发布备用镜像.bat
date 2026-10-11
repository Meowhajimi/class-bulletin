@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ============================================
echo   发布备用镜像（Supabase，纯 IPv4）
echo ============================================
echo.
echo   用途：同学的主站打不开时（Netlify 是 AWS 新加坡 + 有 IPv6），
echo         可以改用这个纯 IPv4 的入口。
echo.

if not exist "dist\index.html" (
  echo   [提示] 还没打包，先生成发布文件……
  python tools\package-web.py
  echo.
)

python tools\publish-mirror.py

echo.
pause
