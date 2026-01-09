const functions = require('@google-cloud/functions-framework');
const { Storage } = require('@google-cloud/storage');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { createCanvas, registerFont } = require('canvas');

const storage = new Storage();
const cacheBucket = storage.bucket('ranktop-v-cache');
const outputBucket = storage.bucket('ranktop-v-preview');

const PRESET = {
  targetW: 720,
  targetH: 1280,
  preset: 'ultrafast',
  crf: '28'
};

const LAYOUT_CONFIG = {
  titleFontSize: 100, titleY: 0, titleBoxTopPadding: 30, titleBoxBottomPadding: 40,
  titleLineSpacing: 60, titleBoxWidth: 980, titleMaxLines: 2, rankFontSize: 60,
  rankPaddingY: 80, rankSpacing: 140, rankNumX: 45, rankTextX: 125, rankBoxWidth: 830,
  rankMaxLines: 1, rankColors: ['#FFD700', '#C0C0C0', '#CD7F32', 'white', 'white'],
  watermarkText: 'ranktop.net', watermarkFontSize: 48, watermarkPadding: 20,
  fontPath: '/usr/share/fonts/truetype/font.ttf', textOutlineWidth: 12
};

if (!fs.existsSync(LAYOUT_CONFIG.fontPath)) throw new Error(`Font missing`);
registerFont(LAYOUT_CONFIG.fontPath, { family: 'CustomFont' });

function fitTextToBox(text, boxWidth, maxLines, initialFontSize) {
  const canvas = createCanvas(boxWidth, 100);
  const ctx = canvas.getContext('2d');
  for (let fontSize = initialFontSize; fontSize >= 1; fontSize -= 2) {
    ctx.font = `${fontSize}px CustomFont`;
    const words = text.split(' '), lines = []; let currentLine = '';
    for (const word of words) {
      const test = currentLine ? `${currentLine} ${word}` : word;
      if (ctx.measureText(test).width <= boxWidth) currentLine = test;
      else { lines.push(currentLine); currentLine = word; }
    }
    if (currentLine) lines.push(currentLine);
    if (lines.length <= maxLines) return { fontSize, lines };
  }
}

function createTextOverlayImage(title, ranks, ranksToShow, targetW, targetH) {
  const canvas = createCanvas(targetW, targetH);
  const ctx = canvas.getContext('2d');
  const scale = targetW / 1080;
  ctx.clearRect(0, 0, targetW, targetH);
  ctx.textBaseline = 'top'; ctx.textAlign = 'left';

  const titleRes = fitTextToBox(title, LAYOUT_CONFIG.titleBoxWidth * scale, 2, 100 * scale);
  const textH = (titleRes.lines.length * titleRes.fontSize) + ((titleRes.lines.length - 1) * 60 * scale);
  const boxH = (70 * scale) + textH;

  ctx.fillStyle = 'black'; ctx.fillRect(0, 0, targetW, boxH);
  ctx.fillStyle = 'white'; ctx.font = `${titleRes.fontSize}px CustomFont`;
  let currY = (boxH - textH) / 2;
  titleRes.lines.forEach(l => {
    ctx.fillText(l, (targetW - ctx.measureText(l).width) / 2, currY);
    currY += titleRes.fontSize + (60 * scale);
  });

  for (let i = 0; i < ranksToShow; i++) {
    const idx = (ranks.length - ranksToShow) + i;
    const y = (80 * scale) + boxH + (idx * 140 * scale);
    const rRes = fitTextToBox(ranks[idx], 830 * scale, 1, 60 * scale);
    ctx.font = `${60 * scale}px CustomFont`;
    ctx.strokeStyle = 'black'; ctx.lineWidth = 12 * scale;
    ctx.strokeText(`${idx + 1}.`, 45 * scale, y);
    ctx.fillStyle = LAYOUT_CONFIG.rankColors[idx] || 'white';
    ctx.fillText(`${idx + 1}.`, 45 * scale, y);
    ctx.font = `${rRes.fontSize}px CustomFont`;
    ctx.strokeText(rRes.lines[0], 125 * scale, y);
    ctx.fillStyle = 'white'; ctx.fillText(rRes.lines[0], 125 * scale, y);
  }
  return canvas;
}

functions.http('processVideos', async (req, res) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' });
  if (req.method === 'OPTIONS') return res.status(204).send('');
  
  if (req.body.action === 'getUploadUrls') {
    const { videoCount, sessionId, fileTypes } = req.body;
    const uploadUrls = [], filePaths = [];
    for (let i = 0; i < videoCount; i++) {
      const fileName = `${sessionId}/v_${i}.${(fileTypes?.[i] || 'video/mp4').split('/')[1]}`;
      const [url] = await cacheBucket.file(fileName).getSignedUrl({ version: 'v4', action: 'write', expires: Date.now() + 900000 });
      uploadUrls.push({ index: i, url }); filePaths.push(fileName);
    }
    return res.json({ uploadUrls, filePaths, sessionId });
  }

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const { sessionId, title, ranks, filePaths } = req.body;
  const tracker = new ProgressTracker(res);
  
  try {
    const local = await Promise.all(filePaths.map(async (fp, i) => {
      const p = `/tmp/i_${i}_${uuidv4()}.mp4`;
      await cacheBucket.file(fp).download({ destination: p }); return p;
    }));

    const processed = await Promise.all(local.map(async (f, i) => {
      const out = `/tmp/p_${i}_${uuidv4()}.mp4`, ov = `/tmp/o_${i}_${uuidv4()}.png`;
      fs.writeFileSync(ov, createTextOverlayImage(title, ranks, i + 1, 720, 1280).toBuffer('image/png'));
      await new Promise((res, rej) => {
        const filter = `[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280[v];[1:v]scale=720:1280[ov];[v][ov]overlay=0:0`;
        spawn('ffmpeg', ['-i', f, '-i', ov, '-filter_complex', filter, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-y', out])
          .on('close', c => { fs.unlinkSync(ov); c === 0 ? res() : rej(); });
      });
      return out;
    }));

    const final = `/tmp/f_${uuidv4()}.mp4`, list = `/tmp/l_${uuidv4()}.txt`;
    fs.writeFileSync(list, processed.map(p => `file '${p}'`).join('\n'));
    await new Promise(r => spawn('ffmpeg', ['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-y', final]).on('close', r));
    
    await outputBucket.upload(final, { destination: `${sessionId}.mp4` });
    const [url] = await outputBucket.file(`${sessionId}.mp4`).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + 3600000 });
    
    [...local, ...processed, final, list].forEach(f => { try { fs.unlinkSync(f); } catch {} });
    tracker.complete(url);
  } catch (e) { tracker.error(e.message); }
});

class ProgressTracker {
  constructor(res) { this.res = res; }
  update(msg, prog) { this.res.write(`data: ${JSON.stringify({ message: msg, progress: prog })}\n\n`); }
  complete(url) { this.res.write(`data: ${JSON.stringify({ complete: true, videoUrl: url })}\n\n`); this.res.end(); }
  error(e) { this.res.write(`data: ${JSON.stringify({ error: e })}\n\n`); this.res.end(); }
}
