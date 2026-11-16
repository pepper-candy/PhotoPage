import type { Page, Photo, Placement } from './types.ts'

export const EXPORT_SIZES = [
  { id: 'original', label: 'Original' },
  { id: '16k', label: '16K', longEdge: 15360 },
  { id: '8k', label: '8K', longEdge: 7680 },
  { id: '4k', label: '4K', longEdge: 3840 },
  { id: '2k', label: '2K', longEdge: 2560 },
  { id: '1080p', label: '1080p', longEdge: 1920 },
  { id: '720p', label: '720p', longEdge: 1280 },
] as const

export type ExportSizeId = (typeof EXPORT_SIZES)[number]['id']

const PAGE_FILL = '#0b0c0f'

function sizeLabel(id: ExportSizeId): string {
  return EXPORT_SIZES.find((item) => item.id === id)?.label ?? id
}

function originalScale(placements: Placement[], photos: Photo[], breakIndex: number): number {
  const cut = Math.max(0, Math.min(photos.length, breakIndex))
  const focusIds = new Set(photos.slice(0, cut).map((photo) => photo.id))
  const refs = placements.filter((item) => focusIds.has(item.photoId))
  const used = refs.length > 0 ? refs : placements
  let scale = 0
  for (const item of used) {
    if (item.w > 0) scale = Math.max(scale, item.sw / item.w)
    if (item.h > 0) scale = Math.max(scale, item.sh / item.h)
  }
  return scale > 0 ? scale : 1
}

export function exportPixelSize(
  page: Page,
  placements: Placement[],
  photos: Photo[],
  sizeId: ExportSizeId,
  breakIndex: number,
): { width: number; height: number } {
  if (sizeId === 'original') {
    const scale = originalScale(placements, photos, breakIndex)
    return {
      width: Math.max(1, Math.round(page.width * scale)),
      height: Math.max(1, Math.round(page.height * scale)),
    }
  }
  const preset = EXPORT_SIZES.find((item) => item.id === sizeId)
  const longEdge = preset && 'longEdge' in preset ? preset.longEdge : 1920
  if (page.width >= page.height) {
    return {
      width: longEdge,
      height: Math.max(1, Math.round(longEdge * (page.height / page.width))),
    }
  }
  return {
    width: Math.max(1, Math.round(longEdge * (page.width / page.height))),
    height: longEdge,
  }
}

function tooLarge(id: ExportSizeId): Error {
  return new Error(`Could not export ${sizeLabel(id)}: the image is too large for this browser.`)
}

function makeCanvas(width: number, height: number, id: ExportSizeId): HTMLCanvasElement {
  const w = Math.ceil(width)
  const h = Math.ceil(height)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) {
    throw tooLarge(id)
  }
  const canvas = document.createElement('canvas')
  try {
    canvas.width = w
    canvas.height = h
  } catch {
    throw tooLarge(id)
  }
  if (canvas.width !== w || canvas.height !== h) throw tooLarge(id)
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw tooLarge(id)
  try {
    ctx.fillStyle = PAGE_FILL
    ctx.fillRect(0, 0, 1, 1)
    const probe = ctx.getImageData(0, 0, 1, 1)
    if (!probe || probe.data.length < 4) throw tooLarge(id)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Could not export')) throw error
    throw tooLarge(id)
  }
  return canvas
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not load a photo for export.'))
    img.src = url
  })
}

function drawPhoto(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  photo: Photo,
  item: Placement,
  scaleX: number,
  scaleY: number,
) {
  const cellX = item.x * scaleX
  const cellY = item.y * scaleY
  const cellW = item.w * scaleX
  const cellH = item.h * scaleY
  const sx = Math.max(0, Math.min(item.sx, photo.width - 1))
  const sy = Math.max(0, Math.min(item.sy, photo.height - 1))
  const sw = Math.max(1, Math.min(item.sw, photo.width - sx))
  const sh = Math.max(1, Math.min(item.sh, photo.height - sy))
  const scale = Math.min(cellW / sw, cellH / sh)
  const dw = sw * scale
  const dh = sh * scale
  ctx.drawImage(img, sx, sy, sw, sh, cellX + (cellW - dw) / 2, cellY + (cellH - dh) / 2, dw, dh)
}

export async function exportPackedPage(
  page: Page,
  photos: Photo[],
  placements: Placement[],
  sizeId: ExportSizeId,
  breakIndex: number,
): Promise<void> {
  if (placements.length === 0) {
    throw new Error('Nothing to export.')
  }
  const { width, height } = exportPixelSize(page, placements, photos, sizeId, breakIndex)
  const canvas = makeCanvas(width, height, sizeId)
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw tooLarge(sizeId)

  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.fillStyle = PAGE_FILL
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  const byId = new Map(photos.map((photo) => [photo.id, photo]))
  const needed = [...new Set(placements.map((item) => item.photoId))]
  const images = new Map<string, HTMLImageElement>()
  await Promise.all(
    needed.map(async (id) => {
      const photo = byId.get(id)
      if (!photo) return
      const img = await loadImage(photo.objectUrl)
      if (img.decode) {
        try {
          await img.decode()
        } catch {
          /* drawImage can still succeed if decode is unavailable */
        }
      }
      images.set(id, img)
    }),
  )

  const scaleX = canvas.width / page.width
  const scaleY = canvas.height / page.height
  for (const item of placements) {
    const photo = byId.get(item.photoId)
    const img = images.get(item.photoId)
    if (!photo || !img) continue
    drawPhoto(ctx, img, photo, item, scaleX, scaleY)
  }

  const blob = await new Promise<Blob>((resolve, reject) => {
    try {
      canvas.toBlob((result) => {
        if (!result) {
          reject(tooLarge(sizeId))
          return
        }
        resolve(result)
      }, 'image/png')
    } catch {
      reject(tooLarge(sizeId))
    }
  })

  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = `photopage-${sizeId}.png`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(href), 1000)
}
