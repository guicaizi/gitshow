#!/usr/bin/env bash
# prize add by yanliang  20261022-start
# Linux / macOS 启动脚本；Windows 用 start.bat
#
#   ./start.sh                 前台运行，只监听 127.0.0.1
#   ./start.sh start           后台运行，默认监听 0.0.0.0（服务器部署用）
#   HOST=127.0.0.1 ./start.sh start   后台运行但只允许本机访问
#   ./start.sh stop|status     停止 / 查看状态，日志写 server.log
#
# prize add by yanliang for 新增 Linux 启动脚本, 20261022-end
set -u
cd "$(dirname "$0")" || exit 1

# prize add by yanliang  20261026-start
# HOST 不预设，按子命令给默认值：run 只给本机，start 对外
HOST="${HOST:-}"
# prize add by yanliang for 后台启动默认对外，避免服务器上启动了却打不开, 20261026-end
PORT="${PORT:-7391}"
PID_FILE=".gdv.pid"
LOG_FILE="server.log"

cmd="${1:-run}"

# prize add by yanliang  20261026-start
# 按端口反查真实监听进程。setsid 后台启动时 $! 拿到的是中间进程，
# 不能直接当 pidfile，否则 stop 会杀不到。
port_pid() {
  (ss -lntp 2>/dev/null || netstat -lntp 2>/dev/null) \
    | grep -E "[:.]${PORT}[[:space:]]" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2
}
# prize add by yanliang for 按端口反查真实进程，修正 pidfile 与实际进程不一致, 20261026-end

is_running() {
  [ -n "$(port_pid)" ]
}

case "$cmd" in
  run)
    HOST="${HOST:-127.0.0.1}"
    export HOST PORT
    exec node server.js
    ;;
  start)
    HOST="${HOST:-0.0.0.0}"
    if is_running; then
      echo "已在运行（pid $(port_pid)）：http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT"
      exit 0
    fi
    HOST="$HOST" PORT="$PORT" setsid nohup node server.js > "$LOG_FILE" 2>&1 < /dev/null &
    # prize add by yanliang for 轮询等端口就绪，再写真实 pid, 20261026-start
    RPID=""
    for _ in 1 2 3 4 5 6; do
      sleep 0.5
      RPID="$(port_pid)"
      [ -n "$RPID" ] && break
    done
    # prize add by yanliang for 轮询等端口就绪，再写真实 pid, 20261026-end
    if [ -n "$RPID" ]; then
      echo "$RPID" > "$PID_FILE"
      echo "已启动（pid $RPID，HOST=$HOST PORT=$PORT）：http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT"
      grep -E "局域网访问|已启动|使用 git" "$LOG_FILE" 2>/dev/null
    else
      rm -f "$PID_FILE"
      echo "启动失败，日志如下："
      tail -20 "$LOG_FILE" 2>/dev/null
      exit 1
    fi
    ;;
  stop)
    # prize add by yanliang for 按端口停进程，pidfile 只作参考, 20261026-start
    RPID="$(port_pid)"
    if [ -n "$RPID" ]; then
      kill "$RPID" && echo "已停止（pid $RPID）"
    else
      echo "没有在运行"
    fi
    # prize add by yanliang for 按端口停进程，pidfile 只作参考, 20261026-end
    rm -f "$PID_FILE"
    ;;
  status)
    if is_running; then
      echo "运行中（pid $(port_pid)）：http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT"
    else
      echo "未运行"
    fi
    ;;
  *)
    echo "用法：$0 [run|start|stop|status]"
    exit 1
    ;;
esac
