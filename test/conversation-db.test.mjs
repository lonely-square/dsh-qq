import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendConversationMessage,
  conversationDatabaseAvailable,
  searchConversation,
  CONVERSATION_DB,
} from '../src/conversation-db.js'

const available = await conversationDatabaseAvailable()
const sqliteTest = available ? test : test.skip

function tmp() {
  return mkdtempSync(join(tmpdir(), 'conversation-db-'))
}

sqliteTest('同一对象的原话写入独立 SQLite 并可按关键词查询', async () => {
  const dir = tmp()
  await appendConversationMessage(dir, {
    who: '姐姐(1)', senderId: '1', senderName: '姐姐', text: '周末去看海',
    role: 'user', msgId: -12, time: new Date('2026-10-20T10:00:00'),
  })
  await appendConversationMessage(dir, {
    who: '鲸鲸(2)', senderId: '2', senderName: '鲸鲸', text: '好呀，记得带伞',
    role: 'agent', time: new Date('2026-10-20T10:01:00'),
  })

  const rows = await searchConversation(dir, { query: '看海', limit: 10 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].text, '周末去看海')
  assert.equal(rows[0].messageId, '-12')
  assert.ok((await import('node:fs')).existsSync(join(dir, CONVERSATION_DB)))
  const all = await searchConversation(dir)
  assert.deepEqual(new Set(all.map((row) => row.role)), new Set(['user', 'agent']))
})

sqliteTest('不同会话目录互不串库', async () => {
  const a = tmp()
  const b = tmp()
  await appendConversationMessage(a, { who: 'a', text: '只在A', role: 'user' })
  await appendConversationMessage(b, { who: 'b', text: '只在B', role: 'user' })
  assert.equal((await searchConversation(a, { query: '只在B' })).length, 0)
  assert.equal((await searchConversation(b, { query: '只在B' })).length, 1)
})

sqliteTest('首次建库会导入旧 Markdown，未开通流水不进正常检索', async () => {
  const dir = tmp()
  const logs = join(dir, '聊天记录')
  const denied = join(logs, '_未开通')
  mkdirSync(denied, { recursive: true })
  writeFileSync(join(logs, '2026-10-26.md'), [
    '- 21:05:09 · 姐姐(1)：以前说过的橘子 #msg=123',
    '- 21:05:10 · 鲸鲸(2)：我记得这个橘子',
    '',
  ].join('\n'))
  writeFileSync(join(denied, '2026-10-26.md'), '- 22:00:00 · 路人(9)：不应该被查到\n')

  const rows = await searchConversation(dir, { query: '橘子', selfId: '2' })
  assert.equal(rows.length, 2)
  assert.equal(rows.find((row) => row.senderId === '1').role, 'user')
  assert.equal(rows.find((row) => row.senderId === '2').role, 'agent')
  assert.equal((await searchConversation(dir, { query: '不应该', selfId: '2' })).length, 0)
})

sqliteTest('同一 OneBot message_id 重放不重复入库', async () => {
  const dir = tmp()
  const entry = { who: '姐姐(1)', text: '只记一次', role: 'user', msgId: 88 }
  await appendConversationMessage(dir, entry)
  await appendConversationMessage(dir, entry)
  assert.equal((await searchConversation(dir, { query: '只记一次' })).length, 1)
})
