import { beforeEach, describe, expect, it } from 'vitest'
import { useTraceSelectionStore } from './traceSelectionStore'

beforeEach(() => {
  useTraceSelectionStore.setState({ selectedId: null })
})

describe('traceSelectionStore', () => {
  it('select 设置/清空选中', () => {
    useTraceSelectionStore.getState().select('s1')
    expect(useTraceSelectionStore.getState().selectedId).toBe('s1')
    useTraceSelectionStore.getState().select(null)
    expect(useTraceSelectionStore.getState().selectedId).toBeNull()
  })

  it('toggle 点击已选中项取消，否则切换', () => {
    useTraceSelectionStore.getState().toggle('s1')
    expect(useTraceSelectionStore.getState().selectedId).toBe('s1')
    useTraceSelectionStore.getState().toggle('s1')
    expect(useTraceSelectionStore.getState().selectedId).toBeNull()
    useTraceSelectionStore.getState().toggle('s2')
    expect(useTraceSelectionStore.getState().selectedId).toBe('s2')
  })
})
