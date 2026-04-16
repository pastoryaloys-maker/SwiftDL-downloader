const express  = require('express');
const cors     = require('cors');
const { spawn, execSync } = require('child_process');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');

const app  = express();
const PORT = 4000;

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const PUBLIC_DIR    = path.join(__dirname, 'public');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(PUBLIC_DIR));
app.use('/files', express.static(DOWNLOADS_DIR));

// ── Auto-detect yt-dlp binary ────────────────────────────────────────────────
let YT_DLP = null;

function detectYtDlp() {
  const candidates = [
    'yt-dlp',
    'yt-dlp.exe',
    path.join(os.homedir(), '.local', 'bin', 'yt-dlp'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Python', 'Scripts', 'yt-dlp.exe'),
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    '/opt/homebrew/bin/yt-dlp',
    'C:\\Python311\\Scripts\\yt-dlp.exe',
    'C:\\Python312\\Scripts\\yt-dlp.exe',
  ];

  for (const cmd of candidates) {
    try {
      execSync(`"${cmd}" --version`, { stdio: 'pipe', timeout: 5000 });
      console.log(`  ✓ yt-dlp found: ${cmd}`);
      return cmd;
    } catch (e) { /* try next */ }
  }

  // Last resort: python module
  try {
    execSync('python3 -m yt_dlp --version', { stdio: 'pipe', timeout: 5000 });
    console.log('  ✓ yt-dlp found as python3 module');
    return '__PYTHON3_MODULE__';
  } catch(e) {}

  try {
    execSync('python -m yt_dlp --version', { stdio: 'pipe', timeout: 5000 });
    console.log('  ✓ yt-dlp found as python module');
    return '__PYTHON_MODULE__';
  } catch(e) {}

  console.warn('  ✗ yt-dlp NOT found! Install it: pip install yt-dlp');
  return null;
}

function buildSpawn(args) {
  if (!YT_DLP) return null;
  if (YT_DLP === '__PYTHON3_MODULE__') return spawn('python3', ['-m', 'yt_dlp', ...args], { env: { ...process.env } });
  if (YT_DLP === '__PYTHON_MODULE__')  return spawn('python',  ['-m', 'yt_dlp', ...args], { env: { ...process.env } });
  return spawn(YT_DLP, args, { env: { ...process.env }, shell: os.platform() === 'win32' });
}

// ── SSE clients & active jobs ────────────────────────────────────────────────
const sseClients = {};
const activeJobs = {};

function sendSSE(jobId, data) {
  const c = sseClients[jobId];
  if (c) { try { c.write(`data: ${JSON.stringify(data)}\n\n`); } catch(e) {} }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtBytes(b) {
  if (!b || b <= 0) return '';
  if (b < 1024)           return b + ' B';
  if (b < 1024 * 1024)    return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 ** 3)      return (b / 1024 / 1024).toFixed(1) + ' MB';
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
  return raw.split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('{') && l.endsWith('}'))
    .map(l => { try { return JSON.parse(l); } catch(e) { return null; } })
    .filter(Boolean);
}

function mapVideo(v) {
  const id = v.id || '';
  const yt  = `https://www.youtube.com/watch?v=${id}`;
  return {
    id,
    title:     v.title || 'Unknown',
    url:       v.url || v.webpage_url || (id.length === 11 ? yt : ''),
    thumbnail: v.thumbnail || (id.length === 11 ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : ''),
    duration:  v.duration_string || fmtDuration(v.duration),
    views:     fmtNum(v.view_count),
    likes:     fmtNum(v.like_count),
    uploader:  v.uploader || v.channel || v.creator || '',
    platform:  v.ie_key || v.extractor_key || 'YouTube',
    date:      fmtDate(v.upload_date),
  };
}

// Standard flags added to every yt-dlp call
const STD_FLAGS = [
  '--no-warnings',
  '--no-check-certificates',
  '--socket-timeout', '20',
  '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

// ── GET /api/diagnose ────────────────────────────────────────────────────────
app.get('/api/diagnose', (req, res) => {
  const result = {
    node: process.version,
    platform: os.platform(),
    ytDlpFound: !!YT_DLP,
    ytDlpPath: YT_DLP || 'NOT FOUND',
    ffmpeg: false,
    downloadsDir: DOWNLOADS_DIR,
    downloadsDirExists: fs.existsSync(DOWNLOADS_DIR),
  };
  try {
    execSync('ffmpeg -version', { stdio: 'pipe', timeout: 3000 });
    result.ffmpeg = true;
  } catch(e) {
    try { execSync('/usr/bin/ffmpeg -version', { stdio: 'pipe', timeout: 3000 }); result.ffmpeg = true; } catch(e2) {}
  }
  res.json(result);
});

// ── POST /api/info ───────────────────────────────────────────────────────────
app.post('/api/info', (req, res) => {
  const { url } = req.body;
  if (!url?.trim()) return res.status(400).json({ error: 'Please provide a URL.' });
  if (!YT_DLP)      return res.status(500).json({ error: 'yt-dlp is not installed. Run: pip install yt-dlp' });

  const args = ['--dump-json', '--no-playlist', ...STD_FLAGS, url.trim()];
  let stdout = '', stderr = '';
  const proc  = buildSpawn(args);
  if (!proc)  return res.status(500).json({ error: 'Could not start yt-dlp' });

  const timer = setTimeout(() => {
    proc.kill();
    if (!res.headersSent) res.status(504).json({ error: 'Timed out fetching video info. The site may be slow — try again.' });
  }, 60000);

  proc.stdout.on('data', d => { stdout += d.toString(); });
  proc.stderr.on('data', d => { stderr += d.toString(); });

  proc.on('close', code => {
    clearTimeout(timer);
    if (res.headersSent) return;

    const objects = parseJsonLines(stdout);
    if (!objects.length) {
      // Produce a friendly error
      let msg = 'Could not fetch video info.';
      if (stderr.includes('Private video'))          msg = 'This video is private.';
      else if (stderr.includes('not available'))     msg = 'This video is not available in your region.';
      else if (stderr.includes('Unsupported URL'))   msg = 'Unsupported URL. Try a direct video link from YouTube, TikTok, Instagram, etc.';
      else if (stderr.includes('login') || stderr.includes('sign in')) msg = 'This video requires login. Try a public video.';
      else if (stderr.includes('age'))               msg = 'This video is age-restricted.';
      else if (stderr.includes('removed'))           msg = 'This video has been removed.';
      else if (code !== 0 && stderr)                 msg = `yt-dlp error: ${stderr.slice(0, 200)}`;
      return res.status(500).json({ error: msg });
    }

    const info = objects[0];
    const fmts  = info.formats || [];
    const heights = [...new Set(fmts.map(f => f.height).filter(h => h > 0))].sort((a, b) => b - a);

    res.json({
      title:    info.title || 'Unknown Title',
      duration: info.duration_string || fmtDuration(info.duration),
      thumbnail: info.thumbnail || '',
      uploader: info.uploader || info.channel || '',
      views:    fmtNum(info.view_count),
      likes:    fmtNum(info.like_count),
      date:     fmtDate(info.upload_date),
      platform: info.extractor_key || info.ie_key || 'Web',
      url:      url.trim(),
      description: (info.description || '').slice(0, 400),
      availableHeights: heights,
    });
  });

  proc.on('error', e => {
    clearTimeout(timer);
    if (!res.headersSent) res.status(500).json({ error: 'Could not run yt-dlp: ' + e.message + '. Make sure it is installed: pip install yt-dlp' });
  });
});

// ── POST /api/search ─────────────────────────────────────────────────────────
app.post('/api/search', (req, res) => {
  const { query, platform = 'youtube', limit = 24 } = req.body;
  if (!query?.trim()) return res.status(400).json({ error: 'Search query is required.' });
  if (!YT_DLP)        return res.status(500).json({ error: 'yt-dlp is not installed.' });

  // Map platform to yt-dlp search prefix
  const prefixMap = {
    youtube:    `ytsearch${limit}:${query}`,
    tiktok:     `ytsearch${limit}:${query} tiktok`,
    instagram:  `ytsearch${limit}:${query} instagram`,
    facebook:   `ytsearch${limit}:${query} facebook`,
    twitter:    `ytsearch${limit}:${query} twitter`,
    vimeo:      `ytsearch${limit}:${query}`,
    soundcloud: `scsearch${limit}:${query}`,
    music:      `ytsearch${limit}:${query} music`,
    other:      `ytsearch${limit}:${query}`,
  };
  const searchStr = prefixMap[platform] || `ytsearch${limit}:${query}`;

  const args = ['--dump-json', '--flat-playlist', ...STD_FLAGS, '--socket-timeout', '30', searchStr];
  let stdout = '';
  const proc  = buildSpawn(args);
  if (!proc) return res.status(500).json({ error: 'Could not start yt-dlp' });

  const timer = setTimeout(() => {
    proc.kill();
    if (!res.headersSent) res.status(504).json({ error: 'Search timed out. Check your internet connection.' });
  }, 90000);

  proc.stdout.on('data', d => { stdout += d.toString(); });
  proc.on('close', () => {
    clearTimeout(timer);
    if (res.headersSent) return;
    const results = parseJsonLines(stdout).map(mapVideo).filter(v => v.title !== 'Unknown');
    res.json({ results, total: results.length });
  });
  proc.on('error', e => {
    clearTimeout(timer);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });
});

// ── GET /api/trending/:platform ──────────────────────────────────────────────
app.get('/api/trending/:platform', (req, res) => {
  if (!YT_DLP) return res.status(500).json({ error: 'yt-dlp not installed' });

  const queryMap = {
    youtube:    'trending music videos 2025',
    tiktok:     'best tiktok viral songs 2025',
    instagram:  'instagram reels trending songs 2025',
    facebook:   'viral music videos facebook 2025',
    twitter:    'viral twitter music video 2025',
    vimeo:      'cinematic beautiful music video 2025',
    soundcloud: 'soundcloud trending electronic music 2025',
    other:      'trending videos 2025',
  };
  const q = queryMap[req.params.platform] || queryMap.other;
  const args = ['--dump-json', '--flat-playlist', ...STD_FLAGS, '--socket-timeout', '30', `ytsearch24:${q}`];
  let stdout = '';
  const proc  = buildSpawn(args);
  if (!proc) return res.status(500).json({ error: 'Could not start yt-dlp' });

  const timer = setTimeout(() => {
    proc.kill();
    if (!res.headersSent) res.status(504).json({ error: 'Timed out loading content.' });
  }, 90000);

  proc.stdout.on('data', d => { stdout += d.toString(); });
  proc.on('close', () => {
    clearTimeout(timer);
    if (res.headersSent) return;
    const results = parseJsonLines(stdout).map(mapVideo).filter(v => v.title !== 'Unknown');
    res.json({ results });
  });
  proc.on('error', e => {
    clearTimeout(timer);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });
});

// ── POST /api/download ───────────────────────────────────────────────────────
app.post('/api/download', (req, res) => {
  const { url, quality, format } = req.body;
  if (!url)    return res.status(400).json({ error: 'URL is required' });
  if (!YT_DLP) return res.status(500).json({ error: 'yt-dlp is not installed. Run: pip install yt-dlp' });

  const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
  res.json({ jobId });
  setImmediate(() => runDownload(jobId, url, quality, format));
});

// ── GET /api/progress/:jobId (SSE) ───────────────────────────────────────────
app.get('/api/progress/:jobId', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  sseClients[req.params.jobId] = res;
  req.on('close', () => delete sseClients[req.params.jobId]);
});

// ── POST /api/cancel/:jobId ──────────────────────────────────────────────────
app.post('/api/cancel/:jobId', (req, res) => {
  const proc = activeJobs[req.params.jobId];
  if (proc) { try { proc.kill('SIGTERM'); } catch(e) {} delete activeJobs[req.params.jobId]; }
  res.json({ ok: true });
});

// ── GET /api/downloads ───────────────────────────────────────────────────────
app.get('/api/downloads', (req, res) => {
  try {
    const files = fs.readdirSync(DOWNLOADS_DIR)
      .filter(f => !f.startsWith('.') && !f.endsWith('.part') && !f.endsWith('.ytdl'))
      .map(f => {
        const stat = fs.statSync(path.join(DOWNLOADS_DIR, f));
        return { name: f, size: fmtBytes(stat.size), bytes: stat.size, mtime: stat.mtime, url: `/files/${encodeURIComponent(f)}` };
      })
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    res.json(files);
  } catch(e) { res.json([]); }
});

// ── DELETE /api/downloads/:name ──────────────────────────────────────────────
app.delete('/api/downloads/:name', (req, res) => {
  const fp = path.join(DOWNLOADS_DIR, decodeURIComponent(req.params.name));
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  res.json({ ok: true });
});

// ── Core download runner ─────────────────────────────────────────────────────
function runDownload(jobId, url, quality, format) {
  const AUDIO_FMTS = ['mp3', 'aac', 'wav', 'flac', 'ogg', 'm4a', 'opus'];
  const fmt        = (format || 'mp4').toLowerCase();
  const isAudio    = AUDIO_FMTS.includes(fmt) || quality === 'Audio only' || quality === 'Audio';
  const outTpl     = path.join(DOWNLOADS_DIR, '%(title).180s.%(ext)s');

  let ffmpegPath = 'ffmpeg';
  try { execSync('ffmpeg -version', { stdio: 'pipe', timeout: 2000 }); }
  catch(e) { try { execSync('/usr/bin/ffmpeg -version', { stdio: 'pipe', timeout: 2000 }); ffmpegPath = '/usr/bin/ffmpeg'; } catch(e2) {} }

  let args = [];
  if (isAudio) {
    const af = AUDIO_FMTS.includes(fmt) ? fmt : 'mp3';
    args = ['-x', '--audio-format', af, '--audio-quality', '0',
            '-o', outTpl, '--no-playlist', '--newline',
            ...STD_FLAGS, url];
  } else {
    const heightMap = { '4K':'2160','4k':'2160','1080p':'1080','720p':'720','480p':'480','360p':'360','240p':'240','Best':'9999','best':'9999' };
    const h  = heightMap[quality] || '1080';
    const vf = ['mp4','mkv','webm','avi','mov'].includes(fmt) ? fmt : 'mp4';
    const fsel = h === '9999'
      ? 'bestvideo+bestaudio/best'
      : `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`;
    args = ['-f', fsel, '--merge-output-format', vf,
            '-o', outTpl, '--no-playlist', '--newline',
            '--ffmpeg-location', ffmpegPath, ...STD_FLAGS, url];
  }

  sendSSE(jobId, { type: 'start', message: 'Starting download…' });
  const proc = buildSpawn(args);
  if (!proc) { sendSSE(jobId, { type: 'error', message: 'Cannot start yt-dlp.' }); return; }
  activeJobs[jobId] = proc;

  proc.stdout.on('data', chunk => {
    for (const line of chunk.toString().split('\n')) {
      const t = line.trim(); if (!t) continue;
      // Progress line: [download]  45.3% of 128.00MiB at 4.20MiB/s ETA 00:18
      const pm = t.match(/\[download\]\s+([\d.]+)%\s+of\s+(\S+)\s+at\s+(\S+\/s)\s+ETA\s+(\S+)/);
      if (pm) { sendSSE(jobId, { type:'progress', percent:parseFloat(pm[1]), totalSize:pm[2], speed:pm[3], eta:pm[4] }); continue; }
      if (t.includes('[Merger]') || t.includes('Merging'))    { sendSSE(jobId, { type:'info', message:'Merging streams with ffmpeg…' }); continue; }
      if (t.includes('[ffmpeg]'))                              { sendSSE(jobId, { type:'info', message:'Processing audio…' }); continue; }
      if (t.includes('already been downloaded'))               { sendSSE(jobId, { type:'info', message:'Already downloaded.' }); continue; }
      if (t.includes('Downloading item'))                      { sendSSE(jobId, { type:'info', message: t.replace('[download]','').trim() }); }
    }
  });

  proc.stderr.on('data', chunk => {
    const msg = chunk.toString().trim();
    if (msg && !msg.toLowerCase().includes('warning') && msg.length > 5) {
      sendSSE(jobId, { type:'log', message: msg.slice(0, 300) });
    }
  });

  proc.on('close', code => {
    delete activeJobs[jobId];
    if (code === 0 || code === null) {
      try {
        const newest = fs.readdirSync(DOWNLOADS_DIR)
          .filter(f => !f.endsWith('.part') && !f.endsWith('.ytdl') && !f.startsWith('.'))
          .map(f => ({ name: f, mt: fs.statSync(path.join(DOWNLOADS_DIR, f)).mtimeMs }))
          .sort((a, b) => b.mt - a.mt)[0];
        const size = newest ? fmtBytes(fs.statSync(path.join(DOWNLOADS_DIR, newest.name)).size) : '';
        sendSSE(jobId, { type:'done', message:'Download complete!', file: newest?.name || '', size, url: newest ? `/files/${encodeURIComponent(newest.name)}` : '' });
      } catch(e) {
        sendSSE(jobId, { type:'done', message:'Download complete!' });
      }
    } else {
      sendSSE(jobId, { type:'error', message:'Download failed. The video may be private, age-restricted, geo-blocked, or the URL is invalid.' });
    }
  });

  proc.on('error', e => {
    delete activeJobs[jobId];
    sendSSE(jobId, { type:'error', message:'Cannot run yt-dlp: ' + e.message + ' — install with: pip install yt-dlp' });
  });
}

// ── Catch-all → index.html ───────────────────────────────────────────────────
app.use((req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// ── Boot ─────────────────────────────────────────────────────────────────────
console.log('\n  Detecting yt-dlp...');
YT_DLP = detectYtDlp();

app.listen(PORT, () => {
  console.log(`\n  ╔═══════════════════════════════════════════╗`);
  console.log(`  ║   🎵  SwiftDL v3 — Running               ║`);
  console.log(`  ║   Open ➜  http://localhost:${PORT}           ║`);
  console.log(`  ║   yt-dlp: ${(YT_DLP || 'NOT FOUND — run: pip install yt-dlp').slice(0,32).padEnd(32)} ║`);
  console.log(`  ╚═══════════════════════════════════════════╝\n`);
});
