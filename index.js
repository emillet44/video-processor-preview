const functions = require('@google-cloud/functions-framework');
const { Storage } = require('@google-cloud/storage');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { createCanvas, registerFont, loadImage } = require('canvas');

const storage = new Storage();
const cacheBucket = storage.bucket('ranktop-v-cache');
const outputBucket = storage.bucket('ranktop-v-preview');

const LAYOUT_CONFIG = {
  fontPath: '/usr/share/fonts/truetype/custom/font.ttf',
  chineseFont: 'Noto Sans CJK SC',
  rankColors: ['#FFD700', '#C0C0C0', '#CD7F32', 'white', 'white'],
};

const emojiCache = new Map();
if (fs.existsSync(LAYOUT_CONFIG.fontPath)) {
  registerFont(LAYOUT_CONFIG.fontPath, { family: 'CustomFont' });
}

// --- Status Management (File based for previews) ---
async function updateStatus(sessionId, status, payload = {}) {
  const file = outputBucket.file(`${sessionId}.json`);
  const data = JSON.stringify({ status, updatedAt: Date.now(), ...payload });
  await file.save(data, { contentType: 'application/json' });
}

// --- Text & Emoji Utilities ---
function getEmojiUrl(emoji) {
  const codePoints = Array.from(emoji).map(c => c.codePointAt(0).toString(16)).join('-');
  return `https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.0.3/assets/72x72/${codePoints}.png`;
}

function getFontForChar(char) {
  if (/\p{Extended_Pictographic}/u.test(char)) return 'Emoji';
  if (/[\u4e00-\u9fa5]|[\u3040-\u30ff]|[\uff00-\uffef]/.test(char)) return LAYOUT_CONFIG.chineseFont;
  return 'CustomFont';
}

function segmentTextByFont(text) {
  const segments = [];
  if (!text) return segments;
  let currentSegment = { text: '', font: '' };
  for (const char of text) {
    const fontNeeded = getFontForChar(char);
    if (currentSegment.text === '') currentSegment = { text: char, font: fontNeeded };
    else if (currentSegment.font === fontNeeded) currentSegment.text += char;
    else { segments.push(currentSegment); currentSegment = { text: char, font: fontNeeded }; }
  }
  if (currentSegment.text) segments.push(currentSegment);
  return segments;
}

function measureMixedText(ctx, text, fontSize) {
  const segments = segmentTextByFont(text);
  let totalWidth = 0;
  segments.forEach(s => {
    if (s.font === 'Emoji') totalWidth += (fontSize * Array.from(s.text).length);
    else { ctx.font = `${fontSize}px "${s.font}"`; totalWidth += ctx.measureText(s.text).width; }
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
          if (!img) { img = await loadImage(url); emojiCache.set(url, img); }
          ctx.drawImage(img, currentX, y + (fontSize * 0.1), fontSize, fontSize);
        } catch (e) {}
        currentX += fontSize;
      }
    } else {
      ctx.font = `${fontSize}px "${s.font}"`;
      if (strokeStyle) { ctx.strokeStyle = strokeStyle; ctx.lineWidth = lineWidth; ctx.strokeText(s.text, currentX, y); }
      ctx.fillStyle = fillStyle; ctx.fillText(s.text, currentX, y);
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

// Auto-stitch overlay: title + all revealed ranks so far
async function createTextOverlayImage(title, ranks, ranksToShow, targetW, targetH) {
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
  for (const l of titleRes.lines) {
    const lw = measureMixedText(ctx, l, titleRes.fontSize);
    await drawMixedText(ctx, l, (targetW - lw) / 2, currY, titleRes.fontSize, 'white');
    currY += titleRes.fontSize + (60 * scale);
  }

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

// --- Pre-edited overlay helpers (preview scale: 720x1280) ---
const PREVIEW_W = 720, PREVIEW_H = 1280;
const PREVIEW_SCALE = PREVIEW_W / 1080;

// Returns the title box height at preview scale, mirroring computeTitleBoxH in the final pipeline.
function computePreviewTitleBoxH(title) {
  const titleRes = fitTextToBox(title, 980 * PREVIEW_SCALE, 2, 100 * PREVIEW_SCALE);
  const textH = (titleRes.lines.length * titleRes.fontSize) + ((titleRes.lines.length - 1) * 60 * PREVIEW_SCALE);
  return { titleRes, boxH: (70 * PREVIEW_SCALE) + textH };
}

// Base overlay: title box + watermark only, no ranks. Always visible.
async function createPreviewBaseOverlay(title) {
  const canvas = createCanvas(PREVIEW_W, PREVIEW_H);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, PREVIEW_W, PREVIEW_H);
  ctx.textBaseline = 'top'; ctx.textAlign = 'left';

  const { titleRes, boxH } = computePreviewTitleBoxH(title);
  const textH = (titleRes.lines.length * titleRes.fontSize) + ((titleRes.lines.length - 1) * 60 * PREVIEW_SCALE);

  ctx.fillStyle = 'black'; ctx.fillRect(0, 0, PREVIEW_W, boxH);
  let currY = (boxH - textH) / 2;
  for (const l of titleRes.lines) {
    const lw = measureMixedText(ctx, l, titleRes.fontSize);
    await drawMixedText(ctx, l, (PREVIEW_W - lw) / 2, currY, titleRes.fontSize, 'white');
    currY += titleRes.fontSize + (60 * PREVIEW_SCALE);
  }

  // Watermark
  const wmFontSize = 48 * PREVIEW_SCALE;
  const wmText = 'ranktop.net';
  const wmW = measureMixedText(ctx, wmText, wmFontSize);
  ctx.save();
  ctx.globalAlpha = 0.6;
  await drawMixedText(ctx, wmText, PREVIEW_W - wmW - (20 * PREVIEW_SCALE), PREVIEW_H - wmFontSize - (20 * PREVIEW_SCALE), wmFontSize, 'white', 'black', 12 * PREVIEW_SCALE);
  ctx.restore();

  return canvas;
}

// One PNG per rank — only that single rank entry, positioned to align with the base overlay.
async function createPreviewRankOverlay(ranks, rankIndex, boxH) {
  const canvas = createCanvas(PREVIEW_W, PREVIEW_H);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, PREVIEW_W, PREVIEW_H);
  ctx.textBaseline = 'top'; ctx.textAlign = 'left';

  const y = (80 * PREVIEW_SCALE) + boxH + (rankIndex * 140 * PREVIEW_SCALE);
  const rRes = fitTextToBox(ranks[rankIndex], 830 * PREVIEW_SCALE, 1, 60 * PREVIEW_SCALE);

  ctx.font = `${60 * PREVIEW_SCALE}px "CustomFont"`;
  ctx.strokeStyle = 'black'; ctx.lineWidth = 12 * PREVIEW_SCALE;
  ctx.strokeText(`${rankIndex + 1}.`, 45 * PREVIEW_SCALE, y);
  ctx.fillStyle = LAYOUT_CONFIG.rankColors[rankIndex] || 'white';
  ctx.fillText(`${rankIndex + 1}.`, 45 * PREVIEW_SCALE, y);

  await drawMixedText(ctx, rRes.lines[0], 125 * PREVIEW_SCALE, y + ((60 * PREVIEW_SCALE - rRes.fontSize) / 2), rRes.fontSize, 'white', 'black', 12 * PREVIEW_SCALE);

  return canvas;
}

// --- Main HTTP Function ---
functions.http('processVideos', async (req, res) => {
  const { action, sessionId } = req.body;

  // 1. Get Upload URLs for auto-stitch (multiple files)
  if (action === 'getUploadUrls') {
    const { videoCount, fileTypes } = req.body;
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

  // 2. Get Upload URL for pre-edited (single file)
  if (action === 'getUploadUrl') {
    const { fileType } = req.body;
    if (!sessionId || !fileType) return res.status(400).json({ error: 'Missing sessionId or fileType' });
    const ext = fileType.split('/')[1] || 'mp4';
    const fileName = `${sessionId}/pre_source.${ext}`;
    const [url] = await cacheBucket.file(fileName).getSignedUrl({
      version: 'v4', action: 'write', expires: Date.now() + 900000, contentType: fileType
    });
    return res.json({ uploadUrl: url, filePath: fileName });
  }

  // 3. Check Status (polling)
  if (action === 'checkStatus') {
    try {
      const file = outputBucket.file(`${sessionId}.json`);
      const [exists] = await file.exists();
      if (!exists) return res.json({ status: 'NOT_FOUND' });
      const [content] = await file.download();
      return res.json(JSON.parse(content.toString()));
    } catch (e) {
      return res.status(500).json({ status: 'ERROR', error: e.message });
    }
  }

  // 4. Auto-stitch rendering (triggered via Cloud Task)
  if (action === 'process') {
    const { title, ranks, filePaths } = req.body;
    const tempFiles = [];

    try {
      await updateStatus(sessionId, 'PROCESSING');

      // Download
      const local = await Promise.all(filePaths.map(async (fp, i) => {
        const p = `/tmp/i_${i}_${uuidv4()}.mp4`;
        await cacheBucket.file(fp).download({ destination: p });
        tempFiles.push(p); return p;
      }));

      // Render segments
      const processed = [];
      for (let i = 0; i < local.length; i++) {
        const out = `/tmp/p_${i}_${uuidv4()}.mp4`;
        const ov = `/tmp/o_${i}_${uuidv4()}.png`;
        tempFiles.push(out, ov);

        const overlayCanvas = await createTextOverlayImage(title, ranks, i + 1, PREVIEW_W, PREVIEW_H);
        fs.writeFileSync(ov, overlayCanvas.toBuffer('image/png'));

        await new Promise((resolve, reject) => {
          const filter = `[0:v]scale=${PREVIEW_W}:${PREVIEW_H}:force_original_aspect_ratio=increase,crop=${PREVIEW_W}:${PREVIEW_H}[v];[1:v]scale=${PREVIEW_W}:${PREVIEW_H}[ov];[v][ov]overlay=0:0`;
          const ff = spawn('ffmpeg', [
            '-i', local[i], '-i', ov, '-filter_complex', filter,
            '-map', '0:a?', '-map', '0:v?',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-y', out
          ]);
          ff.on('error', reject);
          ff.on('close', c => (c === 0 ? resolve() : reject(new Error(`FFmpeg error ${c}`))));
        });
        processed.push(out);
      }

      // Stitch
      const final = `/tmp/f_${uuidv4()}.mp4`, list = `/tmp/l_${uuidv4()}.txt`;
      tempFiles.push(final, list);
      fs.writeFileSync(list, processed.map(p => `file '${p}'`).join('\n'));
      await new Promise((resolve, reject) => {
        spawn('ffmpeg', ['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-y', final])
          .on('error', reject).on('close', c => (c === 0 ? resolve() : reject(new Error('Stitch failed'))));
      });

      // Upload & sign
      const destName = `${sessionId}.mp4`;
      await outputBucket.upload(final, { destination: destName });
      const [url] = await outputBucket.file(destName).getSignedUrl({
        version: 'v4', action: 'read', expires: Date.now() + 3600000
      });

      await updateStatus(sessionId, 'SUCCESS', { videoUrl: url });
      res.status(200).send('OK');

    } catch (e) {
      console.error(e);
      await updateStatus(sessionId, 'FAILED', { error: e.message });
      res.status(500).send(e.message);
    } finally {
      tempFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
      emojiCache.clear();
    }
    return;
  }

  // 5. Pre-edited rendering (triggered via Cloud Task)
  if (action === 'processPreEdited') {
    const { title, ranks, filePath, timestamps, endTime } = req.body;
    const tempFiles = [];

    try {
      await updateStatus(sessionId, 'PROCESSING');

      const parsedRanks = typeof ranks === 'string' ? JSON.parse(ranks) : ranks;
      const parsedEndTime = typeof endTime === 'string' ? parseFloat(endTime) : endTime;
      const sortedTimestamps = [...timestamps].sort((a, b) => a.time - b.time);

      // Download source
      const sourcePath = `/tmp/source_${uuidv4()}${path.extname(filePath) || '.mp4'}`;
      await cacheBucket.file(filePath).download({ destination: sourcePath });
      tempFiles.push(sourcePath);

      // Pre-calculate title box height for rank alignment
      const { boxH } = computePreviewTitleBoxH(title);

      // Base overlay (title + watermark) — always visible, no enable=
      const basePath = `/tmp/base_${uuidv4()}.png`;
      tempFiles.push(basePath);
      fs.writeFileSync(basePath, (await createPreviewBaseOverlay(title)).toBuffer('image/png'));

      // One PNG per rank, mapped in reverse order (highest rank revealed first)
      const rankPaths = [];
      for (let i = 0; i < parsedRanks.length; i++) {
        const rankPath = `/tmp/rank_${i}_${uuidv4()}.png`;
        tempFiles.push(rankPath);
        const rankIndex = parsedRanks.length - 1 - i;
        fs.writeFileSync(rankPath, (await createPreviewRankOverlay(parsedRanks, rankIndex, boxH)).toBuffer('image/png'));
        rankPaths.push({ path: rankPath, rankIndex, timestampSlot: i });
      }

      // Single FFmpeg pass — same filter chain logic as the final pipeline
      const finalPath = `/tmp/f_${uuidv4()}.mp4`;
      tempFiles.push(finalPath);

      const inputArgs = ['-i', sourcePath, '-i', basePath];
      for (const { path: rp } of rankPaths) inputArgs.push('-i', rp);

      const filterParts = [
        `[0:v]scale=${PREVIEW_W}:${PREVIEW_H}:force_original_aspect_ratio=increase,crop=${PREVIEW_W}:${PREVIEW_H}[base_v]`,
        `[1:v]scale=${PREVIEW_W}:${PREVIEW_H}[base_ov]`,
        // No enable= on the base overlay — title and watermark are always visible
        `[base_v][base_ov]overlay=0:0[v_base]`,
      ];
      let prevLabel = 'v_base';
      for (let i = 0; i < rankPaths.length; i++) {
        const { timestampSlot } = rankPaths[i];
        const start = sortedTimestamps[timestampSlot]?.time ?? 0;
        const inputIdx = i + 2;
        filterParts.push(`[${inputIdx}:v]scale=${PREVIEW_W}:${PREVIEW_H}[r${i}]`);
        filterParts.push(`[${prevLabel}][r${i}]overlay=0:0:enable='between(t,${start},${parsedEndTime})'[v${i}]`);
        prevLabel = `v${i}`;
      }

      await new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', [
          ...inputArgs,
          '-filter_complex', filterParts.join(';'),
          '-map', `[${prevLabel}]`,
          '-map', '0:a?',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
          '-c:a', 'aac', '-movflags', '+faststart', '-y', finalPath
        ]);
        let stderr = '';
        ff.stderr.on('data', d => { stderr += d.toString(); });
        ff.on('error', reject);
        ff.on('close', c => (c === 0 ? resolve() : reject(new Error(`FFmpeg pre-edited failed (${c}): ${stderr.slice(-400)}`))));
      });

      // Upload & sign
      const destName = `${sessionId}.mp4`;
      await outputBucket.upload(finalPath, { destination: destName });
      const [url] = await outputBucket.file(destName).getSignedUrl({
        version: 'v4', action: 'read', expires: Date.now() + 3600000
      });

      await updateStatus(sessionId, 'SUCCESS', { videoUrl: url });
      res.status(200).send('OK');

    } catch (e) {
      console.error(e);
      await updateStatus(sessionId, 'FAILED', { error: e.message });
      res.status(500).send(e.message);
    } finally {
      tempFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
      emojiCache.clear();
    }
    return;
  }

  res.status(400).send('Invalid Action');
});
