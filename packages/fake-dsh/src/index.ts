import { type GraphLink, type GraphNode, type Message, makeMessage } from '@dexagent/shared'

export interface DemoEvent {
  delayMs: number
  message: Message
}

export interface PlayOptions {
  speed?: number
  pauseMs?: number
  cycles?: number
  /** 是否播放演示图谱生命周期；传函数可随宿主真实数据就绪动态关闭。 */
  graph?: boolean | (() => boolean)
  /** 是否播放演示执行流；真实 trace 到达后由 main 传函数关闭。 */
  trace?: boolean | (() => boolean)
}

const LINK_SEARCH_FS: GraphLink = {
  id: 'inject:tool-search:fs',
  source: 'tool-search',
  target: 'tool-fs',
  type: 'inject',
}

const LINK_FS_SANDBOX: GraphLink = {
  id: 'inject:tool-fs:sandbox',
  source: 'tool-fs',
  target: 'sandbox-local',
  type: 'inject',
}

const LINK_SEARCH_SANDBOX: GraphLink = {
  id: 'inject:tool-search:sandbox',
  source: 'tool-search',
  target: 'sandbox-local',
  type: 'inject',
}

const LINK_SKILL_SANDBOX: GraphLink = {
  id: 'inject:skill-filesystem:sandbox',
  source: 'skill-filesystem',
  target: 'sandbox-local',
  type: 'inject',
}

/** 演示用静态插件树：连接建立时作为 `graph.snapshot` 全量发出（M1-04 换真实宿主数据）。 */
export function buildDemoGraph(): { nodes: GraphNode[]; links: GraphLink[] } {
  return {
    nodes: [
      { id: 'model-deepseek', label: 'dsh-model-deepseek', type: 'model', status: 'active' },
      { id: 'tool-fs', label: 'dsh-tool-fs', type: 'tool', status: 'active' },
      { id: 'tool-search', label: 'dsh-tool-fs-search', type: 'tool', status: 'active' },
      { id: 'skill-filesystem', label: 'dsh-skill-filesystem', type: 'skill', status: 'active' },
      { id: 'scheduler-cron', label: 'dsh-scheduler-cron', type: 'scheduler', status: 'inactive' },
      { id: 'sandbox-local', label: 'dsh-sandbox-local', type: 'sandbox', status: 'active' },
      {
        id: 'plugin-inventory',
        label: 'dsh-host-plugin-inventory',
        type: 'other',
        status: 'active',
      },
    ],
    links: [LINK_SEARCH_FS, LINK_FS_SANDBOX, LINK_SEARCH_SANDBOX, LINK_SKILL_SANDBOX],
  }
}

export function createDemoGraphSnapshot(): Message {
  return makeMessage('graph.snapshot', buildDemoGraph())
}

const TOOL_EDIT_NODE: GraphNode = {
  id: 'tool-edit',
  label: 'dsh-tool-edit',
  type: 'tool',
  status: 'active',
}

const LINK_EDIT_SANDBOX: GraphLink = {
  id: 'inject:tool-edit:sandbox',
  source: 'tool-edit',
  target: 'sandbox-local',
  type: 'inject',
}

/** 演示图谱生命周期：偶数轮生长一个插件节点，奇数轮回缩（验证 upsert / remove 通道）。 */
export function buildDemoGraphTurn(turnIndex: number): DemoEvent[] {
  if (turnIndex % 2 === 0) {
    return [
      {
        delayMs: 200,
        message: makeMessage('graph.upsert', {
          nodes: [TOOL_EDIT_NODE],
          links: [LINK_EDIT_SANDBOX],
        }),
      },
    ]
  }
  return [
    {
      delayMs: 200,
      message: makeMessage('graph.remove', {
        nodeIds: [TOOL_EDIT_NODE.id],
        linkIds: [LINK_EDIT_SANDBOX.id],
      }),
    },
  ]
}

export function buildDemoTurn(turnIndex: number): DemoEvent[] {
  const turnId = `turn-${turnIndex + 1}`
  const stepId = (n: number) => `${turnId}-step-${n}`
  const toolId = (n: number) => `${turnId}-tool-${n}`
  const willFail = turnIndex % 2 === 1

  let clock = Date.now()
  const stamp = (): number => {
    clock += 120
    return clock
  }

  const events: DemoEvent[] = []
  const push = (delayMs: number, message: Message): void => {
    events.push({ delayMs, message })
  }

  push(
    0,
    makeMessage('trace.turn.start', {
      turnId,
      userMessage: willFail ? '重构一下这个模块，顺便看看有没有坑' : '看看项目结构，修一个已知问题',
      at: stamp(),
    }),
  )
  push(
    40,
    makeMessage('trace.policy', {
      sessionId: 'demo',
      changeId: `${turnId}:policy:preset`,
      kind: 'preset',
      value: 'workspace-write',
      at: stamp(),
    }),
  )
  push(
    40,
    makeMessage('trace.policy', {
      sessionId: 'demo',
      changeId: `${turnId}:policy:sandbox`,
      kind: 'sandbox',
      value: 'workspace-write',
      at: stamp(),
    }),
  )
  push(
    40,
    makeMessage('trace.policy', {
      sessionId: 'demo',
      changeId: `${turnId}:policy:approval`,
      kind: 'approval',
      value: 'ask',
      at: stamp(),
    }),
  )

  push(
    160,
    makeMessage('trace.step.start', {
      turnId,
      stepId: stepId(1),
      index: 0,
      at: stamp(),
    }),
  )
  // 思考先于工具调用下发（真机顺序：assistant/message 在 tool/call 之前）。
  push(
    60,
    makeMessage('trace.step.reasoning', {
      stepId: stepId(1),
      reasoning:
        '用户想知道这个项目是什么、怎么跑起来。最省事、最可靠的入口是 README：里面的定位和启动命令通常就是权威答案，先读它，别急着猜。',
      at: stamp(),
    }),
  )
  push(
    220,
    makeMessage('trace.tool.start', {
      toolCallId: toolId(1),
      stepId: stepId(1),
      toolName: 'read_file',
      pluginId: 'include:tool-fs',
      input: { path: 'README.md' },
      at: stamp(),
    }),
  )
  push(
    80,
    makeMessage('trace.approval', {
      sessionId: 'demo',
      requestId: `${turnId}:approval:edit`,
      phase: 'asked',
      toolName: 'edit_file',
      callId: toolId(3),
      reason: '写入工作区文件需要确认',
      at: stamp(),
    }),
  )
  push(
    80,
    makeMessage('trace.approval', {
      sessionId: 'demo',
      requestId: `${turnId}:approval:edit`,
      phase: 'decided',
      toolName: 'edit_file',
      callId: toolId(3),
      reason: '写入工作区文件需要确认',
      outcome: willFail ? 'rejected' : 'allowed-once',
      at: stamp(),
    }),
  )
  push(
    420,
    makeMessage('trace.tool.end', {
      toolCallId: toolId(1),
      stepId: stepId(1),
      status: 'success',
      output: '# Dex AGENT ...',
      durationMs: 418,
      at: stamp(),
    }),
  )
  push(
    200,
    makeMessage('trace.step.end', {
      stepId: stepId(1),
      status: 'success',
      llmReasoning: '先读 README，了解项目定位与运行方式',
      at: stamp(),
    }),
  )

  push(
    200,
    makeMessage('trace.step.start', {
      turnId,
      stepId: stepId(2),
      index: 1,
      at: stamp(),
    }),
  )
  push(
    60,
    makeMessage('trace.step.reasoning', {
      stepId: stepId(2),
      reasoning:
        'README 里提到了待办与已知问题。用 grep 扫一遍 TODO，能一次性看清还欠什么，比逐个文件读快得多。',
      at: stamp(),
    }),
  )
  push(
    220,
    makeMessage('trace.tool.start', {
      toolCallId: toolId(2),
      stepId: stepId(2),
      toolName: 'grep',
      pluginId: 'include:tool-fs-search',
      input: { pattern: 'TODO', include: '*.ts' },
      at: stamp(),
    }),
  )
  push(
    360,
    makeMessage('trace.tool.end', {
      toolCallId: toolId(2),
      stepId: stepId(2),
      status: 'success',
      output: '3 matches in 2 files',
      durationMs: 356,
      at: stamp(),
    }),
  )
  push(
    200,
    makeMessage('trace.step.end', {
      stepId: stepId(2),
      status: 'success',
      llmReasoning: '定位到 3 处可疑点，准备修改',
      at: stamp(),
    }),
  )

  push(
    200,
    makeMessage('trace.step.start', {
      turnId,
      stepId: stepId(3),
      index: 2,
      at: stamp(),
    }),
  )
  push(
    60,
    makeMessage('trace.step.reasoning', {
      stepId: stepId(3),
      reasoning: willFail
        ? '定位到 3 处可疑点，先改最要命的那一行。写入可能被沙箱拦，如果被拦就把原因说清楚，别硬试。'
        : '定位到 3 处可疑点，先改最要命的那一行，然后再看要不要一并收拾其余两处。',
      at: stamp(),
    }),
  )
  push(
    220,
    makeMessage('trace.tool.start', {
      toolCallId: toolId(3),
      stepId: stepId(3),
      toolName: 'edit_file',
      pluginId: 'include:tool-fs',
      input: { path: 'src/app.ts', line: 42 },
      at: stamp(),
    }),
  )
  push(
    380,
    makeMessage('trace.tool.end', {
      toolCallId: toolId(3),
      stepId: stepId(3),
      status: willFail ? 'failed' : 'success',
      output: willFail ? 'sandbox denied: write outside workspace' : '1 line replaced',
      durationMs: 372,
      at: stamp(),
    }),
  )
  push(
    200,
    makeMessage('trace.step.end', {
      stepId: stepId(3),
      status: willFail ? 'failed' : 'success',
      llmReasoning: willFail ? '写入被沙箱策略拒绝，需要用户审批' : '替换完成，任务收尾',
      at: stamp(),
    }),
  )

  push(
    260,
    makeMessage('trace.turn.end', {
      turnId,
      status: willFail ? 'failed' : 'completed',
      at: stamp(),
    }),
  )

  return events
}

export function playDemoLoop(
  send: (message: Message) => void,
  options: PlayOptions = {},
): () => void {
  const { speed = 1, pauseMs = 2400, cycles = Number.POSITIVE_INFINITY } = options
  let stopped = false

  const graphEnabled = (): boolean =>
    typeof options.graph === 'function' ? options.graph() : options.graph !== false
  const traceEnabled = (): boolean =>
    typeof options.trace === 'function' ? options.trace() : options.trace !== false

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms)
    })

  const run = async (): Promise<void> => {
    for (let index = 0; index < cycles; index += 1) {
      const events = [
        ...(traceEnabled() ? buildDemoTurn(index) : []),
        ...(graphEnabled() ? buildDemoGraphTurn(index) : []),
      ]
      for (const event of events) {
        if (stopped) return
        await sleep(event.delayMs / speed)
        send(event.message)
      }
      if (stopped) return
      await sleep(pauseMs / speed)
    }
  }

  void run()

  return () => {
    stopped = true
  }
}
