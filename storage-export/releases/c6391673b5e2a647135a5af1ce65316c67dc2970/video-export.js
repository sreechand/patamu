/** Browser-local recording of the current model. No camera/microphone is used. */
export const VIDEO_SIZES = {
  landscape: { width: 1280, height: 720 },
  compact: { width: 854, height: 480 },
  portrait: { width: 720, height: 960 },
  square: { width: 960, height: 960 },
};

const MIME_TYPES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

/** Feature detection is deliberate: recording formats vary between browsers. */
export function getVideoExportSupport(canvas) {
  if (typeof globalThis.MediaRecorder !== 'function') {
    return { supported: false, reason: 'Video recording is unavailable in this browser. Open this model in a current Safari or Chrome browser, or download the model instead.' };
  }
  if (!canvas || typeof canvas.captureStream !== 'function') {
    return { supported: false, reason: 'This browser cannot record a canvas. Download the model instead.' };
  }
  const mimeType = MIME_TYPES.find(type => globalThis.MediaRecorder.isTypeSupported(type));
  if (!mimeType) {
    return { supported: false, reason: 'This browser has no supported MP4 or WebM encoder. Download the model instead.' };
  }
  return { supported: true, mimeType, extension: mimeType.startsWith('video/mp4') ? 'mp4' : 'webm' };
}

function abortError(message = 'Video export cancelled.') {
  return new DOMException(message, 'AbortError');
}

function drawWrappedText(context, text, x, y, maxWidth, lineHeight, maxLines = 2) {
  const words = String(text || '').split(/\s+/);
  let line = '';
  let row = 0;
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (context.measureText(next).width > maxWidth && line) {
      if (row === maxLines - 1) {
        let clipped = `${line}…`;
        while (context.measureText(clipped).width > maxWidth && clipped.length > 1) clipped = `${clipped.slice(0, -2)}…`;
        context.fillText(clipped, x, y + row * lineHeight);
        return;
      }
      context.fillText(line, x, y + row * lineHeight);
      row++;
      line = words[i];
    } else line = next;
  }
  if (line) context.fillText(line, x, y + row * lineHeight);
}

/**
 * renderFrame(progress) must synchronously render the current model into
 * sourceCanvas. The caller owns camera state; restore() runs on every exit path.
 * Resolves only after MediaRecorder has delivered its final data chunk.
 */
export async function recordModelVideo(options) {
  try {
    return await recordVideo(options);
  } finally {
    options.restore?.();
  }
}

async function recordVideo({
  canvas,
  sourceCanvas = canvas,
  renderFrame,
  title = 'Patamu · Aquifer Studio',
  subtitle,
  provenance = subtitle || 'Reference layers do not reflect real-world data.',
  filename = 'patamu-aquifer-model',
  duration = 10,
  size = 'landscape',
  width,
  height,
  onProgress = () => {},
  signal,
}) {
  if (typeof renderFrame !== 'function') throw new Error('The model renderer is not ready.');
  if (signal?.aborted) throw abortError();
  const preset = VIDEO_SIZES[size] || VIDEO_SIZES.landscape;
  const dimensions = {
    width: Math.round(Math.min(1920, Math.max(320, Number(width) || preset.width)) / 2) * 2,
    height: Math.round(Math.min(1920, Math.max(320, Number(height) || preset.height)) / 2) * 2,
  };
  const output = document.createElement('canvas');
  output.width = dimensions.width;
  output.height = dimensions.height;
  const support = getVideoExportSupport(output);
  if (!support.supported) throw new Error(support.reason);
  const context = output.getContext('2d', { alpha: false });
  if (!context) throw new Error('The video canvas could not be created.');
  if (!sourceCanvas?.width || !sourceCanvas?.height) throw new Error('The model is not ready. Wait for it to load and try again.');

  const seconds = Math.min(30, Math.max(3, Number(duration) || 10));
  let stream;
  let recorder;
  let frameId;
  let timeoutId;
  let settled = false;
  let rejectRecording;
  let stopRequested = false;
  const chunks = [];

  const paint = progress => {
    renderFrame(progress);
    const { width, height } = output;
    const padding = Math.round(width * .0375);
    const top = Math.round(height * .12);
    const bottom = Math.round(height * .17);
    const roomHeight = height - top - bottom;
    context.fillStyle = '#f4f1e9';
    context.fillRect(0, 0, width, height);
    const ratio = Math.min((width - padding * 2) / sourceCanvas.width, roomHeight / sourceCanvas.height);
    const imageWidth = sourceCanvas.width * ratio;
    const imageHeight = sourceCanvas.height * ratio;
    context.drawImage(sourceCanvas, (width - imageWidth) / 2, top + (roomHeight - imageHeight) / 2, imageWidth, imageHeight);
    context.fillStyle = '#183f36';
    context.font = `600 ${Math.round(width * .023)}px system-ui, sans-serif`;
    drawWrappedText(context, title, padding, Math.round(top * .58), width - padding * 2, 30, 1);
    context.font = `${Math.max(13, Math.round(width * .015))}px system-ui, sans-serif`;
    context.fillStyle = '#40564e';
    drawWrappedText(context, provenance, padding, height - bottom + 20, width - padding * 2, Math.round(height * .034), 2);
    context.fillStyle = '#49685c';
    context.font = `500 ${Math.max(11, Math.round(width * .013))}px system-ui, sans-serif`;
    context.fillText('PATAMU  /  AQUIFER STUDIO', padding, height - Math.round(height * .025));
  };

  const fail = error => {
    if (settled) return;
    settled = true;
    rejectRecording?.(error);
    if (recorder?.state !== 'inactive') {
      try { recorder?.stop(); } catch { /* Recorder may have already failed. */ }
    }
  };
  const onAbort = () => fail(abortError());
  const onVisibility = () => {
    if (document.hidden) fail(abortError('Export stopped because the tab was hidden. Keep the app open while recording.'));
  };

  try {
    paint(0);
    // Detect a cross-origin image before starting; a tainted canvas cannot record.
    try { context.getImageData(0, 0, 1, 1); }
    catch { throw new Error('The terrain image cannot be recorded because its server does not allow canvas export. Turn off satellite imagery and try again.'); }
    stream = output.captureStream(30);
    if (!stream.getVideoTracks().length) throw new Error('The browser did not provide a video track.');
    recorder = new MediaRecorder(stream, { mimeType: support.mimeType, videoBitsPerSecond: 4_000_000 });

    const result = new Promise((resolve, reject) => {
      rejectRecording = reject;
      recorder.ondataavailable = event => { if (event.data?.size) chunks.push(event.data); };
      recorder.onerror = event => fail(new Error(event.error?.message || 'Video encoding failed. Try a shorter recording or another browser.'));
      recorder.onstop = () => {
        if (settled) return;
        settled = true;
        const type = recorder.mimeType || support.mimeType;
        const blob = new Blob(chunks, { type });
        if (!stopRequested || !blob.size) return reject(new Error('The browser did not finish creating the video. Please try again.'));
        const extension = type.startsWith('video/mp4') ? 'mp4' : 'webm';
        const stem = filename.replace(/\.(mp4|webm)$/i, '').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'patamu-aquifer-model';
        resolve({ blob, filename: `${stem}.${extension}`, mimeType: type, extension, duration: seconds, ...dimensions });
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      document.addEventListener('visibilitychange', onVisibility);
      // A stalled encoder must not leave a permanently disabled export button.
      timeoutId = setTimeout(() => fail(new Error('Video encoding timed out. Keep the app visible and try again.')), (seconds + 20) * 1000);
      recorder.start(250);
      onProgress(0);
      const start = performance.now();
      const frame = now => {
        if (settled || stopRequested) return;
        if (signal?.aborted) return onAbort();
        try {
          const progress = Math.min(1, (now - start) / (seconds * 1000));
          paint(progress);
          onProgress(progress);
          if (progress >= 1) {
            stopRequested = true;
            recorder.stop();
          } else frameId = requestAnimationFrame(frame);
        } catch (error) { fail(error); }
      };
      frameId = requestAnimationFrame(frame);
    });
    return await result;
  } finally {
    cancelAnimationFrame(frameId);
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onAbort);
    document.removeEventListener('visibilitychange', onVisibility);
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch { /* Best effort on a cancelled encoder. */ }
    }
    stream?.getTracks().forEach(track => track.stop());
    output.width = output.height = 0;
  }
}

/** Call from a click handler, including a second Save button on mobile Safari. */
export function downloadModelVideo(result, filename) {
  const url = URL.createObjectURL(result.blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename ? `${filename.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'patamu-aquifer-model'}.${result.extension}` : result.filename || `patamu-aquifer-model.${result.extension}`;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
