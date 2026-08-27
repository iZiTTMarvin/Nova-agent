import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import {
  computeResizeDimensions,
  MAX_IMAGE_EDGE,
  MAX_IMAGE_INGEST_BYTES,
  prepareImageForStorage
} from '../../../src/main/images/imageIngest'

function dataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString('base64')}`
}

async function createPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 36, g: 82, b: 126, alpha: 1 }
    }
  }).png().toBuffer()
}

async function createNoisePng(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3)
  let state = 0x12345678
  for (let i = 0; i < raw.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) | 0
    raw[i] = state >>> 24
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

describe('prepareImageForStorage', () => {
  it('未触发门槛时保留原始图片字节', async () => {
    const source = await createPng(320, 180)
    const sourceUrl = dataUrl(source, 'image/png')

    const prepared = await prepareImageForStorage(sourceUrl, 'image/png')

    expect(prepared.wasResized).toBe(false)
    expect(prepared.bytes).toBe(source.length)
    expect(prepared.dataUrl).toBe(sourceUrl)
    expect(Buffer.from(prepared.dataUrl.split(',')[1]!, 'base64')).toEqual(source)
  })

  it('按实际图片格式校正普通 MIME，同时保留原始字节', async () => {
    const source = await createPng(320, 180)
    const prepared = await prepareImageForStorage(dataUrl(source, 'image/jpeg'), 'image/jpeg')

    expect(prepared.mimeType).toBe('image/png')
    expect(prepared.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(Buffer.from(prepared.dataUrl.split(',')[1]!, 'base64')).toEqual(source)
  })

  it('长边超过 2000 时按比例缩放并输出不超过长边', async () => {
    const source = await createPng(2400, 600)

    const prepared = await prepareImageForStorage(dataUrl(source, 'image/png'), 'image/png')
    const output = Buffer.from(prepared.dataUrl.split(',')[1]!, 'base64')
    const metadata = await sharp(output).metadata()

    expect(prepared.wasResized).toBe(true)
    expect(metadata.width).toBe(2000)
    expect(metadata.height).toBe(500)
    expect(Math.max(metadata.width!, metadata.height!)).toBeLessThanOrEqual(MAX_IMAGE_EDGE)
    expect(prepared.mimeType).toBe('image/png')
  })

  it('原图超过 5 MiB 即使尺寸较小也会重编码并控制存储体积', async () => {
    const source = await createNoisePng(1400, 1400)
    expect(source.length).toBeGreaterThan(MAX_IMAGE_INGEST_BYTES)

    const prepared = await prepareImageForStorage(dataUrl(source, 'image/png'), 'image/png')
    const output = Buffer.from(prepared.dataUrl.split(',')[1]!, 'base64')
    const metadata = await sharp(output).metadata()

    expect(prepared.wasResized).toBe(true)
    expect(prepared.bytes).toBe(output.length)
    expect(prepared.bytes).toBeLessThanOrEqual(MAX_IMAGE_INGEST_BYTES)
    expect(Math.max(metadata.width!, metadata.height!)).toBeLessThanOrEqual(MAX_IMAGE_EDGE)
  })

  it('EXIF 方向为竖图时按旋转后的宽高计算缩放尺寸', async () => {
    const raw = Buffer.alloc(2400 * 600 * 3, 128)
    const source = await sharp(raw, { raw: { width: 2400, height: 600, channels: 3 } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer()

    const prepared = await prepareImageForStorage(dataUrl(source, 'image/jpeg'), 'image/jpeg')
    const output = Buffer.from(prepared.dataUrl.split(',')[1]!, 'base64')
    const metadata = await sharp(output).metadata()

    expect(metadata.width).toBe(500)
    expect(metadata.height).toBe(2000)
  })

  it('非法 data URL 逐张返回可操作错误', async () => {
    await expect(
      prepareImageForStorage('https://example.com/image.png', 'image/png')
    ).rejects.toThrow('图片数据无效')
  })
})

describe('computeResizeDimensions', () => {
  it('保持比例并将长边限制在上限内', () => {
    expect(computeResizeDimensions(4000, 1000)).toEqual({ width: 2000, height: 500 })
    expect(computeResizeDimensions(1000, 4000)).toEqual({ width: 500, height: 2000 })
  })
})
