@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"
title Git 提交比对工具

set "PORT=7391"
set "URL=http://127.0.0.1:%PORT%"

rem ===== 1. 找 node =====
set "NODE_EXE="
where node >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set "NODE_EXE=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not defined NODE_EXE (
  echo [错误] 没有找到 node。
  echo 请先安装 Node.js，或把 node.exe 所在目录加进 PATH。
  pause
  exit /b 1
)

rem ===== 2. 已经在跑就直接打开页面 =====
call :is_up
if defined UP (
  echo 服务已经在运行，直接打开页面：%URL%
  if not "%GDV_NO_BROWSER%"=="1" start "" "%URL%"
  ping -n 4 127.0.0.1 >nul
  exit /b 0
)

rem ===== 3. 启动 =====
echo 正在启动 Git 提交比对工具...
start "git-diff-viewer" /min "%NODE_EXE%" "%~dp0server.js"

set "WAIT=0"
:waitloop
ping -n 2 127.0.0.1 >nul
set /a WAIT+=1
call :is_up
if defined UP goto ready
if %WAIT% lss 8 goto waitloop
echo.
echo [错误] 启动失败：%PORT% 端口没有起来。
echo 请还原最小化的 "git-diff-viewer" 窗口，看里面报了什么错。
echo 常见原因：端口被其他程序占用、node 版本过低、server.js 被改动。
pause
exit /b 1

:ready
if not "%GDV_NO_BROWSER%"=="1" start "" "%URL%"
echo.
echo 已打开 %URL%
echo 关闭 "git-diff-viewer" 窗口即可停止服务。
ping -n 5 127.0.0.1 >nul
exit /b 0

rem ===== 检查 7391 是否有进程在 LISTENING，结果写进 UP =====
:is_up
set "UP="
for /f "tokens=*" %%L in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do set "UP=1"
exit /b 0
