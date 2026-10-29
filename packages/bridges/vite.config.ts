import { builtinModules, createRequire } from 'node:module'
import { defineConfig } from 'vite'

const require = createRequire(import.meta.url)
// 显式指向 ws 的 Node 实现：默认解析会命中其 browser 字段，产物会退化成浏览器桩。
const wsEntry = require.resolve('ws')

/**
 * 把 dsh 宿主入口插件打成自包含 ESM（M1-04b）：
 * - `@dexagent/shared`、`zod`、`ws` 全部内联；
 * - node 内置模块保持 external（dsh 进程原生可用）；
 * - 产物 `dist/dex-graph-bridge.mjs` 由 dex profile patch 以 file:// 直载。
 */
export default defineConfig({
  resolve: {
    alias: [{ find: /^ws$/, replacement: wsEntry }],
  },
  build: {
    target: 'node20',
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    lib: {
      entry: {
        'dex-graph-bridge': 'src/host/entry.ts',
        'dex-trace-bridge': 'src/host/trace-entry.ts',
        'dex-model-control': 'src/host/model-control-entry.ts',
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.mjs`,
    },
    rollupOptions: {
      external: [
        ...builtinModules,
        ...builtinModules.map((name) => `node:${name}`),
        'bufferutil',
        'utf-8-validate',
      ],
    },
  },
})
