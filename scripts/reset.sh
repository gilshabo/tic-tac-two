#!/bin/zsh

echo "🛑 Stopping servers running on ports 3001, 3002..."
for PORT in 3001 3002; do
  PID=$(lsof -ti:$PORT)
  if [ -n "$PID" ]; then
    echo "Stopping process $PID on port $PORT..."
    kill -9 $PID 2>/dev/null
  else
    echo "No process found on port $PORT."
  fi
done

echo "🛑 Stopping and removing old Redis container..."
if docker ps -a --format '{{.Names}}' | grep -q '^ttt-redis$'; then
  docker rm -f ttt-redis >/dev/null 2>&1
  echo "Redis container removed."
else
  echo "No container named ttt-redis found."
fi

echo "🚀 Starting new Redis instance..."
docker run --name ttt-redis -p 6379:6379 -d redis:7-alpine

echo "🧹 Clearing all data in Redis..."
sleep 2 # Wait for the server to start
docker exec -it ttt-redis redis-cli FLUSHALL

echo "✅ Cleanup complete. System ready for e2e tests."
