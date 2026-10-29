import type { TraceMessage } from '@dexagent/shared'
import { create } from 'zustand'
import {
  applyTraceMessage,
  initialTraceState,
  type TraceState,
  truncateTraceStateAtStep,
} from '../core/trace'

export interface TraceStore extends TraceState {
  sourceState: TraceState
  viewMode: 'live' | 'replay'
  replaySessionId: string | null
  timeTravelStepId: string | null
  timeTravelError: string | null
  dispatch: (message: TraceMessage) => void
  replace: (state: TraceState, sessionId: string) => void
  restoreLive: (state: TraceState, sessionId: string) => void
  enterTimeTravel: (stepId: string) => void
  previousStep: () => void
  nextStep: () => void
  exitTimeTravel: () => void
  clear: () => void
}

function stepIds(state: TraceState): readonly string[] {
  return state.turns.flatMap((turn) => turn.steps.map((step) => step.id))
}

export const useTraceStore = create<TraceStore>((set, get) => ({
  ...initialTraceState,
  sourceState: initialTraceState,
  viewMode: 'live',
  replaySessionId: null,
  timeTravelStepId: null,
  timeTravelError: null,
  dispatch: (message) => {
    set((state) => {
      if (state.viewMode === 'replay') return state
      const sourceState = applyTraceMessage(state.sourceState, message)
      if (state.timeTravelStepId === null) {
        return {
          ...sourceState,
          sourceState,
          timeTravelError: null,
        }
      }
      const cut = truncateTraceStateAtStep(sourceState, state.timeTravelStepId)
      if (!cut.ok) {
        return {
          ...state,
          sourceState,
          timeTravelError: cut.error,
        }
      }
      return {
        ...cut.state,
        sourceState,
        timeTravelError: null,
      }
    })
  },
  replace: (state, sessionId) => {
    set({
      ...state,
      sourceState: state,
      viewMode: 'replay',
      replaySessionId: sessionId,
      timeTravelStepId: null,
      timeTravelError: null,
    })
  },
  restoreLive: (state, _sessionId) => {
    set({
      ...state,
      sourceState: state,
      viewMode: 'live',
      replaySessionId: null,
      timeTravelStepId: null,
      timeTravelError: null,
    })
  },
  enterTimeTravel: (stepId) => {
    set((state) => {
      const cut = truncateTraceStateAtStep(state.sourceState, stepId)
      if (!cut.ok) return { ...state, timeTravelError: cut.error }
      return {
        ...cut.state,
        timeTravelStepId: stepId,
        timeTravelError: null,
      }
    })
  },
  previousStep: () => {
    const state = get()
    const ids = stepIds(state.sourceState)
    const currentIndex =
      state.timeTravelStepId === null ? ids.length : ids.indexOf(state.timeTravelStepId)
    if (currentIndex <= 0) return
    const previous = ids[currentIndex - 1]
    if (previous !== undefined) state.enterTimeTravel(previous)
  },
  nextStep: () => {
    const state = get()
    const ids = stepIds(state.sourceState)
    const currentIndex = state.timeTravelStepId === null ? -1 : ids.indexOf(state.timeTravelStepId)
    const next = ids[currentIndex + 1]
    if (next !== undefined) state.enterTimeTravel(next)
  },
  exitTimeTravel: () => {
    set((state) => ({
      ...state.sourceState,
      viewMode: state.viewMode,
      replaySessionId: state.replaySessionId,
      sourceState: state.sourceState,
      timeTravelStepId: null,
      timeTravelError: null,
    }))
  },
  clear: () => {
    set({
      ...initialTraceState,
      sourceState: initialTraceState,
      viewMode: 'live',
      replaySessionId: null,
      timeTravelStepId: null,
      timeTravelError: null,
    })
  },
}))
