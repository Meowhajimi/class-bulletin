@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal enabledelayedexpansion

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
if errorlevel 1 (
  echo   [错误] 找不到 git。请先安装 Git for Windows：https://git-scm.com/download/win
  echo.
  pause
  exit /b 1
)

echo   [1/4] 重新打包（把最新网页写进 dist\）……
echo.
python tools\package-web.py
if errorlevel 1 (
  echo.
  echo   [错误] 打包失败，已停下。请把上面的报错发给学委群里的技术同学。
  echo.
  pause
  exit /b 1
)

if not exist ".git" (
  echo   [2/4] 第一次使用：初始化仓库……
  git init
  git branch -M main
  echo.
)

for /f "delims=" %%r in ('git remote 2^>nul') do set HAS_REMOTE=1
if not defined HAS_REMOTE (
  echo   [2/4] 还没有关联远程仓库。请到 GitHub 新建一个**空仓库**
  echo         （不要勾选 Add README），然后把它的地址粘到下面。
  echo         形如：https://github.com/你的用户名/class-bulletin.git
  echo.
  set /p REPO_URL=   粘贴仓库地址后回车：
  if not defined REPO_URL (
    echo   [已取消] 没有填地址。
    echo.
    pause
    exit /b 1
  )
  git remote add origin "!REPO_URL!"
  echo.
) else (
  echo   [2/4] 远程仓库已关联。
  echo.
)

echo   [3/4] 提交本次改动……
git add -A
git -c user.name="class-bulletin" -c user.email="class-bulletin@local" commit -m "更新网站 %date% %time%" 2>nul
if errorlevel 1 (
  echo         没有新的改动需要提交（或提交被跳过）。
) 
echo.

echo   [4/4] 推送到 GitHub……
git push -u origin main
if errorlevel 1 (
  echo.
  echo   [失败] 推送没成功。常见原因：
  echo          · 需要登录 GitHub —— 弹出的窗口里授权即可
  echo          · 网络不通 —— 多试一次，或换个时间
  echo          · 远程仓库是新建的开发分支冲突 —— 到 GitHub 上看提示
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================
echo   推送完成 ✅
echo ============================================
echo.
echo   Cloudflare Pages 会在十几秒内自动重新部署。
echo   过一分钟后打开 https://class-bulletin.pages.dev/ 按 Ctrl+F5 看看。
echo.
pause
