@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"
title Git diff viewer - stop

set "PORT=7391"

call :is_up
if not defined UP (
  echo 服务没有在运行：本地 %PORT% 端口没有被占用。
  ping -n 3 127.0.0.1 >nul
  exit /b 0
)

echo 正在停止本地 %PORT% 端口上的服务...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
  echo   结束进程 PID %%P
  taskkill /PID %%P /F >nul 2>nul
)

set "WAIT=0"
:waitloop
ping -n 2 127.0.0.1 >nul
set /a WAIT+=1
call :is_up
if not defined UP goto stopped
if %WAIT% lss 5 goto waitloop
echo.
echo [提示] %PORT% 端口仍被占用。
echo 可能是别的程序在用这个端口，或该进程需要管理员权限才能结束。
pause
exit /b 1

:stopped
echo.
echo 已停止，%PORT% 端口已释放。
echo 需要重新启动请双击 start.bat。
ping -n 4 127.0.0.1 >nul
exit /b 0

rem ===== 检查 7391 是否有进程在 LISTENING，结果写进 UP =====
:is_up
set "UP="
for /f "tokens=*" %%L in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do set "UP=1"
exit /b 0
