/**
 * Captures N video frames from a Kick HLS playlist URL, spaced `spacingSec`
 * apart, scaled to 1280px wide. Returns frame buffers in memory (no permanent
 * disk writes).
 *
 * Why we walk the playlists ourselves instead of handing the master m3u8 URL
 * straight to ffmpeg (which is what this did until 2026-08-24):
 *
 *   Kick's playback token now embeds a Google PAL ad nonce (`palNonce`), which
 *   pushes the master m3u8 URL to ~4.3KB and the variant playlist URLs to
 *   ~5.3KB. ffmpeg's MAX_URL_SIZE is 4096 bytes — it silently TRUNCATES longer
 *   URLs, so the JWT signature is cut off and IVS answers 400 Bad Request.
 *   The nonce is only present when the PAL SDK loaded in time during the
 *   headless-browser resolve, so this failed intermittently (~50% of resolves)
 *   rather than outright. Raising the limit isn't possible — it's a compile-time
 *   constant in every current ffmpeg release.
 *
 *   axios has no such limit, so we fetch master → variant → media playlist
 *   ourselves, download only the segments we need (segment URLs are ~860 chars,
 *   comfortably under any limit), and hand ffmpeg local files. As a bonus this
 *   downloads a few hundred KB instead of streaming the whole live edge.
 *
 * Segment files and JPEGs live in a per-call temp directory that is removed
 * after read, so nothing is left lying around between calls.
 */

import axios from 'axios';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ImageBlob {
  buffer: Buffer;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
}

// Playlists are tiny; segments are ~1MB. Both should be near-instant on a
// healthy connection — these are stall guards, not budgets.
const PLAYLIST_TIMEOUT_MS = 10_000;
const SEGMENT_TIMEOUT_MS = 20_000;

// Frames are scaled to this width; picking a variant much larger just wastes
// bandwidth, so we prefer the smallest rendition at or above it.
const TARGET_WIDTH = 1280;

interface Variant {
  url: string;
  bandwidth: number;
  width: number;
}

interface Segment {
  url: string;
  duration: number;
}

/**
 * Wraps an HTTP failure into a message the caller can pattern-match on.
 * buildMentionVisionContext() retries after invalidating the HLS cache when it
 * sees 403/410/expired, so the status code must survive into the message.
 */
function describeHttpError(err: unknown, what: string): Error {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    if (status) return new Error(`HTTP ${status} fetching ${what}`);
    return new Error(`${what} request failed: ${err.code || err.message}`);
  }
  return err instanceof Error ? err : new Error(`${what} failed: ${String(err)}`);
}

async function fetchPlaylist(url: string, what: string): Promise<string> {
  try {
    const res = await axios.get<string>(url, {
      responseType: 'text',
      timeout: PLAYLIST_TIMEOUT_MS,
      // Playlists are text/plain-ish; stop axios from trying to parse JSON.
      transformResponse: [(d) => d]
    });
    return res.data;
  } catch (err) {
    throw describeHttpError(err, what);
  }
}

async function fetchSegment(url: string): Promise<Buffer> {
  try {
    const res = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: SEGMENT_TIMEOUT_MS
    });
    return Buffer.from(res.data);
  } catch (err) {
    throw describeHttpError(err, 'segment');
  }
}

/** Resolves a playlist-relative URI against the playlist's own URL. */
function absolutize(uri: string, baseUrl: string): string {
  return new URL(uri, baseUrl).toString();
}

function parseAttributes(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Attribute lists are comma-separated, but values may be quoted strings that
  // themselves contain commas (e.g. CODECS="avc1.4d402a,mp4a.40.2").
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    out[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return out;
}

/** Parses a master playlist. Returns [] if this isn't one (i.e. it's a media playlist). */
function parseMaster(text: string, baseUrl: string): Variant[] {
  const lines = text.split(/\r?\n/);
  const variants: Variant[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
    // The URI is the next non-empty, non-tag line.
    let uri = '';
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      if (!next || next.startsWith('#')) continue;
      uri = next;
      break;
    }
    if (!uri) continue;
    const resolution = attrs.RESOLUTION || '';
    const width = parseInt(resolution.split('x')[0], 10);
    variants.push({
      url: absolutize(uri, baseUrl),
      bandwidth: parseInt(attrs.BANDWIDTH || '0', 10) || 0,
      width: Number.isFinite(width) ? width : 0
    });
  }
  return variants;
}

/**
 * Picks the cheapest rendition that still fills TARGET_WIDTH. Falls back to the
 * widest available when everything is smaller than the target.
 */
function pickVariant(variants: Variant[]): Variant {
  const atOrAbove = variants
    .filter(v => v.width >= TARGET_WIDTH)
    .sort((a, b) => a.width - b.width || a.bandwidth - b.bandwidth);
  if (atOrAbove.length > 0) return atOrAbove[0];

  const byWidth = [...variants].sort((a, b) => b.width - a.width || b.bandwidth - a.bandwidth);
  return byWidth[0];
}

function parseMediaPlaylist(text: string, baseUrl: string): Segment[] {
  const lines = text.split(/\r?\n/);
  const segments: Segment[] = [];
  let pendingDuration: number | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const value = parseFloat(line.slice('#EXTINF:'.length).split(',')[0]);
      pendingDuration = Number.isFinite(value) ? value : null;
      continue;
    }
    // Skip every other tag, including LL-HLS #EXT-X-PART entries — we only want
    // whole segments, which are the bare URI lines following an #EXTINF.
    if (line.startsWith('#')) continue;
    if (pendingDuration === null) continue;
    segments.push({ url: absolutize(line, baseUrl), duration: pendingDuration });
    pendingDuration = null;
  }
  return segments;
}

/**
 * Chooses `count` segments ending at the live edge and spaced ~spacingSec apart,
 * returned oldest-first. When the playlist is too short to honour the spacing,
 * spreads the picks evenly over whatever is listed rather than returning
 * duplicate frames.
 */
function pickSegments(segments: Segment[], count: number, spacingSec: number): Segment[] {
  if (segments.length === 0) return [];
  if (segments.length <= count) return segments;

  // Start offset of each segment relative to the first one in the playlist.
  const starts: number[] = [];
  let elapsed = 0;
  for (const seg of segments) {
    starts.push(elapsed);
    elapsed += seg.duration;
  }
  const liveEdge = starts[starts.length - 1];

  const indices: number[] = [];
  for (let k = count - 1; k >= 0; k--) {
    const target = liveEdge - k * spacingSec;
    let best = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < starts.length; i++) {
      const diff = Math.abs(starts[i] - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    }
    if (!indices.includes(best)) indices.push(best);
  }

  // The playlist didn't span enough time for the requested spacing — fall back
  // to an even spread so we still return `count` distinct frames.
  if (indices.length < count) {
    const spread: number[] = [];
    const step = (segments.length - 1) / (count - 1);
    for (let k = 0; k < count; k++) {
      const idx = Math.round(k * step);
      if (!spread.includes(idx)) spread.push(idx);
    }
    return spread.map(i => segments[i]);
  }

  return indices.map(i => segments[i]);
}

/** Extracts a single scaled JPEG from a local media segment. */
async function extractFrame(segmentPath: string, outPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', segmentPath,
      '-frames:v', '1',
      '-vf', `scale=${TARGET_WIDTH}:-1`,
      '-y',
      outPath
    ];
    const ff = spawn('ffmpeg', args);
    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); });
    ff.on('close', code => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 300)}`));
        return;
      }
      resolve();
    });
    ff.on('error', reject);
  });
}

export async function captureFrames(
  hlsUrl: string,
  count: number,
  spacingSec: number
): Promise<ImageBlob[]> {
  const masterText = await fetchPlaylist(hlsUrl, 'master playlist');

  // A master playlist lists renditions; if there are none we were handed a
  // media playlist directly, which is equally usable.
  const variants = parseMaster(masterText, hlsUrl);
  let mediaUrl = hlsUrl;
  let mediaText = masterText;
  if (variants.length > 0) {
    mediaUrl = pickVariant(variants).url;
    mediaText = await fetchPlaylist(mediaUrl, 'media playlist');
  }

  const segments = parseMediaPlaylist(mediaText, mediaUrl);
  if (segments.length === 0) {
    throw new Error('no segments in media playlist — stream may have just ended');
  }

  const picked = pickSegments(segments, count, spacingSec);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kick-frames-'));

  try {
    // One bad segment shouldn't cost us the whole capture — gather what works
    // and only fail if nothing does.
    const results = await Promise.allSettled(
      picked.map(async (seg, i) => {
        const stem = String(i).padStart(2, '0');
        const segPath = path.join(tmpDir, `seg_${stem}.ts`);
        const jpgPath = path.join(tmpDir, `frame_${stem}.jpg`);
        fs.writeFileSync(segPath, await fetchSegment(seg.url));
        await extractFrame(segPath, jpgPath);
        return fs.readFileSync(jpgPath);
      })
    );

    const frames: ImageBlob[] = [];
    let lastError: string | null = null;
    for (const result of results) {
      if (result.status === 'fulfilled') {
        frames.push({ buffer: result.value, mediaType: 'image/jpeg' as const });
      } else {
        lastError = result.reason instanceof Error ? result.reason.message : String(result.reason);
      }
    }

    if (frames.length === 0) {
      throw new Error(`all ${picked.length} segment(s) failed: ${lastError ?? 'unknown error'}`);
    }
    return frames;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Loads all reference photos for a channel from data/channel-refs/<channel>/
 * Returns an empty array if the folder is missing or has no usable images.
 */
export function loadReferencePhotos(channel: string): ImageBlob[] {
  const dir = path.join(process.cwd(), 'data', 'channel-refs', channel);
  if (!fs.existsSync(dir)) return [];

  const out: ImageBlob[] = [];
  const files = fs.readdirSync(dir).sort();
  for (const f of files) {
    const lower = f.toLowerCase();
    let mediaType: ImageBlob['mediaType'] | null = null;
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) mediaType = 'image/jpeg';
    else if (lower.endsWith('.png')) mediaType = 'image/png';
    else if (lower.endsWith('.webp')) mediaType = 'image/webp';
    if (!mediaType) continue;
    try {
      const buffer = fs.readFileSync(path.join(dir, f));
      out.push({ buffer, mediaType });
    } catch (err) {
      if (err instanceof Error) {
        console.warn(`[refs] failed to read ${f}: ${err.message}`);
      }
    }
  }
  return out;
}
