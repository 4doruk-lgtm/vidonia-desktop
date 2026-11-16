const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');

// Clips are processed in segments for AI and 120 fps, so disk use stays small (each segment is removed after joining)
const MAX_TOTAL_SECONDS = 60;
const SEG_AI_SECONDS = 10;
const SEG_120_SECONDS = 15;

// Packaged apps keep binaries outside the asar archive
function unpacked(p) { return app.isPackaged ? p.replace('app.asar', 'app.asar.unpacked') : p; }
function ffmpegBin() { return unpacked(ffmpegStatic); }

function engineDir(name) {
  return app.isPackaged ? path.join(process.resourcesPath, name) : path.join(__dirname, 'bin', name);
}
const AI_DIR = () => engineDir('realesrgan');
const AI_BIN = () => path.join(AI_DIR(), 'realesrgan-ncnn-vulkan.exe');
const RIFE_DIR = () => engineDir('rife');
const RIFE_BIN = () => path.join(RIFE_DIR(), 'rife-ncnn-vulkan.exe');

const STRENGTH = {
  standard: { dn: '1.5:1.5:6:6', sh: '0.8', con: '1.04', sat: '1.06' },
  strong:   { dn: '2.2:2.2:8:8', sh: '1.3', con: '1.07', sat: '1.10' }
};

// Runs a process. Resolves with its stderr text (ffmpeg writes progress there).
function runProc(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true, cwd: opts.cwd });
    let err = '';
    p.stderr.on('data', d => { const t = d.toString(); err += t; if (opts.onStderr) opts.onStderr(t); });
    p.stdout.on('data', d => { if (opts.onStdout) opts.onStdout(d.toString()); });
    p.on('error', e => reject(new Error('Could not start ' + path.basename(bin) + ': ' + e.message)));
    p.on('close', code => {
      if (code === 0 || opts.allowAnyExit) resolve(err);
      else reject(new Error((opts.label || path.basename(bin)) + ' failed: ' + err.slice(-400)));
    });
  });
}

function parseTime(text) {
  const m = text.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g);
  if (!m) return null;
  const [h, mi, s] = m[m.length - 1].replace('time=', '').split(':').map(Number);
  return h * 3600 + mi * 60 + s;
}

function reportTime(sender, text, total, base, span) {
  const s = parseTime(text);
  if (s !== null && total > 0) sender.send('progress', Math.min(base + span, Math.round(base + (s / total) * span)));
}

async function probeFps(input) {
  const info = await runProc(ffmpegBin(), ['-i', input], { allowAnyExit: true });
  const m = info.match(/(\d+(?:\.\d+)?) fps/);
  return Math.max(1, Math.round(m ? parseFloat(m[1]) : 30));
}

// Output size and filters for each mode. res is '1080' or '2160'.
function videoFilters(method, res) {
  const s = method === 'aggressive' ? STRENGTH.strong : STRENGTH.standard;
  const is4k = res === '2160';
  let scale;
  if (method === 'tiktok') {
    const w = is4k ? 2160 : 1080, h = is4k ? 3840 : 1920;
    scale = `scale=${w}:${h}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`;
  } else {
    scale = `scale=-2:${is4k ? 2160 : 1080}:flags=lanczos`;
  }
  return [scale, `hqdn3d=${s.dn}`, `unsharp=5:5:${s.sh}:5:5:0.0`, `eq=contrast=${s.con}:saturation=${s.sat}`].join(',');
}

// Recommended, Aggressive and TikTok-ready: ffmpeg filters only
async function enhanceFilters(input, output, method, res, start, length, sender) {
  const aggressive = method === 'aggressive';
  const tiktok = method === 'tiktok';
  const args = ['-y'];
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', input, '-t', String(length), '-vf', videoFilters(method, res),
    '-c:v', 'libx264', '-preset', aggressive ? 'slow' : 'medium',
    '-crf', aggressive ? '16' : (tiktok ? '17' : '18'), '-pix_fmt', 'yuv420p');
  if (tiktok) args.push('-maxrate', '16M', '-bufsize', '32M');
  args.push('-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output);
  await runProc(ffmpegBin(), args, { label: 'Enhancement', onStderr: t => reportTime(sender, t, length, 0, 99) });
}

// Extracts frames of a clip into a folder
async function extractFrames(input, dir, fps, start, length) {
  const args = ['-y'];
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', input, '-t', String(length), '-vf', `fps=${fps}`, path.join(dir, '%08d.png'));
  await runProc(ffmpegBin(), args, { label: 'Frame extraction' });
}

// AI upscale: frames -> Real-ESRGAN (GPU through Vulkan) -> encode with the original audio
async function enhanceAI(input, output, res, start, length, sender) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vidonia-ai-'));
  const framesIn = path.join(work, 'in');
  const framesOut = path.join(work, 'out');
  fs.mkdirSync(framesIn); fs.mkdirSync(framesOut);
  try {
    const fps = await probeFps(input);
    const total = Math.max(1, Math.round(length * fps));
    sender.send('progress', 3);
    await extractFrames(input, framesIn, fps, start, length);
    sender.send('progress', 12);

    const timer = setInterval(() => {
      try {
        const done = fs.readdirSync(framesOut).length;
        sender.send('progress', 12 + Math.min(75, Math.round((done / total) * 75)));
      } catch (e) { /* folder not ready */ }
    }, 1000);
    try {
      await runProc(AI_BIN(), ['-i', framesIn, '-o', framesOut, '-n', 'realesrgan-x4plus', '-s', '2', '-f', 'png'],
        { cwd: AI_DIR(), label: 'AI upscale' });
    } finally { clearInterval(timer); }
    sender.send('progress', 88);

    const h = res === '2160' ? 2160 : 1080;
    await runProc(ffmpegBin(), ['-y',
      '-framerate', String(fps), '-start_number', '1', '-i', path.join(framesOut, '%08d.png'),
      '-ss', String(start), '-t', String(length), '-i', input,
      '-map', '0:v:0', '-map', '1:a:0?',
      '-vf', `scale=-2:${h}:flags=lanczos,unsharp=5:5:0.6:5:5:0.0,eq=contrast=1.03:saturation=1.05`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', output], { label: 'Encoding' });
    sender.send('progress', 98);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// 60 fps -> 120 fps with RIFE (frame interpolation on the GPU)
async function interpolate120(input, output, length, sender) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vidonia-rife-'));
  const framesIn = path.join(work, 'in');
  const framesOut = path.join(work, 'out');
  fs.mkdirSync(framesIn); fs.mkdirSync(framesOut);
  try {
    const fps = await probeFps(input);
    sender.send('progress', 5);
    await extractFrames(input, framesIn, fps, 0, length);
    const count = fs.readdirSync(framesIn).length;
    sender.send('progress', 20);

    const timer = setInterval(() => {
      try {
        const done = fs.readdirSync(framesOut).length;
        sender.send('progress', 20 + Math.min(70, Math.round((done / (count * 2)) * 70)));
      } catch (e) { /* folder not ready */ }
    }, 1000);
    try {
      await runProc(RIFE_BIN(), ['-i', framesIn, '-o', framesOut, '-m', 'rife-v4.6', '-n', String(count * 2)],
        { cwd: RIFE_DIR(), label: 'Frame interpolation' });
    } finally { clearInterval(timer); }
    sender.send('progress', 92);

    await runProc(ffmpegBin(), ['-y',
      '-pattern_type', 'glob', '-framerate', '120', '-i', path.join(framesOut, '*.png'),
      '-i', input, '-map', '0:v:0', '-map', '1:a:0?',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', output], { label: 'Encoding' });
    sender.send('progress', 98);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// One pass over a segment: enhancement, then optional 120 fps
async function runPipeline(input, out, method, res, fps, start, length, sender) {
  const mid = out + '.mid.mp4';
  try {
    if (method === 'ai') await enhanceAI(input, mid, res, start, length, sender);
    else await enhanceFilters(input, mid, method, res, start, length, sender);
    if (fps === '120') await interpolate120(mid, out, length, sender);
    else fs.renameSync(mid, out);
  } finally {
    fs.unlink(mid, () => {});
  }
}

// Joins segment files without re-encoding (they all come from the same encoder settings)
async function joinSegments(files, output) {
  const list = output + '.list.txt';
  fs.writeFileSync(list, files.map(f => "file '" + f.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'").join('\n'));
  try {
    await runProc(ffmpegBin(), ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', output], { label: 'Joining' });
  } finally {
    fs.unlink(list, () => {});
  }
}

ipcMain.handle('enhance', async (event, opts) => {
  const { data, name, method, start, length, res = '1080', fps = 'original' } = opts;
  const sender = event.sender;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const ext = path.extname(name || '').toLowerCase() || '.mp4';
  const input = path.join(os.tmpdir(), `vidonia-${id}-in${ext}`);
  const output = path.join(os.tmpdir(), `vidonia-${id}-out.mp4`);
  const len = Math.max(0.5, Number(length) || 0);
  const st = Math.max(0, Number(start) || 0);

  if (len > MAX_TOTAL_SECONDS) throw new Error(`Please trim the video to ${MAX_TOTAL_SECONDS} seconds or less.`);
  if (method === 'ai' && !fs.existsSync(AI_BIN())) throw new Error('The AI engine is not included in this build.');
  if (fps === '120' && !fs.existsSync(RIFE_BIN())) throw new Error('The 120 fps engine (RIFE) is not included in this build.');

  // Segment length: AI and 120 fps are split so the disk never holds the whole clip as PNG frames
  let seg = Infinity;
  if (method === 'ai') seg = Math.min(seg, SEG_AI_SECONDS);
  if (fps === '120') seg = Math.min(seg, SEG_120_SECONDS);
  const count = Math.max(1, Math.ceil(len / seg));

  fs.writeFileSync(input, Buffer.from(data));
  const parts = [];
  try {
    for (let i = 0; i < count; i++) {
      const segStart = st + i * (count === 1 ? 0 : seg);
      const segLen = count === 1 ? len : Math.min(seg, len - i * seg);
      const part = path.join(os.tmpdir(), `vidonia-${id}-part${i}.mp4`);
      parts.push(part);
      const segSender = {
        send: (channel, pct) => sender.send('progress', Math.round(((i + pct / 100) / count) * 100))
      };
      await runPipeline(input, part, method, res, fps, segStart, segLen, segSender);
    }
    if (parts.length === 1) fs.renameSync(parts[0], output);
    else await joinSegments(parts, output);
    sender.send('progress', 100);
    return fs.readFileSync(output);
  } finally {
    for (const f of [input, output, ...parts]) fs.unlink(f, () => {});
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 640,
    backgroundColor: '#050814', title: 'Vidonia',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
