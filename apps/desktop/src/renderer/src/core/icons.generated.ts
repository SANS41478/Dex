// biome-ignore-all format: 机器生成文件——格式由 scripts/gen-icons.mjs 决定，不由 biome 改写
/* ==========================================================================
   图标路径数据 · 由 scripts/gen-icons.mjs 从 brand/icons/*.svg 生成
   MUST NOT 手工编辑——要改图标请改 brand/icons/ 下的源文件后重跑脚本。
   共 27 个图标，统一规格：24 网格 / 描边 1.75 / 圆头圆角 / 内容区留 2px 内边距。
   ========================================================================== */

export const ICON_NAMES = [
  'approval',
  'attach',
  'back',
  'chevron-left',
  'chevron-right',
  'close',
  'credential',
  'dag',
  'export',
  'filter',
  'graph',
  'maximize',
  'minimize',
  'model',
  'new-chat',
  'refresh',
  'replay',
  'search',
  'send',
  'session',
  'settings',
  'stop',
  'theme-dark',
  'theme-light',
  'theme-system',
  'timeline',
  'workspace',
] as const

export type IconName = (typeof ICON_NAMES)[number]

/** 每个值的形状是 <svg> 的内部标记（不含外层 svg 标签） */
export const ICON_PATHS: Record<IconName, string> = {
  'approval': '<path d="M12 3.4 5 6.1v5.5c0 4 2.9 7.6 7 8.9 4.1-1.3 7-4.9 7-8.9V6.1L12 3.4Z"/><path d="m9.2 11.9 2 2 3.7-3.9"/>',
  'attach': '<path d="M18.6 11.4 12 18a4.24 4.24 0 0 1-6-6l6.7-6.7a2.83 2.83 0 0 1 4 4l-6.7 6.7a1.41 1.41 0 0 1-2-2l6.2-6.2"/>',
  'back': '<path d="M20 12H4.5M11 5.5 4.5 12 11 18.5"/>',
  'chevron-left': '<path d="m14.5 6.5-5.5 5.5 5.5 5.5"/>',
  'chevron-right': '<path d="m9.5 6.5 5.5 5.5-5.5 5.5"/>',
  'close': '<path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5"/>',
  'credential': '<circle cx="16.4" cy="7.6" r="3.6"/><path d="M13.8 10.2 5.4 18.6V21h2.6v-2.1H10v-2.1h2.1l1.7-1.7"/>',
  'dag': '<path d="M10.5 4h3a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"/><path d="M4.5 17h3a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-1a1 1 0 0 1 1-1Z"/><path d="M16.5 17h3a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-1a1 1 0 0 1 1-1Z"/><path d="M12 8v2.5M6 17v-4.5h12V17M6 12.5h12"/>',
  'export': '<path d="M12 3.5v11M7.8 10.3 12 14.5l4.2-4.2"/><path d="M4 16.5v2A2 2 0 0 0 6 20.5h12a2 2 0 0 0 2-2v-2"/>',
  'filter': '<path d="M3.5 5.5h17l-6.4 7.4v5.6l-4.2 2.1v-7.7L3.5 5.5Z"/>',
  'graph': '<circle cx="12" cy="12" r="2.6"/><circle cx="12" cy="4.4" r="1.8"/><circle cx="5.2" cy="17.6" r="1.8"/><circle cx="18.8" cy="17.6" r="1.8"/><path d="M12 6.2v3.2M10.2 13.6 6.6 16.4M13.8 13.6l3.6 2.8M7 17.6h10"/>',
  'maximize': '<rect x="5.5" y="5.5" width="13" height="13" rx="1.5"/>',
  'minimize': '<path d="M5.5 12h13"/>',
  'model': '<rect x="7" y="7" width="10" height="10" rx="2"/><rect x="10.6" y="10.6" width="2.8" height="2.8" rx="0.8"/><path d="M9.8 7V3.8M14.2 7V3.8M9.8 20.2V17M14.2 20.2V17M7 9.8H3.8M7 14.2H3.8M20.2 9.8H17M20.2 14.2H17"/>',
  'new-chat': '<path d="M20 14.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8Z"/><path d="M12 8v5M9.5 10.5h5"/><path d="M8 16.5v3.6L11.8 16.5"/>',
  'refresh': '<path d="M20.5 12a8.5 8.5 0 1 1-8.5-8.5c2.38 0 4.66.95 6.37 2.59L20.5 8.2"/><path d="M20.5 3.5v4.7h-4.7"/>',
  'replay': '<path d="M20.5 12a8.5 8.5 0 1 1-8.5-8.5c2.38 0 4.66.95 6.37 2.59L20.5 8.2"/><path d="M20.5 3.5v4.7h-4.7"/><path d="m10.6 8.6 5 3.4-5 3.4Z"/>',
  'search': '<circle cx="10.8" cy="10.8" r="6.3"/><path d="m15.5 15.5 4.5 4.5"/>',
  'send': '<path d="M20.6 3.4 3.4 10.5l7.1 2.9 2.9 7.2 7.2-17.2Z"/><path d="m10.5 13.4 10.1-10"/>',
  'session': '<path d="M20 14.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8Z"/><path d="M8 16.5v3.6L11.8 16.5"/>',
  'settings': '<path d="M3.5 7.5h4.2M12.3 7.5h8.2M3.5 16.5h7.2M15.3 16.5h5.2"/><circle cx="10" cy="7.5" r="2"/><circle cx="13" cy="16.5" r="2"/>',
  'stop': '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  'theme-dark': '<path d="M20.5 14.7A8.5 8.5 0 0 1 9.3 3.5a8.5 8.5 0 1 0 11.2 11.2Z"/>',
  'theme-light': '<circle cx="12" cy="12" r="4"/><path d="M12 2.8v2.7M12 18.5v2.7M2.8 12h2.7M18.5 12h2.7"/><path d="m7.4 7.4-1.9-1.9M16.6 16.6l1.9 1.9M16.6 7.4l1.9-1.9M7.4 16.6l-1.9 1.9"/>',
  'theme-system': '<rect x="3.2" y="4.2" width="17.6" height="12.2" rx="2"/><path d="M8.6 20.4h6.8M12 16.4v4"/>',
  'timeline': '<path d="M3.5 4v16"/><path d="M7 8h8M7 12h11M7 16h5.5"/>',
  'workspace': '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.2a2 2 0 0 1 1.5.7l1 1.2h7.3a2 2 0 0 1 2 2v7.4a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.5Z"/>',
}
