import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development, /api goes to a local API on port 3000, mirroring the
// Vercel rewrite in production so the browser always talks to one origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.WNX_API_URL ?? 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
