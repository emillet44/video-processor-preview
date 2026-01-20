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

const LAYOUT_CONFIG = {
  fontPath: '/usr/share/fonts/truetype/custom/font.ttf',
  fallbackFontPath: '/usr/share/fonts/truetype/custom/NotoSans-Regular.ttf',
  rankColors: ['#FFD700', '#C0C0C0', '#CD7F32', 'white', 'white']
};

// --- Font Registration ---
if (fs.existsSync(LAYOUT_CONFIG.fontPath)) {
  registerFont(LAYOUT_CONFIG.fontPath, { family: 'CustomFont' });
} else {
  throw new Error(`Main font missing at ${LAYOUT_CONFIG.fontPath}`);
}

let hasFallbackFont = false;
if (fs.existsSync(LAYOUT_CONFIG.fallbackFontPath)) {
  registerFont(LAYOUT_CONFIG.fallbackFontPath, { family: 'FallbackFont' });
  hasFallbackFont = true;
}

// --- Text Utilities ---
function needsFallbackFont(char) {
  if (!hasFallbackFont) return false;
  const code = char.charCodeAt(0);
  return code > 0x024F; 
}

function segmentTextByFont(text) {
  const segments = [];
  if (!text) return segments;
  let currentSegment = { text: '', needsFallback: false };
  for (const char of text) {
    const charNeedsFallback = needsFallbackFont(char);
    if (currentSegment.text === '') {
      currentSegment = { text: char, needsFallback: charNeedsFallback };
    } else if (currentSegment.needsFallback === charNeedsFallback) {
      currentSegment.text += char;
    } else {
      segments.push(currentSegment);
      currentSegment = { text: char, needsFallback: charNeedsFallback };
    }
  }
  if (currentSegment.text) segments.push(currentSegment);
  return segments;
}

function measureMixedText(ctx, text, fontSize) {
  const segments = segmentTextByFont(text);
  let totalWidth = 0;
  segments.forEach(s => {
    ctx.font = `${fontSize}px "${s.needsFallback ? 'FallbackFont' : 'CustomFont'}"`;
    totalWidth += ctx.measureText(s.text).width;
  });
  return totalWidth;
}

function drawMixedText(ctx, text, x, y, fontSize, fillStyle, strokeStyle = null, lineWidth = 0) {
  const segments = segmentTextByFont(text);
  let currentX = x;
  segments.forEach(s => {
    ctx.font = `${fontSize}px "${s.needsFallback ? 'FallbackFont' : 'CustomFont'}"`;
    if (strokeStyle && lineWidth > 0) {
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = lineWidth;
      ctx.strokeText(s.text, currentX, y);
    }
    ctx.fillStyle = fillStyle;
    ctx.fillText(s.text, currentX, y);
    currentX += ctx.measureText(s.text).width;
  });
}

function fitTextToBox(text, boxWidth, maxLines, initialFontSize) {
  const canvas = createCanvas(boxWidth, 100);
  const ctx = canvas.getContext('2d');
  for (let fontSize = initialFontSize; fontSize >= 1; fontSize -= 2) {
    const words = text.split(' '), lines = []; let currentLine = '';
    for (const word of words) {
      const test = currentLine ? `${currentLine} ${word}` : word;
      if (measureMixedText(ctx, test, fontSize) <= boxWidth) currentLine = test;
      else { lines.push(currentLine); currentLine = word; }
    }
    if (currentLine) lines.push(currentLine);
    if (lines.length <= maxLines) return { fontSize, lines };
  }
  return { fontSize: 10, lines: [text] };
}

function createTextOverlayImage(title, ranks, ranksToShow, targetW, targetH) {
  const canvas = createCanvas(targetW, targetH);
  const ctx = canvas.getContext('2d');
  const scale = targetW / 1080;
  ctx.clearRect(0, 0, targetW, targetH);
  ctx.textBaseline = 'top'; ctx.textAlign = 'left';

  const titleRes = fitTextToBox(title, 980 * scale, 2, 100 * scale);
  const textH = (titleRes.lines.length * titleRes.fontSize) + ((titleRes.lines.length - 1) * 60 * scale);
  const boxH = (70 * scale) + textH;

  ctx.fillStyle = 'black'; ctx.fillRect(0, 0, targetW, boxH);
  let currY = (boxH - textH) / 2;
  titleRes.lines.forEach(l => {
    const lw = measureMixedText(ctx, l, titleRes.fontSize);
    drawMixedText(ctx, l, (targetW - lw) / 2, currY, titleRes.fontSize, 'white');
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
    
    drawMixedText(ctx, rRes.lines[0], 125 * scale, y, rRes.fontSize, 'white', 'black', 12 * scale);
  }
  return canvas;
}

// --- Main Function ---
functions.http('processVideos', async (req, res) => {
  res.set({ 
    'Access-Control-Allow-Origin': '*', 
    'Access-Control-Allow-Methods': 'POST', 
    'Access-Control-Allow-Headers': 'Content-Type' 
  });
  
  if (req.method === 'OPTIONS') return res.status(204).send('');
  
  // Handle Upload URL generation
  if (req.body.action === 'getUploadUrls') {
    const { videoCount, sessionId, fileTypes } = req.body;
    const uploadUrls = [], filePaths = [];
    for (let i = 0; i < videoCount; i++) {
      const fileName = `${sessionId}/v_${i}.${(fileTypes?.[i] || 'video/mp4').split('/')[1]}`;
      const [url] = await cacheBucket.file(fileName).getSignedUrl({ 
        version: 'v4', action: 'write', expires: Date.now() + 900000 
      });
      uploadUrls.push({ index: i, url }); filePaths.push(fileName);
    }
    return res.json({ uploadUrls, filePaths, sessionId });
  }

  // Handle Video Processing
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const { sessionId, title, ranks, filePaths } = req.body;
  const tracker = new ProgressTracker(res);
  const tempFiles = [];

  try {
    const totalSteps = filePaths.length;
    
    // Step 1: Download (0% - 15%)
    tracker.update('Downloading fragments...', 5);
    const local = await Promise.all(filePaths.map(async (fp, i) => {
      const p = `/tmp/i_${i}_${uuidv4()}.mp4`;
      await cacheBucket.file(fp).download({ destination: p });
      tempFiles.push(p);
      return p;
    }));
    tracker.update('Download complete', 15);

    // Step 2: Render Segments (15% - 75%)
    const processed = [];
    for (let i = 0; i < local.length; i++) {
      const f = local[i];
      const out = `/tmp/p_${i}_${uuidv4()}.mp4`;
      const ov = `/tmp/o_${i}_${uuidv4()}.png`;
      tempFiles.push(out, ov);

      // UI Update
      const renderProgress = 15 + Math.floor(((i) / totalSteps) * 60);
      tracker.update(`Rendering fragment ${i + 1} of ${totalSteps}...`, renderProgress);

      fs.writeFileSync(ov, createTextOverlayImage(title, ranks, i + 1, 720, 1280).toBuffer('image/png'));
      
      await new Promise((resolve, reject) => {
        const filter = `[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280[v];[1:v]scale=720:1280[ov];[v][ov]overlay=0:0`;
        const ff = spawn('ffmpeg', [
            '-i', f, '-i', ov, '-filter_complex', filter, 
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-y', out
        ]);
        
        ff.on('error', reject);
        ff.on('close', c => {
            try { fs.unlinkSync(ov); } catch(e) {}
            c === 0 ? resolve() : reject(new Error(`FFmpeg failed at segment ${i}`));
        });
      });
      processed.push(out);
      
      // Post-segment update
      const postRenderProgress = 15 + Math.floor(((i + 1) / totalSteps) * 60);
      tracker.update(`Fragment ${i + 1} processed`, postRenderProgress);
    }

    // Step 3: Stitching (75% - 90%)
    tracker.update('Stitching segments together...', 75);
    const final = `/tmp/f_${uuidv4()}.mp4`, list = `/tmp/l_${uuidv4()}.txt`;
    tempFiles.push(final, list);
    fs.writeFileSync(list, processed.map(p => `file '${p}'`).join('\n'));
    
    await new Promise((resolve, reject) => {
        spawn('ffmpeg', ['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-y', final])
        .on('error', reject)
        .on('close', resolve);
    });
    tracker.update('Stitching complete', 90);

    // Step 4: Final Upload (90% - 100%)
    tracker.update('Finalizing video upload...', 92);
    await outputBucket.upload(final, { destination: `${sessionId}.mp4` });
    const [url] = await outputBucket.file(`${sessionId}.mp4`).getSignedUrl({ 
        version: 'v4', action: 'read', expires: Date.now() + 3600000 
      });
    
    tracker.complete(url);
  } catch (e) { 
    console.error("Task failed:", e);
    tracker.error(e.message); 
  } finally {
    // Proactive cleanup
    tempFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
  }
});

class ProgressTracker {
  constructor(res) { this.res = res; }
  update(msg, prog) { 
    this.res.write(`data: ${JSON.stringify({ message: msg, progress: prog })}\n\n`); 
  }
  complete(url) { 
    this.res.write(`data: ${JSON.stringify({ complete: true, videoUrl: url, progress: 100 })}\n\n`); 
    this.res.end(); 
  }
  error(e) { 
    this.res.write(`data: ${JSON.stringify({ error: e })}\n\n`); 
    this.res.end(); 
  }
}
