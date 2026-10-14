import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const apiPort = Number(process.env.GNITO_PORT || 8377);

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, 'src/client'),
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src/client') },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/client'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: false,
      },
    },
  },
});
