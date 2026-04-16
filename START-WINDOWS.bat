@echo off
title SwiftDL - Video & Audio Downloader
color 0A
cls
echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║    🎵  SwiftDL - Video & Audio Downloader    ║
echo  ╚══════════════════════════════════════════════╝
echo.
echo  Checking Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js not found! Download from: https://nodejs.org
    pause & exit
)
echo  [OK] Node.js found

echo  Checking yt-dlp...
where yt-dlp >nul 2>&1
if %errorlevel% neq 0 (
    echo  Installing yt-dlp...
    pip install yt-dlp
)
echo  [OK] yt-dlp ready

echo  Installing packages (first run only)...
if not exist node_modules npm install

echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║  Starting SwiftDL on http://localhost:4000   ║
echo  ║  Press Ctrl+C to stop the server             ║
echo  ╚══════════════════════════════════════════════╝
echo.
timeout /t 1 /nobreak >nul
start "" "http://localhost:4000"
node server.js
pause
