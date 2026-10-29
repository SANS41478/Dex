import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import { injectFigmaCapture } from './electron/figma-capture'

/** 仅开发模式 + FIGMA_CAPTURE=1 时注入 Figma 捕获脚本（TOOL-06）。 */
const figmaCapturePlugin = (): Plugin => ({
  name: 'dex-figma-capture',
  apply: 'serve',
  transformIndexHtml(html) {
    return injectFigmaCapture(html)
  },
})

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [
      react(),
      tailwindcss(),
      ...(process.env.FIGMA_CAPTURE === '1' ? [figmaCapturePlugin()] : []),
    ],
    build: {
      // electron-vite 默认不压缩 renderer 产物；深度按需下打开 esbuild 压缩。
      minify: 'esbuild',
      rollupOptions: {
        output: {
          // 深度按需（M1-06）：3D 图谱与 React 拆独立 chunk，图谱面板懒加载后再拉取。
          manualChunks(id: string) {
            if (
              id.includes('node_modules/three') ||
              id.includes('react-force-graph') ||
              id.includes('three-render-objects') ||
              id.includes('3d-force-graph') ||
              id.includes('d3-force')
            ) {
              return 'graph3d'
            }
            if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react'
            return undefined
          },
        },
      },
    },
    server: {
      port: 5173,
      strictPort: true,
    },
  },
})
