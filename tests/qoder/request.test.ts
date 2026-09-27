import test from 'node:test'
import assert from 'node:assert/strict'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import { readLimitedText } from '../../src/qoder/transport/request.ts'
import { QoderLlmError } from '../../src/qoder/errors.ts'

const JSON_BODY = JSON.stringify({ ok: true, models: ['a', 'b'] })

/** Wrap raw bytes in a Response whose body streams them. */
function responseOf(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(bytes, { headers })
}

test('readLimitedText passes a plain body through unchanged', async () => {
  const text = await readLimitedText(responseOf(new TextEncoder().encode(JSON_BODY)), 1024, 'label')
  assert.equal(text, JSON_BODY)
})

test('readLimitedText decompresses a gzip body declared by content-encoding', async () => {
  const gzipped = gzipSync(JSON_BODY)
  const text = await readLimitedText(
    responseOf(gzipped, { 'content-encoding': 'gzip' }),
    1024,
    'label',
  )
  assert.equal(text, JSON_BODY)
})

test('readLimitedText decompresses a gzip body when the header is missing too', async () => {
  // The Electron desktop host reports neither content-type nor
  // content-encoding for a compressed response; only the magic number is left.
  const gzipped = gzipSync(JSON_BODY)
  const text = await readLimitedText(responseOf(gzipped), 1024, 'label')
  assert.equal(text, JSON_BODY)
})

test('readLimitedText decompresses brotli and deflate bodies', async () => {
  const brotlied = brotliCompressSync(JSON_BODY)
  assert.equal(
    await readLimitedText(responseOf(brotlied, { 'content-encoding': 'br' }), 1024, 'label'),
    JSON_BODY,
  )
  const deflated = deflateSync(JSON_BODY)
  assert.equal(
    await readLimitedText(responseOf(deflated, { 'content-encoding': 'deflate' }), 1024, 'label'),
    JSON_BODY,
  )
})

test('readLimitedText rejects gzip magic bytes that are not valid gzip', async () => {
  await assert.rejects(
    () => readLimitedText(responseOf(new Uint8Array([0x1f, 0x8b, 0x00, 0x01])), 1024, 'label'),
    (error: Error) => {
      assert.ok(error instanceof QoderLlmError)
      assert.equal((error as QoderLlmError).code, 'MALFORMED_RESPONSE')
      return true
    },
  )
})

test('readLimitedText still enforces the byte limit before and after decompression', async () => {
  const gzipped = gzipSync('x'.repeat(4096))
  await assert.rejects(
    () => readLimitedText(responseOf(gzipped, { 'content-encoding': 'gzip' }), 1024, 'label'),
    (error: Error) => {
      assert.ok(error instanceof QoderLlmError)
      assert.equal((error as QoderLlmError).code, 'MALFORMED_RESPONSE')
      return true
    },
  )
})

test('readLimitedText returns an empty string when the response has no body', async () => {
  assert.equal(await readLimitedText(new Response(null), 1024, 'label'), '')
})
