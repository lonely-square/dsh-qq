import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { imageFileArg } from '../src/tools.js'

test('宿主本地图片转成 OneBot 容器可读的 base64 参数', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-send-'))
  const file = join(dir, 'face.png')
  writeFileSync(file, Buffer.from([1, 2, 3, 4]))
  assert.equal(imageFileArg(file), 'base64://AQIDBA==')
})

test('URL、相对路径和不存在的绝对路径保持原样', () => {
  assert.equal(imageFileArg('https://example.com/a.png'), 'https://example.com/a.png')
  assert.equal(imageFileArg('face.png'), 'face.png')
  assert.equal(imageFileArg('/not/found.png'), '/not/found.png')
})
