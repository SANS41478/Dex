import { createServer, type Server } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import { probePortFree } from './port-guard'

const blockers: Server[] = []

afterAll(() => {
  for (const server of blockers) server.close()
})

function listenOn(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      blockers.push(server)
      resolve(server)
    })
  })
}

describe('probePortFree', () => {
  it('空闲端口返回 free', async () => {
    // 端口 0 让内核分配一个必然空闲的端口。
    const scratch = await listenOn(0)
    const freePort = (scratch.address() as { port: number }).port
    scratch.close()
    await new Promise<void>((resolve) => scratch.once('close', resolve))
    const result = await probePortFree({ port: freePort })
    expect(result.free).toBe(true)
  })

  it('被占用端口报 EADDRINUSE', async () => {
    const scratch = await listenOn(0)
    const busyPort = (scratch.address() as { port: number }).port
    // scratch 保持监听，作为占用者。
    const result = await probePortFree({ port: busyPort })
    expect(result.free).toBe(false)
    expect(result.code).toBe('EADDRINUSE')
    expect(result.message).toContain(String(busyPort))
  })
})
