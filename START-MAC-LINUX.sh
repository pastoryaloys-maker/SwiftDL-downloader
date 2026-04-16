#!/bin/bash
clear
echo ""
echo "  ╔══════════════════════════════════════════════╗"
echo "  ║    🎵  SwiftDL - Video & Audio Downloader    ║"
echo "  ╚══════════════════════════════════════════════╝"
echo ""

command -v node >/dev/null 2>&1 || { echo "  [ERROR] Node.js required: https://nodejs.org"; exit 1; }
echo "  [OK] Node.js $(node -v)"

if ! command -v yt-dlp >/dev/null 2>&1; then
  echo "  Installing yt-dlp..."
  pip3 install yt-dlp 2>/dev/null || pip install yt-dlp
fi
echo "  [OK] yt-dlp $(yt-dlp --version)"

command -v ffmpeg >/dev/null 2>&1 && echo "  [OK] ffmpeg found" || echo "  [WARN] ffmpeg not found (1080p/4K needs it)"

[ ! -d node_modules ] && { echo "  Installing packages..."; npm install; }

echo ""
echo "  ╔══════════════════════════════════════════════╗"
echo "  ║  Open  ➜  http://localhost:4000              ║"
echo "  ║  Press     Ctrl+C  to stop                   ║"
echo "  ╚══════════════════════════════════════════════╝"
echo ""

sleep 1
command -v open >/dev/null 2>&1 && (sleep 1.5 && open "http://localhost:4000") &
command -v xdg-open >/dev/null 2>&1 && (sleep 1.5 && xdg-open "http://localhost:4000") &

node server.js
