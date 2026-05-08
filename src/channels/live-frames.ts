/**
 * Captures N video frames from a Kick HLS playlist URL using ffmpeg,
 * spaced `spacingSec` apart, scaled to 720p. Returns frame buffers
 * in memory (no permanent disk writes).
 *
 * ffmpeg writes JPEGs to a per-call temp directory which is cleaned up
 * after read. This avoids leaving frame files lying around between calls.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ImageBlob {
  buffer: Buffer;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
}

export async function captureFrames(
  hlsUrl: string,
  count: number,
  spacingSec: number
): Promise<ImageBlob[]> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kick-frames-'));
  const totalDuration = (count - 1) * spacingSec + 1;

  try {
    await new Promise<void>((resolve, reject) => {
      const args = [
        '-hide_banner', '-loglevel', 'error',
        '-i', hlsUrl,
        '-vf', `fps=1/${spacingSec},scale=1280:-1`,
        '-frames:v', String(count),
        '-t', String(totalDuration),
        '-y',
        path.join(tmpDir, 'frame_%02d.jpg')
      ];
      const ff = spawn('ffmpeg', args);
      let stderr = '';
      ff.stderr.on('data', d => { stderr += d.toString(); });
      ff.on('close', code => {
        if (code !== 0) {
          reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 500)}`));
          return;
        }
        resolve();
      });
      ff.on('error', reject);
    });

    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.jpg')).sort();
    return files.map(f => ({
      buffer: fs.readFileSync(path.join(tmpDir, f)),
      mediaType: 'image/jpeg' as const
    }));
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
