@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ============================================
echo   更新主站（Cloudflare Pages）
echo ============================================
echo.
echo   主站地址：https://class-bulletin.pages.dev/
echo   备用地址：https://class-bulletin-major.netlify.app/
echo.
echo   提示：只发/改公告的话【不用跑这个】，
echo         直接打开 https://class-bulletin.pages.dev/admin 发布即可。
echo.

echo   [1/3] 正在重新打包……
echo.
python tools\package-web.py
echo.

echo   [2/3] 接下来在浏览器里操作（已为你打开控制台）：
echo.
echo       1. 左侧点  Workers ^& Pages
echo       2. 点开项目  class-bulletin
echo          （图标是 Pages 的那个，别点成同名的 Worker）
echo       3. 上方点  Create new deployment
echo          （老界面叫 Upload assets）
echo       4. 把下面这个目录【里面的内容】全选，拖进上传区：
echo.
echo          D:\learn web\dist
echo.
echo          要拖【里面的内容】，不是拖 dist 文件夹本身。
echo          上传后文件列表里 index.html 应该在最外层。
echo       5. 点  Deploy  —— 等十几秒，网址不会变
echo.
echo   [3/3] 验证
echo.
echo       打开 https://class-bulletin.pages.dev/ 并按 Ctrl+F5 强刷
echo       看到新内容就成功了。
echo.
echo   --------------------------------------------------
echo   备用地址（Netlify）要不要一起更新：
echo     app.netlify.com  ^>  项目 class-bulletin-major
echo     ^>  Deploys  ^>  拖入 class-bulletin.zip
echo   只用 Pages 也完全可以，Netlify 只是备用。
echo   --------------------------------------------------
echo.

start "" "https://dash.cloudflare.com/"

echo   已为你打开 Cloudflare 控制台。
echo.
pause
