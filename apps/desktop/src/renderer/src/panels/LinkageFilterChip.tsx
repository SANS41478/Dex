import { useLinkageStore } from '../stores/linkageStore'

/**
 * 跨面板的「只看这个插件」筛选状态条。
 *
 * **为什么提到面板级**：这个筛选是**全局**的（`linkageStore.pluginFilterId`），执行流与
 * 时间线都按它过滤，而触发点却在**另一个面板**——3D 图谱里点一下工具节点就会设上它
 * （M2-05 的联动设计）。原先 chip 只长在执行流面板的头部：
 * 用户在图谱里点了一下，切到执行流看到「该插件没有可展示的 Step」，
 * 而切回图谱时**完全看不到**筛选还开着，只能靠刷新页面恢复（黑盒报告 D07）。
 * 现在它挂在观测面板的公共头部，三个 Tab 都能看到、都能一键清空。
 */
export function LinkageFilterChip() {
  const pluginFilterId = useLinkageStore((state) => state.pluginFilterId)
  const setPluginFilter = useLinkageStore((state) => state.setPluginFilter)
  if (pluginFilterId === null) return null
  return (
    <span className="linkage-filter" data-testid="plugin-filter-chip">
      <span className="muted">执行流只看插件</span>
      <span className="mono linkage-filter-id">{pluginFilterId}</span>
      <button
        type="button"
        className="graph-chip"
        onClick={() => setPluginFilter(null)}
        aria-label="清除插件过滤"
        data-testid="plugin-filter-clear"
      >
        ✕
      </button>
    </span>
  )
}
