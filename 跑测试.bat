@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ============================================
echo   跑一遍全部测试（改了代码之后建议跑）
echo ============================================
echo.

rem 这台电脑装了 Node 但没加进 PATH，所以先自己找一遍
set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"

if not defined NODE_EXE (
  echo [警告] 找不到 node，将跳过「前端 / Word 生成」那部分测试。
  echo        其余 Python 测试照常运行。
  echo.
) else (
  echo --- 1/9 前端逻辑 + 数据层 + DOM 渲染 + Word 生成（node）---
  "%NODE_EXE%" --test "tools/tests/*.test.js"
  echo.
)

echo --- 2/9 后端接口 + 在线人数 + 老数据库迁移 ---
python tools\tests\api_smoke.py
echo.

echo --- 3/9 上传前的机密 key 检测 ---
python tools\tests\package_scan_test.py
echo.

echo --- 4/9 Word 备份生成器 ---
python tools\tests\backup_docx_test.py
echo.

echo --- 5/9 schema.sql 语句顺序 ---
python tools\tests\schema_order_test.py
echo.

echo --- 6/9 主题一致性（CSS 变量 / 深色模式 / 对比度）---
python tools\tests\theme_test.py
echo.

echo --- 7/9 安全防护（锁定递增 / 风控识别 / 零误报 / 黑名单）---
python tools\tests\security_test.py
echo.

echo --- 8/9 备用镜像工具（密钥该放哪个 HTTP 头）---
python tools\tests\mirror_tool_test.py
echo.

echo --- 9/9 文档编码（防止中文被写成乱码）---
python tools\tests\encoding_test.py
echo.

echo ============================================
echo   合计 429 项；每一项最后的「失败 0 项」才是对的
echo ============================================
echo.
pause
