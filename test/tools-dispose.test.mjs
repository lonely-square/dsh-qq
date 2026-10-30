import assert from 'node:assert/strict'
import test from 'node:test'

import { registerTools } from '../src/tools.js'

test('registerTools 收集并释放每一个工具注册句柄', () => {
  const registered = []
  const disposed = []
  const tools = {
    register(definition) {
      registered.push(definition.name)
      return () => disposed.push(definition.name)
    },
  }
  const logger = { info() {}, warn() {}, debug() {} }
  const dispose = registerTools(
    { get: (name) => (name === 'tools' ? tools : null) },
    {
      client: {},
      manager: {},
      config: {},
      logger,
      pin: {},
      wake: {},
      noteSelfSaid() {},
    },
  )

  assert.ok(registered.length >= 10, '应该注册完整的一组 QQ 工具')
  assert.equal(new Set(registered).size, registered.length, '工具名不应重复')
  dispose()
  assert.deepEqual([...disposed].sort(), [...registered].sort())
})

test('宿主没有 tools 服务时返回可安全调用的空注销函数', () => {
  const dispose = registerTools(
    { get: () => null },
    { config: {}, logger: { info() {} } },
  )
  assert.equal(typeof dispose, 'function')
  assert.doesNotThrow(() => dispose())
})
