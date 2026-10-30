import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendConversationMessage, conversationDatabaseAvailable } from '../src/conversation-db.js'
import { registerTools } from '../src/tools.js'

const available = await conversationDatabaseAvailable()
const sqliteTest = available ? test : test.skip

sqliteTest('qq_history 开头声明历史未必是最新状态，并包住历史片段', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'history-tool-'))
  await appendConversationMessage(dir, {
    who: '姐姐(1)', senderId: '1', text: '我最近在学游泳', role: 'user',
  })

  const definitions = new Map()
  const record = { sessionId: 's1', scope: 'private', peerId: '1', dir }
  registerTools(
    { get: (name) => name === 'tools' ? { register: (definition) => definitions.set(definition.name, definition) } : null },
    {
      client: {},
      manager: { selfId: '2', find: () => record },
      config: {},
      logger: { info() {}, warn() {}, debug() {} },
      pin: {},
      wake: {},
      noteSelfSaid() {},
    },
  )

  const result = await definitions.get('qq_history').execute(
    { query: '游泳' },
    { agent: { session: { id: 's1' } } },
  )
  assert.equal(result.ok, true)
  assert.ok(result.text.startsWith('历史相关对话记录不一定是最新状态，请以实际为准。'))
  assert.ok(result.text.includes('「历史对话开始」'))
  assert.ok(result.text.includes('「历史对话结束」'))
})
