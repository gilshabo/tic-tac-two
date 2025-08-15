#!/bin/bash
set -e

# הפעל Redis אם לא רץ
if ! docker ps | grep -q ttt-redis; then
  echo "🚀 Starting Redis..."
  docker run --name ttt-redis -p 6379:6379 -d redis:7-alpine
else
  echo "ℹ️ Redis already running."
fi

# פתח שרתים בטרמינלים נפרדים
echo "🚀 Starting Server 3001..."
osascript -e 'tell app "Terminal"
    do script "cd \"$(pwd)\"; PORT=3001 node server/server.js"
end tell'

echo "🚀 Starting Server 3002..."
osascript -e 'tell app "Terminal"
    do script "cd \"$(pwd)\"; PORT=3002 node server/server.js"
end tell'

sleep 2

# הרצת תסריט demo שהועבר כפרמטר (ברירת מחדל win_row)
SCENARIO=${1:-win_row}
npm run demo:$SCENARIO
