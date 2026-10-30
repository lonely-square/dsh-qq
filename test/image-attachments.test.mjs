import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createInboundMessage,
  createPendingImageBuffer,
  detectImageMediaType,
  saveImageAttachments,
} from '../src/inbound.js'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

test('按图片字节识别类型，不依赖 QQ/CDN 给的扩展名', () => {
  assert.equal(detectImageMediaType(PNG_1X1), 'image/png')
  assert.equal(detectImageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg')
  assert.equal(detectImageMediaType(Buffer.from('GIF89a', 'ascii')), 'image/gif')
  assert.equal(detectImageMediaType(Buffer.from('RIFF0000WEBP', 'ascii')), 'image/webp')
  assert.equal(detectImageMediaType(Buffer.from('not-an-image')), null)
})

test('下载后的图片写入 DSH 附件服务，并随同一条用户消息交给模型', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-image-'))
  const path = join(dir, 'qq-wrong-extension.jpg')
  await writeFile(path, PNG_1X1)

  let saved = null
  const ref = {
    attachmentId: 'sha256:test',
    mediaType: 'image/png',
    bytes: PNG_1X1.length,
    width: 1,
    height: 1,
    name: 'qq-wrong-extension.jpg',
  }
  const attachments = {
    async saveImages(inputs) {
      saved = inputs
      return [ref]
    },
  }

  const refs = await saveImageAttachments([path], attachments)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].mediaType, 'image/png')
  assert.deepEqual(refs, [ref])

  const message = createInboundMessage('看看这张图', refs)
  assert.equal(message.role, 'user')
  assert.equal(message.content[0].type, 'text')
  assert.equal(message.content[1].type, 'image')
  assert.deepEqual(message.content[1].attachment, ref)
})

test('附件服务不可用时安全降级，不让图片拖垮文字消息', async () => {
  const warnings = []
  const refs = await saveImageAttachments(['/not/found.png'], {
    async saveImages() {
      throw new Error('不应走到这里')
    },
  }, { warn: (line) => warnings.push(line) })
  assert.deepEqual(refs, [])
  assert.equal(warnings.length, 1)
})

test('群里先发表情再单独 @：同一发送者的图片会留给下一轮', () => {
  let time = 1000
  const pending = createPendingImageBuffer({ now: () => time })
  pending.remember({
    peerId: '100',
    senderId: '200',
    messageId: -896643540,
    urls: ['https://example.test/sticker.png'],
  })

  assert.deepEqual(pending.take({ peerId: '100', senderId: '200' }), {
    urls: ['https://example.test/sticker.png'],
    messageId: -896643540,
    at: 1000,
  })
  assert.deepEqual(pending.take({ peerId: '100', senderId: '200' }).urls, [])
})

test('待看图片按群和发送者隔离，并会过期', () => {
  let time = 1000
  const pending = createPendingImageBuffer({ ttlMs: 5000, now: () => time })
  pending.remember({ peerId: '100', senderId: '200', messageId: 1, urls: ['https://example.test/a.png'] })
  assert.deepEqual(pending.take({ peerId: '100', senderId: '201' }).urls, [])

  time = 7001
  assert.deepEqual(pending.take({ peerId: '100', senderId: '200' }).urls, [])
})
