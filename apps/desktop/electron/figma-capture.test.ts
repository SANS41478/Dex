import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CAPTURE_ORIGIN, injectFigmaCapture } from './figma-capture'

const indexPath = fileURLToPath(new URL('../src/renderer/index.html', import.meta.url))
const sourceHtml = readFileSync(indexPath, 'utf8')

describe('figma capture injection', () => {
  it('源 index.html 不含 mcp.figma.com（生产安全边界）', () => {
    expect(sourceHtml).not.toContain(CAPTURE_ORIGIN)
    expect(sourceHtml).not.toContain('capture.js')
  })

  it('注入后：脚本与 CSP 放行均存在，且原 CSP 条目保留', () => {
    const html = injectFigmaCapture(sourceHtml)

    expect(html).toContain(`${CAPTURE_ORIGIN}/mcp/html-to-design/capture.js`)
    expect(html).toContain(`script-src 'self' 'unsafe-inline' ${CAPTURE_ORIGIN};`)
    expect(html).toContain(`connect-src 'self' ws://127.0.0.1:* ws://localhost:* ${CAPTURE_ORIGIN}`)
    expect(html).toContain("default-src 'self'")
    expect(html.endsWith('</html>\n') || html.endsWith('</html>')).toBe(true)
  })

  it('CSP 或 body 锚点缺失时抛出可读错误（防静默失效）', () => {
    expect(() => injectFigmaCapture('<html><head></head><body></body></html>')).toThrow(
      /CSP 锚点缺失/,
    )
    expect(() =>
      injectFigmaCapture(
        "<meta content=\"script-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*\">",
      ),
    ).toThrow(/<\/body> 锚点/)
  })
})
