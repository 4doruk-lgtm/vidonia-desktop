const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// Bundled ffmpeg binary (ffmpeg-static). Unpacked from the asar so it can run.
function ffmpegBinary() {
  let p = require('ffmpeg-static');
  if (app.isPackaged) p = p.replace('app.asar', 'app.asar.unpacked');
  return p;
}

const STRENGTH = {
  standard: { dn: '1.5:1.5:6:6', sh: '0.8', con: '1.04', sat: '1.06' },
  strong:   { dn: '2.2:2.2:8:8', sh: '1.3', con: '1.07', sat: '1.10' }
};

function runFFmpeg(args, sender, lengthSec) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegBinary(), args, { windowsHide: true });
    let stderr = '';
    p.stderr.on('data', d => {
      const text = d.toString();
      stderr += text;
      const m = text.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g);
      if (m && lengthSec > 0) {
        const [h, mi, s] = m[m.length - 1].replace('time=', '').split(':').map(Number);
        const secs = h * 3600 + mi * 60 + s;
        sender.send('progress', Math.min(99, Math.round((secs / lengthSec) * 100)));
      }
    });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error('Processing failed: ' + stderr.slice(-300))));
  });
}

ipcMain.handle('enhance', async (event, { data, name, method, start, length }) => {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const ext = path.extname(name || '').toLowerCase() || '.mp4';
  const input = path.join(os.tmpdir(), `vidonia-${id}-in${ext}`);
  const output = path.join(os.tmpdir(), `vidonia-${id}-out.mp4`);
  const aggressive = method === 'aggressive';
  const s = STRENGTH[aggressive ? 'strong' : 'standard'];
  const vf = [
    'scale=-2:1080:flags=lanczos',
    `hqdn3d=${s.dn}`,
    `unsharp=5:5:${s.sh}:5:5:0.0`,
    `eq=contrast=${s.con}:saturation=${s.sat}`
  ].join(',');

  fs.writeFileSync(input, Buffer.from(data));
  const len = Math.max(0.5, Number(length) || 0);
  const args = ['-y'];
  if (Number(start) > 0) args.push('-ss', String(start));
  args.push('-i', input, '-t', String(len), '-vf', vf,
    '-c:v', 'libx264', '-preset', aggressive ? 'slow' : 'medium', '-crf', aggressive ? '16' : '18',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', output);
  try {
    await runFFmpeg(args, event.sender, len);
    return fs.readFileSync(output);
  } finally {
    fs.unlink(input, () => {});
    fs.unlink(output, () => {});
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#06060a',
    title: 'Vidonia',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
