import { describe, expect, it } from 'vitest'
import { useLinkageStore } from './linkageStore'

describe('linkageStore', () => {
  it('设置与清除插件过滤保持独立', () => {
    const store = useLinkageStore.getState()
    store.setPluginFilter('include:tool-fs')
    expect(useLinkageStore.getState().pluginFilterId).toBe('include:tool-fs')
    store.setPluginFilter(null)
    expect(useLinkageStore.getState().pluginFilterId).toBeNull()
  })

  it('聚焦请求可被消费后清除', () => {
    const store = useLinkageStore.getState()
    store.requestGraphFocus('include:tool-fs')
    const request = useLinkageStore.getState().focusRequest
    expect(request?.nodeId).toBe('include:tool-fs')
    expect(request?.nonce).toEqual(expect.any(Number))
    store.clearFocusRequest()
    expect(useLinkageStore.getState().focusRequest).toBeNull()
  })
})
