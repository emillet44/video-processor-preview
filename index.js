const functions = require('@google-cloud/functions-framework');
const { Storage } = require('@google-cloud/storage');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { createCanvas, registerFont, loadImage } = require('canvas');

// --- Configuration ---
const storage = new Storage();
const cacheBucket = storage.bucket('ranktop-v-cache'); // Uploads go here
const outputBucket = storage.bucket('ranktop-v-preview'); // Final previews go here

const LAYOUT_CONFIG = {
  fontPath: '/usr/share/fonts/truetype/custom/font.ttf', // Ensure this exists in your Docker image
  chineseFont: 'Noto Sans CJK SC',
  rankColors: ['#FFD700', '#C0C0C0', '#CD7F32', 'white', 'white']
};

const emojiCache = new Map();

// --- Font Registration ---
try {
  if (fs.existsSync(LAYOUT_CONFIG.fontPath)) {
    registerFont(LAYOUT_CONFIG.fontPath, { family: 'CustomFont' });
  }
} catch (e) {
  console.warn(`Warning: Main font missing at ${LAYOUT_CONFIG.fontPath}`);
}

// --- Text & Emoji Utilities ---
function getEmojiUrl(emoji) {
  const codePoints = Array.from(emoji)
    .map(c => c.codePointAt(0).toString(16))
    .join('-');
  return `https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.0.3/assets/72x72/${codePoints}.png`;
}

function getFontForChar(char) {
  const isCJK = /[\u4e00-\u9fa5]|[\u3040-\u30ff]|[\uff00-\uffef]/.test(char);
  const isEmoji = /\p{Extended_Pictographic}/u.test(char);
  if (isEmoji) return 'Emoji';
  if (isCJK) return LAYOUT_CONFIG.chineseFont;
  return 'CustomFont';
}

function segmentTextByFont(text) {
  const segments = [];
  if (!text) return segments;
  let currentSegment = { text: '', font: '' };
  for (const char of text) {
    const fontNeeded = getFontForChar(char);
    if (currentSegment.text === '') {
      currentSegment = { text: char, font: fontNeeded };
    } else if (currentSegment.font === fontNeeded) {
      currentSegment.text += char;
    } else {
      segments.push(currentSegment);
      currentSegment = { text: char, font: fontNeeded };
    }
  }
  if (currentSegment.text) segments.push(currentSegment);
  return segments;
}

function measureMixedText(ctx, text, fontSize) {
  const segments = segmentTextByFont(text);
  let totalWidth = 0;
  segments.forEach(s => {
    if (s.font === 'Emoji') {
      totalWidth += (fontSize * Array.from(s.text).length);
    } else {
      ctx.font = `${fontSize}px "${s.font}"`;
      totalWidth += ctx.measureText(s.text).width;
    }
  });
  return totalWidth;
}

async function drawMixedText(ctx, text, x, y, fontSize, fillStyle, strokeStyle = null, lineWidth = 0) {
  const segments = segmentTextByFont(text);
  let currentX = x;

  for (const s of segments) {
    if (s.font === 'Emoji') {
      const emojis = Array.from(s.text);
      for (const emoji of emojis) {
        try {
          const url = getEmojiUrl(emoji);
          let img = emojiCache.get(url);
          if (!img) {
            img = await loadImage(url);
            emojiCache.set(url, img);
          }
          ctx.drawImage(img, currentX, y + (fontSize * 0.1), fontSize, fontSize);
          currentX += fontSize;
        } catch (e) {
          currentX += fontSize;
        }
      }
    } else {
      ctx.font = `${fontSize}px "${s.font}"`;
      if (strokeStyle && lineWidth > 0) {
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = lineWidth;
        ctx.strokeText(s.text, currentX, y);
      }
      ctx.fillStyle = fillStyle;
      ctx.fillText(s.text, currentX, y);
      currentX += ctx.measureText(s.text).width;
    }
  }
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

async function createTextOverlayImage(title, ranks, ranksToShow, targetW, targetH) {
  const canvas = createCanvas(targetW, targetH);
  const ctx = canvas.getContext('2d');
  const scale = targetW / 1080;
  ctx.clearRect(0, 0, targetW, targetH);
  ctx.textBaseline = 'top'; ctx.textAlign = 'left';

  // Draw Title
  const titleRes = fitTextToBox(title, 980 * scale, 2, 100 * scale);
  const textH = (titleRes.lines.length * titleRes.fontSize) + ((titleRes.lines.length - 1) * 60 * scale);
  const boxH = (70 * scale) + textH;

  ctx.fillStyle = 'black'; ctx.fillRect(0, 0, targetW, boxH);
  let currY = (boxH - textH) / 2;
  for (const l of titleRes.lines) {
    const lw = measureMixedText(ctx, l, titleRes.fontSize);
    await drawMixedText(ctx, l, (targetW - lw) / 2, currY, titleRes.fontSize, 'white');
    currY += titleRes.fontSize + (60 * scale);
  }

  // Draw Ranks
  for (let i = 0; i < ranksToShow; i++) {
    const idx = (ranks.length - ranksToShow) + i;
    const y = (80 * scale) + boxH + (idx * 140 * scale);
    const rRes = fitTextToBox(ranks[idx], 830 * scale, 1, 60 * scale);
    
    ctx.font = `${60 * scale}px "CustomFont"`;
    ctx.strokeStyle = 'black'; ctx.lineWidth = 12 * scale;
    ctx.strokeText(`${idx + 1}.`, 45 * scale, y);
    ctx.fillStyle = LAYOUT_CONFIG.rankColors[idx] || 'white';
    ctx.fillText(`${idx + 1}.`, 45 * scale, y);
    
    await drawMixedText(ctx, rRes.lines[0], 125 * scale, y, rRes.fontSize, 'white', 'black', 12 * scale);
  }
  return canvas;
}

// --- Main HTTP Function ---
functions.http('processVideos', async (req, res) => {
  res.set({ 
    'Access-Control-Allow-Origin': '*', 
    'Access-Control-Allow-Methods': 'POST', 
    'Access-Control-Allow-Headers': 'Content-Type' 
  });
  
  if (req.method === 'OPTIONS') return res.status(204).send('');
  
  // 1. Handle Upload URL Generation
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

  // 2. Handle Video Processing Stream
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const { sessionId, title, ranks, filePaths } = req.body;
  const tracker = new ProgressTracker(res);
  const tempFiles = [];

  try {
    const totalSteps = filePaths.length;
    tracker.update('Downloading fragments...', 5);
    
    // Download source videos
    const local = await Promise.all(filePaths.map(async (fp, i) => {
      const p = `/tmp/i_${i}_${uuidv4()}.mp4`;
      await cacheBucket.file(fp).download({ destination: p });
      tempFiles.push(p);
      return p;
    }));

    const processed = [];
    for (let i = 0; i < local.length; i++) {
      const f = local[i];
      const out = `/tmp/p_${i}_${uuidv4()}.mp4`;
      const ov = `/tmp/o_${i}_${uuidv4()}.png`;
      tempFiles.push(out, ov);

      const renderProgress = 15 + Math.floor(((i) / totalSteps) * 60);
      tracker.update(`Rendering fragment ${i + 1} of ${totalSteps}...`, renderProgress);

      const overlayCanvas = await createTextOverlayImage(title, ranks, i + 1, 720, 1280);
      fs.writeFileSync(ov, overlayCanvas.toBuffer('image/png'));
      
      await new Promise((resolve, reject) => {
        // Complex filter: Scale video and overlay, then overlay them.
        const filter = `[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280[v];[1:v]scale=720:1280[ov];[v][ov]overlay=0:0`;
        
        const ff = spawn('ffmpeg', [
            '-i', f, 
            '-i', ov, 
            '-filter_complex', filter, 
            '-map', '0:a?', // Preserve audio if it exists
            '-map', '0:v?', // Fallback map (usually handled by filter, but good practice)
            '-c:v', 'libx264', 
            '-preset', 'ultrafast', // Speed priority for previews
            '-crf', '28', 
            '-y', out
        ]);
        
        ff.on('error', reject);
        ff.on('close', c => {
            try { if (fs.existsSync(ov)) fs.unlinkSync(ov); } catch(e) {}
            c === 0 ? resolve() : reject(new Error(`FFmpeg failed at segment ${i}`));
        });
      });
      processed.push(out);
      tracker.update(`Fragment ${i + 1} processed`, 15 + Math.floor(((i + 1) / totalSteps) * 60));
    }

    tracker.update('Stitching segments...', 75);
    const final = `/tmp/f_${uuidv4()}.mp4`, list = `/tmp/l_${uuidv4()}.txt`;
    tempFiles.push(final, list);
    fs.writeFileSync(list, processed.map(p => `file '${p}'`).join('\n'));
    
    await new Promise((resolve, reject) => {
        spawn('ffmpeg', ['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-y', final])
        .on('error', reject)
        .on('close', resolve);
    });

    tracker.update('Finalizing upload...', 92);
    const destName = `${sessionId}.mp4`;
    await outputBucket.upload(final, { destination: destName });
    const [url] = await outputBucket.file(destName).getSignedUrl({ 
        version: 'v4', action: 'read', expires: Date.now() + 3600000 
    });
    
    tracker.complete(url);
  } catch (e) { 
    console.error("Task failed:", e);
    tracker.error(e.message); 
  } finally {
    tempFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
    emojiCache.clear();
  }
});

class ProgressTracker {
  constructor(res) { this.res = res; }
  update(msg, prog) { this.res.write(`data: ${JSON.stringify({ message: msg, progress: prog })}\n\n`); }
  complete(url) { this.res.write(`data: ${JSON.stringify({ complete: true, videoUrl: url, progress: 100 })}\n\n`); this.res.end(); }
  error(e) { this.res.write(`data: ${JSON.stringify({ error: e })}\n\n`); this.res.end(); }
}
