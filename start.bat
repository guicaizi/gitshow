@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE_EXE=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"

echo 正在启动 Git 提交比对工具...
start "git-diff-viewer" /min "%NODE_EXE%" "%~dp0server.js"
timeout /t 2 >nul
start "" "http://127.0.0.1:7391"
echo.
echo 已打开 http://127.0.0.1:7391
echo 关闭弹出的 node 窗口即可停止服务。
timeout /t 3 >nul
