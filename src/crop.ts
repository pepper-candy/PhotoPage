import {
  maxCropForGroup,
  type Photo,
  type Rect,
} from './types.ts'

const EPS = 1e-9

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function isFullFrame(photo: Photo): boolean {
  const S = photo.safe
  return S.x <= 1 && S.y <= 1 && S.w >= photo.width - 2 && S.h >= photo.height - 2
}

export function legalAspectRange(photo: Photo): { min: number; max: number } {
  const W = photo.width
  const H = photo.height
  const S = photo.safe
  const minArea = (1 - maxCropForGroup(photo.group)) * W * H
  const unmarked = isFullFrame(photo)

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
  const want = isFullFrame(photo)
    ? photo.width / photo.height
    : photo.safe.w / Math.max(photo.safe.h, EPS)
  return clamp(want, min, max)
}

/** Source rect for a display aspect, anchored on the safe region. Marked crops stay tight. */
export function sourceRectForAspect(photo: Photo, aspect: number): Rect {
  const W = photo.width
  const H = photo.height
  const S = photo.safe
  const { min: aMin, max: aMax } = legalAspectRange(photo)
  const a = clamp(aspect, aMin, aMax)
  const unmarked = isFullFrame(photo)
  const minArea = (1 - maxCropForGroup(photo.group)) * W * H

  let w = Math.max(S.w, a * S.h)
  let h = w / a

  if (unmarked) {
    const area = w * h
    if (area < minArea) {
      const scale = Math.sqrt(minArea / area)
      w *= scale
      h *= scale
    }
  }

  if (w > W + EPS || h > H + EPS) {
    const fit = Math.min(W / w, H / h)
    w *= fit
    h *= fit
  }
  if (W / H >= a) {
    h = Math.min(h, H)
    w = h * a
    if (w > W) {
      w = W
      h = w / a
    }
  } else {
    w = Math.min(w, W)
    h = w / a
    if (h > H) {
      h = H
      w = h * a
    }
  }

  if (w < S.w - EPS) {
    w = Math.min(S.w, W)
    h = w / a
  }
  if (h < S.h - EPS) {
    h = Math.min(S.h, H)
    w = h * a
  }
  if (w > W + EPS || h > H + EPS) {
    const fit = Math.min(W / w, H / h, 1)
    w *= fit
    h *= fit
  }

  const minX = Math.max(0, S.x + S.w - w)
  const maxX = Math.min(W - w, S.x)
  const minY = Math.max(0, S.y + S.h - h)
  const maxY = Math.min(H - h, S.y)

  const x = minX <= maxX ? clamp(S.x + S.w / 2 - w / 2, minX, maxX) : clamp(S.x + S.w / 2 - w / 2, 0, Math.max(0, W - w))
  const y = minY <= maxY ? clamp(S.y + S.h / 2 - h / 2, minY, maxY) : clamp(S.y + S.h / 2 - h / 2, 0, Math.max(0, H - h))
  return { x, y, w, h }
}
