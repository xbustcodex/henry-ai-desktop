/**
 * Streaming file download with redirect-following and size verification.
 *
 * Both voice models (whisper for STT, the local neural voices for TTS) arrive
 * the same way: a large file from a HuggingFace URL that 302s to a CDN. The
 * rules are identical for both, so they live here rather than being written
 * twice — in particular the `.part` + verify + rename dance, which is what
 * stops an interrupted download from leaving a truncated model that later
 * passes a mere "file exists" check and then fails to load.
 */

import fs from 'fs';
import https from 'https';
import path from 'path';
import { URL } from 'url';

export interface DownloadProgress {
  downloaded: number;
  total: number;
  pct: number;
}

export interface DownloadOptions {
  /** Absolute destination. Parent directories are created. */
  dest: string;
  /** Reject a file smaller than this — a truncated download is not a model. */
  minBytes?: number;
  onProgress?: (p: DownloadProgress) => void;
}

const MAX_REDIRECTS = 5;

/**
 * Download `url` to `dest`. Streams to a `.part` sibling, verifies the size,
 * then renames into place. Rejects on any non-200, on an empty body, and on a
 * body that does not match `content-length`.
 */
function downloadTo(url: string, dest: string, options: DownloadOptions, redirectsLeft: number): Promise<DownloadProgress> {
  return new Promise((resolve, reject) => {
    const partPath = `${dest}.part`;

    const fail = (err: Error) => {
      try { fs.unlinkSync(partPath); } catch { /* already gone */ }
      reject(err);
    };

    const req = https.get(url, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          fail(new Error('Too many redirects downloading the file.'));
          return;
        }
        downloadTo(new URL(res.headers.location, url).toString(), dest, options, redirectsLeft - 1)
          .then(resolve, fail);
        return;
      }
      if (status !== 200) {
        res.resume();
        fail(new Error(`Download failed with HTTP ${status}.`));
        return;
      }

      const total = Number(res.headers['content-length'] || 0);
      let downloaded = 0;
      const out = fs.createWriteStream(partPath);
      res.on('data', (chunk: Buffer) => {
        downloaded += chunk.length;
        options.onProgress?.({
          downloaded,
          total,
          pct: total > 0 ? Math.round((downloaded / total) * 100) : 0,
        });
      });
      res.pipe(out);

      out.on('finish', () => {
        out.close(() => {
          try {
            const size = fs.statSync(partPath).size;
            if (size === 0) {
              fail(new Error('Downloaded file was empty.'));
              return;
            }
            if (options.minBytes !== undefined && size < options.minBytes) {
              fail(new Error(`Download incomplete (${size} bytes, expected at least ${options.minBytes}) — try again.`));
              return;
            }
            if (total > 0 && size !== total) {
              fail(new Error(`Download incomplete (${size} of ${total} bytes) — try again.`));
              return;
            }
            fs.renameSync(partPath, dest);
            options.onProgress?.({ downloaded: size, total: size, pct: 100 });
            resolve({ downloaded: size, total: size, pct: 100 });
          } catch (e) {
            fail(e instanceof Error ? e : new Error(String(e)));
          }
        });
      });
      out.on('error', fail);
      res.on('error', fail);
    });
    req.on('error', fail);
    req.setTimeout(30_000, () => req.destroy(new Error('Download timed out.')));
  });
}

export function downloadFile(url: string, options: DownloadOptions): Promise<DownloadProgress> {
  try {
    fs.mkdirSync(path.dirname(options.dest), { recursive: true });
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
  return downloadTo(url, options.dest, options, MAX_REDIRECTS);
}

/** True when `file` exists and is at least `minBytes`. */
export function fileLooksComplete(file: string, minBytes: number): boolean {
  try {
    return fs.statSync(file).isFile() && fs.statSync(file).size >= minBytes;
  } catch {
    return false;
  }
}