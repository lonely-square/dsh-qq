import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendConversationMessage,
  conversationDatabaseAvailable,
  searchConversation,
  searchConversationWindows,
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

sqliteTest('默认命中点可扩大，每个命中点带前后原话', async () => {
  const dir = tmp()
  const lines = ['开场', '甲之前', '回答甲', '中间一', '中间二', '乙之前', '回答乙', '收尾']
  for (let index = 0; index < lines.length; index += 1) {
    await appendConversationMessage(dir, {
      who: index % 2 ? '用户(1)' : '鲸鲸(2)',
      text: lines[index],
      role: index % 2 ? 'user' : 'agent',
      time: new Date(2026, 9, 20, 10, 0, index),
    })
  }

  const one = await searchConversationWindows(dir, { query: '之前', hits: 1, around: 1 })
  assert.equal(one.hits.length, 1)
  assert.equal(one.windows.length, 1)
  assert.equal(one.windows[0].rows.length, 3)
  assert.deepEqual(one.windows[0].rows.map((row) => row.text), ['中间二', '乙之前', '回答乙'])

  const expanded = await searchConversationWindows(dir, { query: '之前', hits: 2, around: 1 })
  assert.equal(expanded.hits.length, 2)
  assert.equal(expanded.windows.length, 2)
  assert.equal(expanded.windows.reduce((n, window) => n + window.rows.length, 0), 6)
})

sqliteTest('邻近命中点的上下文重叠时合并，不重复塞入', async () => {
  const dir = tmp()
  for (const [index, text] of ['前', '橘子甲', '橘子乙', '后'].entries()) {
    await appendConversationMessage(dir, { who: '用户(1)', text, role: 'user', time: new Date(2026, 9, 20, 11, 0, index) })
  }
  const result = await searchConversationWindows(dir, { query: '橘子', hits: 5, around: 1 })
  assert.equal(result.hits.length, 2)
  assert.equal(result.windows.length, 1)
  assert.deepEqual(result.windows[0].rows.map((row) => row.text), ['前', '橘子甲', '橘子乙', '后'])
})
