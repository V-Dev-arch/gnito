import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { openSandboxMediaFile } from '../sandbox/docker.js';

const GENERATED_DIR = path.join(DATA_DIR, 'generated-media');
const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_GENERATED_STORAGE_BYTES = 1024 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function generatedDir(): string {
  fs.mkdirSync(GENERATED_DIR, { recursive: true, mode: 0o700 });
  const stats = fs.lstatSync(GENERATED_DIR);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('Generated media storage is not a trusted directory.');
  fs.chmodSync(GENERATED_DIR, 0o700);
  return fs.realpathSync(GENERATED_DIR);
}

function descriptorRoot(): string | null {
  const root = process.platform === 'linux' ? '/proc/self/fd'
    : process.platform === 'darwin' ? '/dev/fd' : '';
  return root && fs.existsSync(root) && fs.constants.O_DIRECTORY && fs.constants.O_NOFOLLOW ? root : null;
}

function openGeneratedPng(id: string): { fd: number; size: number } | null {
  const procFd = descriptorRoot();
  if (!procFd) return null;
  let directoryFd: number | undefined;
  let fileFd: number | undefined;
  try {
    directoryFd = fs.openSync(generatedDir(), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    fileFd = fs.openSync(`${procFd}/${directoryFd}/${id}.png`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK || 0));
    const stats = fs.fstatSync(fileFd);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_GENERATED_IMAGE_BYTES) return null;
    const result = { fd: fileFd, size: stats.size };
    fileFd = undefined;
    return result;
  } catch { return null; }
  finally {
    if (fileFd !== undefined) { try { fs.closeSync(fileFd); } catch {} }
    if (directoryFd !== undefined) { try { fs.closeSync(directoryFd); } catch {} }
  }
}

export function storeGeneratedPng(encoded: string): { id: string; url: string } {
  if (!encoded || encoded.length > Math.ceil(MAX_GENERATED_IMAGE_BYTES * 4 / 3) + 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('The generated image response was empty or exceeded the 20 MiB limit.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > MAX_GENERATED_IMAGE_BYTES || bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new Error('The generated image data was invalid or exceeded the 20 MiB limit.');
  }
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('The provider response was not a valid PNG image.');
  }
  const directory = generatedDir();
  let totalBytes = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.png')) continue;
    try { totalBytes += fs.statSync(path.join(directory, entry.name)).size; } catch { /* A concurrently removed image uses no quota. */ }
    if (totalBytes + bytes.length > MAX_GENERATED_STORAGE_BYTES) throw new Error('Local generated-image storage is full (1 GiB limit). Remove generated images before creating more.');
  }
  if (totalBytes + bytes.length > MAX_GENERATED_STORAGE_BYTES) throw new Error('Local generated-image storage is full (1 GiB limit). Remove generated images before creating more.');
  const id = randomUUID();
  fs.writeFileSync(path.join(directory, `${id}.png`), bytes, { flag: 'wx', mode: 0o600 });
  return { id, url: `/api/media/${id}` };
}

function safeHeaderFilename(filename: string): string {
  return [...filename].map(character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 || character === '"' || character === '\\' ? '_' : character;
  }).join('');
}

function streamPinnedFile(req: Request, res: Response, file: { fd: number; size: number; contentType: string; filename: string; cacheControl: string }): void {
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', file.cacheControl);
  res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${safeHeaderFilename(file.filename)}"`);
  res.setHeader('Accept-Ranges', 'bytes');
  let start = 0;
  let end = file.size - 1;
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      fs.closeSync(file.fd);
      res.setHeader('Content-Range', `bytes */${file.size}`);
      res.status(416).end();
      return;
    }
    if (!match[1]) {
      const suffix = Number(match[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) {
        fs.closeSync(file.fd);
        res.setHeader('Content-Range', `bytes */${file.size}`);
        res.status(416).end();
        return;
      }
      start = Math.max(0, file.size - suffix);
    } else {
      start = Number(match[1]);
      if (match[2]) end = Math.min(file.size - 1, Number(match[2]));
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= file.size || end < start) {
      fs.closeSync(file.fd);
      res.setHeader('Content-Range', `bytes */${file.size}`);
      res.status(416).end();
      return;
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${file.size}`);
  }
  res.setHeader('Content-Length', String(end - start + 1));
  try {
    const stream = fs.createReadStream(file.filename, { fd: file.fd, autoClose: true, start, end });
    stream.on('error', () => {
      if (res.destroyed) return;
      if (!res.headersSent) res.status(404).end();
      else res.destroy();
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch {
    try { fs.closeSync(file.fd); } catch {}
    if (!res.headersSent) res.status(404).end();
    else res.destroy();
  }
}

export function registerMediaRoutes(app: any): void {
  app.get('/api/media/:id', (req: Request, res: Response) => {
    const id = String(req.params.id || '');
    if (!UUID_PATTERN.test(id)) { res.status(404).json({ error: 'not-found' }); return; }
    let media: { fd: number; size: number } | null;
    try { media = openGeneratedPng(id); }
    catch { media = null; }
    if (!media) { res.status(404).json({ error: 'not-found' }); return; }
    streamPinnedFile(req, res, {
      ...media,
      contentType: 'image/png',
      filename: `gnito-${id}.png`,
      cacheControl: 'private, max-age=3600',
    });
  });

  app.get('/api/terminal/media', (req: Request, res: Response) => {
    const workspacePath = typeof req.query.path === 'string' ? req.query.path : '';
    const media = openSandboxMediaFile(workspacePath);
    if (!media) { res.status(404).json({ error: 'not-found', message: 'Only image and video files inside the Gnito terminal workspace can be previewed or downloaded.' }); return; }
    streamPinnedFile(req, res, { ...media, cacheControl: 'private, no-store' });
  });
}
