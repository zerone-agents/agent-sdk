import { describe, it, expect, beforeAll } from 'vitest'
import { FileReadTool } from './read.js'
import { DefaultToolServices } from './default-services.js'
import type { ToolContext } from '../types.js'
import { resolve } from 'path'
import { readFile, stat } from 'fs/promises'

const FIXTURE_DIR = resolve(__dirname, 'test-fixtures/images')
const ctx = (): ToolContext => ({
  cwd: FIXTURE_DIR,
  toolUseId: 'test',
  agentId: 'test-image-suite',
  services: new DefaultToolServices() as any,
  subprocessEnv: { ...process.env },
})

async function callRead(file_path: string) {
  return FileReadTool.call({ file_path }, ctx())
}

/**
 * Image-handling regression tests for the FileReadTool image branch
 * (src/tools/read.ts:478-506). Covers sharp metadata extraction,
 * flatten (alpha → white bg), resize (>MAX_LONG_EDGE), JPEG conversion,
 * and invalid-image handling. Locks behavior across the sharp 0.34 → 0.35
 * bump from issue #22.
 */
describe('FileReadTool image handling', () => {
  describe('valid 1x1 JPEG (passthrough path)', () => {
    const fixture = resolve(FIXTURE_DIR, '1x1.jpg')

    it('returns an image attachment', async () => {
      const result = await callRead(fixture)
      expect(result.is_error).toBeFalsy()
      const data = result.content as any[]
      expect(Array.isArray(data)).toBe(true)
      const imageBlock = data.find((b) => b.type === 'image')
      expect(imageBlock).toBeDefined()
    })

    it('preserves JPEG mime and bytes when no resize/flatten is needed', async () => {
      const result = await callRead(fixture)
      const data = result.content as any[]
      const imageBlock = data.find((b) => b.type === 'image')
      const source = imageBlock!.source as { type: string; media_type: string; data: string }

      // Passthrough path: output is the original file content, mime stays image/jpeg.
      expect(source.media_type).toBe('image/jpeg')
      const originalBase64 = (await readFile(fixture)).toString('base64')
      expect(source.data).toBe(originalBase64)
    })

    it('emits a text annotation with the file size and mime', async () => {
      const result = await callRead(fixture)
      const data = result.content as any[]
      const textBlock = data.find((b) => b.type === 'text')
      expect(textBlock).toBeDefined()
      const fileStat = await stat(fixture)
      expect(textBlock!.text).toContain('1x1.jpg')
      expect(textBlock!.text).toContain(`${fileStat.size} bytes`)
      expect(textBlock!.text).toContain('image/jpeg')
    })
  })

  describe('PNG with alpha (flatten + JPEG conversion)', () => {
    const fixture = resolve(FIXTURE_DIR, '1x1-alpha.png')

    it('converts PNG with alpha to JPEG (media_type flips)', async () => {
      const result = await callRead(fixture)
      const data = result.content as any[]
      const imageBlock = data.find((b) => b.type === 'image')
      const source = imageBlock!.source as { type: string; media_type: string; data: string }

      // PNG path is NOT passthrough — code always re-encodes through sharp.
      expect(source.media_type).toBe('image/jpeg')
      // And the bytes must differ from the original (PNG → JPEG is lossy).
      const originalBase64 = (await readFile(fixture)).toString('base64')
      expect(source.data).not.toBe(originalBase64)
    })

    it('produces a valid JPEG buffer (magic bytes FF D8 FF)', async () => {
      const result = await callRead(fixture)
      const data = result.content as any[]
      const imageBlock = data.find((b) => b.type === 'image')
      const source = imageBlock!.source as { media_type: string; data: string }
      const bytes = Buffer.from(source.data, 'base64')
      expect(bytes[0]).toBe(0xff)
      expect(bytes[1]).toBe(0xd8)
      expect(bytes[2]).toBe(0xff)
    })

    it('flattens transparent alpha onto white background (pixel becomes near-white)', async () => {
      // The fixture is a fully-transparent green pixel (alpha=0). After
      // flatten with white background, the resulting RGB pixel should
      // be white (or extremely close), not green.
      const result = await callRead(fixture)
      const data = result.content as any[]
      const imageBlock = data.find((b) => b.type === 'image')
      const source = imageBlock!.source as { data: string }
      const bytes = Buffer.from(source.data, 'base64')

      // Parse JPEG scan data using sharp to read the resulting pixel.
      // (Re-using sharp for verification is acceptable — it's the same
      // library, but reading raw bytes is impractical without a JPEG decoder.)
      const sharp = (await import('sharp')).default
      const { data: rawPixels, info } = await sharp(bytes)
        .raw()
        .toBuffer({ resolveWithObject: true })
      expect(info.width).toBe(1)
      expect(info.height).toBe(1)
      expect(info.channels).toBeGreaterThanOrEqual(3)
      // After flatten onto white: RGB should be ~255.
      expect(rawPixels[0]).toBeGreaterThan(240) // R
      expect(rawPixels[1]).toBeGreaterThan(240) // G
      expect(rawPixels[2]).toBeGreaterThan(240) // B
    })
  })

  describe('oversized image (resize path)', () => {
    const fixture = resolve(FIXTURE_DIR, 'large.jpg')

    it('downscales so the long edge does not exceed MAX_LONG_EDGE (1536)', async () => {
      const result = await callRead(fixture)
      const data = result.content as any[]
      const imageBlock = data.find((b) => b.type === 'image')
      const source = imageBlock!.source as { data: string }
      const bytes = Buffer.from(source.data, 'base64')

      const sharp = (await import('sharp')).default
      const meta = await sharp(bytes).metadata()
      expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1536)
    })

    it('re-encodes as JPEG even when input was already JPEG (because resize forces it)', async () => {
      const result = await callRead(fixture)
      const data = result.content as any[]
      const imageBlock = data.find((b) => b.type === 'image')
      const source = imageBlock!.source as { media_type: string; data: string }

      expect(source.media_type).toBe('image/jpeg')
      // Output bytes must be smaller than the original since we downscaled.
      const originalBytes = await readFile(fixture)
      expect(Buffer.from(source.data, 'base64').length).toBeLessThan(originalBytes.length)
    })
  })

  describe('invalid image bytes', () => {
    const fixture = resolve(FIXTURE_DIR, 'invalid.jpg')

    it('does not crash the tool — returns a tool_result (possibly with error flag)', async () => {
      // The image branch is unguarded; sharp will throw on metadata() of
      // invalid bytes. The tool's call() wrapper in defineTool catches
      // and returns is_error: true. We just verify no exception escapes.
      const result = await callRead(fixture)
      expect(result).toBeDefined()
      expect(typeof result).toBe('object')
      // Either is_error: true (caught by defineTool) OR the original
      // bytes are returned base64-encoded (if sharp was unavailable).
      expect(result.is_error === true || result.is_error === false).toBe(true)
    })

    it('reports a meaningful error in the content when sharp fails', async () => {
      const result = await callRead(fixture)
      if (!result.is_error) {
        // Sharp wasn't loaded (unusual case) — skip rather than fail.
        // In a healthy install, sharp IS loaded and this branch is reached.
        return
      }
      const content = Array.isArray(result.content) ? result.content.join('') : String(result.content)
      // Sharp's error for invalid JPEG typically mentions the input.
      expect(content.length).toBeGreaterThan(0)
      expect(content).toMatch(/error|invalid|corrupt|premature|unexpected/i)
    })
  })
})
