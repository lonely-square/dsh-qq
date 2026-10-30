import assert from 'node:assert/strict'
import test from 'node:test'

import { registerTools } from '../src/tools.js'

const quiet = { info() {}, warn() {}, debug() {}, error() {} }

function boot(record, calls) {
  const definitions = new Map()
  registerTools(
    {
      get: (name) =>
        name === 'tools'
          ? { register: (definition) => definitions.set(definition.name, definition) }
          : undefined,
    },
    {
      client: {
        async call(action, params) {
          calls.push({ action, params })
          return { message: [] }
        },
      },
      manager: { find: () => record },
      config: {},
      logger: quiet,
      pin: {},
      wake: {},
      noteSelfSaid() {},
    },
  )
  return definitions
}

test('qq_images 接受 SnowLuma 负数消息 ID，并优先回捞最近的图片消息', async () => {
  const calls = []
  const record = { lastMessageId: 337028105, lastImageMessageId: -896643540 }
  const tool = boot(record, calls).get('qq_images')
  const result = await tool.execute({}, { agent: { session: { id: 'session-1' } } })

  assert.equal(result.messageId, -896643540)
  assert.deepEqual(calls[0], {
    action: 'get_msg',
    params: { message_id: -896643540 },
  })
})
