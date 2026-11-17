import { adaptSource, canFillCell, cellAspectRange, sourceRectForAspect } from './crop.ts'
import type { Photo, Placement } from './types.ts'

const EPS = 1.5
const MIN_CELL = 24

export type CutAxis = 'v' | 'h'

export type Cut = {
  id: string
  axis: CutAxis
  pos: number
  start: number
  end: number
  left: string[]
  right: string[]
}

function near(a: number, b: number, slack = EPS): boolean {
  return Math.abs(a - b) <= slack
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.min(a1, b1) - Math.max(a0, b0)
}

function matchSlack(gutter: number): number {
  return Math.max(EPS, gutter * 0.25)
}

function placementForBox(
  photo: Photo,
  box: { x: number; y: number; w: number; h: number },
  prev?: Placement,
): Placement {
  const aspect = box.w / Math.max(box.h, 0.001)
  const src = prev
    ? adaptSource(photo, aspect, { x: prev.sx, y: prev.sy, w: prev.sw, h: prev.sh })
    : sourceRectForAspect(photo, aspect)
  return {
    photoId: photo.id,
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    sx: src.x,
    sy: src.y,
    sw: src.w,
    sh: src.h,
  }
}

type Seg = {
  axis: CutAxis
  pos: number
  start: number
  end: number
  left: Set<string>
  right: Set<string>
}

function pairSegs(placements: Placement[], gutter: number): Seg[] {
  const g = Math.max(0, gutter)
  const slack = matchSlack(g)
  const segs: Seg[] = []
  for (let i = 0; i < placements.length; i++) {
    const a = placements[i]
    for (let j = 0; j < placements.length; j++) {
      if (i === j) continue
      const b = placements[j]
      const yHit = overlap(a.y, a.y + a.h, b.y, b.y + b.h)
      if (yHit > slack && near(a.x + a.w + g, b.x, slack)) {
        segs.push({
          axis: 'v',
          pos: a.x + a.w,
          start: Math.max(a.y, b.y),
          end: Math.min(a.y + a.h, b.y + b.h),
          left: new Set([a.photoId]),
          right: new Set([b.photoId]),
        })
      }
      const xHit = overlap(a.x, a.x + a.w, b.x, b.x + b.w)
      if (xHit > slack && near(a.y + a.h + g, b.y, slack)) {
        segs.push({
          axis: 'h',
          pos: a.y + a.h,
          start: Math.max(a.x, b.x),
          end: Math.min(a.x + a.w, b.x + b.w),
          left: new Set([a.photoId]),
          right: new Set([b.photoId]),
        })
      }
    }
  }
  return segs
}

function mergeCluster(segs: Seg[], gutter: number): Seg[] {
  const g = Math.max(0, gutter)
  const sorted = segs.slice().sort((a, b) => a.start - b.start || a.end - b.end)
  const out: Seg[] = []
  for (const seg of sorted) {
    const last = out[out.length - 1]
    if (last && seg.start <= last.end + g + EPS) {
      last.end = Math.max(last.end, seg.end)
      last.start = Math.min(last.start, seg.start)
      for (const id of seg.left) last.left.add(id)
      for (const id of seg.right) last.right.add(id)
    } else {
      out.push({
        axis: seg.axis,
        pos: seg.pos,
        start: seg.start,
        end: seg.end,
        left: new Set(seg.left),
        right: new Set(seg.right),
      })
    }
  }
  return out
}

function isCleanCut(seg: Seg, byId: Map<string, Placement>): boolean {
  if (seg.left.size === 0 || seg.right.size === 0) return false
  if (seg.end - seg.start < MIN_CELL * 0.5) return false
  for (const id of [...seg.left, ...seg.right]) {
    if (!byId.has(id)) return false
  }
  return true
}

export function findCuts(placements: Placement[], gutter: number): Cut[] {
  if (placements.length < 2) return []
  const byId = new Map(placements.map((item) => [item.photoId, item]))
  const buckets = new Map<string, Seg[]>()
  for (const seg of pairSegs(placements, gutter)) {
    const key = `${seg.axis}:${Math.round(seg.pos)}`
    const list = buckets.get(key)
    if (list) list.push(seg)
    else buckets.set(key, [seg])
  }

  const cuts: Cut[] = []
  for (const [key, segs] of buckets) {
    const axis: CutAxis = key.startsWith('v') ? 'v' : 'h'
    for (const merged of mergeCluster(segs, gutter)) {
      if (!isCleanCut(merged, byId)) continue
      cuts.push({
        id: `${axis}:${[...merged.left].sort().join(',')}|${[...merged.right].sort().join(',')}`,
        axis,
        pos: merged.pos,
        start: merged.start,
        end: merged.end,
        left: [...merged.left],
        right: [...merged.right],
      })
    }
  }
  return cuts
}

function deltaRange(photo: Photo, w: number, h: number, grow: boolean): { min: number; max: number } {
  const { min: aMin, max: aMax } = cellAspectRange(photo)
  if (grow) {
    return { min: aMin * h - w, max: aMax * h - w }
  }
  return { min: w - aMax * h, max: w - aMin * h }
}

function clampDelta(
  placements: Placement[],
  photos: Map<string, Photo>,
  cut: Cut,
  delta: number,
): number {
  let lo = Number.NEGATIVE_INFINITY
  let hi = Number.POSITIVE_INFINITY
  const left = new Set(cut.left)
  const right = new Set(cut.right)
  for (const item of placements) {
    const photo = photos.get(item.photoId)
    if (!photo) continue
    if (cut.axis === 'v') {
      if (left.has(item.photoId)) {
        const range = deltaRange(photo, item.w, item.h, true)
        lo = Math.max(lo, range.min, MIN_CELL - item.w)
        hi = Math.min(hi, range.max)
      } else if (right.has(item.photoId)) {
        const range = deltaRange(photo, item.w, item.h, false)
        lo = Math.max(lo, range.min, -item.x)
        hi = Math.min(hi, range.max, item.w - MIN_CELL)
      }
    } else if (left.has(item.photoId)) {
      const { min: aMin, max: aMax } = cellAspectRange(photo)
      lo = Math.max(lo, item.w / aMax - item.h, MIN_CELL - item.h)
      hi = Math.min(hi, item.w / aMin - item.h)
    } else if (right.has(item.photoId)) {
      const { min: aMin, max: aMax } = cellAspectRange(photo)
      lo = Math.max(lo, item.h - item.w / aMin, -item.y)
      hi = Math.min(hi, item.h - item.w / aMax, item.h - MIN_CELL)
    }
  }
  if (!(lo <= hi)) return 0
  return Math.min(hi, Math.max(lo, delta))
}

function boxesOverlap(a: Placement, b: Placement): boolean {
  return overlap(a.x, a.x + a.w, b.x, b.x + b.w) > EPS && overlap(a.y, a.y + a.h, b.y, b.y + b.h) > EPS
}

function hasOverlap(items: Placement[]): boolean {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (boxesOverlap(items[i], items[j])) return true
    }
  }
  return false
}

function applyDelta(
  placements: Placement[],
  photos: Map<string, Photo>,
  cut: Cut,
  d: number,
  pageW: number,
  pageH: number,
): Placement[] | null {
  const left = new Set(cut.left)
  const right = new Set(cut.right)
  const next: Placement[] = []
  for (const item of placements) {
    const photo = photos.get(item.photoId)
    if (!photo) {
      next.push(item)
      continue
    }
    let box = { x: item.x, y: item.y, w: item.w, h: item.h }
    if (cut.axis === 'v' && left.has(item.photoId)) box = { ...box, w: item.w + d }
    else if (cut.axis === 'v' && right.has(item.photoId)) box = { x: item.x + d, y: item.y, w: item.w - d, h: item.h }
    else if (cut.axis === 'h' && left.has(item.photoId)) box = { ...box, h: item.h + d }
    else if (cut.axis === 'h' && right.has(item.photoId)) box = { x: item.x, y: item.y + d, w: item.w, h: item.h - d }
    if (box.w < MIN_CELL - EPS || box.h < MIN_CELL - EPS) return null
    if (box.x < -EPS || box.y < -EPS || box.x + box.w > pageW + EPS || box.y + box.h > pageH + EPS) return null
    if (!canFillCell(photo, box.w, box.h)) return null
    next.push(placementForBox(photo, box, item))
  }
  if (hasOverlap(next)) return null
  return next
}

export function nudgeCut(
  placements: Placement[],
  photos: Photo[],
  cut: Cut,
  delta: number,
  page?: { width: number; height: number },
): Placement[] {
  const byPhoto = new Map(photos.map((photo) => [photo.id, photo]))
  const pageW = page?.width ?? Number.POSITIVE_INFINITY
  const pageH = page?.height ?? Number.POSITIVE_INFINITY
  const want = clampDelta(placements, byPhoto, cut, delta)
  if (Math.abs(want) < 1e-6) return placements
  const direct = applyDelta(placements, byPhoto, cut, want, pageW, pageH)
  if (direct) return direct
  let lo = 0
  let hi = want
  let best = placements
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2
    const next = applyDelta(placements, byPhoto, cut, mid, pageW, pageH)
    if (next) {
      best = next
      lo = mid
    } else {
      hi = mid
    }
  }
  return best
}
