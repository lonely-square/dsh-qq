/**
 * 同一宿主热重载时，Cordis 偶尔会让新旧插件上下文短暂重叠。
 * OneBot 连接一重叠，同一条 QQ 消息就会被处理两三次；模块级 Map 又扛不住
 * 重新 import，所以把租约表挂到 globalThis 的全局 Symbol 上。
 */
const REGISTRY_KEY = Symbol.for('dsh-qq.runtime-leases.v1')

function registry() {
  if (!(globalThis[REGISTRY_KEY] instanceof Map)) globalThis[REGISTRY_KEY] = new Map()
  return globalThis[REGISTRY_KEY]
}

/**
 * 取得一个运行实例租约。同一个 key 的新实例会先释放旧实例。
 * 返回的 release 具备所有权检查：旧上下文迟到的 dispose 不会误删新租约。
 */
export function acquireRuntimeLease(key, dispose, logger) {
  const leases = registry()
  const normalized = String(key ?? '').trim() || 'default'
  const previous = leases.get(normalized)
  const lease = { dispose }

  if (previous && previous !== lease) {
    logger?.warn?.(`[dsh-qq] 检测到同一 OneBot 连接的旧实例，先释放旧实例再接管：${normalized}`)
    try {
      previous.dispose?.('replaced')
    } catch (err) {
      logger?.warn?.(`[dsh-qq] 释放旧实例失败：${err?.message ?? err}`)
    }
  }

  leases.set(normalized, lease)
  return () => {
    if (leases.get(normalized) === lease) leases.delete(normalized)
  }
}
