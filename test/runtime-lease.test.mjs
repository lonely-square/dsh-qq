import assert from 'node:assert/strict'
import test from 'node:test'

import { acquireRuntimeLease } from '../src/runtime-lease.js'

test('同一 NapCat 地址的新实例会先释放旧实例', () => {
  const disposed = []
  const releaseFirst = acquireRuntimeLease('test:same-endpoint', (reason) => disposed.push(`first:${reason}`))
  const releaseSecond = acquireRuntimeLease('test:same-endpoint', (reason) => disposed.push(`second:${reason}`))

  assert.deepEqual(disposed, ['first:replaced'])

  // 旧上下文迟到的 dispose/release 不能把第二个实例的租约删掉。
  releaseFirst()
  const releaseThird = acquireRuntimeLease('test:same-endpoint', (reason) => disposed.push(`third:${reason}`))
  assert.deepEqual(disposed, ['first:replaced', 'second:replaced'])

  releaseSecond()
  releaseThird()
})

test('不同 NapCat 地址互不干扰，主动 release 后也不会被重复释放', () => {
  const disposed = []
  const releaseA = acquireRuntimeLease('test:endpoint-a', () => disposed.push('a'))
  const releaseB = acquireRuntimeLease('test:endpoint-b', () => disposed.push('b'))
  assert.deepEqual(disposed, [])
  releaseA()
  releaseB()

  const releaseA2 = acquireRuntimeLease('test:endpoint-a', () => disposed.push('a2'))
  assert.deepEqual(disposed, [])
  releaseA2()
})
