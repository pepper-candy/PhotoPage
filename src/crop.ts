import {
  maxCropForGroup,
  type Photo,
  type Rect,
} from './types.ts'

const EPS = 1e-9

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function legalAspectRange(photo: Photo): { min: number; max: number } {
  const W = photo.width
  const H = photo.height
  const S = photo.safe
  const minArea = (1 - maxCropForGroup(photo.group)) * W * H
  const unmarked =
    S.x <= 1 && S.y <= 1 && S.w >= W - 2 && S.h >= H - 2

  const min = unmarked ? minArea / (H * H) : Math.max(S.w / H, minArea / (H * H))
  const max = unmarked ? (W * W) / minArea : Math.min(W / S.h, (W * W) / minArea)

  if (!(min <= max)) {
    const natural = W / H
    return { min: Math.min(min, natural), max: Math.max(max, natural) }
  }
  return { min, max }
}

export function preferredAspect(photo: Photo): number {
  const { min, max } = legalAspectRange(photo)
  return clamp(photo.width / photo.height, min, max)
}

/** Source rect for a display aspect, anchored on the safe-crop center, then the image center. */
export function sourceRectForAspect(photo: Photo, aspect: number): Rect {
  const W = photo.width
  const H = photo.height
  const S = photo.safe
  const { min: aMin, max: aMax } = legalAspectRange(photo)
  const a = clamp(aspect, aMin, aMax)
  const minArea = (1 - maxCropForGroup(photo.group)) * W * H

  let w = Math.max(S.w, a * S.h)
  let h = w / a
  const area = w * h
  if (area < minArea) {
    const scale = Math.sqrt(minArea / area)
    w *= scale
    h *= scale
  }

  if (w > W) {
    w = W
    h = w / a
  }
  if (h > H) {
    h = H
    w = h * a
  }
  w = Math.min(w, W)
  h = Math.min(h, H)

  const minX = Math.max(0, S.x + S.w - w)
  const maxX = Math.min(W - w, S.x)
  const minY = Math.max(0, S.y + S.h - h)
  const maxY = Math.min(H - h, S.y)

  const safeCx = S.x + S.w / 2
  const safeCy = S.y + S.h / 2
  let x = safeCx - w / 2
  let y = safeCy - h / 2

  if (x < minX - EPS || x > maxX + EPS || y < minY - EPS || y > maxY + EPS) {
    x = W / 2 - w / 2
    y = H / 2 - h / 2
  }

  x = minX <= maxX ? clamp(x, minX, maxX) : clamp(x, 0, Math.max(0, W - w))
  y = minY <= maxY ? clamp(y, minY, maxY) : clamp(y, 0, Math.max(0, H - h))
  return { x, y, w, h }
}
