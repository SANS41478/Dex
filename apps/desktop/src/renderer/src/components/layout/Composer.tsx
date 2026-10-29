import {
  type ApprovalPolicy,
  approvalPolicies,
  isApprovalPolicySupported,
  isPermissionPresetSupported,
  type PermissionPreset,
  permissionPresets,
  reasoningEfforts,
  reasoningEffortsFor,
  resolveReasoningEffort,
} from '@dexagent/shared'
import { useMemo, useState } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useTraceStore } from '../../stores/traceStore'

/** 无活跃会话时的输入框提示：区分「历史只读回放」与「还没开过会话」。 */
const IDLE_PLACEHOLDER = '先添加工作区并新建会话…'

const PERMISSION_LABEL: Record<PermissionPreset, string> = {
  'read-only': '只读',
  'workspace-write': '工作区写入',
  'danger-full-access': '完全访问',
}

const APPROVAL_LABEL: Record<ApprovalPolicy, string> = {
  ask: '询问审批',
  never: '自动通过',
}

export function Composer() {
  const [draft, setDraft] = useState('')
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  const sending = useChatStore((state) => state.sending)
  const stopping = useChatStore((state) => state.stopping)
  const error = useChatStore((state) => state.error)
  const failedPrompt = useChatStore((state) => state.failedPrompt)
  const resend = useChatStore((state) => state.resend)
  const attachments = useChatStore((state) => state.attachments)
  const permissionPreset = useChatStore((state) => state.permissionPreset)
  const approvalPolicy = useChatStore((state) => state.approvalPolicy)
  const reasoningEffort = useChatStore((state) => state.reasoningEffort)
  const pickAttachments = useChatStore((state) => state.pickAttachments)
  const removeAttachment = useChatStore((state) => state.removeAttachment)
  const setPermissionPreset = useChatStore((state) => state.setPermissionPreset)
  const setApprovalPolicy = useChatStore((state) => state.setApprovalPolicy)
  const setReasoningEffort = useChatStore((state) => state.setReasoningEffort)
  const noteSystem = useChatStore((state) => state.noteSystem)
  const send = useChatStore((state) => state.send)
  const stop = useChatStore((state) => state.stop)
  const viewMode = useTraceStore((state) => state.viewMode)
  const replaySessionId = useTraceStore((state) => state.replaySessionId)
  const catalog = useModelStore((state) => state.catalog)
  const selectModel = useModelStore((state) => state.select)
  const selectedModel = catalog.selection
  const selectedValue =
    selectedModel === null ? '' : `${selectedModel.provider}/${selectedModel.model}`
  /*
   * 只有「没有会话」才禁用整块（那时确实没法输入）。
   * 「正在跑」不再 disabled 输入框：原实现把它算进 disabled，会在按下发送的瞬间
   * 让 textarea 失焦，而且整轮任务期间用户完全无法预输入下一条。
   * 对齐 dsh 的乐观提交语义——发送期间输入框保持可编辑，只有提交动作被拦。
   */
  const disabled = activeSessionId === null
  const placeholder =
    activeSessionId !== null
      ? '描述要完成的编码任务…'
      : viewMode === 'replay' && replaySessionId !== null
        ? `只读回放 ${replaySessionId}：历史会话不能继续对话，点「新对话」开始`
        : IDLE_PLACEHOLDER
  const providerModels = useMemo(
    () =>
      catalog.providers.flatMap((provider) =>
        provider.models.map((model) => ({
          value: `${provider.id}/${model.id}`,
          // 「未配置凭据」直接写在选项上：这类 provider 选了一定会失败。与其让用户发出去
          // 再从宿主日志里发现 `MISSING_CREDENTIAL`（黑盒报告 D18），不如在选择的那一刻就说。
          label: `${provider.name} · ${model.name}${
            provider.credential.configured ? '' : '（未配置凭据）'
          }`,
          configured: provider.credential.configured,
          providerLabel: provider.name,
        })),
      ),
    [catalog.providers],
  )

  /** 当前模型支持的推理档位（未知模型 = 全档位）。不支持的档位在下拉里置灰。 */
  const allowedEfforts = useMemo(
    () => reasoningEffortsFor(selectedModel?.provider, selectedModel?.model),
    [selectedModel?.provider, selectedModel?.model],
  )

  /**
   * 切换推理档位。
   *
   * 必须与模型下拉走**同一条写回路径**（`models/select`）：那是唯一把配置真正写进
   * dsh 会话的通道。只改本地 store 的话，档位要等到用户「再切换一次模型」才会被带上，
   * 于是出现「照提示把 medium 改成 off 却依然失败」（黑盒报告 D02）。
   */
  const changeReasoningEffort = (value: string): void => {
    const requested = reasoningEfforts.find((effort) => effort === value) ?? 'off'
    const selection = catalog.selection
    if (activeSessionId === null || selection === null) {
      setReasoningEffort(requested)
      return
    }
    const next = resolveReasoningEffort(selection.provider, selection.model, requested)
    setReasoningEffort(next)
    void selectModel(activeSessionId, {
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: next,
    }).catch(() => undefined)
  }

  const submit = (): void => {
    const text = draft.trim()
    // 宿主一次只接一轮：sending 期间不往 SDK 里塞第二条（否则撞 SESSION_BUSY）。
    // 输入框本身仍可编辑，草稿会留着，等宿主回到 idle 再发。
    if (text === '' || disabled || sending) return
    setDraft('')
    void send(text)
  }

  return (
    <section className="composer" data-testid="composer">
      {attachments.length > 0 ? (
        <div className="composer-attachments">
          {attachments.map((attachment) => (
            <span className="attachment-chip" key={attachment.path}>
              <span>{attachment.kind === 'image' ? '▧' : '▤'}</span>
              <span className="mono">{attachment.path.split(/[\\/]/).at(-1)}</span>
              <button
                type="button"
                onClick={() => removeAttachment(attachment.path)}
                aria-label={`移除 ${attachment.path}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          /*
           * 中文/日文输入法的组合态里，回车是「确认候选词」，而 key 同样是 'Enter'。
           * 不先拦这一步，会把还没打完的半截话直接发出去。
           * isComposing 与 keyCode 229 是浏览器暴露 IME 组合态的两条标准信号。
           */
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            submit()
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        data-testid="chat-input"
        /* 行高交给 CSS `field-sizing: content` 自适应（min/max-height 兜底），
           这里只给不支持该特性时的退化基线。 */
        rows={1}
      />
      <div className="composer-toolbar">
        <div className="composer-controls" data-testid="composer-controls">
          <fieldset className="composer-option-group">
            <legend>权限与审批</legend>
            <select
              className="composer-select composer-select-policy"
              value={permissionPreset}
              onChange={(event) =>
                setPermissionPreset(
                  permissionPresets.find((preset) => preset === event.target.value) ??
                    'workspace-write',
                )
              }
              disabled={disabled}
              aria-label="权限预设"
              data-testid="permission-selector"
            >
              {permissionPresets.map((preset) => {
                const supported = isPermissionPresetSupported(preset)
                return (
                  <option value={preset} key={preset} disabled={!supported}>
                    {PERMISSION_LABEL[preset]}
                    {supported ? '' : '（当前 runtime 不可用）'}
                  </option>
                )
              })}
            </select>
            <select
              className="composer-select composer-select-approval"
              value={approvalPolicy}
              onChange={(event) =>
                setApprovalPolicy(
                  approvalPolicies.find((policy) => policy === event.target.value) ?? 'ask',
                )
              }
              disabled={disabled}
              aria-label="审批策略"
              data-testid="approval-selector"
            >
              {approvalPolicies.map((policy) => {
                const supported = isApprovalPolicySupported(policy)
                return (
                  <option value={policy} key={policy} disabled={!supported}>
                    {APPROVAL_LABEL[policy]}
                    {supported ? '' : '（当前 runtime 不可用）'}
                  </option>
                )
              })}
            </select>
          </fieldset>
          <fieldset className="composer-option-group">
            <legend>模型与推理</legend>
            <select
              className="composer-select composer-select-model"
              value={selectedValue}
              onChange={(event) => {
                const [provider, model] = event.target.value.split('/')
                if (activeSessionId === null || provider === undefined || model === undefined)
                  return
                const picked = providerModels.find((item) => item.value === event.target.value)
                if (picked !== undefined && !picked.configured) {
                  // 前置告知：缺凭据属于「一定能探测到」的问题，不该等发出去才发现（D18）。
                  noteSystem(
                    `provider「${picked.providerLabel}」还没有配置 API key，这一轮会因为缺凭据失败。请到「设置 → 模型」写入后重试。`,
                  )
                }
                // 换模型时档位要跟着收敛：新模型未必支持旧档位（如 deepseek-flash 只吃 off），
                // 不收敛的话就会把上一个模型的档位原封不动发过去，整轮失败。
                const next = resolveReasoningEffort(provider, model, reasoningEffort)
                setReasoningEffort(next)
                void selectModel(activeSessionId, {
                  provider,
                  model,
                  reasoningEffort: next,
                }).catch(() => undefined)
              }}
              disabled={disabled || providerModels.length === 0}
              aria-label="模型"
              data-testid="composer-model-selector"
            >
              <option value="">选择模型</option>
              {providerModels.map((model) => (
                <option value={model.value} key={model.value}>
                  {model.label}
                </option>
              ))}
            </select>
            <select
              className="composer-select composer-select-reasoning"
              value={reasoningEffort}
              onChange={(event) => changeReasoningEffort(event.target.value)}
              disabled={disabled}
              aria-label="推理等级"
              data-testid="reasoning-selector"
            >
              {reasoningEfforts.map((effort) => (
                <option value={effort} key={effort} disabled={!allowedEfforts.includes(effort)}>
                  推理 · {effort}
                  {allowedEfforts.includes(effort) ? '' : '（该模型不支持）'}
                </option>
              ))}
            </select>
          </fieldset>
        </div>
        <div className="composer-actions" data-testid="composer-actions">
          <button
            type="button"
            className="composer-icon-button"
            onClick={() => void pickAttachments().catch(() => undefined)}
            disabled={disabled}
            title="添加工作区文件引用"
            aria-label="添加工作区文件引用"
          >
            ＋
          </button>
          {error !== null ? (
            <span className="composer-error">
              <span className="composer-error-text" title={error}>
                {error}
              </span>
              {failedPrompt !== null ? (
                <button
                  type="button"
                  className="composer-retry"
                  onClick={() => {
                    void resend().catch(() => undefined)
                  }}
                  disabled={disabled || sending}
                  data-testid="chat-retry"
                >
                  重发
                </button>
              ) : null}
            </span>
          ) : null}
          <button
            type="button"
            className="graph-chip"
            disabled={!sending || stopping}
            onClick={() => {
              void stop().catch(() => undefined)
            }}
            data-testid="chat-stop"
          >
            {stopping ? '停止中…' : '停止'}
          </button>
          <button
            type="button"
            className="graph-chip graph-chip-active"
            disabled={disabled || sending || draft.trim() === ''}
            onClick={submit}
            data-testid="chat-send"
          >
            发送
          </button>
        </div>
      </div>
    </section>
  )
}
