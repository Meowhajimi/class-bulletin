@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ============================================
echo   云端自检：检查线上网站和数据库是否正常
echo ============================================
echo.

rem 这台电脑装了 Node 但没加进 PATH，所以先自己找一遍
set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"

if not defined NODE_EXE (
  echo [错误] 找不到 node。
  echo.
  echo   这台电脑应该装了 Node，只是没加进 PATH。
  echo   可以手动运行下面这条（注意两边的引号）：
  echo.
  echo   "C:\Program Files\nodejs\node.exe" tools\live-check.js --check-write
  echo.
  pause
  exit /b 1
)

echo   使用的 node：%NODE_EXE%
echo.

rem --check-write 会以"未登录访客"身份尝试发一条空标题公告。
rem 这是安全的：即使权限策略失效，空标题也会被数据库约束拦下，不会留下垃圾数据。
"%NODE_EXE%" tools\live-check.js --check-write

echo.
echo ============================================
echo   下面三项都要是绿色的对勾才算正常：
echo     1. 能读到公告
echo     2. 公开注册已关闭
echo     3. 未登录发布被拒绝
echo ============================================
echo.
pause
