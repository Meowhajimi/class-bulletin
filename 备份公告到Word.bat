@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ============================================
echo   备份公告到 Word
echo ============================================
echo.
echo   直接连云端导出，不需要网站还活着。
echo.

python tools\backup-to-word.py

echo.
echo ============================================
echo   备份文件在 backups\ 目录里
echo   建议定期把它复制到网盘或 U 盘
echo ============================================
echo.
pause
