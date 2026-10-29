import { ICON_PATHS, type IconName } from '../../core/icons.generated'

export interface IconProps {
  /** 图标名，取自 brand/icons/*.svg 的文件名（无扩展名） */
  readonly name: IconName
  /** 渲染边长（px）。尺寸档位见设计系统第 11 章：12 / 14 / 16 / 20 / 24 / 32 / 48 */
  readonly size?: number
  readonly className?: string
}

/**
 * 品牌图标。路径数据由 `scripts/gen-icons.mjs` 从 `brand/icons/*.svg` 生成，
 * 此处只负责套上统一的 svg 外壳（24 网格 / 描边 1.75 / 圆头圆角 / currentColor）。
 */
export function Icon({ name, size = 16, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: 内容来自仓库内 brand/icons/ 的构建期产物，非用户输入
      dangerouslySetInnerHTML={{ __html: ICON_PATHS[name] }}
    />
  )
}
