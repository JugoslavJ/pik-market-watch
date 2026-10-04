import { defineConfig } from 'vite';

export default defineConfig({
  base: '/olx/assets/',
  build: {
    manifest: true,
    rollupOptions: { input: 'src/main.jsx', output: { manualChunks: {
      charts: ['echarts/core', 'echarts/charts', 'echarts/components', 'echarts/renderers'],
      maps: ['maplibre-gl'],
    } } },
  },
});
