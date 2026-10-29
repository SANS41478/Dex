/** 宿主与连接状态的展示文案与色调档位（AppSidebar 底部状态行 / 设置抽屉共用）。 */

export type HostStatusPhase = 'unknown' | 'starting' | 'ready' | 'stopped' | 'error' | 'missing'

export type ConnectionStatusKind = 'connecting' | 'open' | 'closed'

/** 色调档位映射到现有 `.status-*` 类（styles.css）。 */
export type StatusTone = 'open' | 'connecting' | 'closed'

const HOST_LABELS: Record<HostStatusPhase, string> = {
  unknown: '宿主未知',
  starting: '宿主启动中',
  ready: '宿主运行中',
  stopped: '宿主已停止',
  error: '宿主异常',
  missing: '未找到宿主',
}

const HOST_TONES: Record<HostStatusPhase, StatusTone> = {
  unknown: 'closed',
  starting: 'connecting',
  ready: 'open',
  stopped: 'closed',
  error: 'closed',
  missing: 'closed',
}

const CONNECTION_LABELS: Record<ConnectionStatusKind, string> = {
  connecting: '连接中',
  open: '已连接',
  closed: '已断开',
}

const CONNECTION_TONES: Record<ConnectionStatusKind, StatusTone> = {
  connecting: 'connecting',
  open: 'open',
  closed: 'closed',
}

export function hostStatusLabel(phase: HostStatusPhase): string {
  return HOST_LABELS[phase]
}

export function hostStatusTone(phase: HostStatusPhase): StatusTone {
  return HOST_TONES[phase]
}

export function connectionStatusLabel(status: ConnectionStatusKind): string {
  return CONNECTION_LABELS[status]
}

export function connectionStatusTone(status: ConnectionStatusKind): StatusTone {
  return CONNECTION_TONES[status]
}
