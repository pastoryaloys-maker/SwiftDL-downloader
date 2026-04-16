'use strict';

const express  = require('express');
const cors     = require('cors');
const { spawn, execSync } = require('child_process');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const https    = require('https');

const app  = express();
const PORT = process.env.PORT || 4000;

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const PUBLIC_DIR    = path.join(__dirname, 'public');

// Create downloads folder if missing
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET','POST','DELETE','OPTIONS'] }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/files', express.static(DOWNLOADS_DIR));

// Always return JSON on API errors - never HTML
app.use('/api', (req, res, next) => {
  res.on('finish', () => {});
  next();
});

// ── SSE clients & active jobs ─────────────────────────────────────────────────
const sseClients = new Map();
const activeJobs  = new Map();

function sendSSE(jobId, data) {
  const client = sseClients.get(jobId);
  if (client && !client.writableEnded) {
    try { client.write(`data: ${JSON.stringify(data)}\n\n`); } catch(e) {}
  }
}

// ── Detect yt-dlp ─────────────────────────────────────────────────────────────
let YT_DLP_CMD   = null;
let YT_DLP_ARGS  = [];   // prefix args when using python -m yt_dlp

function detectYtDlp() {
  const bins = [
    'yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    '/opt/homebrew/bin/yt-dlp',
    path.join(os.homedir(), '.local', 'bin', 'yt-dlp'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Python', 'Scripts', 'yt-dlp.exe'),
    'C:\\Python311\\Scripts\\yt-dlp.exe',
    'C:\\Python312\\Scripts\\yt-dlp.exe',
    'C:\\Python313\\Scripts\\yt-dlp.exe',
  ];
  for (const b of bins) {
    try {
      execSync(`"${b}" --version`, { stdio: 'pipe', timeout: 8000 });
      console.log(`  ✓ yt-dlp: ${b}`);
      return { cmd: b, args: [] };
    } catch(e) { /* try next */ }
  }
  // Try python module
  for (const py of ['python3', 'python', 'python3.11', 'python3.12']) {
    try {
      execSync(`${py} -m yt_dlp --version`, { stdio: 'pipe', timeout: 8000 });
      console.log(`  ✓ yt-dlp via ${py} -m yt_dlp`);
      return { cmd: py, args: ['-m', 'yt_dlp'] };
    } catch(e) { /* try next */ }
  }
  console.warn('  ✗ yt-dlp NOT found. Run:  pip install yt-dlp');
  return null;
}

// Detect ffmpeg
let FFMPEG_PATH = 'ffmpeg';
function detectFfmpeg() {
  for (const f of ['ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg']) {
    try { execSync(`"${f}" -version`, { stdio: 'pipe', timeout: 5000 }); return f; } catch(e) {}
  }
  return null;
}

// Build a child process for yt-dlp with given args
function runYtDlp(args) {
  if (!YT_DLP_CMD) return null;
  const allArgs = [...YT_DLP_ARGS, ...args];
  const opts = { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } };
  if (os.platform() === 'win32') opts.shell = true;
  return spawn(YT_DLP_CMD, allArgs, opts);
}

// Standard flags for every yt-dlp call
const BASE_FLAGS = [
  '--no-warnings',
  '--no-check-certificates',
  '--socket-timeout', '25',
  '--retries', '3',
  '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

// ── Formatters ────────────────────────────────────────────────────────────────
function fmtBytes(b) {
  if (!b || b <= 0) return '';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 ** 3)   return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 ** 3).toFixed(2) + ' GB';
}

function fmtDuration(s) {
  if (!s) return '';
  s = Math.round(Number(s));
  if (isNaN(s) || s < 0) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    : `${m}:${String(sec).padStart(2,'0')}`;
}

function fmtNum(n) {
  if (n == null || n === 0) return '';
  n = Number(n);
  if (isNaN(n)) return '';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtDate(d) {
  if (!d || d.length < 8) return '';
  return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
}

function parseJsonLines(raw) {
  if (!raw) return [];
  return raw.split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('{') && l.endsWith('}'))
    .map(l => { try { return JSON.parse(l); } catch(e) { return null; } })
    .filter(Boolean);
}

function mapVideo(v) {
  const id = v.id || '';
  const ytUrl = id.length === 11 ? `https://www.youtube.com/watch?v=${id}` : '';
  return {
    id,
    title:     (v.title || 'Unknown').slice(0, 200),
    url:       v.url || v.webpage_url || ytUrl || '',
    thumbnail: v.thumbnail || (id.length === 11 ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : ''),
    duration:  v.duration_string || fmtDuration(v.duration),
    views:     fmtNum(v.view_count),
    likes:     fmtNum(v.like_count),
    uploader:  (v.uploader || v.channel || v.creator || '').slice(0, 80),
    platform:  v.ie_key || v.extractor_key || 'YouTube',
    date:      fmtDate(v.upload_date),
  };
}

function friendlyError(stderr) {
  if (!stderr) return 'Could not fetch video info.';
  const s = stderr.toLowerCase();
  if (s.includes('private video'))            return 'This video is private and cannot be downloaded.';
  if (s.includes('not available'))            return 'This video is not available in your region.';
  if (s.includes('unsupported url'))          return 'Unsupported URL. Paste a direct video link from YouTube, TikTok, Instagram, etc.';
  if (s.includes('login') || s.includes('sign in')) return 'This content requires a login. Try a public video.';
  if (s.includes('age'))                      return 'This video is age-restricted.';
  if (s.includes('removed') || s.includes('deleted')) return 'This video has been removed.';
  if (s.includes('copyright'))               return 'This video is blocked due to copyright.';
  if (s.includes('connection') || s.includes('timeout')) return 'Connection timed out. Check your internet and try again.';
  if (s.includes('403') || s.includes('forbidden')) return 'Access denied by the server (403). The URL may be expired or geo-blocked.';
  if (s.includes('404') || s.includes('not found'))  return 'Video not found (404). Check the URL.';
  return 'Download error: ' + stderr.slice(0, 200);
}

// ── Helper: safe JSON response ────────────────────────────────────────────────
function jsonOk(res, data)       { if (!res.headersSent) res.json(data); }
function jsonErr(res, code, msg) { if (!res.headersSent) res.status(code).json({ error: msg }); }

// ── GET /api/status ───────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  jsonOk(res, {
    ok:         true,
    ytDlp:      !!YT_DLP_CMD,
    ytDlpPath:  YT_DLP_CMD || 'not found',
    ffmpeg:     !!FFMPEG_PATH,
    ffmpegPath: FFMPEG_PATH || 'not found',
    node:       process.version,
    platform:   os.platform(),
    downloadsDir: DOWNLOADS_DIR,
    message:    YT_DLP_CMD ? 'SwiftDL backend is running ✓' : 'yt-dlp not found — run: pip install yt-dlp',
  });
});

// ── POST /api/info ────────────────────────────────────────────────────────────
app.post('/api/info', (req, res) => {
  const { url } = req.body || {};
  if (!url?.trim())   return jsonErr(res, 400, 'Please provide a URL.');
  if (!YT_DLP_CMD)    return jsonErr(res, 503, 'yt-dlp is not installed on this server. Run: pip install yt-dlp');

  const proc  = runYtDlp(['--dump-json', '--no-playlist', ...BASE_FLAGS, url.trim()]);
  if (!proc)  return jsonErr(res, 500, 'Could not start yt-dlp process.');

  let stdout = '', stderr = '';
  const timer = setTimeout(() => {
    proc.kill();
    jsonErr(res, 504, 'Timed out fetching video info. The site may be slow — please try again.');
  }, 60000);

  proc.stdout.on('data', d => { stdout += d.toString(); });
  proc.stderr.on('data', d => { stderr += d.toString(); });

  proc.on('close', code => {
    clearTimeout(timer);
    if (res.headersSent) return;
    const objects = parseJsonLines(stdout);
    if (!objects.length) return jsonErr(res, 422, friendlyError(stderr));
    const info    = objects[0];
    const fmts    = info.formats || [];
    const heights = [...new Set(fmts.map(f => f.height).filter(h => h > 0))].sort((a, b) => b - a);
    jsonOk(res, {
      title:       (info.title || 'Unknown Title').slice(0, 300),
      duration:    info.duration_string || fmtDuration(info.duration),
      thumbnail:   info.thumbnail || '',
      uploader:    (info.uploader || info.channel || '').slice(0, 100),
      views:       fmtNum(info.view_count),
      likes:       fmtNum(info.like_count),
      date:        fmtDate(info.upload_date),
      platform:    info.extractor_key || info.ie_key || 'Web',
      url:         url.trim(),
      description: (info.description || '').slice(0, 400),
      availableHeights: heights,
    });
  });

  proc.on('error', e => {
    clearTimeout(timer);
    jsonErr(res, 500, 'Cannot run yt-dlp: ' + e.message + '. Install it with: pip install yt-dlp');
  });
});

// ── POST /api/search ──────────────────────────────────────────────────────────
app.post('/api/search', (req, res) => {
  const { query, platform = 'youtube', limit = 24 } = req.body || {};
  if (!query?.trim()) return jsonErr(res, 400, 'Search query is required.');
  if (!YT_DLP_CMD)    return jsonErr(res, 503, 'yt-dlp is not installed.');

  const prefixMap = {
    youtube:    `ytsearch${limit}:${query}`,
    tiktok:     `ytsearch${limit}:${query} tiktok`,
    instagram:  `ytsearch${limit}:${query} instagram reel`,
    facebook:   `ytsearch${limit}:${query} facebook`,
    twitter:    `ytsearch${limit}:${query} twitter x`,
    vimeo:      `ytsearch${limit}:${query}`,
    soundcloud: `scsearch${limit}:${query}`,
    other:      `ytsearch${limit}:${query}`,
  };
  const searchStr = prefixMap[platform] || `ytsearch${limit}:${query}`;
  const proc = runYtDlp(['--dump-json', '--flat-playlist', ...BASE_FLAGS, '--socket-timeout', '30', searchStr]);
  if (!proc) return jsonErr(res, 500, 'Could not start yt-dlp.');

  let stdout = '';
  const timer = setTimeout(() => {
    proc.kill();
    jsonErr(res, 504, 'Search timed out. Check your internet connection and try again.');
  }, 90000);

  proc.stdout.on('data', d => { stdout += d.toString(); });
  proc.on('close', () => {
    clearTimeout(timer);
    if (res.headersSent) return;
    const results = parseJsonLines(stdout).map(mapVideo).filter(v => v.title !== 'Unknown' && v.url);
    jsonOk(res, { results, total: results.length });
  });
  proc.on('error', e => {
    clearTimeout(timer);
    jsonErr(res, 500, e.message);
  });
});

// ── GET /api/trending/:platform ───────────────────────────────────────────────
app.get('/api/trending/:platform', (req, res) => {
  if (!YT_DLP_CMD) return jsonErr(res, 503, 'yt-dlp not installed.');
  const qmap = {
    youtube:    'top music videos official 2024',
    tiktok:     'tiktok viral trending music 2024',
    instagram:  'instagram reels popular music 2024',
    facebook:   'viral music video facebook 2024',
    twitter:    'viral music twitter trending 2024',
    vimeo:      'cinematic beautiful music video',
    soundcloud: 'trending electronic music mix',
    other:      'trending videos 2024',
  };
  const q   = qmap[req.params.platform] || qmap.other;
  const proc = runYtDlp(['--dump-json', '--flat-playlist', ...BASE_FLAGS, '--socket-timeout', '30', `ytsearch24:${q}`]);
  if (!proc) return jsonErr(res, 500, 'Could not start yt-dlp.');

  let stdout = '';
  const timer = setTimeout(() => { proc.kill(); jsonErr(res, 504, 'Timed out.'); }, 90000);

  proc.stdout.on('data', d => { stdout += d.toString(); });
  proc.on('close', () => {
    clearTimeout(timer);
    if (res.headersSent) return;
    jsonOk(res, { results: parseJsonLines(stdout).map(mapVideo).filter(v => v.url) });
  });
  proc.on('error', e => { clearTimeout(timer); jsonErr(res, 500, e.message); });
});

// ── POST /api/download ────────────────────────────────────────────────────────
app.post('/api/download', (req, res) => {
  const { url, quality, format } = req.body || {};
  if (!url)       return jsonErr(res, 400, 'URL is required.');
  if (!YT_DLP_CMD)return jsonErr(res, 503, 'yt-dlp is not installed. Run: pip install yt-dlp');
  const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  jsonOk(res, { jobId });
  setImmediate(() => runDownload(jobId, url, quality, format));
});

// ── GET /api/progress/:jobId (SSE) ────────────────────────────────────────────
app.get('/api/progress/:jobId', (req, res) => {
  res.setHeader('Content-Type',        'text/event-stream');
  res.setHeader('Cache-Control',       'no-cache, no-store');
  res.setHeader('Connection',          'keep-alive');
  res.setHeader('X-Accel-Buffering',   'no');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  const { jobId } = req.params;
  sseClients.set(jobId, res);
  // Send a heartbeat every 15s to keep connection alive
  const hb = setInterval(() => {
    if (res.writableEnded) { clearInterval(hb); return; }
    try { res.write(': heartbeat\n\n'); } catch(e) { clearInterval(hb); }
  }, 15000);
  req.on('close', () => { clearInterval(hb); sseClients.delete(jobId); });
});

// ── POST /api/cancel/:jobId ───────────────────────────────────────────────────
app.post('/api/cancel/:jobId', (req, res) => {
  const proc = activeJobs.get(req.params.jobId);
  if (proc) { try { proc.kill('SIGTERM'); } catch(e) {} activeJobs.delete(req.params.jobId); }
  jsonOk(res, { ok: true });
});

// ── GET /api/downloads ────────────────────────────────────────────────────────
app.get('/api/downloads', (req, res) => {
  try {
    const files = fs.readdirSync(DOWNLOADS_DIR)
      .filter(f => !f.startsWith('.') && !f.endsWith('.part') && !f.endsWith('.ytdl') && !f.endsWith('.temp'))
      .map(f => {
        try {
          const stat = fs.statSync(path.join(DOWNLOADS_DIR, f));
          return { name: f, size: fmtBytes(stat.size), bytes: stat.size, mtime: stat.mtime, url: `/files/${encodeURIComponent(f)}` };
        } catch(e) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    jsonOk(res, files);
  } catch(e) { jsonOk(res, []); }
});

// ── DELETE /api/downloads/:name ───────────────────────────────────────────────
app.delete('/api/downloads/:name', (req, res) => {
  try {
    const fp = path.join(DOWNLOADS_DIR, decodeURIComponent(req.params.name));
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    jsonOk(res, { ok: true });
  } catch(e) { jsonErr(res, 500, e.message); }
});

// ── Core download runner ──────────────────────────────────────────────────────
function runDownload(jobId, url, quality, format) {
  const AUDIO_FMTS = ['mp3', 'aac', 'wav', 'flac', 'ogg', 'm4a', 'opus'];
  const fmt        = (format || 'mp4').toLowerCase();
  const isAudio    = AUDIO_FMTS.includes(fmt) || quality === 'Audio only' || quality === 'Audio';
  const outTpl     = path.join(DOWNLOADS_DIR, '%(title).150s.%(ext)s');

  let args = [];
  if (isAudio) {
    const af = AUDIO_FMTS.includes(fmt) ? fmt : 'mp3';
    args = ['-x', '--audio-format', af, '--audio-quality', '0',
            '-o', outTpl, '--no-playlist', '--newline', ...BASE_FLAGS, url];
  } else {
    const hmap = { '4K':'2160','4k':'2160','1080p':'1080','720p':'720','480p':'480','360p':'360','240p':'240','Best':'9999','best':'9999' };
    const h    = hmap[quality] || '1080';
    const vf   = ['mp4','mkv','webm','avi','mov'].includes(fmt) ? fmt : 'mp4';
    const fsel = h === '9999'
      ? 'bestvideo+bestaudio/best'
      : `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`;
    const ff = FFMPEG_PATH || 'ffmpeg';
    args = ['-f', fsel, '--merge-output-format', vf,
            '-o', outTpl, '--no-playlist', '--newline', '--ffmpeg-location', ff, ...BASE_FLAGS, url];
  }

  sendSSE(jobId, { type: 'start', message: 'Starting download…' });

  const proc = runYtDlp(args);
  if (!proc) { sendSSE(jobId, { type: 'error', message: 'Cannot start yt-dlp. Check that it is installed.' }); return; }
  activeJobs.set(jobId, proc);

  proc.stdout.on('data', chunk => {
    for (const line of chunk.toString().split('\n')) {
      const t = line.trim(); if (!t) continue;
      const pm = t.match(/\[download\]\s+([\d.]+)%\s+of\s+(\S+)\s+at\s+(\S+\/s)\s+ETA\s+(\S+)/);
      if (pm) { sendSSE(jobId, { type: 'progress', percent: parseFloat(pm[1]), totalSize: pm[2], speed: pm[3], eta: pm[4] }); continue; }
      if (t.match(/\[download\]\s+([\d.]+)%/)) {
        const m2 = t.match(/([\d.]+)%/);
        if (m2) sendSSE(jobId, { type: 'progress', percent: parseFloat(m2[1]), totalSize: '', speed: '', eta: '' });
        continue;
      }
      if (t.includes('[Merger]') || t.includes('Merging')) { sendSSE(jobId, { type: 'info', message: 'Merging video + audio…' }); continue; }
      if (t.includes('[ffmpeg]'))                           { sendSSE(jobId, { type: 'info', message: 'Processing with ffmpeg…' }); continue; }
      if (t.includes('already been downloaded'))            { sendSSE(jobId, { type: 'info', message: 'Already downloaded.' }); }
    }
  });

  proc.stderr.on('data', chunk => {
    const msg = chunk.toString().trim();
    if (msg && msg.length > 3 && !msg.toLowerCase().includes('warning')) {
      sendSSE(jobId, { type: 'log', message: msg.slice(0, 250) });
    }
  });

  proc.on('close', code => {
    activeJobs.delete(jobId);
    if (code === 0 || code === null) {
      try {
        const newest = fs.readdirSync(DOWNLOADS_DIR)
          .filter(f => !f.endsWith('.part') && !f.endsWith('.ytdl') && !f.startsWith('.'))
          .map(f => { try { return { name: f, mt: fs.statSync(path.join(DOWNLOADS_DIR, f)).mtimeMs }; } catch(e) { return null; } })
          .filter(Boolean)
          .sort((a, b) => b.mt - a.mt)[0];
        const size = newest ? fmtBytes(fs.statSync(path.join(DOWNLOADS_DIR, newest.name)).size) : '';
        sendSSE(jobId, { type: 'done', message: 'Download complete!', file: newest?.name || '', size, url: newest ? `/files/${encodeURIComponent(newest.name)}` : '' });
      } catch(e) {
        sendSSE(jobId, { type: 'done', message: 'Download complete!' });
      }
    } else {
      sendSSE(jobId, { type: 'error', message: 'Download failed. The video may be private, age-restricted, or geo-blocked.' });
    }
  });

  proc.on('error', e => {
    activeJobs.delete(jobId);
    sendSSE(jobId, { type: 'error', message: 'yt-dlp error: ' + e.message });
  });
}

// ── Catch-all → serve index.html ─────────────────────────────────────────────
app.use((req, res) => {
  const indexFile = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexFile)) res.sendFile(indexFile);
  else res.status(404).json({ error: 'Frontend not found. Make sure public/index.html exists.' });
});

// ── Global error handler — always returns JSON ───────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  jsonErr(res, 500, 'Internal server error: ' + err.message);
});

// ── Start ─────────────────────────────────────────────────────────────────────
console.log('\n  Checking dependencies…');
const ytDlpResult = detectYtDlp();
if (ytDlpResult) { YT_DLP_CMD = ytDlpResult.cmd; YT_DLP_ARGS = ytDlpResult.args; }

const ffResult = detectFfmpeg();
if (ffResult) { FFMPEG_PATH = ffResult; console.log(`  ✓ ffmpeg: ${ffResult}`); }
else           { console.warn('  ✗ ffmpeg not found (needed for 1080p/4K merging)'); }

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ╔═══════════════════════════════════════════════╗`);
  console.log(`  ║   🎵  SwiftDL v3 — Ready                      ║`);
  console.log(`  ║   Local  ➜  http://localhost:${PORT}              ║`);
  console.log(`  ║   Status ➜  http://localhost:${PORT}/api/status   ║`);
  console.log(`  ╚═══════════════════════════════════════════════╝\n`);
});
