# SwiftDL — Video & Audio Downloader

Download videos and audio from YouTube, TikTok, Instagram, Facebook, Twitter/X, Vimeo, and hundreds of other sites.

---

## ⚡ Quick Start (3 steps)

### Step 1 — Install Node.js
Download from https://nodejs.org → click the big green "LTS" button → install it.

### Step 2 — Install yt-dlp
Open a terminal (or Command Prompt on Windows) and run:
```
pip install yt-dlp
```
If that doesn't work, install Python first from https://python.org, then run it again.

### Step 3 — Start SwiftDL
**Windows:** Double-click `START-WINDOWS.bat`

**Mac / Linux:** Open a terminal in this folder and run:
```
bash START-MAC-LINUX.sh
```

Your browser will open at **http://localhost:4000** automatically. That's it!

---

## 📥 How to use

1. **Paste a URL** — copy a video URL from YouTube/TikTok/Instagram etc. and paste it into the app
2. **Click Analyze** — the app fetches the video title, thumbnail, and available formats
3. **Pick quality & format** — choose from 4K, 1080p, 720p, 480p, 360p, 240p, or Audio Only
4. **Click Download** — watch the real-time progress bar in the Queue tab
5. **Get your file** — go to the Files tab and click "Save" to save it anywhere on your computer

---

## 🌐 Supported sites

YouTube, TikTok, Instagram, Facebook, Twitter/X, Vimeo, Dailymotion, SoundCloud, 
Reddit, Twitch, Bilibili, Rumble, and 1000+ more sites powered by yt-dlp.

---

## 📁 Where are my downloads?

All downloaded files are saved in the `downloads/` folder inside this project folder.
You can also access them from the **Files** tab in the app.

---

## ❓ Troubleshooting

| Problem | Solution |
|---------|----------|
| "yt-dlp not found" | Run `pip install yt-dlp` in terminal |
| "node not found" | Install Node.js from nodejs.org |
| Download fails | Run `pip install -U yt-dlp` to update yt-dlp |
| No HD video (only 480p) | Install ffmpeg — see below |
| Port 4000 in use | Edit server.js and change `PORT = 4000` to `PORT = 4001` |

---

## 🎬 Install ffmpeg (for HD quality)

ffmpeg is needed to merge HD video + audio streams (required for 1080p and 4K).

**Windows:**
1. Go to https://ffmpeg.org/download.html
2. Click "Windows builds from gyan.dev"
3. Download `ffmpeg-release-essentials.zip`
4. Extract it and move `ffmpeg.exe` to `C:\Windows\System32`

**Mac:**
```
brew install ffmpeg
```

**Linux (Ubuntu/Debian):**
```
sudo apt install ffmpeg
```

---

## 🔧 Manual start (if the .bat / .sh doesn't work)

Open terminal in this folder and run:
```
npm install
node server.js
```
Then open http://localhost:4000 in your browser.

---

Built with ❤️ using Express.js, React, and yt-dlp
