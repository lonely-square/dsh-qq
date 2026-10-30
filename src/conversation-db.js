import {
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'

export const CONVERSATION_DB = '对话历史.sqlite3'

let sqlitePromise = null
const queues = new Map()

async function sqlite() {
  if (!sqlitePromise) sqlitePromise = import('node:sqlite').catch(() => null)
  return sqlitePromise
}

/** Node 22+ 内置 SQLite；旧 Node 上让 Markdown 流水继续工作。 */
export async function conversationDatabaseAvailable() {
  const mod = await sqlite()
  return Boolean(mod?.DatabaseSync)
}

function serial(dir, task) {
  const key = String(dir)
  const previous = queues.get(key) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(task)
  queues.set(key, current)
  return current.finally(() => {
    if (queues.get(key) === current) queues.delete(key)
  })
}

function init(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'agent')),
      sender_id TEXT NOT NULL DEFAULT '',
      sender_name TEXT NOT NULL DEFAULT '',
      who TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      message_id TEXT NOT NULL DEFAULT '',
      authorized INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'live',
      source_key TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS messages_time_idx ON messages(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS messages_sender_idx ON messages(sender_id, occurred_at DESC);
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
}

function parseMarkdownLine(day, line) {
  const match = /^-\s+(\d{2}:\d{2}:\d{2})\s+·\s+(.*?)：(.*?)(?:\s+#msg=(-?\d+))?$/.exec(line)
  if (!match) return null
  const time = new Date(`${day}T${match[1]}`)
  if (Number.isNaN(time.getTime())) return null
  const who = match[2].trim()
  const sender = /^(.*)\((\d+)\)$/.exec(who)
  return {
    occurredAt: time.getTime(),
    who,
    senderName: sender?.[1]?.trim() ?? who,
    senderId: sender?.[2] ?? '',
    text: match[3].replace(/\s+⏎\s+/g, '\n').trim(),
    messageId: match[4] ?? '',
  }
}

/** 首次建库时把旧 Markdown 原话导入；只导一次，不做模型总结。 */
function importMarkdownOnce(db, dir, selfId = '') {
  const imported = db.prepare("SELECT value FROM metadata WHERE key = 'markdown_import_v1'").get()
  if (imported) return 0

  const root = join(dir, '聊天记录')
  const files = []
  const collect = (folder, authorized) => {
    if (!existsSync(folder)) return
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) collect(path, entry.name === '_未开通' ? 0 : authorized)
      else if (entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name)) files.push({ path, authorized })
    }
  }
  collect(root, 1)

  const insert = db.prepare(`
    INSERT OR IGNORE INTO messages
      (occurred_at, role, sender_id, sender_name, who, text, message_id, authorized, source, source_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'markdown', ?)
  `)
  let count = 0
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
      const day = file.path.slice(-13, -3)
      const rel = relative(dir, file.path)
      const lines = readFileSync(file.path, 'utf8').split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        const parsed = parseMarkdownLine(day, lines[index])
        if (!parsed?.text) continue
        const result = insert.run(
          parsed.occurredAt,
          selfId && parsed.senderId === String(selfId) ? 'agent' : 'user',
          parsed.senderId,
          parsed.senderName,
          parsed.who,
          parsed.text,
          parsed.messageId,
          file.authorized,
          `markdown:${rel}:${index + 1}`,
        )
        count += Number(result.changes) || 0
      }
    }
    db.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('markdown_import_v1', ?)").run(
      new Date().toISOString(),
    )
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return count
}

async function open(dir, { selfId = '' } = {}) {
  const mod = await sqlite()
  if (!mod?.DatabaseSync) throw new Error('当前 Node 不支持 node:sqlite（需要 Node 22+）')
  const db = new mod.DatabaseSync(join(dir, CONVERSATION_DB))
  try {
    init(db)
    importMarkdownOnce(db, dir, selfId)
    return db
  } catch (err) {
    db.close()
    throw err
  }
}

/** 往当前群/私聊的独立 SQLite 库追加一条原话。 */
export async function appendConversationMessage(dir, entry = {}, logger) {
  if (!dir) return false
  const text = String(entry.text ?? '').replace(/\r/g, '').trim()
  if (!text) return false

  // Node 20 没有内置 SQLite：安静退回原有 Markdown，不让每条消息刷一行错。
  if (!(await conversationDatabaseAvailable())) return false

  return serial(dir, async () => {
    let db
    try {
      db = await open(dir, { selfId: entry.selfId })
      const time = entry.time instanceof Date ? entry.time : new Date()
      const messageId = String(entry.msgId ?? '').trim()
      const role = entry.role === 'agent' ? 'agent' : 'user'
      const sourceKey = /^-?\d+$/.test(messageId) && messageId !== '0'
        ? `onebot:${role}:${messageId}`
        : null
      db.prepare(`
        INSERT OR IGNORE INTO messages
          (occurred_at, role, sender_id, sender_name, who, text, message_id, authorized, source, source_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'live', ?)
      `).run(
        time.getTime(),
        role,
        String(entry.senderId ?? ''),
        String(entry.senderName ?? ''),
        String(entry.who ?? '').trim(),
        text,
        messageId,
        entry.authorized === false ? 0 : 1,
        sourceKey,
      )
      return true
    } catch (err) {
      logger?.debug?.(`[dsh-qq] 对话数据库写入失败：${err?.message ?? err}`)
      return false
    } finally {
      db?.close()
    }
  })
}

function boundary(value, endOfDay = false) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`)
    : new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date.getTime()
}

/** 查当前对象的原始历史；query 为空时返回最近消息。 */
const SELECT_MESSAGE = `
  SELECT id, occurred_at AS occurredAt, role, sender_id AS senderId,
         sender_name AS senderName, who, text, message_id AS messageId
  FROM messages
`

function filters({ query = '', before = '', after = '' } = {}) {
  const clauses = ['authorized = 1']
  const params = []
  const words = String(query).trim().split(/\s+/).filter(Boolean).slice(0, 8)
  for (const word of words) {
    clauses.push('(text LIKE ? ESCAPE \'\\\' OR who LIKE ? ESCAPE \'\\\')')
    const escaped = word.replace(/[\\%_]/g, '\\$&')
    params.push(`%${escaped}%`, `%${escaped}%`)
  }
  const beforeMs = boundary(before, true)
  const afterMs = boundary(after, false)
  if (beforeMs !== null) {
    clauses.push('occurred_at <= ?')
    params.push(beforeMs)
  }
  if (afterMs !== null) {
    clauses.push('occurred_at >= ?')
    params.push(afterMs)
  }
  return { clauses, params }
}

function queryRows(db, options = {}) {
  const { clauses, params } = filters(options)
  const take = Math.min(Math.max(1, Number(options.limit) || 30), 100)
  return db.prepare(`
    ${SELECT_MESSAGE}
    WHERE ${clauses.join(' AND ')}
    ORDER BY occurred_at DESC, id DESC
    LIMIT ?
  `).all(...params, take)
}

export async function searchConversation(dir, options = {}) {
  if (!dir) throw new Error('当前会话没有独立目录')
  return serial(dir, async () => {
    const db = await open(dir, { selfId: options.selfId })
    try {
      return queryRows(db, options)
    } finally {
      db.close()
    }
  })
}

function rowsAround(db, hit, around) {
  const before = db.prepare(`
    ${SELECT_MESSAGE}
    WHERE authorized = 1
      AND (occurred_at < ? OR (occurred_at = ? AND id <= ?))
    ORDER BY occurred_at DESC, id DESC
    LIMIT ?
  `).all(hit.occurredAt, hit.occurredAt, hit.id, around + 1).reverse()
  const after = db.prepare(`
    ${SELECT_MESSAGE}
    WHERE authorized = 1
      AND (occurred_at > ? OR (occurred_at = ? AND id > ?))
    ORDER BY occurred_at ASC, id ASC
    LIMIT ?
  `).all(hit.occurredAt, hit.occurredAt, hit.id, around)
  return [...before, ...after]
}

/**
 * 先找命中点，再展开每个命中点前后的原话。
 * 返回的 windows 已合并重叠片段，片段内按旧→新排列。
 */
export async function searchConversationWindows(
  dir,
  { query = '', hits = 5, around = 2, before = '', after = '', selfId = '' } = {},
) {
  if (!dir) throw new Error('当前会话没有独立目录')
  return serial(dir, async () => {
    const db = await open(dir, { selfId })
    try {
      const hitLimit = Math.min(Math.max(1, Number(hits) || 5), 20)
      const radius = Math.min(Math.max(0, Number(around) || 2), 8)
      const cleanQuery = String(query).trim()

      // 没有检索词就是「看最近」：不伪造命中点，只给一个连续尾巴。
      if (!cleanQuery) {
        const recent = queryRows(db, { before, after, limit: Math.min(hitLimit * 2, 40) }).reverse()
        return { hits: [], windows: recent.length ? [{ rows: recent, hitIds: [] }] : [] }
      }

      const found = queryRows(db, { query: cleanQuery, before, after, limit: hitLimit })
      const hitIds = new Set(found.map((row) => Number(row.id)))
      const windows = []

      for (const hit of found) {
        const rows = rowsAround(db, hit, radius)
        const ids = new Set(rows.map((row) => Number(row.id)))
        const overlaps = windows.filter((window) => [...ids].some((id) => window.ids.has(id)))
        if (overlaps.length === 0) {
          windows.push({ ids, rows: new Map(rows.map((row) => [Number(row.id), row])) })
          continue
        }
        const target = overlaps[0]
        for (const row of rows) {
          target.ids.add(Number(row.id))
          target.rows.set(Number(row.id), row)
        }
        for (const extra of overlaps.slice(1)) {
          for (const [id, row] of extra.rows) {
            target.ids.add(id)
            target.rows.set(id, row)
          }
          windows.splice(windows.indexOf(extra), 1)
        }
      }

      return {
        hits: found,
        windows: windows
          .map((window) => ({
            hitIds: [...window.ids].filter((id) => hitIds.has(id)),
            rows: [...window.rows.values()].sort(
              (a, b) => Number(a.occurredAt) - Number(b.occurredAt) || Number(a.id) - Number(b.id),
            ),
          }))
          .sort((a, b) => Number(b.rows.at(-1)?.occurredAt ?? 0) - Number(a.rows.at(-1)?.occurredAt ?? 0)),
      }
    } finally {
      db.close()
    }
  })
}

export function formatConversationRows(rows = []) {
  if (!rows.length) return '（没找到相关对话）'
  return rows.map((row) => {
    const at = new Date(Number(row.occurredAt))
    const stamp = Number.isNaN(at.getTime()) ? '' : at.toLocaleString('zh-CN', { hour12: false })
    const who = String(row.who || row.senderName || (row.role === 'agent' ? '你' : '对方'))
    const msg = row.messageId ? ` #msg=${row.messageId}` : ''
    return `${stamp} · ${who}：${String(row.text).replace(/\n+/g, ' ⏎ ')}${msg}`
  }).join('\n')
}

export function formatConversationWindows(windows = [], { maxChars = 6000 } = {}) {
  if (!windows.length) return '（没找到相关对话）'
  const blocks = windows.map((window, index) => {
    const hitIds = new Set((window.hitIds ?? []).map(Number))
    const lines = (window.rows ?? []).map((row) => {
      const at = new Date(Number(row.occurredAt))
      const stamp = Number.isNaN(at.getTime()) ? '' : at.toLocaleString('zh-CN', { hour12: false })
      const who = String(row.who || row.senderName || (row.role === 'agent' ? '你' : '对方'))
      const mark = hitIds.has(Number(row.id)) ? '★ ' : '  '
      const msg = row.messageId ? ` #msg=${row.messageId}` : ''
      return `${mark}${stamp} · ${who}：${String(row.text).replace(/\n+/g, ' ⏎ ')}${msg}`
    })
    return `[片段 ${index + 1}]\n${lines.join('\n')}`
  })
  const text = blocks.join('\n\n')
  if (text.length <= maxChars) return text
  const clipped = text.slice(0, maxChars).replace(/\n[^\n]*$/, '')
  return `${clipped}\n（结果过长，已截断；可缩小日期或换更准的关键词再查）`
}
