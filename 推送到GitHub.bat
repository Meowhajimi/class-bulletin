@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal enabledelayedexpansion

rem ============================================================
rem  ★ 写这个 .bat 的规矩：**括号块里不写中文**
rem
rem  原因（真实事故）：cmd.exe 在 chcp 65001 下解析"多字节中文 + 括号块"时
rem  会出现位置错乱，把一整行从中间劈开，再拿后半截当命令执行：
rem      '开发分支冲突' is not recognized as an internal or external command
rem  于是提示只打出一半，还多一行莫名其妙的报错。
rem  文件本身完全正常（UTF-8 / CRLF / 无 BOM），所以肉眼查不出来。
rem
rem  所以下面一律用 `if errorlevel 1 goto :标签`，中文提示写在块外的标签里。
rem  tools/tests/bat_safety_test.py 会盯着这条规矩。
rem ============================================================

echo.
echo ============================================
echo   推送到 GitHub（Cloudflare Pages 会自动部署）
echo ============================================
echo.
echo   流程：打包 dist/  ^>  提交  ^>  推送
echo   推送成功后，Cloudflare 会自己在十几秒内重新部署。
echo   不用再去网页上拖文件。
echo.

where git >nul 2>nul
if errorlevel 1 goto :no_git

echo   [1/4] 重新打包（把最新网页写进 dist\）……
echo.
python tools\package-web.py
if errorlevel 1 goto :package_failed

if not exist ".git" goto :init_repo
goto :check_remote

:init_repo
echo   [2/4] 第一次使用：初始化仓库……
git init
git branch -M main
echo.

:check_remote
for /f "delims=" %%r in ('git remote 2^>nul') do set HAS_REMOTE=1
if not defined HAS_REMOTE goto :ask_remote

echo   [2/4] 远程仓库已关联。
echo.
goto :commit

:ask_remote
echo   [2/4] 还没有关联远程仓库。请到 GitHub 新建一个**空仓库**
echo         （不要勾选 Add README），然后把它的地址粘到下面。
echo         形如：https://github.com/你的用户名/class-bulletin.git
echo.
set /p REPO_URL=   粘贴仓库地址后回车：
if not defined REPO_URL goto :no_url
git remote add origin "!REPO_URL!"
echo.
goto :commit

:no_url
echo   [已取消] 没有填地址。
echo.
pause
exit /b 1

:commit
echo   [3/4] 提交本次改动……
git add -A
git -c user.name="class-bulletin" -c user.email="class-bulletin@local" commit -m "更新网站 %date% %time%" 2>nul
if errorlevel 1 echo         没有新的改动需要提交（或提交被跳过）。
echo.

echo   [4/4] 推送到 GitHub……
git push -u origin main
if errorlevel 1 goto :push_failed

echo.
echo ============================================
echo   Push done. Cloudflare will deploy automatically.
echo ============================================
echo.
echo   Wait about 1 minute, then open this URL
echo   and press Ctrl+F5 to hard-refresh:
echo.
echo     https://class-bulletin.pages.dev/
echo.
pause
exit /b 0

rem ====================== 出错时的提示（都在块外）======================

:no_git
echo   [错误] 找不到 git。请先安装 Git for Windows：https://git-scm.com/download/win
echo.
pause
exit /b 1

:package_failed
echo.
echo   [错误] 打包失败，已停下。请把上面的报错发给学委群里的技术同学。
echo.
pause
exit /b 1

:push_failed
echo.
echo   [失败] 推送没成功。常见原因：
echo          · 需要登录 GitHub —— 弹出的窗口里授权即可
echo          · 网络不通（连接被重置）—— 这是最常见的一种，多试几次，或换个时间
echo          · 远程仓库是新建的开发分支冲突 —— 到 GitHub 上看提示
echo.
echo   小提示：改动已经**提交到本地**了，不会丢。网络恢复后重新双击本文件即可。
echo.
pause
exit /b 1
