import type { JsonValue, SettingsNamespace } from '@dexagent/shared'

export interface SettingsField {
  readonly path: readonly string[]
  readonly label: string
  readonly kind: 'boolean' | 'number' | 'string' | 'select' | 'readonly'
  readonly value?: JsonValue
  readonly options?: readonly JsonValue[]
}

type RecordValue = Record<string, unknown>

function recordOf(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : null
}

function scalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

/**
 * 解析 schemastery JSON 的引用。
 *
 * 真实 dsh `describe()` 的形状（2026-10-08 实测，与旧单测的假数据不同）：
 * 根是 `{ uid: 10514, refs: { "10514": <节点>, "10513": <节点>, … } }`，
 * **uid 是数字**、子节点以数字 id 引用（`dict: { enabled: 10513 }`）。
 * 旧实现只认字符串 uid 且不处理根包装，于是每个命名空间都被判为「没有可安全生成的字段」。
 * 两种形状（内联对象 / 数字引用 / 字符串引用）这里都要兼容。
 */
function resolveNode(value: unknown, refs: RecordValue): RecordValue | null {
  if (typeof value === 'string') return resolveNode(refs[value], refs)
  if (typeof value === 'number') return resolveNode(refs[String(value)], refs)
  const node = recordOf(value)
  if (node === null) return null
  // 根包装 `{ uid, refs }`：uid 指向 refs 里的真实根节点。
  if (node.uid !== undefined && node.refs !== undefined) {
    return resolveNode(refs[String(node.uid)], refs)
  }
  if (typeof node.uid === 'string' && typeof node.type !== 'string') {
    return resolveNode(refs[node.uid], refs)
  }
  return node
}

function atPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    const record = recordOf(current)
    if (record !== null) {
      current = record[segment]
      continue
    }
    if (Array.isArray(current)) {
      const index = Number(segment)
      current = Number.isInteger(index) ? current[index] : undefined
      continue
    }
    return undefined
  }
  return current
}

function isSecretPath(path: readonly string[], secrets: SettingsNamespace['secrets']): boolean {
  return secrets.some(
    ({ path: secret }) =>
      path.length >= secret.length && secret.every((segment, index) => path[index] === segment),
  )
}

function unionOptions(node: RecordValue): JsonValue[] | null {
  if (node.type === 'enum' && Array.isArray(node.list) && node.list.every(scalar)) {
    return node.list as JsonValue[]
  }
  if (node.type !== 'union' || !Array.isArray(node.list)) return null
  const values = node.list.flatMap((entry): JsonValue[] => {
    const option = recordOf(entry)
    return option?.type === 'const' && scalar(option.value) ? [option.value] : []
  })
  return values.length === node.list.length && values.length > 0 ? values : null
}

/**
 * 可编辑性判据（2026-10-08 修正）。
 *
 * dsh `settings.describe()` 返回的 schema 是 `volatileForm` 的**投影**：只含 volatile
 * 字段，且 `plainSchema` 已把 `meta.volatile` 标记删掉（`settings/schema.ts:19-31`）。
 * 因此「出现在描述里的字段」= 「可即时写入的字段」，不需要也不应该再读 volatile 标记。
 *
 * 旧实现按 `meta.volatile === true` 判定，导致「高级」页（和复用它的插件配置区）
 * 把所有字段都渲染成只读——dsh 侧 mutate 本就只接受 volatile 路径，描述层已经保证了
 * 这一点。这是被既有验收（只断言分区存在）漏掉的静默退化。
 */
export function settingsFields(namespace: SettingsNamespace): SettingsField[] {
  const root = recordOf(namespace.schema)
  const refs = recordOf(root?.refs) ?? {}
  const rootNode = resolveNode(namespace.schema, refs)
  if (rootNode === null) return []

  const fields: SettingsField[] = []
  const visit = (rawNode: unknown, path: readonly string[]): void => {
    const node = resolveNode(rawNode, refs)
    if (node === null || isSecretPath(path, namespace.secrets)) return

    const dict = recordOf(node.dict)
    if (dict !== null) {
      for (const [key, child] of Object.entries(dict)) visit(child, [...path, key])
      return
    }

    const current = atPath(namespace.value, path)
    const value = scalar(current) ? current : scalar(node.default) ? node.default : undefined
    const label = path.join(' · ')
    const options = unionOptions(node)
    if (options !== null && (value === undefined || options.includes(value))) {
      fields.push({
        path,
        label,
        kind: 'select',
        ...(value === undefined ? {} : { value }),
        options,
      })
      return
    }
    if (node.type === 'boolean' && typeof value === 'boolean') {
      fields.push({ path, label, kind: 'boolean', value })
      return
    }
    if (node.type === 'number' && typeof value === 'number') {
      fields.push({ path, label, kind: 'number', value })
      return
    }
    if (node.type === 'string' && (value === undefined || typeof value === 'string')) {
      fields.push({ path, label, kind: 'string', ...(value === undefined ? {} : { value }) })
      return
    }
    if (value !== undefined) fields.push({ path, label, kind: 'readonly', value })
  }

  visit(rootNode, [])
  return fields
}
