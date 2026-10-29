import { describe, expect, it } from 'vitest'
import {
  buildGraphSnapshotExport,
  graphSnapshotExportSchema,
  serializeGraphSnapshotJson,
} from './graph-snapshot'

const nodes = [
  { id: 'b', label: 'b', type: 'tool' as const, status: 'active' as const },
  { id: 'a', label: 'a', type: 'model' as const, status: 'inactive' as const },
]
const links = [
  { id: 'z', source: 'b', target: 'a', type: 'runtime' as const },
  { id: 'a', source: 'a', target: 'b', type: 'inject' as const },
]

describe('graph snapshot export', () => {
  it('按 id 稳定排序并保留视图状态', () => {
    const snapshot = buildGraphSnapshotExport(
      nodes,
      links,
      {
        camera: null,
        visibleTypes: ['tool', 'model'],
        focusOnly: true,
        selectedNodeId: 'a',
      },
      123,
    )
    expect(snapshot.nodes.map((node) => node.id)).toEqual(['a', 'b'])
    expect(snapshot.links.map((link) => link.id)).toEqual(['a', 'z'])
    expect(snapshot.view).toMatchObject({ focusOnly: true, selectedNodeId: 'a' })
    expect(graphSnapshotExportSchema.safeParse(snapshot).success).toBe(true)
  })

  it('空图谱和 null camera 可序列化，且不带敏感字段', () => {
    const snapshot = buildGraphSnapshotExport(
      [],
      [],
      { camera: null, visibleTypes: [], focusOnly: false, selectedNodeId: null },
      123,
    )
    const json = serializeGraphSnapshotJson(snapshot)
    expect(JSON.parse(json)).toMatchObject({ schemaVersion: 1, nodes: [], links: [] })
    expect(json).not.toMatch(/trace|session|credential|apiKey/i)
  })
})
