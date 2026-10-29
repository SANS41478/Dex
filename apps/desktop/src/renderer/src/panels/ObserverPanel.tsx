import { lazy, Suspense } from 'react'
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { useObserverStore } from '../stores/observerStore'
import { DagPanel } from './DagPanel'

const GraphPanel = lazy(() =>
  import('./GraphPanel').then((module) => ({ default: module.GraphPanel })),
)

function GraphPanelFallback() {
  return (
    <section className="panel" data-testid="panel-graph">
      <header className="panel-header">
        <span>3D 架构图谱</span>
        <span className="muted">加载中…</span>
      </header>
      <div className="panel-body">
        <p className="placeholder">正在加载 3D 渲染模块（three / force-graph）。</p>
      </div>
    </section>
  )
}

export function ObserverPanel() {
  const flowView = useObserverStore((state) => state.flowView)
  const setFlowView = useObserverStore((state) => state.setFlowView)
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'dex-observer-split',
    storage: localStorage,
    onlySaveAfterUserInteractions: true,
  })

  return (
    <section className="observer-shell" data-testid="panel-observer">
      <Group
        orientation="vertical"
        className="observer-split"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        <Panel id="observer-graph" defaultSize="55" minSize={180}>
          <Suspense fallback={<GraphPanelFallback />}>
            <GraphPanel />
          </Suspense>
        </Panel>
        <Separator
          id="observer-split-handle"
          className="observer-resize-handle"
          aria-label="调整 3D 图谱与执行流的高度占比"
          title="拖动调整上下占比，双击恢复 55/45"
        >
          <span className="observer-resize-grip" aria-hidden="true" />
        </Separator>
        <Panel id="observer-flow" defaultSize="45" minSize={150}>
          <DagPanel view={flowView} onViewChange={setFlowView} />
        </Panel>
      </Group>
    </section>
  )
}
