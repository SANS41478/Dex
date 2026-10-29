import { describe, expect, it } from 'vitest'
import {
  createSdkRequest,
  encodeSdkFrame,
  isMethodNotFound,
  parseSdkFrame,
  parseSessionStatusNotification,
  SDK_METHOD_NOT_FOUND,
  type SdkNotification,
} from './sdk'

describe('parseSdkFrame', () => {
  it('识别请求 / 响应 / 通知三类帧', () => {
    expect(parseSdkFrame('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')?.kind).toBe(
      'request',
    )
    expect(parseSdkFrame('{"jsonrpc":"2.0","id":1,"result":{}}')?.kind).toBe('response')
    expect(parseSdkFrame('{"jsonrpc":"2.0","method":"session.status","params":{}}')?.kind).toBe(
      'notification',
    )
  })

  it('忽略空行、非法 JSON 与非 2.0 帧', () => {
    expect(parseSdkFrame('')).toBeNull()
    expect(parseSdkFrame('   ')).toBeNull()
    expect(parseSdkFrame('not json')).toBeNull()
    expect(parseSdkFrame('{"jsonrpc":"1.0","id":1,"method":"x"}')).toBeNull()
    expect(parseSdkFrame('{"jsonrpc":"2.0"}')).toBeNull()
    expect(parseSdkFrame('{"id":1,"method":"x"}')).toBeNull()
  })

  it('响应可携带 error 且 id 支持字符串', () => {
    const frame = parseSdkFrame(
      `{"jsonrpc":"2.0","id":"abc","error":{"code":${SDK_METHOD_NOT_FOUND},"message":"not found"}}`,
    )
    if (frame?.kind !== 'response') throw new Error('expected response frame')
    expect(isMethodNotFound(frame.frame)).toBe(true)
    expect(frame.frame.error?.message).toBe('not found')
  })

  it('请求带 params 与不带 params 都可解析', () => {
    const withParams = parseSdkFrame('{"jsonrpc":"2.0","id":1,"method":"m","params":{"a":1}}')
    if (withParams?.kind !== 'request') throw new Error('expected request frame')
    expect(withParams.frame.params).toEqual({ a: 1 })

    const withoutParams = parseSdkFrame('{"jsonrpc":"2.0","id":1,"method":"shutdown"}')
    if (withoutParams?.kind !== 'request') throw new Error('expected request frame')
    expect(withoutParams.frame.params).toBeUndefined()
  })

  it('编码 → 解析往返一致（含换行结尾）', () => {
    const line = encodeSdkFrame(createSdkRequest(7, 'dex/ping'))
    expect(line.endsWith('\n')).toBe(true)
    const frame = parseSdkFrame(line)
    if (frame?.kind !== 'request') throw new Error('expected request frame')
    expect(frame.frame).toEqual({ jsonrpc: '2.0', id: 7, method: 'dex/ping' })
  })
})

describe('createSdkRequest', () => {
  it('exactOptionalPropertyTypes 下不产生空 params 字段', () => {
    expect('params' in createSdkRequest(1, 'shutdown')).toBe(false)
    expect(createSdkRequest(1, 'm', null).params).toBeNull()
  })
})

describe('parseSessionStatusNotification', () => {
  const notification = (params: unknown, method = 'session.status'): SdkNotification => ({
    jsonrpc: '2.0',
    method,
    params,
  })

  it('解析 idle / running 两态', () => {
    expect(
      parseSessionStatusNotification(notification({ sessionId: 's1', status: 'running' })),
    ).toEqual({ sessionId: 's1', status: 'running' })
    expect(
      parseSessionStatusNotification(notification({ sessionId: 's1', status: 'idle' })),
    ).toEqual({
      sessionId: 's1',
      status: 'idle',
    })
  })

  it('形状不符一律返回 null（不抛异常，未知通知忽略）', () => {
    // 别的通知方法
    expect(
      parseSessionStatusNotification(notification({ sessionId: 's1' }, 'session.event')),
    ).toBeNull()
    // 取值域外
    expect(
      parseSessionStatusNotification(notification({ sessionId: 's1', status: 'busy' })),
    ).toBeNull()
    // 缺字段 / params 非对象
    expect(parseSessionStatusNotification(notification({ status: 'idle' }))).toBeNull()
    expect(parseSessionStatusNotification(notification('idle'))).toBeNull()
    expect(parseSessionStatusNotification({ jsonrpc: '2.0', method: 'session.status' })).toBeNull()
  })

  it('容忍 params 上的额外字段（宿主新增字段不破坏解析）', () => {
    expect(
      parseSessionStatusNotification(
        notification({ sessionId: 's1', status: 'idle', agentId: 'a1' }),
      ),
    ).toEqual({ sessionId: 's1', status: 'idle' })
  })
})
