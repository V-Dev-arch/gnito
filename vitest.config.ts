import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 15_000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src/client') },
  },
});
