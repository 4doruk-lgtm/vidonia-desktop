const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');

// Packaged apps keep binaries outside the asar archive, so paths must be unpacked
function unpacked(p) { return app.isPackaged ? p.replace('app.asar', 'app.asar.unpacked') : p; }
function ffmpegBin() { return unpacked(ffmpegStatic); }
function aiDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'realesrgan') : path.join(__dirname, 'bin', 'final');
}
function aiBin() { return path.join(aiDir(), 'realesrgan-ncnn-vulkan.exe'); }

const STRENGTH = {
  standard: { dn: '1.5:1.5:6:6', sh: '0.8', con: '1.04', sat: '1.06' },
  strong:   { dn: '2.2:2.2:8:8', sh: '1.3', con: '1.07', sat: '1.10' }
};

// Run a process and resolve with its stderr (for ffmpeg, stderr holds the progress and info)
function runProc(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true, cwd: opts.cwd });
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); if (opts.onStderr) opts.onStderr(d.toString()); });
    p.stdout.on('data', () => {});
    p.on('error', reject);
    p.on('close', code => {
      if (code === 0 || opts.allowAnyExit) resolve(err);
      else reject(new Error('Processing failed: ' + err.slice(-400)));
    });
  });
}

function parseTime(text) {
  const matches = text.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g);
  if (!matches) return null;
  const [h, m, s] = matches[matches.length - 1].replace('time=', '').split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

async function probeFps(input) {
  const info = await runProc(ffmpegBin(), ['-i', input], { allowAnyExit: true });
  const m = info.match(/(\d+(?:\.\d+)?) fps/);
  const fps = m ? parseFloat(m[1]) : 30;
  return Math.min(60, Math.max(1, Math.round(fps)));
}

// Normal / Aggressive / Fast: ffmpeg filters only
async function enhanceFilters(input, output, method, start, length, sender) {
  const aggressive = method === 'aggressive';
  const s = STRENGTH[aggressive ? 'strong' : 'standard'];
  const vf = [
    'scale=-2:1080:flags=lanczos',
    `hqdn3d=${s.dn}`,
    `unsharp=5:5:${s.sh}:5:5:0.0`,
    `eq=contrast=${s.con}:saturation=${s.sat}`
  ].join(',');
  const args = ['-y'];
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', input, '-t', String(length), '-vf', vf,
    '-c:v', 'libx264', '-preset', aggressive ? 'slow' : 'medium', '-crf', aggressive ? '16' : '18',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', output);
  await runProc(ffmpegBin(), args, {
    onStderr: t => { const secs = parseTime(t); if (secs !== null) sender.send('progress', Math.min(99, Math.round((secs / length) * 100))); }
  });
}

// AI upscale: frames -> Real-ESRGAN (GPU via Vulkan) -> encode with original audio
async function enhanceAI(input, output, start, length, sender) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vidonia-ai-'));
  const framesIn = path.join(work, 'in');
  const framesOut = path.join(work, 'out');
  fs.mkdirSync(framesIn); fs.mkdirSync(framesOut);
  try {
    const fps = await probeFps(input);
    const total = Math.max(1, Math.round(length * fps));

    sender.send('progress', 3);
    await runProc(ffmpegBin(), ['-y', '-ss', String(start), '-i', input, '-t', String(length),
      '-vf', `fps=${fps}`, path.join(framesIn, '%08d.png')]);
    sender.send('progress', 12);

    const timer = setInterval(() => {
      try {
        const done = fs.readdirSync(framesOut).length;
        sender.send('progress', 12 + Math.min(75, Math.round((done / total) * 75)));
      } catch (e) { /* folder not ready yet */ }
    }, 1000);
    try {
      await runProc(aiBin(), ['-i', framesIn, '-o', framesOut, '-n', 'realesr-animevideov3', '-s', '2', '-f', 'png'],
        { cwd: aiDir() });
    } finally { clearInterval(timer); }
    sender.send('progress', 88);

    await runProc(ffmpegBin(), ['-y',
      '-framerate', String(fps), '-start_number', '1', '-i', path.join(framesOut, '%08d.png'),
      '-ss', String(start), '-t', String(length), '-i', input,
      '-map', '0:v:0', '-map', '1:a:0?',
      '-vf', 'scale=-2:1080:flags=lanczos,unsharp=5:5:0.6:5:5:0.0,eq=contrast=1.03:saturation=1.05',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', output]);
    sender.send('progress', 98);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

ipcMain.handle('enhance', async (event, { data, name, method, start, length }) => {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const ext = path.extname(name || '').toLowerCase() || '.mp4';
  const input = path.join(os.tmpdir(), `vidonia-${id}-in${ext}`);
  const output = path.join(os.tmpdir(), `vidonia-${id}-out.mp4`);
  const len = Math.max(0.5, Number(length) || 0);
  const st = Math.max(0, Number(start) || 0);
  fs.writeFileSync(input, Buffer.from(data));
  try {
    if (method === 'ai') await enhanceAI(input, output, st, len, event.sender);
    else await enhanceFilters(input, output, method, st, len, event.sender);
    return fs.readFileSync(output);
  } finally {
    fs.unlink(input, () => {});
    fs.unlink(output, () => {});
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 640,
    backgroundColor: '#06060a', title: 'Vidonia',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
