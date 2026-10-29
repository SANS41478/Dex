/**
 * Figma 捕获脚本的注入变换（TOOL-06）。
 *
 * 生产包 MUST NOT 含 `mcp.figma.com` 的任何引用；仅当开发模式且显式
 * `FIGMA_CAPTURE=1` 时，由 electron.vite.config.ts 调用本函数注入
 * 捕获脚本并放宽 CSP。纯函数、无副作用，便于单测锁定安全边界。
 */

export const CAPTURE_ORIGIN = 'https://mcp.figma.com'

const CAPTURE_SCRIPT = `<script src="${CAPTURE_ORIGIN}/mcp/html-to-design/capture.js" async></script>`

const CSP_SCRIPT_BEFORE = "script-src 'self' 'unsafe-inline';"
const CSP_SCRIPT_AFTER = `script-src 'self' 'unsafe-inline' ${CAPTURE_ORIGIN};`

const CSP_CONNECT_BEFORE = "connect-src 'self' ws://127.0.0.1:* ws://localhost:*"
const CSP_CONNECT_AFTER = `${CSP_CONNECT_BEFORE} ${CAPTURE_ORIGIN}`

export function injectFigmaCapture(html: string): string {
  if (!html.includes(CSP_SCRIPT_BEFORE) || !html.includes(CSP_CONNECT_BEFORE)) {
    throw new Error(
      '[figma-capture] index.html 的 CSP 锚点缺失：请同步更新 electron/figma-capture.ts（TOOL-06）',
    )
  }
  if (!html.includes('</body>')) {
    throw new Error('[figma-capture] index.html 缺少 </body> 锚点')
  }

  return html
    .replace(CSP_SCRIPT_BEFORE, CSP_SCRIPT_AFTER)
    .replace(CSP_CONNECT_BEFORE, CSP_CONNECT_AFTER)
    .replace('</body>', `  ${CAPTURE_SCRIPT}\n  </body>`)
}
