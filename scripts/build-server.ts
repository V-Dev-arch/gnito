/**
 * Build the server for production. Uses esbuild to bundle src/server → dist/server.
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(process.cwd(), 'dist/server');

fs.mkdirSync(OUT, { recursive: true });

await build({
  entryPoints: [path.resolve(process.cwd(), 'src/server/index.ts')],
  outfile: path.join(OUT, 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  external: ['express', 'better-sqlite3', 'node-cron', 'zod', 'react-markdown', 'remark-gfm', 'wouter', 'lucide-react', 'highlight.js', 'dompurify', 'marked', 'argon2', 'jsonwebtoken', 'chalk'],
  sourcemap: true,
  banner: {
    js: `import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);`,
  },
});

// Copy public/brand into dist/client (so server can serve it statically).
const brandSrc = path.resolve(process.cwd(), 'public/brand');
const brandDst = path.resolve(process.cwd(), 'dist/client/brand');
fs.cpSync(brandSrc, brandDst, { recursive: true });

console.log('[build] server bundled → dist/server/index.js');
console.log('[build] brand assets copied → dist/client/brand');
