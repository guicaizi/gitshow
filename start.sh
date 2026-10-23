#!/usr/bin/env bash
# prize add by yanliang  20261022-start
# Linux / macOS 启动脚本；Windows 用 start.bat
#
#   ./start.sh                 前台运行，只监听 127.0.0.1
#   HOST=0.0.0.0 ./start.sh    允许局域网访问（部署到服务器时用这个）
#   ./start.sh start|stop|status   后台运行，日志写 server.log
#
# prize add by yanliang for 新增 Linux 启动脚本, 20261022-end
set -u
cd "$(dirname "$0")" || exit 1

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-7391}"
PID_FILE=".gdv.pid"
LOG_FILE="server.log"

cmd="${1:-run}"

is_running() {
  [ -f "$PID_FILE" ] || return 1
  pid="$(cat "$PID_FILE" 2>/dev/null)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

case "$cmd" in
  run)
    export HOST PORT
    exec node server.js
    ;;
  start)
    if is_running; then
      echo "已在运行（pid $(cat "$PID_FILE")）：http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT"
      exit 0
    fi
    HOST="$HOST" PORT="$PORT" setsid nohup node server.js > "$LOG_FILE" 2>&1 < /dev/null &
    echo $! > "$PID_FILE"
    sleep 1
    if is_running; then
      echo "已启动（pid $(cat "$PID_FILE")，HOST=$HOST PORT=$PORT），日志：$(pwd)/$LOG_FILE"
      grep -E "局域网访问|已启动|使用 git" "$LOG_FILE" 2>/dev/null
    else
      echo "启动失败，日志如下："
      tail -20 "$LOG_FILE" 2>/dev/null
      exit 1
    fi
    ;;
  stop)
    if is_running; then
      kill "$(cat "$PID_FILE")" && echo "已停止（pid $(cat "$PID_FILE")）"
    else
      echo "没有在运行"
    fi
    rm -f "$PID_FILE"
    ;;
  status)
    if is_running; then
      echo "运行中（pid $(cat "$PID_FILE")）：http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT"
    else
      echo "未运行"
    fi
    ;;
  *)
    echo "用法：$0 [run|start|stop|status]"
    exit 1
    ;;
esac
