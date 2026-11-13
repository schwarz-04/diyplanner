import { defineConfig } from 'vite';

// Feste Dateinamen, damit das WordPress-Plugin die Dateien einfach einbinden kann.
export default defineConfig({
  base: './',
  server: { proxy: { '/api': 'http://localhost:8765' } },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/editor.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/editor[extname]',
      },
    },
  },
});
