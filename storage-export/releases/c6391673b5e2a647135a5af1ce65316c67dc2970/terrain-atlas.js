import * as Lerc from './vendor/lerc/LercDecode.es.js';

// Live display terrain; the app retains its open-data grid for downloadable models.
// Bounds and output rows use [north, west, south, east], north-to-south respectively.
export const ATLAS_TERRAIN_META = Object.freeze({
  source: 'Esri Living Atlas · Terrain 3D',
  url: 'https://www.arcgis.com/home/item.html?id=7029fb60158543ad845c7e1527af11e4',
  serviceUrl: 'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer',
  attribution: 'Sources: Vantor, Airbus DS, USGS, NGA, NASA, CGIAR, GEBCO, N Robinson, NCEAS, NLS, OS, NMA, Geodatastyrelsen and the GIS User Community',
  exportNotice: 'This live service does not allow offline tile export. Downloadable models use the open terrain source.',
  resolutionNotice: 'Multiple elevation sources; local source resolution varies. Display sampling does not establish survey accuracy.',
  displayOnly: true
});

const GRID_SIZE = 81, MAX_TILES = 16, TOTAL_TIMEOUT_MS = 20000;
const cache = new Map();
let decoderPromise;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function validateBounds(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) {
    throw new Error('Atlas terrain needs four finite bounding-box coordinates.');
  }
  const [north, west, south, east] = bounds;
  if (north <= south || east <= west || north > 85.0511287 || south < -85.0511287 || west < -180 || east > 180) {
    throw new Error('Atlas terrain needs an ordered bounding box within the Web Mercator map extent.');
  }
  if (north - south < 0.00001 || east - west < 0.00001 || north - south > 5 || east - west > 5) {
    throw new Error('Choose an Atlas terrain region between 0.00001° and 5° across.');
  }
}

function tilePoint(lon, lat, zoom) {
  const scale = 2 ** zoom;
  return [scale * (lon + 180) / 360, scale * (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2];
}

function tilePlan(bounds) {
  const [n, w, s, e] = bounds;
  const [x0, y0] = tilePoint(w, n, 0), [x1, y1] = tilePoint(e, s, 0);
  let zoom = clamp(Math.ceil(Math.log2((GRID_SIZE - 1) / (256 * Math.max(x1 - x0, y1 - y0)))), 5, 13);
  let extent;
  do {
    const scale = 2 ** zoom;
    extent = {
      left: clamp(Math.floor(x0 * scale), 0, scale - 1),
      top: clamp(Math.floor(y0 * scale), 0, scale - 1),
      right: clamp(Math.floor(x1 * scale), 0, scale - 1),
      bottom: clamp(Math.floor(y1 * scale), 0, scale - 1)
    };
    if ((extent.right - extent.left + 1) * (extent.bottom - extent.top + 1) <= MAX_TILES) break;
    zoom--;
  } while (zoom > 0);
  const tiles = [];
  for (let y = extent.top; y <= extent.bottom; y++) {
    for (let x = extent.left; x <= extent.right; x++) tiles.push({x, y, zoom});
  }
  return {zoom, tiles};
}

function ensureDecoder() {
  if (!decoderPromise) {
    decoderPromise = Lerc.load({locateFile: () => new URL('./vendor/lerc/lerc-wasm.wasm', import.meta.url).href})
      .catch(error => { decoderPromise = null; throw error; });
  }
  return decoderPromise;
}

function withinDeadline(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || new Error('Atlas terrain request cancelled.'));
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason || new Error('Atlas terrain request cancelled.'));
    signal.addEventListener('abort', aborted, {once: true});
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

function decodeTile(buffer) {
  if (buffer.byteLength < 20 || buffer.byteLength > 4000000) throw new Error('Atlas returned an invalid elevation tile.');
  const tile = Lerc.decode(buffer);
  if (!Number.isInteger(tile.width) || !Number.isInteger(tile.height) || tile.width < 2 || tile.height < 2 || tile.width > 1024 || tile.height > 1024 || !tile.pixels?.[0] || tile.pixels[0].length !== tile.width * tile.height) {
    throw new Error('Atlas returned an unsupported elevation grid.');
  }
  if (tile.mask && tile.mask.length !== tile.width * tile.height) throw new Error('Atlas returned an invalid elevation mask.');
  return tile;
}

function sampleTile(tile, u, v) {
  // ArcGIS elevation tiles have 257 nodes (256 intervals), including shared edges.
  const x = clamp(u, 0, 1) * (tile.width - 1), y = clamp(v, 0, 1) * (tile.height - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, tile.width - 1), y1 = Math.min(y0 + 1, tile.height - 1);
  const fx = x - x0, fy = y - y0;
  const samples = [[x0, y0, (1 - fx) * (1 - fy)], [x1, y0, fx * (1 - fy)], [x0, y1, (1 - fx) * fy], [x1, y1, fx * fy]];
  let sum = 0, weight = 0;
  for (const [col, row, factor] of samples) {
    const idx = row * tile.width + col, value = tile.pixels[0][idx];
    if (factor > 0 && (!tile.mask || tile.mask[idx]) && Number.isFinite(value) && value > -12000 && value < 10000) {
      sum += value * factor;
      weight += factor;
    }
  }
  // Do not invent terrain or silently turn missing coverage into sea level.
  return weight > 0.999999 ? sum / weight : null;
}

/** Fetch a bounded, complete 81×81 display grid from Living Atlas Terrain 3D. */
export async function loadAtlasTerrain(bounds, {signal: callerSignal} = {}) {
  validateBounds(bounds);
  if (callerSignal?.aborted) throw new Error('Atlas terrain request cancelled.');
  const key = bounds.join(',');
  if (cache.has(key)) return cache.get(key);
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Atlas terrain request cancelled.'));
  callerSignal?.addEventListener('abort', cancel, {once: true});
  const timer = setTimeout(() => controller.abort(new Error('Atlas terrain took too long. Your open terrain model is still available.')), TOTAL_TIMEOUT_MS);
  try {
    await withinDeadline(ensureDecoder(), controller.signal);
    const {zoom, tiles} = tilePlan(bounds), loaded = new Map();
    let next = 0;
    async function worker() {
      while (next < tiles.length) {
        const tile = tiles[next++];
        const url = `${ATLAS_TERRAIN_META.serviceUrl}/tile/${zoom}/${tile.y}/${tile.x}`;
        const response = await fetch(url, {signal: controller.signal, mode: 'cors'});
        if (!response.ok) throw new Error(`Atlas elevation is unavailable here (${response.status}). Your open terrain model is still available.`);
        loaded.set(`${tile.x}/${tile.y}`, decodeTile(await response.arrayBuffer()));
      }
    }
    await withinDeadline(Promise.all(Array.from({length: Math.min(4, tiles.length)}, worker)), controller.signal);
    const [north, west, south, east] = bounds, scale = 2 ** zoom;
    const grid = Array.from({length: GRID_SIZE}, (_, row) => Array.from({length: GRID_SIZE}, (_, col) => {
      const lon = west + (east - west) * col / (GRID_SIZE - 1), lat = north + (south - north) * row / (GRID_SIZE - 1);
      const [rawX, rawY] = tilePoint(lon, lat, zoom);
      const x = clamp(rawX, 0, scale - Number.EPSILON * scale), y = clamp(rawY, 0, scale - Number.EPSILON * scale);
      const tileX = Math.floor(x), tileY = Math.floor(y), tile = loaded.get(`${tileX}/${tileY}`);
      const value = tile ? sampleTile(tile, x - tileX, y - tileY) : null;
      if (!Number.isFinite(value)) throw new Error('Atlas has incomplete elevation coverage in this region. Your open terrain model is still available.');
      return Math.round(value * 100) / 100;
    }));
    const result = {...ATLAS_TERRAIN_META, bounds: [...bounds], grid, grid81x81: grid, zoom, retrievedAt: new Date().toISOString()};
    cache.set(key, result);
    if (cache.size > 8) cache.delete(cache.keys().next().value);
    return result;
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', cancel);
  }
}

export const atlasTestHelpers = Object.freeze({validateBounds, tilePoint, tilePlan, sampleTile, decodeTile});
