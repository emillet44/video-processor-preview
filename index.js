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

// --- Configuration & Assets ---
const FONTS = {
  'Archivo Expanded Bold': '/usr/share/fonts/truetype/custom/font.ttf',
  'Arial Regular': '/usr/share/fonts/truetype/custom/Arial-Regular.ttf',
};

// Register all available fonts
Object.entries(FONTS).forEach(([family, p]) => {
  if (fs.existsSync(p)) {
    registerFont(p, { family });
  }
});

const CHINESE_FONT = 'Noto Sans CJK SC';
const emojiCache = new Map();

/**
 * Scales config values for the target render resolution (720p).
 * Base is 1080p (Original). 720 / 1080 = 0.666...
 */
function getScaledSettings(config, targetWidth) {
  const scale = targetWidth / 1080;
  return {
    titleFontSize: (config.titleFontSize ?? 100) * scale,
    titleLineSpacing: (config.titleLineSpacing ?? 30) * scale,
    titleBoxWidth: (config.titleBoxWidth ?? 980) * scale,
    titleMaxLines: config.titleMaxLines ?? 2,
    titleBoxTopPadding: (config.titleBoxTopPadding ?? 30) * scale,
    titleBoxBottomPadding: (config.titleBoxBottomPadding ?? 40) * scale,
    subtitleFontSize: (config.subtitleFontSize ?? 44) * scale,
    subtitleTopMargin: (config.subtitleTopMargin ?? 10) * scale,
    rankFontSize: (config.rankFontSize ?? 60) * scale,
    rankSpacing: (config.rankSpacing ?? 140) * scale,
    rankPaddingY: (config.rankPaddingY ?? 80) * scale,
    rankNumX: 45 * scale,
    rankTextX: 125 * scale,
    rankBoxWidth: (config.rankBoxWidth ?? 830) * scale,
    textOutlineWidth: (config.textOutlineWidth ?? (config.fontFamily === 'Arial Regular' ? 9 : 18)) * scale,
    watermarkFontSize: 48 * scale,
    watermarkPadding: 20 * scale,
    creatorWatermarkFontSize: 44 * scale,
    creatorWatermarkBottomPadding: 80 * scale,
    scale,
  };
}

// --- Text & Emoji Utilities ---
function getEmojiUrl(emoji) {
  const codePoints = Array.from(emoji).map(c => c.codePointAt(0).toString(16)).join('-');
  return `https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.0.3/assets/72x72/${codePoints}.png`;
}

function getFontForChar(char, primaryFont) {
  if (/\p{Extended_Pictographic}/u.test(char)) return 'Emoji';
  if (/[\u4e00-\u9fa5]|[\u3040-\u30ff]|[\uff00-\uffef]/.test(char)) return CHINESE_FONT;
  return primaryFont;
}

function segmentTextByFont(text, primaryFont) {
  const segments = [];
  if (!text) return segments;
  let currentSegment = { text: '', font: '' };
  for (const char of text) {
    const fontNeeded = getFontForChar(char, primaryFont);
    if (currentSegment.text === '') currentSegment = { text: char, font: fontNeeded };
    else if (currentSegment.font === fontNeeded) currentSegment.text += char;
    else { segments.push(currentSegment); currentSegment = { text: char, font: fontNeeded }; }
  }
  if (currentSegment.text) segments.push(currentSegment);
  return segments;
}

function measureMixedText(ctx, text, fontSize, primaryFont) {
  const segments = segmentTextByFont(text, primaryFont);
  let totalWidth = 0;
  segments.forEach(s => {
    if (s.font === 'Emoji') totalWidth += (fontSize * Array.from(s.text).length);
    else { ctx.font = `${fontSize}px "${s.font}"`; totalWidth += ctx.measureText(s.text).width; }
  });
  return totalWidth;
}

async function drawMixedText(ctx, text, x, y, fontSize, primaryFont, fillStyle, strokeStyle = null, lineWidth = 0) {
  const segments = segmentTextByFont(text, primaryFont);
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
  return currentX - x; // return width drawn
}

function wrapText(ctx, text, maxWidth, maxLines, fontSize, primaryFont) {
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const testWidth = measureMixedText(ctx, testLine, fontSize, primaryFont);
    if (testWidth <= maxWidth) {
      currentLine = testLine;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines.slice(0, maxLines);
}

function fitTextToBox(text, boxWidth, maxLines, initialFontSize, primaryFont) {
  const canvas = createCanvas(100, 100);
  const ctx = canvas.getContext('2d');
  for (let size = initialFontSize; size >= 10; size -= 2) {
    const lines = wrapText(ctx, text, boxWidth, maxLines, size, primaryFont);
    if (lines.length <= maxLines) return { fontSize: size, lines };
  }
  return { fontSize: 10, lines: [text] };
}

// --- Status Management ---
async function updateStatus(sessionId, status, payload = {}) {
  const file = outputBucket.file(`${sessionId}.json`);
  const data = JSON.stringify({ status, updatedAt: Date.now(), ...payload });
  await file.save(data, { contentType: 'application/json' });
}

// --- Rendering Core ---

/**
 * Generates the full composite overlay image for a frame.
 * Used for both Auto-stitch (progressive) and Pre-edited (layers).
 */
async function createOverlayImage(targetW, targetH, title, ranks, ranksToShow, config) {
  const canvas = createCanvas(targetW, targetH);
  const ctx = canvas.getContext('2d');
  const S = getScaledSettings(config, targetW);
  const font = config.fontFamily || 'Archivo Expanded Bold';

  ctx.clearRect(0, 0, targetW, targetH);
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // 1. Title & Subtitle Layout
  const titleRes = fitTextToBox(title || 'Title', S.titleBoxWidth, S.titleMaxLines, S.titleFontSize, font);
  const textH = titleRes.lines.length * titleRes.fontSize + (titleRes.lines.length - 1) * S.titleLineSpacing;
  const subtitleH = config.subtitle ? S.subtitleTopMargin + S.subtitleFontSize : 0;
  const boxH = S.titleBoxTopPadding + textH + subtitleH + S.titleBoxBottomPadding;

  // 2. Title Backdrop
  if (config.titleBackdrop === 'black' || config.titleBackdrop === 'white') {
    ctx.fillStyle = config.titleBackdrop;
    ctx.fillRect(0, 0, targetW, boxH);
  } else if (config.titleBackdrop === 'blurred') {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, targetW, boxH);
  }

  // 3. Render Title (with word colors)
  const wordColorMap = new Map();
  (config.titleWordColors || []).forEach(wc => wordColorMap.set(wc.word.toLowerCase(), wc.color));

  let currY = (boxH - subtitleH - textH) / 2;
  
  if (config.textShadow !== false && config.titleShadowBlur) {
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = config.titleShadowBlur * S.scale;
  }

  for (const line of titleRes.lines) {
    const lineWidth = measureMixedText(ctx, line, titleRes.fontSize, font);
    let currentX = (targetW - lineWidth) / 2;
    const words = line.split(' ');
    
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const displayWord = i < words.length - 1 ? `${word} ` : word;
      const color = wordColorMap.get(word.toLowerCase()) || 'white';
      
      const drawnWidth = await drawMixedText(
        ctx, displayWord, currentX, currY, titleRes.fontSize, font,
        color, (config.textShadow !== false ? 'black' : null), S.textOutlineWidth
      );
      currentX += drawnWidth;
    }
    currY += titleRes.fontSize + S.titleLineSpacing;
    ctx.shadowBlur = 0;
  }

  // 4. Subtitle
  if (config.subtitle) {
    const subW = measureMixedText(ctx, config.subtitle, S.subtitleFontSize, font);
    await drawMixedText(
      ctx, config.subtitle, (targetW - subW) / 2, currY + S.subtitleTopMargin, 
      S.subtitleFontSize, font, config.subtitleColor || '#CCCCCC',
      (config.textShadow !== false ? 'black' : null), S.textOutlineWidth * 0.5
    );
  }

  // 5. Ranks
  for (let i = 0; i < ranksToShow; i++) {
    const rankText = ranks[i];
    if (!rankText) continue;

    const y = S.rankPaddingY + boxH + i * S.rankSpacing;
    const rankColor = config.rankColors?.[i] ?? 'white';

    if (config.textShadow !== false && config.rankShadowBlur) {
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = config.rankShadowBlur * S.scale;
    }

    // Rank Number
    await drawMixedText(
      ctx, `${i + 1}.`, S.rankNumX, y, S.rankFontSize, font,
      rankColor, (config.textShadow !== false ? 'black' : null), S.textOutlineWidth
    );

    // Rank Text
    const rRes = fitTextToBox(rankText, S.rankBoxWidth, 1, S.rankFontSize, font);
    const centerY = y + (S.rankFontSize - rRes.fontSize) / 2;
    await drawMixedText(
      ctx, rRes.lines[0], S.rankTextX, centerY, rRes.fontSize, font,
      (config.matchRankColor ? rankColor : 'white'),
      (config.textShadow !== false ? 'black' : null), S.textOutlineWidth
    );
    ctx.shadowBlur = 0;
  }

  // 6. Watermarks
  ctx.globalAlpha = 0.6;
  const wmText = 'ranktop.net';
  const wmW = measureMixedText(ctx, wmText, S.watermarkFontSize, font);
  await drawMixedText(
    ctx, wmText, targetW - wmW - S.watermarkPadding, targetH - S.watermarkFontSize - S.watermarkPadding,
    S.watermarkFontSize, font, 'white', 'black', S.textOutlineWidth
  );

  if (config.creatorWatermark) {
    ctx.globalAlpha = 0.7;
    const cwmW = measureMixedText(ctx, config.creatorWatermark, S.creatorWatermarkFontSize, font);
    await drawMixedText(
      ctx, config.creatorWatermark, (targetW - cwmW) / 2, 
      targetH - S.creatorWatermarkFontSize - S.creatorWatermarkBottomPadding,
      S.creatorWatermarkFontSize, font, config.creatorWatermarkColor || 'white',
      'black', S.textOutlineWidth * 0.6
    );
  }

  return canvas;
}

// --- HTTP Route Handlers ---

functions.http('processVideos', async (req, res) => {
  const { action, sessionId, layoutConfig = {} } = req.body;
  const RENDER_W = 720, RENDER_H = 1280;

  // 1. Utility Handlers
  if (action === 'getUploadUrls') {
    const { videoCount, fileTypes } = req.body;
    const uploadUrls = [], filePaths = [];
    for (let i = 0; i < videoCount; i++) {
      const fileName = `${sessionId}/v_${i}.${(fileTypes?.[i] || 'video/mp4').split('/')[1]}`;
      const [url] = await cacheBucket.file(fileName).getSignedUrl({ version: 'v4', action: 'write', expires: Date.now() + 900000 });
      uploadUrls.push({ index: i, url }); filePaths.push(fileName);
    }
    return res.json({ uploadUrls, filePaths, sessionId });
  }

  if (action === 'getUploadUrl') {
    const { fileType } = req.body;
    const ext = fileType.split('/')[1] || 'mp4';
    const fileName = `${sessionId}/pre_source.${ext}`;
    const [url] = await cacheBucket.file(fileName).getSignedUrl({ version: 'v4', action: 'write', expires: Date.now() + 900000, contentType: fileType });
    return res.json({ uploadUrl: url, filePath: fileName });
  }

  if (action === 'checkStatus') {
    const file = outputBucket.file(`${sessionId}.json`);
    const [exists] = await file.exists();
    if (!exists) return res.json({ status: 'NOT_FOUND' });
    const [content] = await file.download();
    return res.json(JSON.parse(content.toString()));
  }

  // 2. Heavy Rendering Pipelines
  if (action === 'process' || action === 'processPreEdited') {
    const tempFiles = [];
    try {
      await updateStatus(sessionId, 'PROCESSING');

      if (action === 'process') {
        const { title, ranks, filePaths } = req.body;
        const localPaths = await Promise.all(filePaths.map(async (fp, i) => {
          const p = `/tmp/i_${i}_${uuidv4()}.mp4`;
          await cacheBucket.file(fp).download({ destination: p });
          tempFiles.push(p); return p;
        }));

        const processed = [];
        for (let i = 0; i < localPaths.length; i++) {
          const out = `/tmp/p_${i}_${uuidv4()}.mp4`;
          const ov = `/tmp/o_${i}_${uuidv4()}.png`;
          tempFiles.push(out, ov);

          const canvas = await createOverlayImage(RENDER_W, RENDER_H, title, ranks, i + 1, layoutConfig);
          fs.writeFileSync(ov, canvas.toBuffer('image/png'));

          await new Promise((resolve, reject) => {
            const filter = `[0:v]scale=${RENDER_W}:${RENDER_H}:force_original_aspect_ratio=increase,crop=${RENDER_W}:${RENDER_H}[v];[1:v]scale=${RENDER_W}:${RENDER_H}[ov];[v][ov]overlay=0:0`;
            spawn('ffmpeg', ['-i', localPaths[i], '-i', ov, '-filter_complex', filter, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-y', out])
              .on('error', reject).on('close', c => (c === 0 ? resolve() : reject(new Error('FFmpeg segment failed'))));
          });
          processed.push(out);
        }

        const final = `/tmp/f_${uuidv4()}.mp4`, list = `/tmp/l_${uuidv4()}.txt`;
        tempFiles.push(final, list);
        fs.writeFileSync(list, processed.map(p => `file '${p}'`).join('\n'));
        await new Promise((resolve, reject) => {
          spawn('ffmpeg', ['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-y', final])
            .on('error', reject).on('close', c => (c === 0 ? resolve() : reject(new Error('Stitch failed'))));
        });

        const destName = `${sessionId}.mp4`;
        await outputBucket.upload(final, { destination: destName });
        const [url] = await outputBucket.file(destName).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + 3600000 });
        await updateStatus(sessionId, 'SUCCESS', { videoUrl: url });
      }

      if (action === 'processPreEdited') {
        const { title, ranks, filePath, timestamps, endTime } = req.body;
        const sourcePath = `/tmp/src_${uuidv4()}.mp4`;
        await cacheBucket.file(filePath).download({ destination: sourcePath });
        tempFiles.push(sourcePath);

        const sortedT = [...timestamps].sort((a, b) => a.time - b.time);
        const finalPath = `/tmp/f_${uuidv4()}.mp4`;
        tempFiles.push(finalPath);

        const inputArgs = ['-i', sourcePath];
        const filterParts = [`[0:v]scale=${RENDER_W}:${RENDER_H}:force_original_aspect_ratio=increase,crop=${RENDER_W}:${RENDER_H}[base_v]`];
        
        const baseOv = `/tmp/b_${uuidv4()}.png`;
        tempFiles.push(baseOv);
        const baseCanvas = await createOverlayImage(RENDER_W, RENDER_H, title, [], 0, layoutConfig);
        fs.writeFileSync(baseOv, baseCanvas.toBuffer('image/png'));
        inputArgs.push('-i', baseOv);
        filterParts.push(`[1:v]scale=${RENDER_W}:${RENDER_H}[base_ov]`, `[base_v][base_ov]overlay=0:0[v_base]`);

        let prevLabel = 'v_base';
        for (let i = 0; i < ranks.length; i++) {
          const rankOv = `/tmp/r_${i}_${uuidv4()}.png`;
          tempFiles.push(rankOv);
          const rConfig = { ...layoutConfig, titleBackdrop: 'none', subtitle: '', creatorWatermark: '' };
          const rankCanvas = await createOverlayImage(RENDER_W, RENDER_H, "", ranks, i + 1, rConfig);
          fs.writeFileSync(rankOv, rankCanvas.toBuffer('image/png'));
          
          const inputIdx = i + 2;
          const start = sortedT[ranks.length - 1 - i]?.time ?? 0;
          inputArgs.push('-i', rankOv);
          filterParts.push(`[${inputIdx}:v]scale=${RENDER_W}:${RENDER_H}[r${i}]`);
          filterParts.push(`[${prevLabel}][r${i}]overlay=0:0:enable='between(t,${start},${endTime})'[v${i}]`);
          prevLabel = `v${i}`;
        }

        await new Promise((resolve, reject) => {
          spawn('ffmpeg', [...inputArgs, '-filter_complex', filterParts.join(';'), '-map', `[${prevLabel}]`, '-map', '0:a?', '-c:v', 'libx264', '-preset', 'ultrafast', '-y', finalPath] )
            .on('error', reject).on('close', resolve);
        });

        const destName = `${sessionId}.mp4`;
        await outputBucket.upload(finalPath, { destination: destName });
        const [url] = await outputBucket.file(destName).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + 3600000 });
        await updateStatus(sessionId, 'SUCCESS', { videoUrl: url });
      }

      res.status(200).send('OK');
    } catch (e) {
      console.error(e);
      await updateStatus(sessionId, 'FAILED', { error: e.message });
      res.status(500).send(e.message);
    } finally {
      tempFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
      emojiCache.clear();
    }
  }
});
