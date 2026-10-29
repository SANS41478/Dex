import { useEffect, useState } from 'react'
import {
  connectionStatusLabel,
  connectionStatusTone,
  hostStatusLabel,
  hostStatusTone,
} from '../../core/status-labels'
import { useConnectionStore } from '../../stores/connectionStore'
import { useHostStore } from '../../stores/hostStore'
import { useNavigationStore } from '../../stores/navigationStore'
import { GeneralSettings } from './GeneralSettings'
import { GlobalSettings } from './GlobalSettings'
import { ModelsSettings } from './ModelsSettings'
import { PluginsSettings } from './PluginsSettings'
import { WorkspacesSettings } from './WorkspacesSettings'

/**
 * 设置窗口的左侧分区导航（UI-09 照 dsh 重排；UI-10 加「插件」）。
 *
 * dsh 的顺序是「通用(0) → 模型(10) → 插件(15) → …」；Dex 目前提供：
 * 通用（精选条目）/ 模型（provider 管理）/ 工作区（宿主登记）/ 插件（查看/启停/配置）
 * / 高级（原始命名空间）/ 运行状态（Dex 特有）。账号、Agent 预设等分区待 dsh 能力接入后再开。
 */
const SECTIONS = [
  { id: 'general', label: '通用' },
  { id: 'models', label: '模型' },
  { id: 'workspaces', label: '工作区' },
  { id: 'plugins', label: '插件' },
  { id: 'advanced', label: '高级' },
  { id: 'status', label: '运行状态' },
] as const

type SettingsSection = (typeof SECTIONS)[number]['id']

/**
 * 设置窗口（UI-01）：形态对齐 dsh 桌面端——**应用内居中模态窗**，
 * 宽高约 800×800 且受视口约束，左侧分区导航 + 右侧内容滚动。
 *
 * 由原「右侧滑出抽屉」改造而来；开关仍是 `navigationStore.settingsOpen`，
 * 挂载点仍在 `App` 内（遮罩是 `position: fixed`，视觉上覆盖整个窗口）。
 *
 * `data-testid` 保留旧名 `settings-drawer`——`e2e/app.spec.ts` 与两个诊断脚本
 * 脚本都按它取元素，改名会连带改测试而收益不抵成本。
 */
export function SettingsDialog() {
  const open = useNavigationStore((state) => state.settingsOpen)
  const closeSettings = useNavigationStore((state) => state.closeSettings)
  const [section, setSection] = useState<SettingsSection>('general')
  const hostPhase = useHostStore((state) => state.phase)
  const hostDetail = useHostStore((state) => state.detail)
  const connection = useConnectionStore((state) => state.status)

  /*
   * Esc 关闭：监听必须挂在 `document` 上。
   *
   * 原实现把 `onKeyDown` 写在内层 `<section>` 的 JSX 属性上——那个 section 没有初始焦点，
   * 键盘事件根本冒泡不到它，于是 Esc 完全失灵。而遮罩层 `settings-backdrop-hit` 铺满全屏、
   * 吞掉所有点击，用户就被关在设置窗里出不来（黑盒报告 D10；该遮罩还连锁导致 5 个
   * 交互用例点击超时）。
   */
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeSettings()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, closeSettings])

  if (!open) return null

  return (
    <div className="settings-backdrop" data-testid="settings-drawer">
      {/* 点击窗口外关闭：用透明按钮承载，满足 a11y（键盘可用、有可访问名）。 */}
      <button
        type="button"
        className="settings-backdrop-hit"
        aria-label="关闭设置"
        onClick={closeSettings}
      />
      <section className="settings-modal" role="dialog" aria-label="设置" aria-modal="true">
        <header className="settings-modal-head">
          <span className="settings-modal-title">设置</span>
          <button
            type="button"
            className="graph-chip"
            onClick={closeSettings}
            aria-label="关闭设置"
            data-testid="settings-close"
          >
            关闭
          </button>
        </header>

        <div className="settings-modal-body">
          <nav className="settings-nav" aria-label="设置分区">
            {SECTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`settings-nav-item${
                  section === item.id ? ' settings-nav-item-active' : ''
                }`}
                aria-current={section === item.id ? 'page' : undefined}
                onClick={() => setSection(item.id)}
                data-testid={`settings-nav-${item.id}`}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="settings-content" data-testid="settings-content">
            {section === 'status' ? (
              <section className="settings-section">
                <h3 className="settings-section-title">运行状态</h3>
                <div className="settings-row">
                  <span className={`status status-${hostStatusTone(hostPhase)}`}>
                    <span className="status-dot" />
                    {hostStatusLabel(hostPhase)}
                  </span>
                  {hostDetail !== null ? <span className="muted">{hostDetail}</span> : null}
                </div>
                <div className="settings-row">
                  <span className={`status status-${connectionStatusTone(connection)}`}>
                    <span className="status-dot" />
                    {connectionStatusLabel(connection)}
                  </span>
                </div>
              </section>
            ) : null}

            {section === 'general' ? <GeneralSettings /> : null}
            {section === 'models' ? <ModelsSettings /> : null}
            {section === 'workspaces' ? <WorkspacesSettings /> : null}
            {section === 'plugins' ? <PluginsSettings /> : null}
            {section === 'advanced' ? <GlobalSettings /> : null}
          </div>
        </div>
      </section>
    </div>
  )
}
