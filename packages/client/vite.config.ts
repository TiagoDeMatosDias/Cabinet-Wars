import { defineConfig } from 'vite';

// In development the Node server (npm run server) provides /api and the /ws game socket.
export default defineConfig({
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
