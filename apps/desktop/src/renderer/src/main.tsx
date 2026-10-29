import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './assets/fonts/noto-sans-sc.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { generateSyntheticGraph } from './core/bench-graph'
import { useGraphStore } from './stores/graphStore'
import './styles.css'

declare global {
  interface Window {
    /** 基准脚本钩子（仅 DEV 构建注入）：window.__dexBench.seedGraph(500) */
    __dexBench?: { seedGraph: (count: number) => void }
  }
}

const container = document.getElementById('root')
if (!container) throw new Error('未找到 #root 挂载点')

if (import.meta.env.DEV) {
  window.__dexBench = {
    seedGraph: (count: number) => {
      const graph = generateSyntheticGraph(count)
      useGraphStore.setState({ nodes: graph.nodes, links: graph.links })
    },
  }
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
