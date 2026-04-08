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

// ─────────────────────────────────────────────────────────────────────────────
// PREVIEW LAYOUT CONFIG (Optimized for 720p)
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_LAYOUT_CONFIG = {
  fontFamily: 'Archivo Expanded Bold',
  chineseFont: 'Noto Sans CJK SC',

  // Title
  titleFontSize: 100,
  titleLineSpacing: 30,
  titleBoxWidth: 980,
  titleMaxLines: 2,
  titleBoxTopPadding: 30,
  titleBoxBottomPadding: 40,
  titleBackdrop: 'black',         // 'none' | 'black' | 'white' | 'blurred'
  titleWordColors: [],
  titleDefaultColor: 'white',
  titleShadowBlur: 25,
  titleShadowColor: 'rgba(0,0,0,0.8)',

  // Subtitle
  subtitle: '',
  subtitleFontSize: 44,
  subtitleColor: '#CCCCCC',
  subtitleTopMargin: 10,

  // Ranks
  rankFontSize: 60,
  rankSpacing: 140,
  rankPaddingY: 80,
  rankNumX: 45,
  rankTextX: 125,
  rankBoxWidth: 830,
  rankMaxLines: 1,
  rankColors: ['#FFD700', '#C0C0C0', '#CD7F32', 'white', 'white'],
  rankShadowBlur: 5,
  rankShadowColor: 'rgba(0,0,0,0.8)',

  // Text styling
  textShadow: true,

  // Watermarks
  watermarkText: 'ranktop.net',
  watermarkFontSize: 48,
  watermarkPadding: 20,
  watermarkOpacity: 0.6,
  creatorWatermark: '',
  creatorWatermarkFontSize: 44,
  creatorWatermarkOpacity: 0.7,
  creatorWatermarkColor: '#FFFFFF',
  creatorWatermarkBottomPadding: 80,

  matchRankColor: false,
};

function getDerivedSettings(clientConfig = {}, targetWidth = 720) {
  const SCALE = targetWidth / 1080;
  const targetHeight = Math.round(1920 * SCALE);
  
  const baseOutlineWidth = clientConfig.textOutlineWidth != null
    ? clientConfig.textOutlineWidth
    : (clientConfig.fontFamily === 'Arial Regular' ? 9 : 18);

  return {
    titleFontSize:                 (clientConfig.titleFontSize          ?? 100) * SCALE,
    titleLineSpacing:              (clientConfig.titleLineSpacing       ?? 30)  * SCALE,
    titleBoxWidth:                 (clientConfig.titleBoxWidth          ?? 980) * SCALE,
    titleMaxLines:                  clientConfig.titleMaxLines          ?? 2,
    titleBoxTopPadding:            (clientConfig.titleBoxTopPadding     ?? 30)  * SCALE,
    titleBoxBottomPadding:         (clientConfig.titleBoxBottomPadding  ?? 40)  * SCALE,

    subtitleFontSize:              (clientConfig.subtitleFontSize       ?? 44)  * SCALE,
    subtitleTopMargin:             (clientConfig.subtitleTopMargin      ?? 10)  * SCALE,

    rankFontSize:                  (clientConfig.rankFontSize           ?? 60)  * SCALE,
    rankSpacing:                   (clientConfig.rankSpacing            ?? 140) * SCALE,
    rankPaddingY:                  (clientConfig.rankPaddingY           ?? 80)  * SCALE,
    rankNumX:                       45 * SCALE,
    rankTextX:                      125 * SCALE,
    rankBoxWidth:                  (clientConfig.rankBoxWidth           ?? 830) * SCALE,

    textOutlineWidth:               baseOutlineWidth * SCALE,

    watermarkFontSize:              48 * SCALE,
    watermarkPadding:               20 * SCALE,
    creatorWatermarkFontSize:       44 * SCALE,
    creatorWatermarkBottomPadding:  80 * SCALE,
    
    scale: SCALE,
    targetW: targetWidth,
    targetH: targetHeight
  };
}

function resolveLayoutConfig(clientConfig = {}, targetWidth = 720) {
  const merged = { ...DEFAULT_LAYOUT_CONFIG, ...clientConfig };
  const derived = getDerivedSettings(clientConfig, targetWidth);
  return { ...merged, ...derived };
}

const FONT_MAP = {
  'Archivo Expanded Bold': '/usr/share/fonts/truetype/custom/Archivo-Expanded-Bold.ttf',
  'Arial Regular': '/usr/share/fonts/truetype/custom/Arial-Regular.ttf'
};

const emojiCache = new Map();

for (const [family, fontPath] of Object.entries(FONT_MAP)) {
  if (fs.existsSync(fontPath)) {
    registerFont(fontPath, { family });
  }
}

function getBaseFontFamily(config) {
  return config.fontFamily || 'Archivo Expanded Bold';
}

// ─────────────────────────────────────────────────────────────────────────────
// Status & Notification
// ─────────────────────────────────────────────────────────────────────────────

async function updateStatus(sessionId, status, payload = {}) {
  try {
    const file = outputBucket.file(`${sessionId}.json`);
    const data = JSON.stringify({ status, updatedAt: Date.now(), ...payload });
    await file.save(data, {
      contentType: 'application/json',
      resumable: false,
      metadata: { cacheControl: 'no-cache' }
    });
  } catch (e) {
    console.warn("Failed to update status file:", e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Canvas Utilities
// ─────────────────────────────────────────────────────────────────────────────
function getEmojiUrl(emoji) {
  const codePoints = Array.from(emoji).map(c => c.codePointAt(0).toString(16)).join('-');
  return `https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.0.3/assets/72x72/${codePoints}.png`;
}

function getFontForChar(char, config) {
  if (/\p{Extended_Pictographic}/u.test(char)) return 'Emoji';
  if (/[\u4e00-\u9fa5]|[\u3040-\u30ff]|[\uff00-\uffef]/.test(char)) return config.chineseFont;
  return getBaseFontFamily(config);
}

function segmentTextByFont(text, config) {
  const segments = [];
  if (!text) return segments;
  let currentSegment = { text: '', font: '' };
  for (const char of text) {
    const fontNeeded = getFontForChar(char, config);
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

function measureMixedText(ctx, text, fontSize, config) {
  const segments = segmentTextByFont(text, config);
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

async function drawMixedText(ctx, text, x, y, fontSize, fillStyle, strokeStyle, lineWidth, config) {
  const segments = segmentTextByFont(text, config);
  let currentX = x;
  const drawOutline = config.textShadow !== false;

  for (const s of segments) {
    if (s.font === 'Emoji') {
      const emojis = Array.from(s.text);
      for (const emoji of emojis) {
        try {
          const url = getEmojiUrl(emoji);
          let img = emojiCache.get(url);
          if (!img) { img = await loadImage(url); emojiCache.set(url, img); }
          ctx.drawImage(img, currentX, y + (fontSize * 0.1), fontSize, fontSize);
        } catch (e) { console.warn(`Emoji Load Failed: ${emoji}`); }
        currentX += fontSize;
      }
    } else {
      ctx.font = `${fontSize}px "${s.font}"`;
      if (drawOutline && strokeStyle && lineWidth > 0) {
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

function buildWordColorMap(wordColors) {
  const map = new Map();
  for (const { word, color } of (wordColors || [])) {
    map.set(word.toLowerCase(), color);
  }
  return map;
}

async function drawColoredTitleLine(ctx, line, x, y, fontSize, config) {
  const wordColorMap = buildWordColorMap(config.titleWordColors);
  const strokeColor = 'black';

  ctx.shadowColor = config.titleShadowColor;
  ctx.shadowBlur = config.titleShadowBlur || 0;
  ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;

  const words = line.split(' ');
  let currentX = x;

  for (let wi = 0; wi < words.length; wi++) {
    const word = words[wi];
    const color = wordColorMap.get(word.toLowerCase()) || config.titleDefaultColor;
    const displayWord = wi < words.length - 1 ? word + ' ' : word;
    await drawMixedText(ctx, displayWord, currentX, y, fontSize, color, strokeColor, config.textOutlineWidth, config);
    currentX += measureMixedText(ctx, displayWord, fontSize, config);
  }
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'rgba(0,0,0,0)';
}

function fitTextToBox(text, boxWidth, maxLines, initialFontSize, config) {
  const canvas = createCanvas(boxWidth, 100);
  const ctx = canvas.getContext('2d');
  for (let fontSize = initialFontSize; fontSize >= 1; fontSize -= 2) {
    const words = text.split(' '), lines = []; let currentLine = '';
    for (const word of words) {
      const test = currentLine ? `${currentLine} ${word}` : word;
      if (measureMixedText(ctx, test, fontSize, config) <= boxWidth) currentLine = test;
      else { lines.push(currentLine); currentLine = word; }
    }
    if (currentLine) lines.push(currentLine);
    if (lines.length <= maxLines) return { fontSize, lines };
  }
  return { fontSize: 10, lines: [text] };
}

function computeTitleBoxH(title, config) {
  const titleRes = fitTextToBox(title, config.titleBoxWidth, config.titleMaxLines, config.titleFontSize, config);
  const textH = (titleRes.lines.length * titleRes.fontSize) + ((titleRes.lines.length - 1) * config.titleLineSpacing);
  const subtitleH = config.subtitle ? config.subtitleTopMargin + config.subtitleFontSize : 0;
  const boxH = config.titleBoxTopPadding + textH + subtitleH + config.titleBoxBottomPadding;
  return { titleRes, boxH, textH, subtitleH };
}

async function drawTitleBlock(ctx, title, config) {
  const { titleRes, boxH, textH } = computeTitleBoxH(title, config);

  if (config.titleBackdrop === 'black' || config.titleBackdrop === 'white') {
    ctx.fillStyle = config.titleBackdrop;
    ctx.fillRect(0, 0, config.targetW, boxH);
  }

  const subtitleH = config.subtitle ? config.subtitleTopMargin + config.subtitleFontSize : 0;
  let currY = ((boxH - subtitleH) - textH) / 2;

  for (const line of titleRes.lines) {
    const lw = measureMixedText(ctx, line, titleRes.fontSize, config);
    await drawColoredTitleLine(ctx, line, (config.targetW - lw) / 2, currY, titleRes.fontSize, config);
    currY += titleRes.fontSize + config.titleLineSpacing;
  }

  if (config.subtitle) {
    const subW = measureMixedText(ctx, config.subtitle, config.subtitleFontSize, config);
    await drawMixedText(
      ctx, config.subtitle, (config.targetW - subW) / 2, currY + config.subtitleTopMargin,
      config.subtitleFontSize, config.subtitleColor, 'black', config.textOutlineWidth * 0.5, config
    );
  }

  return boxH;
}

async function drawWatermarks(ctx, config) {
  const fixedShadowColor = 'rgba(0,0,0,0.8)';
  const fixedShadowBlur = 15 * config.scale;

  const wmW = measureMixedText(ctx, config.watermarkText, config.watermarkFontSize, config);
  ctx.save();
  ctx.globalAlpha = config.watermarkOpacity;
  ctx.shadowColor = fixedShadowColor;
  ctx.shadowBlur = fixedShadowBlur;
  await drawMixedText(
    ctx, config.watermarkText,
    config.targetW - wmW - config.watermarkPadding,
    config.targetH - config.watermarkFontSize - config.watermarkPadding,
    config.watermarkFontSize, 'white', 'black', config.textOutlineWidth, config
  );
  ctx.restore();

  if (config.creatorWatermark) {
    const cwW = measureMixedText(ctx, config.creatorWatermark, config.creatorWatermarkFontSize, config);
    ctx.save();
    ctx.globalAlpha = config.creatorWatermarkOpacity;
    ctx.shadowColor = fixedShadowColor;
    ctx.shadowBlur = fixedShadowBlur;
    await drawMixedText(
      ctx, config.creatorWatermark, (config.targetW - cwW) / 2,
      config.targetH - config.creatorWatermarkFontSize - config.creatorWatermarkBottomPadding,
      config.creatorWatermarkFontSize, config.creatorWatermarkColor, 'black', config.textOutlineWidth * 0.6, config
    );
    ctx.restore();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlay Creation
// ─────────────────────────────────────────────────────────────────────────────
async function createTextOverlayImage(title, ranks, ranksToShow, config) {
  const canvas = createCanvas(config.targetW, config.targetH), ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, config.targetW, config.targetH);
  ctx.textBaseline = 'top'; ctx.textAlign = 'left';

  const boxH = await drawTitleBlock(ctx, title, config);
  const drawOutline = config.textShadow !== false;

  for (let i = 0; i < ranksToShow; i++) {
    const idx = (ranks.length - ranksToShow) + i;
    const y = config.rankPaddingY + boxH + (idx * config.rankSpacing);
    const rRes = fitTextToBox(ranks[idx], config.rankBoxWidth, config.rankMaxLines, config.rankFontSize, config);

    const rankColor = config.rankColors[idx] || 'white';

    ctx.shadowColor = config.rankShadowColor;
    ctx.shadowBlur = config.rankShadowBlur || 0;
    ctx.font = `${config.rankFontSize}px "${getBaseFontFamily(config)}"`;

    if (drawOutline) {
      ctx.strokeStyle = 'black'; ctx.lineWidth = config.textOutlineWidth;
      ctx.strokeText(`${idx + 1}.`, config.rankNumX, y);
    }
    ctx.fillStyle = rankColor;
    ctx.fillText(`${idx + 1}.`, config.rankNumX, y);
    ctx.shadowBlur = 0; ctx.shadowColor = 'rgba(0,0,0,0)';

    const textColor = config.matchRankColor ? rankColor : 'white';

    await drawMixedText(
      ctx, rRes.lines[0], config.rankTextX, y + ((config.rankFontSize - rRes.fontSize) / 2),
      rRes.fontSize, textColor, 'black', config.textOutlineWidth, config
    );
  }

  await drawWatermarks(ctx, config);
  return canvas;
}

async function createBaseOverlayImage(title, config) {
  const canvas = createCanvas(config.targetW, config.targetH), ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, config.targetW, config.targetH);
  ctx.textBaseline = 'top'; ctx.textAlign = 'left';

  await drawTitleBlock(ctx, title, config);
  await drawWatermarks(ctx, config);
  return canvas;
}

async function createRankOverlayImage(ranks, rankIndex, boxH, config) {
  const canvas = createCanvas(config.targetW, config.targetH), ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, config.targetW, config.targetH);
  ctx.textBaseline = 'top'; ctx.textAlign = 'left';

  const y = config.rankPaddingY + boxH + (rankIndex * config.rankSpacing);
  const rRes = fitTextToBox(ranks[rankIndex], config.rankBoxWidth, config.rankMaxLines, config.rankFontSize, config);
  const rankColor = config.rankColors[rankIndex] || 'white';
  const drawOutline = config.textShadow !== false;

  ctx.shadowColor = config.rankShadowColor;
  ctx.shadowBlur = config.rankShadowBlur || 0;
  ctx.font = `${config.rankFontSize}px "${getBaseFontFamily(config)}"`;

  if (drawOutline) {
    ctx.strokeStyle = 'black'; ctx.lineWidth = config.textOutlineWidth;
    ctx.strokeText(`${rankIndex + 1}.`, config.rankNumX, y);
  }
  ctx.fillStyle = rankColor;
  ctx.fillText(`${rankIndex + 1}.`, config.rankNumX, y);

  ctx.shadowBlur = 0; ctx.shadowColor = 'rgba(0,0,0,0)';

  const textColor = config.matchRankColor ? rankColor : 'white';

  await drawMixedText(
    ctx, rRes.lines[0], config.rankTextX, y + ((config.rankFontSize - rRes.fontSize) / 2),
    rRes.fontSize, textColor, 'black', config.textOutlineWidth, config
  );
  return canvas;
}

// ─────────────────────────────────────────────────────────────────────────────
// FFmpeg Helpers
// ─────────────────────────────────────────────────────────────────────────────
function spawnWithTimeout(cmd, args, ms, label = 'Process') {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`${label} failed (${code}): ${stderr.slice(-400)}`));
    });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`${label} timed out after ${ms / 1000}s`));
    }, ms);
  });
}

function downloadWithTimeout(gcsFile, destination, ms, label = 'Download') {
  return Promise.race([
    gcsFile.download({ destination }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    )
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

functions.http('processVideos', async (req, res) => {
  let body = req.body;
  if (Buffer.isBuffer(body)) {
    try { body = JSON.parse(body.toString()); } catch (e) {}
  } else if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {}
  }

  const { action, sessionId, title, filePaths, filePath, layoutConfig: rawConfig, videoCount, fileTypes } = body;
  
  let ranks = body.ranks || [];
  if (typeof ranks === 'string') {
    try { ranks = JSON.parse(ranks); } catch (e) {}
  }

  let timestamps = body.timestamps || [];
  if (typeof timestamps === 'string') {
    try { timestamps = JSON.parse(timestamps); } catch (e) {}
  }

  let endTime = body.endTime;
  if (typeof endTime === 'string') endTime = parseFloat(endTime);
  
  const RENDER_W = 720, RENDER_H = 1280;
  const clientConfig = typeof rawConfig === 'string' ? JSON.parse(rawConfig) : (rawConfig || {});
  const activeConfig = resolveLayoutConfig(clientConfig, RENDER_W);

  if (action === 'getUploadUrls') {
    const uploadUrls = [], generatedPaths = [];
    for (let i = 0; i < videoCount; i++) {
      const ext = (fileTypes?.[i] || 'video/mp4').split('/')[1] || 'mp4';
      const fileName = `${sessionId}/v_${i}.${ext}`;
      const [url] = await cacheBucket.file(fileName).getSignedUrl({ version: 'v4', action: 'write', expires: Date.now() + 900000 });
      uploadUrls.push({ index: i, url }); generatedPaths.push(fileName);
    }
    return res.json({ uploadUrls, filePaths: generatedPaths, sessionId });
  }

  if (action === 'getUploadUrl') {
    const ext = (body.fileType || 'video/mp4').split('/')[1] || 'mp4';
    const fileName = `${sessionId}/pre_source.${ext}`;
    const [url] = await cacheBucket.file(fileName).getSignedUrl({ version: 'v4', action: 'write', expires: Date.now() + 900000 });
    return res.json({ uploadUrl: url, filePath: fileName });
  }

  if (action === 'checkStatus') {
    const file = outputBucket.file(`${sessionId}.json`);
    const [exists] = await file.exists();
    if (!exists) return res.json({ status: 'NOT_FOUND' });
    const [content] = await file.download();
    return res.json(JSON.parse(content.toString()));
  }

  if (action === 'process' || action === 'processPreEdited') {
    const tempFiles = [];
    try {
      await updateStatus(sessionId, 'PROCESSING', { progress: 5 });
      const { boxH } = computeTitleBoxH(title, activeConfig);

      if (action === 'process') {
        const local = await Promise.all(filePaths.map(async (fp, i) => {
          const p = `/tmp/in_${i}_${uuidv4()}.mp4`;
          await downloadWithTimeout(cacheBucket.file(fp), p, 120000, `Download clip ${i}`);
          tempFiles.push(p); 
          return p;
        }));

        const processed = [];
        for (let i = 0; i < local.length; i++) {
          const prog = 10 + Math.floor((i / local.length) * 60);
          await updateStatus(sessionId, 'PROCESSING', { progress: prog });

          const out = `/tmp/p_${i}_${uuidv4()}.mp4`;
          const ov = `/tmp/ov_${i}_${uuidv4()}.png`;
          tempFiles.push(out, ov);

          const canvas = await createTextOverlayImage(title, ranks, i + 1, activeConfig);
          fs.writeFileSync(ov, canvas.toBuffer('image/png', { compressionLevel: 3 }));

          let filter;
          if (activeConfig.titleBackdrop === 'blurred' && boxH > 0) {
            filter = [
              `[0:v]scale=${RENDER_W}:${RENDER_H}:force_original_aspect_ratio=increase,crop=${RENDER_W}:${RENDER_H}[scaled]`,
              `[scaled]split[full][forblur]`,
              `[forblur]crop=${RENDER_W}:${Math.ceil(boxH)}:0:0,boxblur=15:4[blurred_top]`,
              `[full][blurred_top]overlay=0:0[with_blur]`,
              `[1:v]scale=${RENDER_W}:${RENDER_H}[ov]`,
              `[with_blur][ov]overlay=0:0`,
            ].join(';');
          } else {
            filter = `[0:v]scale=${RENDER_W}:${RENDER_H}:force_original_aspect_ratio=increase,crop=${RENDER_W}:${RENDER_H}[v];[1:v]scale=${RENDER_W}:${RENDER_H}[ov];[v][ov]overlay=0:0`;
          }

          await spawnWithTimeout('ffmpeg', [
            '-threads', '0', '-i', local[i], '-i', ov, 
            '-filter_complex', filter, 
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', 
            '-movflags', '+faststart', '-y', out
          ], 300000, 'Overlay');
          
          processed.push(out);
        }

        await updateStatus(sessionId, 'PROCESSING', { progress: 80 });
        const final = `/tmp/f_${uuidv4()}.mp4`, list = `/tmp/l_${uuidv4()}.txt`;
        tempFiles.push(final, list);
        fs.writeFileSync(list, processed.map(p => `file '${p}'`).join('\n'));
        
        await spawnWithTimeout('ffmpeg', [
          '-f', 'concat', '-safe', '0', '-i', list, 
          '-c', 'copy', '-movflags', '+faststart', '-y', final
        ], 120000, 'Stitch');

        await outputBucket.upload(final, { destination: `${sessionId}.mp4` });
        const [url] = await outputBucket.file(`${sessionId}.mp4`).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + 3600000 });
        await updateStatus(sessionId, 'SUCCESS', { videoUrl: url, progress: 100 });
      }

      if (action === 'processPreEdited') {
        const sourcePath = `/tmp/src_${uuidv4()}.mp4`;
        await downloadWithTimeout(cacheBucket.file(filePath), sourcePath, 120000, 'Download source');
        tempFiles.push(sourcePath);

        const finalPath = `/tmp/f_${uuidv4()}.mp4`;
        tempFiles.push(finalPath);
        
        const baseOv = `/tmp/base_${uuidv4()}.png`;
        tempFiles.push(baseOv);
        const baseCanvas = await createBaseOverlayImage(title, activeConfig);
        fs.writeFileSync(baseOv, baseCanvas.toBuffer('image/png', { compressionLevel: 3 }));

        const rankPaths = [];

        for (let i = 0; i < ranks.length; i++) {
          const prog = 25 + Math.floor((i / ranks.length) * 35);
          await updateStatus(sessionId, 'PROCESSING', { progress: prog });

          const rankPath = `/tmp/rank_${i}_${uuidv4()}.png`;
          tempFiles.push(rankPath);

          const rankIndex = ranks.length - 1 - i;
          const rankCanvas = await createRankOverlayImage(ranks, rankIndex, boxH, activeConfig);
          fs.writeFileSync(rankPath, rankCanvas.toBuffer('image/png', { compressionLevel: 3 }));
          rankPaths.push({ path: rankPath, rankIndex });
        }

        const inputArgs = ['-threads', '0', '-i', sourcePath, '-i', baseOv];
        for (const { path } of rankPaths) inputArgs.push('-i', path);

        const filterParts = [];
        let scaledLabel;

        if (activeConfig.titleBackdrop === 'blurred') {
          filterParts.push(
            `[0:v]scale=${RENDER_W}:${RENDER_H}:force_original_aspect_ratio=increase,crop=${RENDER_W}:${RENDER_H}[scaled]`,
            `[scaled]split[full][forblur]`,
            `[forblur]crop=${RENDER_W}:${Math.ceil(boxH)}:0:0,boxblur=15:4[blurred_top]`,
            `[full][blurred_top]overlay=0:0[v_preblur]`
          );
          scaledLabel = 'v_preblur';
        } else {
          filterParts.push(`[0:v]scale=${RENDER_W}:${RENDER_H}:force_original_aspect_ratio=increase,crop=${RENDER_W}:${RENDER_H}[v_scaled]`);
          scaledLabel = 'v_scaled';
        }

        filterParts.push(`[1:v]scale=${RENDER_W}:${RENDER_H}[base_ov]`, `[${scaledLabel}][base_ov]overlay=0:0[v_base]`);

        let prevLabel = 'v_base';
        for (let i = 0; i < rankPaths.length; i++) {
          const { rankIndex } = rankPaths[i];
          const timestampObj = timestamps.find(t => t.rankIndex === rankIndex);
          const start = timestampObj?.time ?? 0;

          filterParts.push(`[${i + 2}:v]scale=${RENDER_W}:${RENDER_H}[r${i}]`);
          filterParts.push(`[${prevLabel}][r${i}]overlay=0:0:enable='between(t,${start},${endTime})'[v${i}]`);
          prevLabel = `v${i}`;
        }

        await spawnWithTimeout('ffmpeg', [
          ...inputArgs, '-filter_complex', filterParts.join(';'),
          '-map', `[${prevLabel}]`, '-map', '0:a?',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-movflags', '+faststart', '-y', finalPath
        ], 600000, 'Pre-edited overlay');

        await outputBucket.upload(finalPath, { destination: `${sessionId}.mp4` });
        const [url] = await outputBucket.file(`${sessionId}.mp4`).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + 3600000 });
        await updateStatus(sessionId, 'SUCCESS', { videoUrl: url, progress: 100 });
      }

      res.status(200).send('OK');
    } catch (e) {
      console.error("Preview Job Error:", e);
      await updateStatus(sessionId, 'FAILED', { error: e.message });
      res.status(500).send(e.message);
    } finally {
      tempFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
      emojiCache.clear();
    }
  }
});
