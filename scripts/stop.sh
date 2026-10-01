#!/bin/bash
# Stops the Studio server that the app launcher left running in the background.
PORT="${STUDIO_PORT:-3210}"
PIDS="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [ -z "$PIDS" ]; then echo "Nothing is listening on port $PORT."; exit 0; fi
kill $PIDS && echo "Stopped the Studio server (port $PORT)."
