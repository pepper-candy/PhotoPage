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

const MIN_SRC_PX = 32
const MIN_SRC_FRAC = 0.1

function minSourceSide(photo: Photo): number {
  return Math.max(MIN_SRC_PX, Math.min(photo.width, photo.height) * MIN_SRC_FRAC)
}

/** Largest source window of this aspect that fits in the photo (zoomed out). */
export function maxSourceForAspect(photo: Photo, aspect: number): { w: number; h: number } {
  const a = Math.max(aspect, EPS)
  let w = photo.width
  let h = w / a
  if (h > photo.height + EPS) {
    h = photo.height
    w = h * a
  }
  return { w: Math.max(1, w), h: Math.max(1, h) }
}

function minSourceForAspect(photo: Photo, aspect: number): { w: number; h: number } {
  const a = Math.max(aspect, EPS)
  const floor = minSourceSide(photo)
  let h = floor
  let w = h * a
  if (w < floor) {
    w = floor
    h = w / a
  }
  const max = maxSourceForAspect(photo, a)
  if (w > max.w + EPS || h > max.h + EPS) return max
  return { w: Math.max(1, w), h: Math.max(1, h) }
}

export function cellAspectRange(photo: Photo): { min: number; max: number } {
  const floor = minSourceSide(photo)
  const min = floor / Math.max(photo.height, EPS)
  const max = photo.width / Math.max(floor, EPS)
  if (!(min <= max)) {
    const natural = photo.width / Math.max(photo.height, EPS)
    return { min: Math.min(min, natural), max: Math.max(max, natural) }
  }
  return { min, max }
}

export function canFillCell(photo: Photo, w: number, h: number): boolean {
  const { min, max } = cellAspectRange(photo)
  const a = w / Math.max(h, EPS)
  return a + 1e-4 >= min && a - 1e-4 <= max
}

export function placeSource(photo: Photo, w: number, h: number, cx: number, cy: number): Rect {
  const width = clamp(w, 1, photo.width)
  const height = clamp(h, 1, photo.height)
  return {
    x: clamp(cx - width / 2, 0, Math.max(0, photo.width - width)),
    y: clamp(cy - height / 2, 0, Math.max(0, photo.height - height)),
    w: width,
    h: height,
  }
}

/** Keep pan/zoom while the cell aspect changes (gutter split). Zoom in if the new shape needs a tighter crop. */
export function adaptSource(photo: Photo, aspect: number, prev: Rect): Rect {
  const a = Math.max(aspect, EPS)
  const max = maxSourceForAspect(photo, a)
  const min = minSourceForAspect(photo, a)
  const prevMax = maxSourceForAspect(photo, prev.w / Math.max(prev.h, EPS))
  const t = prevMax.w > EPS ? clamp(prev.w / prevMax.w, 0, 1) : 1
  const w = clamp(max.w * t, min.w, max.w)
  const h = w / a
  return placeSource(photo, w, h, prev.x + prev.w / 2, prev.y + prev.h / 2)
}

export function panSource(photo: Photo, src: Rect, dx: number, dy: number): Rect {
  return placeSource(photo, src.w, src.h, src.x + src.w / 2 + dx, src.y + src.h / 2 + dy)
}

export function zoomSource(photo: Photo, src: Rect, factor: number, ox = 0.5, oy = 0.5): Rect {
  const a = src.w / Math.max(src.h, EPS)
  const max = maxSourceForAspect(photo, a)
  const min = minSourceForAspect(photo, a)
  const w = clamp(src.w * factor, min.w, max.w)
  const h = w / a
  const px = src.x + clamp(ox, 0, 1) * src.w
  const py = src.y + clamp(oy, 0, 1) * src.h
  return placeSource(photo, w, h, px - clamp(ox, 0, 1) * w + w / 2, py - clamp(oy, 0, 1) * h + h / 2)
}

export function panSlack(photo: Photo, src: Rect): { x: number; y: number } {
  return {
    x: Math.max(0, src.x) + Math.max(0, photo.width - src.x - src.w),
    y: Math.max(0, src.y) + Math.max(0, photo.height - src.y - src.h),
  }
}

export function canPan(photo: Photo, src: Rect): boolean {
  const slack = panSlack(photo, src)
  return slack.x > 1.5 || slack.y > 1.5
}
