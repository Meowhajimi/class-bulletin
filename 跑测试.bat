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
  echo --- 1/11 前端逻辑 + 数据层 + 栏目规则 + DOM 渲染 + Word 生成（node）---
  "%NODE_EXE%" --test "tools/tests/*.test.js"
  echo.
)

echo --- 2/11 后端接口 + 在线人数 + 栏目增删改 + 老数据库迁移 ---
python tools\tests\api_smoke.py
echo.

echo --- 3/11 上传前的机密 key 检测 ---
python tools\tests\package_scan_test.py
echo.

echo --- 4/11 Word 备份生成器 ---
python tools\tests\backup_docx_test.py
echo.

echo --- 5/11 schema.sql 语句顺序 ---
python tools\tests\schema_order_test.py
echo.

echo --- 6/11 主题一致性（CSS 变量 / 深色模式 / 对比度）---
python tools\tests\theme_test.py
echo.

echo --- 7/11 安全防护（锁定递增 / 风控识别 / 零误报 / 黑名单）---
python tools\tests\security_test.py
echo.

echo --- 8/11 备用镜像工具（密钥该放哪个 HTTP 头）---
python tools\tests\mirror_tool_test.py
echo.

echo --- 9/11 文档编码（防止中文被写成乱码）---
python tools\tests\encoding_test.py
echo.

echo --- 10/11 页脚源码链接（外链安全 / 只改 config）---
python tools\tests\footer_link_test.py
echo.

echo --- 11/11 接线检查（import 路径 / 命名导入 / qs('#id') 对应的元素）---
python tools\tests\wiring_test.py
echo.

echo ============================================
echo   合计 576 项；每一项最后的「失败 0 项」才是对的
echo ============================================
echo.
pause
