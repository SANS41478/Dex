import { makeMessage } from '@dexagent/shared'
import { describe, expect, it } from 'vitest'
import { useTraceStore } from './traceStore'

function seedState(): void {
  const store = useTraceStore.getState()
  store.clear()
  store.dispatch(makeMessage('trace.turn.start', { turnId: 't1', userMessage: '任务', at: 1 }))
  store.dispatch(makeMessage('trace.step.start', { turnId: 't1', stepId: 's1', index: 0, at: 2 }))
  store.dispatch(makeMessage('trace.step.end', { stepId: 's1', status: 'success', at: 3 }))
  store.dispatch(makeMessage('trace.step.start', { turnId: 't1', stepId: 's2', index: 1, at: 4 }))
}

describe('traceStore time travel', () => {
  it('回看时保留完整源状态，实时消息只更新源状态', () => {
    seedState()
    useTraceStore.getState().enterTimeTravel('s1')
    expect(useTraceStore.getState().turns[0]?.steps.map((step) => step.id)).toEqual(['s1'])

    useTraceStore.getState().dispatch(
      makeMessage('trace.tool.start', {
        toolCallId: 'c2',
        stepId: 's2',
        toolName: 'read',
        pluginId: 'plugin-fs',
        input: { path: 'x' },
        at: 5,
      }),
    )

    const state = useTraceStore.getState()
    expect(state.turns[0]?.steps.map((step) => step.id)).toEqual(['s1'])
    expect(state.sourceState.turns[0]?.steps[1]?.toolCalls).toHaveLength(1)
  })

  it('前后切换与返回实时恢复最新状态', () => {
    seedState()
    useTraceStore.getState().enterTimeTravel('s2')
    expect(useTraceStore.getState().timeTravelStepId).toBe('s2')

    useTraceStore.getState().previousStep()
    expect(useTraceStore.getState().timeTravelStepId).toBe('s1')
    useTraceStore.getState().nextStep()
    expect(useTraceStore.getState().timeTravelStepId).toBe('s2')

    useTraceStore.getState().exitTimeTravel()
    expect(useTraceStore.getState().timeTravelStepId).toBeNull()
    expect(useTraceStore.getState().turns[0]?.steps).toHaveLength(2)
  })
})
