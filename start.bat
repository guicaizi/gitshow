@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"
title Git �ύ�ȶԹ���

set "PORT=7391"
set "URL=http://127.0.0.1:%PORT%"

rem ===== 1. �� node =====
set "NODE_EXE="
where node >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
rem prize fix by yanliang  20261102-start
rem 兜底路径改用 %USERPROFILE%，不再写死 Administrator；并支持 versions 下任意版本目录
if not defined NODE_EXE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not defined NODE_EXE for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do if not defined NODE_EXE if exist "%%D\node.exe" set "NODE_EXE=%%D\node.exe"
rem prize fix by yanliang for 修复找不到 node, 20261102-end
if not defined NODE_EXE (
  echo [����] û���ҵ� node��
  echo ���Ȱ�װ Node.js����� node.exe ����Ŀ¼�ӽ� PATH��
  pause
  exit /b 1
)

rem ===== 2. �Ѿ����ܾ�ֱ�Ӵ�ҳ�� =====
call :is_up
if defined UP (
  echo �����Ѿ������У�ֱ�Ӵ�ҳ�棺%URL%
  if not "%GDV_NO_BROWSER%"=="1" start "" "%URL%"
  ping -n 4 127.0.0.1 >nul
  exit /b 0
)

rem ===== 3. ���� =====
echo �������� Git �ύ�ȶԹ���...
start "git-diff-viewer" /min "%NODE_EXE%" "%~dp0server.js"

set "WAIT=0"
:waitloop
ping -n 2 127.0.0.1 >nul
set /a WAIT+=1
call :is_up
if defined UP goto ready
if %WAIT% lss 8 goto waitloop
echo.
echo [����] ����ʧ�ܣ�%PORT% �˿�û��������
echo �뻹ԭ��С���� "git-diff-viewer" ���ڣ������汨��ʲô����
echo ����ԭ�򣺶˿ڱ���������ռ�á�node �汾���͡�server.js ���Ķ���
pause
exit /b 1

:ready
if not "%GDV_NO_BROWSER%"=="1" start "" "%URL%"
echo.
echo �Ѵ� %URL%
echo �ر� "git-diff-viewer" ���ڼ���ֹͣ����
ping -n 5 127.0.0.1 >nul
exit /b 0

rem ===== ��� 7391 �Ƿ��н����� LISTENING�����д�� UP =====
:is_up
set "UP="
for /f "tokens=*" %%L in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do set "UP=1"
exit /b 0
