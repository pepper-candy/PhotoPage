import { clamp, legalAspectRange, preferredAspect, sourceRectForAspect } from './crop.ts'
import {
  PAGE_WIDTH,
  type LayoutMode,
  type PackOptions,
  type Page,
  type Photo,
  type PhotoGroup,
  type Placement,
  type Rect,
} from './types.ts'

const EPS = 0.6
const FOCUS_ROW_SCALE = 2.2
const FOCUS_MIN_RATIO = 1.5
const GAP_PASSES = 5
const LAND_ASPECT = 4 / 3
const PORT_ASPECT = 3 / 4
const PHOTO_ASPECT_MIN = 0.45
const PHOTO_ASPECT_MAX = 2.2
const SLOT_ALIGNS = [0, 0.25, 0.5, 0.75, 1]

function cellArea(rect: { w: number; h: number }): number {
  return Math.max(0, rect.w) * Math.max(0, rect.h)
}

function nicheAreaCap(focusPlaced: Placement[]): number {
  if (focusPlaced.length === 0) return Number.POSITIVE_INFINITY
  return Math.min(...focusPlaced.map(cellArea)) / FOCUS_MIN_RATIO
}

type Dir = 'right' | 'down' | 'left' | 'up'
type Limits = { inner: number; hMin: number; hMax: number; hPref: number }

function tagGroups(photos: Photo[], breakIndex: number): Photo[] {
  const b = clamp(Math.trunc(breakIndex), 0, photos.length)
  return photos.map((photo, index) => {
    const group: PhotoGroup = index < b ? 'focus' : 'niche'
    return photo.group === group ? photo : { ...photo, group }
  })
}

function fitsAspect(photo: Photo, w: number, h: number): boolean {
  const { min, max } = legalAspectRange(photo)
  const a = w / Math.max(h, 0.001)
  return a + 1e-4 >= min && a - 1e-4 <= max
}

function legalBox(photo: Photo, box: Rect): Rect {
  const { min, max } = legalAspectRange(photo)
  const a = clamp(box.w / Math.max(box.h, 0.001), min, max)
  let w = box.w
  let h = w / a
  if (h > box.h) {
    h = box.h
    w = h * a
  }
  if (w > box.w) {
    w = box.w
    h = w / a
  }
  return {
    x: box.x,
    y: box.y,
    w: Math.max(1, w),
    h: Math.max(1, h),
  }
}

function toPlacement(photo: Photo, box: Rect): Placement {
  const fitted = fitsAspect(photo, box.w, box.h) ? box : legalBox(photo, box)
  const src = sourceRectForAspect(photo, fitted.w / Math.max(fitted.h, 0.001))
  return {
    photoId: photo.id,
    x: fitted.x,
    y: fitted.y,
    w: fitted.w,
    h: fitted.h,
    sx: src.x,
    sy: src.y,
    sw: src.w,
    sh: src.h,
  }
}

function rowLimits(row: Photo[], width: number, gutter: number): Limits {
  const gaps = Math.max(0, row.length - 1) * gutter
  const inner = Math.max(1, width - gaps)
  let sumMin = 0
  let sumMax = 0
  let sumPref = 0
  for (const photo of row) {
    const { min, max } = legalAspectRange(photo)
    sumMin += min
    sumMax += Math.max(min, max)
    sumPref += preferredAspect(photo)
  }
  const hAt = (sum: number) => (sum > 0 ? inner / sum : inner)
  const hMin = hAt(sumMax)
  const hMax = Math.max(hAt(sumMin), hMin)
  return { inner, hMin, hMax, hPref: clamp(hAt(sumPref), hMin, hMax) }
}

function prefHeight(row: Photo[], width: number, gutter: number): number {
  return rowLimits(row, width, gutter).hPref
}

function naturalTotal(rows: Photo[][], width: number, gutter: number): number {
  if (rows.length === 0) return 0
  let sum = Math.max(0, rows.length - 1) * gutter
  for (const row of rows) sum += prefHeight(row, width, gutter)
  return sum
}

function partitionByTarget(
  photos: Photo[],
  width: number,
  gutter: number,
  targetH: number,
): Photo[][] {
  const rows: Photo[][] = []
  let row: Photo[] = []
  for (const photo of photos) {
    if (row.length === 0) {
      row = [photo]
      continue
    }
    const nextH = prefHeight([...row, photo], width, gutter)
    if (nextH < targetH) {
      rows.push(row)
      row = [photo]
    } else {
      row = [...row, photo]
    }
  }
  if (row.length) rows.push(row)
  return rows
}

function rowSpan(rows: Photo[][], width: number, gutter: number) {
  let minSum = 0
  let maxSum = 0
  let prefSum = 0
  for (const row of rows) {
    const limit = rowLimits(row, width, gutter)
    minSum += limit.hMin
    maxSum += limit.hMax
    prefSum += limit.hPref
  }
  return { minSum, maxSum, prefSum, gaps: Math.max(0, rows.length - 1) * gutter }
}

function partitionCanFill(rows: Photo[][], width: number, height: number, gutter: number): boolean {
  if (rows.length === 0) return false
  const { minSum, maxSum, gaps } = rowSpan(rows, width, gutter)
  const budget = height - gaps
  return minSum <= budget + EPS && maxSum >= budget - EPS
}

function mergeToFit(photos: Photo[], width: number, height: number, gutter: number): Photo[][] {
  const rows = photos.map((photo) => [photo])
  const overMin = (next: Photo[][]) => {
    const { minSum, gaps } = rowSpan(next, width, gutter)
    return minSum > height - gaps + EPS
  }
  while (rows.length > 1 && overMin(rows)) {
    let best = 0
    let bestCount = rows[0].length + rows[1].length
    for (let i = 1; i < rows.length - 1; i++) {
      const count = rows[i].length + rows[i + 1].length
      if (count < bestCount) {
        bestCount = count
        best = i
      }
    }
    rows[best] = [...rows[best], ...rows[best + 1]]
    rows.splice(best + 1, 1)
  }
  return rows
}

function partitionScore(rows: Photo[][], width: number, height: number, gutter: number): number {
  const cleaned = rows.filter((row) => row.length)
  if (!cleaned.length) return 1e15
  const { minSum, maxSum, prefSum, gaps } = rowSpan(cleaned, width, gutter)
  const budget = height - gaps
  const overflow = Math.max(0, minSum - budget)
  const short = Math.max(0, budget - maxSum)
  const prefDiff = Math.abs(prefSum - budget)
  if (overflow > EPS) return 1e12 + overflow
  if (short > EPS) return 1e6 + short + prefDiff * 0.01
  return prefDiff
}

function bestPartition(photos: Photo[], width: number, height: number, gutter: number): Photo[][] {
  if (photos.length <= 1) return photos.length ? [[...photos]] : []

  const scoreOf = (rows: Photo[][]) => partitionScore(rows, width, height, gutter)
  let best = [photos.slice()]
  let bestScore = scoreOf(best)
  const consider = (rows: Photo[][]) => {
    const cleaned = rows.filter((row) => row.length)
    if (!cleaned.length) return
    const score = scoreOf(cleaned)
    if (score < bestScore - 0.25) {
      best = cleaned.map((row) => row.slice())
      bestScore = score
    }
  }

  const targets = [height]
  for (let i = 1; i <= 28; i++) targets.push((height * i) / 28)
  let lo = 1
  let hi = Math.max(2, height)
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2
    targets.push(mid)
    const total = naturalTotal(partitionByTarget(photos, width, gutter, mid), width, gutter)
    if (total > height) hi = mid
    else lo = mid
  }
  for (const target of targets) consider(partitionByTarget(photos, width, gutter, target))
  consider(photos.map((photo) => [photo]))
  consider(mergeToFit(photos, width, height, gutter))

  let rows = best.map((row) => row.slice())
  for (let guard = 0; guard < 24; guard++) {
    const current = scoreOf(rows)
    let improved = false
    const attempt = (next: Photo[][]) => {
      const cleaned = next.filter((row) => row.length)
      if (scoreOf(cleaned) < current - 0.25) {
        rows = cleaned
        improved = true
        return true
      }
      return false
    }

    let found = false
    for (let r = 0; r < rows.length && !found; r++) {
      if (rows[r].length >= 2) {
        for (let cut = 1; cut < rows[r].length; cut++) {
          const next = rows.map((row) => row.slice())
          const right = next[r].splice(cut)
          next.splice(r + 1, 0, right)
          if (attempt(next)) {
            found = true
            break
          }
        }
      }
      if (found) break
      if (r < rows.length - 1) {
        const merged = rows.map((row) => row.slice())
        merged[r] = [...merged[r], ...merged[r + 1]]
        merged.splice(r + 1, 1)
        if (attempt(merged)) {
          found = true
          break
        }
      }
      if (found || r >= rows.length - 1) continue
      for (const dir of [1, -1]) {
        const next = rows.map((row) => row.slice())
        const moved = dir === 1 ? next[r].pop() : next[r + 1].shift()
        if (!moved) continue
        if (dir === 1) next[r + 1].unshift(moved)
        else next[r].push(moved)
        if (attempt(next)) {
          found = true
          break
        }
      }
    }
    if (!improved && !found) break
    consider(rows)
  }
  return best
}

function solveHeights(limits: Limits[], budget: number, fill: boolean): number[] {
  const target = Math.max(limits.length, budget)
  let hs = limits.map((limit) => limit.hPref)
  const sum = () => hs.reduce((total, h) => total + h, 0)

  const pull = (goal: number) => {
    const current = sum()
    if (current <= EPS) return
    const gain = goal / current
    hs = hs.map((h, i) => clamp(h * gain, limits[i].hMin, limits[i].hMax))
  }

  if (sum() > target || (fill && sum() < target)) pull(target)

  for (let iter = 0; iter < 12; iter++) {
    const diff = target - sum()
    if (Math.abs(diff) < EPS) break
    if (!fill && diff > 0) break
    let roomSum = 0
    const room = hs.map((h, i) => {
      const space = diff > 0 ? limits[i].hMax - h : h - limits[i].hMin
      const open = Math.max(0, space)
      roomSum += open
      return open
    })
    if (roomSum < EPS) break
    const take = Math.min(Math.abs(diff), roomSum)
    hs = hs.map((h, i) => h + Math.sign(diff) * (room[i] / roomSum) * take)
  }

  if (sum() > target + EPS) {
    const gain = target / sum()
    hs = hs.map((h, i) => Math.max(limits[i].hMin, h * gain))
  }
  return hs.map((h) => Math.max(1, h))
}

function assignWidths(row: Photo[], height: number, inner: number): number[] {
  const specs = row.map((photo) => {
    const { min, max } = legalAspectRange(photo)
    const pref = preferredAspect(photo)
    const minW = min * height
    const maxW = Math.max(minW, max * height)
    return { minW, maxW, prefW: clamp(pref * height, minW, maxW) }
  })
  let widths = specs.map((spec) => spec.prefW)
  for (let iter = 0; iter < 10; iter++) {
    const total = widths.reduce((sum, w) => sum + w, 0)
    const diff = inner - total
    if (Math.abs(diff) < 0.25) break
    let roomSum = 0
    const room = widths.map((w, i) => {
      const space = diff > 0 ? specs[i].maxW - w : w - specs[i].minW
      const open = Math.max(0, space)
      roomSum += open
      return open
    })
    if (roomSum < 0.25) break
    const take = Math.min(Math.abs(diff), roomSum)
    widths = widths.map((w, i) => w + Math.sign(diff) * (room[i] / roomSum) * take)
  }
  return widths
}

function layoutRows(
  rows: Photo[][],
  region: Rect,
  gutter: number,
  fill: boolean,
  targetH?: number,
): Placement[] {
  if (rows.length === 0 || region.w < 1 || region.h < 1) return []
  const gaps = Math.max(0, rows.length - 1) * gutter
  const budget = Math.max(rows.length, region.h - gaps)
  const limits = rows.map((row) => {
    const limit = rowLimits(row, region.w, gutter)
    if (targetH != null) limit.hPref = clamp(targetH, limit.hMin, limit.hMax)
    return limit
  })
  const heights = solveHeights(limits, budget, fill)
  const placements: Placement[] = []
  let y = region.y

  rows.forEach((row, rowIndex) => {
    const inner = limits[rowIndex].inner
    let height = heights[rowIndex]
    const minAspect = row.reduce((sum, photo) => sum + legalAspectRange(photo).min, 0)
    if (minAspect > 0 && minAspect * height > inner + EPS) {
      height = inner / minAspect
    }
    height = Math.max(1, height)
    const widths = assignWidths(row, height, inner)
    let x = region.x
    for (let i = 0; i < row.length; i++) {
      const w = Math.max(1, widths[i])
      placements.push(fillCell(row[i], { x, y, w, h: height }))
      x += w + gutter
    }
    y += height
    if (rowIndex < rows.length - 1) y += gutter
  })
  return placements
}

function fitSize(photo: Photo, maxW: number, maxH: number): { w: number; h: number } {
  const { min, max } = legalAspectRange(photo)
  const aspect = clamp(maxW / Math.max(maxH, 1), min, max)
  let w = maxW
  let h = w / aspect
  if (h > maxH) {
    h = maxH
    w = h * aspect
  }
  return { w: Math.max(1, w), h: Math.max(1, h) }
}

function placeSingle(photo: Photo, region: Rect): Placement {
  const { w, h } = fitSize(photo, region.w, region.h)
  return fillCell(photo, { x: region.x, y: region.y, w, h })
}

function vertOverlap(a: Placement, b: Placement): boolean {
  return a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS
}

function horzOverlap(a: Placement, b: Placement): boolean {
  return a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS
}

function boxesOverlap(a: Rect, b: Rect, gutter: number): boolean {
  return (
    a.x < b.x + b.w + gutter - EPS &&
    a.x + a.w + gutter > b.x + EPS &&
    a.y < b.y + b.h + gutter - EPS &&
    a.y + a.h + gutter > b.y + EPS
  )
}

function availableGap(
  placement: Placement,
  dir: Dir,
  others: Placement[],
  region: Rect,
  gutter: number,
): number {
  if (dir === 'right') {
    let limit = region.x + region.w
    for (const other of others) {
      if (other.photoId === placement.photoId) continue
      if (vertOverlap(placement, other) && other.x >= placement.x + placement.w - EPS) {
        limit = Math.min(limit, other.x - gutter)
      }
    }
    return Math.max(0, limit - (placement.x + placement.w))
  }
  if (dir === 'left') {
    let limit = region.x
    for (const other of others) {
      if (other.photoId === placement.photoId) continue
      if (vertOverlap(placement, other) && other.x + other.w <= placement.x + EPS) {
        limit = Math.max(limit, other.x + other.w + gutter)
      }
    }
    return Math.max(0, placement.x - limit)
  }
  if (dir === 'down') {
    let limit = region.y + region.h
    for (const other of others) {
      if (other.photoId === placement.photoId) continue
      if (horzOverlap(placement, other) && other.y >= placement.y + placement.h - EPS) {
        limit = Math.min(limit, other.y - gutter)
      }
    }
    return Math.max(0, limit - (placement.y + placement.h))
  }
  let limit = region.y
  for (const other of others) {
    if (other.photoId === placement.photoId) continue
    if (horzOverlap(placement, other) && other.y + other.h <= placement.y + EPS) {
      limit = Math.max(limit, other.y + other.h + gutter)
    }
  }
  return Math.max(0, placement.y - limit)
}

function tryExpand(
  placement: Placement,
  dir: Dir,
  placements: Placement[],
  photo: Photo,
  region: Rect,
  gutter: number,
  maxArea?: number,
): { area: number; next: Placement } | null {
  const gap = availableGap(placement, dir, placements, region, gutter)
  if (gap < EPS) return null
  const { min: aMin, max: aMax } = legalAspectRange(photo)
  let x = placement.x
  let y = placement.y
  let w = placement.w
  let h = placement.h

  if (dir === 'right' || dir === 'left') {
    const maxW = Math.min(placement.w + gap, aMax * placement.h)
    const grown = maxW - placement.w
    if (grown <= EPS) return null
    w = maxW
    if (dir === 'left') x = placement.x - grown
  } else {
    const maxH = Math.min(placement.h + gap, placement.w / Math.max(aMin, 0.001))
    const grown = maxH - placement.h
    if (grown <= EPS) return null
    h = maxH
    if (dir === 'up') y = placement.y - grown
  }

  if (maxArea != null && Number.isFinite(maxArea) && w * h > maxArea + EPS) {
    if (dir === 'right' || dir === 'left') {
      const limited = maxArea / Math.max(h, 0.001)
      if (limited <= placement.w + EPS) return null
      if (dir === 'left') x = placement.x - (limited - placement.w)
      w = limited
    } else {
      const limited = maxArea / Math.max(w, 0.001)
      if (limited <= placement.h + EPS) return null
      if (dir === 'up') y = placement.y - (limited - placement.h)
      h = limited
    }
  }

  if (
    x < region.x - EPS ||
    y < region.y - EPS ||
    x + w > region.x + region.w + EPS ||
    y + h > region.y + region.h + EPS
  ) {
    return null
  }

  const box = { x, y, w, h }
  for (const other of placements) {
    if (other.photoId === placement.photoId) continue
    if (boxesOverlap(box, other, gutter)) return null
  }
  return { area: w * h - placement.w * placement.h, next: fillCell(photo, box) }
}

function gapFill(
  start: Placement[],
  photos: Photo[],
  region: Rect,
  gutter: number,
  nicheCap?: number,
  passes = GAP_PASSES,
  expandFocus = true,
): Placement[] {
  const byId = new Map(photos.map((photo) => [photo.id, photo]))
  const order = new Map(photos.map((photo, index) => [photo.id, index]))
  const placements = start.map((placement) => ({ ...placement }))
  const dirs: Dir[] = ['down', 'right', 'up', 'left']
  const capOf = (photo: Photo) =>
    photo.group === 'focus' || nicheCap == null || !Number.isFinite(nicheCap) ? undefined : nicheCap

  for (let pass = 0; pass < passes; pass++) {
    const candidates: { photoId: string; dir: Dir; area: number; focus: boolean }[] = []
    for (const placement of placements) {
      const photo = byId.get(placement.photoId)
      if (!photo) continue
      if (!expandFocus && photo.group === 'focus') continue
      let best: { dir: Dir; area: number } | null = null
      for (const dir of dirs) {
        const candidate = tryExpand(placement, dir, placements, photo, region, gutter, capOf(photo))
        if (candidate && (!best || candidate.area > best.area)) {
          best = { dir, area: candidate.area }
        }
      }
      if (best) {
        candidates.push({
          photoId: placement.photoId,
          dir: best.dir,
          area: best.area,
          focus: photo.group === 'focus',
        })
      }
    }
    if (candidates.length === 0) break
    candidates.sort(
      (a, b) =>
        Number(b.focus) - Number(a.focus) ||
        b.area - a.area ||
        (order.get(a.photoId) ?? 0) - (order.get(b.photoId) ?? 0),
    )
    for (const candidate of candidates) {
      const placement = placements.find((item) => item.photoId === candidate.photoId)
      const photo = byId.get(candidate.photoId)
      if (!placement || !photo) continue
      const fresh = tryExpand(placement, candidate.dir, placements, photo, region, gutter, capOf(photo))
      if (!fresh || fresh.area < EPS) continue
      placements[placements.indexOf(placement)] = fresh.next
    }
  }
  return placements
}

function distributeVertical(placements: Placement[], _region: Rect, _gutter: number): Placement[] {
  return placements
}

function healthyArea(region: Rect): number {
  const edge = Math.max(120, Math.min(region.w, region.h) * 0.22)
  return edge * edge
}

function minFocusCellArea(
  page: Rect,
  focusCount: number,
  nicheCount: number,
  includeAll: boolean,
): number {
  const usable = Math.max(1, cellArea(page) * 0.94)
  if (focusCount <= 0) return 0
  const healthy = healthyArea(page)
  const nPack = includeAll
    ? Math.max(0, nicheCount)
    : Math.max(0, Math.min(nicheCount, Math.floor((usable * 0.9) / Math.max(healthy, 1))))
  const denom = FOCUS_ROW_SCALE * focusCount + nPack
  return (usable * FOCUS_ROW_SCALE) / Math.max(denom, FOCUS_ROW_SCALE * focusCount)
}

function splitRect(region: Rect, gutter: number): [Rect, Rect] | null {
  const g = Math.max(0, gutter)
  if (region.w >= region.h && region.w > g + 28) {
    const w1 = (region.w - g) / 2
    if (w1 < 12 || region.w - w1 - g < 12) return null
    return [
      { x: region.x, y: region.y, w: w1, h: region.h },
      { x: region.x + w1 + g, y: region.y, w: region.w - w1 - g, h: region.h },
    ]
  }
  if (region.h > g + 28) {
    const h1 = (region.h - g) / 2
    if (h1 < 12 || region.h - h1 - g < 12) return null
    return [
      { x: region.x, y: region.y, w: region.w, h: h1 },
      { x: region.x, y: region.y + h1 + g, w: region.w, h: region.h - h1 - g },
    ]
  }
  return null
}

function splitPhotosByArea(photos: Photo[], a: Rect, b: Rect): [Photo[], Photo[]] {
  if (photos.length <= 1) return [photos.slice(), []]
  const wa = Math.max(1, cellArea(a))
  const wb = Math.max(1, cellArea(b))
  const n0 = clamp(Math.round((photos.length * wa) / (wa + wb)), 1, photos.length - 1)
  return [photos.slice(0, n0), photos.slice(n0)]
}

function boxForArea(photo: Photo, area: number, maxW: number, maxH: number): { w: number; h: number } {
  const { min, max } = legalAspectRange(photo)
  const aspect = clamp(preferredAspect(photo), min, max)
  let h = Math.sqrt(Math.max(1, area) / Math.max(aspect, 0.001))
  let w = h * aspect
  if (w > maxW) {
    w = Math.max(1, maxW)
    h = w / aspect
  }
  if (h > maxH) {
    h = Math.max(1, maxH)
    w = h * aspect
  }
  if (w > maxW) {
    w = Math.max(1, maxW)
    h = w / aspect
  }
  return { w: Math.max(1, w), h: Math.max(1, h) }
}

function cappedCell(photo: Photo, region: Rect, maxArea: number, gutter: number): Placement | null {
  const cap = Math.max(1, maxArea)
  const { min, max } = legalAspectRange(photo)
  const aspect = clamp(preferredAspect(photo), min, max)
  let h = Math.sqrt(cap / aspect)
  let w = h * aspect
  w = Math.min(w, region.w)
  h = Math.min(h, region.h)
  if (w * h > cap) {
    const scale = Math.sqrt(cap / Math.max(w * h, 0.001))
    w *= scale
    h *= scale
  }
  if (w < 8 || h < 8) return null
  const g = Math.max(0, gutter)
  if (w > region.w - g && h > region.h - g) return null
  return fillCell(photo, { x: region.x, y: region.y, w, h })
}

function fillCell(photo: Photo, box: Rect): Placement {
  if (!fitsAspect(photo, box.w, box.h)) return toPlacement(photo, box)
  const src = sourceRectForAspect(photo, box.w / Math.max(box.h, 0.001))
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

function photosCanFill(
  photos: Photo[],
  region: Rect,
  gutter: number,
  includeAll: boolean,
  maxArea?: number,
): boolean {
  if (region.w <= gutter + EPS || region.h <= gutter + EPS) return true
  if (photos.length === 0) return false
  const trySet = (set: Photo[]) => {
    if (set.length === 0) return false
    if (maxArea != null && Number.isFinite(maxArea) && set.length === 1 && cellArea(region) > maxArea + EPS) {
      return false
    }
    if (set.length === 1) {
      const limit = rowLimits(set, region.w, gutter)
      if (limit.hMin <= region.h + EPS && limit.hMax >= region.h - EPS) return true
      const { min, max } = legalAspectRange(set[0])
      const wLo = min * region.h
      const wHi = max * region.h
      return wLo <= region.w + EPS && wHi >= region.w - EPS && fitsAspect(set[0], region.w, region.h)
    }
    const merged = mergeToFit(set, region.w, region.h, gutter)
    if (partitionCanFill(merged, region.w, region.h, gutter)) return true
    return partitionCanFill(bestPartition(set, region.w, region.h, gutter), region.w, region.h, gutter)
  }
  if (includeAll) return trySet(photos)
  for (let n = 1; n <= photos.length; n++) {
    if (trySet(photos.slice(0, n))) return true
  }
  return false
}

function leftoverViable(
  photos: Photo[],
  rest: Rect,
  gutter: number,
  includeAll: boolean,
  maxArea?: number,
): boolean {
  if (rest.w <= gutter + EPS || rest.h <= gutter + EPS) return true
  if (photos.length === 0) return false
  return photosCanFill(photos, rest, gutter, includeAll, maxArea)
}

function largestLegalCell(photo: Photo, region: Rect, gutter: number, maxArea?: number): Rect | null {
  const { min, max } = legalAspectRange(photo)
  const cap = maxArea ?? Number.POSITIVE_INFINITY
  const pref = preferredAspect(photo)
  const g = Math.max(0, gutter)
  const areaOk = (w: number, h: number) => w >= 12 && h >= 12 && w * h <= cap + EPS
  const bandHi = Math.min(region.h, region.w / Math.max(min, 0.001), cap / Math.max(region.w, 0.001))
  const bandLo = region.w / Math.max(max, 0.001)
  if (bandLo <= bandHi + EPS && bandLo <= region.h + EPS) {
    const h = clamp(region.w / Math.max(pref, 0.001), bandLo, bandHi)
    if (areaOk(region.w, h) && fitsAspect(photo, region.w, h)) {
      return { x: region.x, y: region.y, w: region.w, h }
    }
  }
  const stripHi = Math.min(region.w, max * region.h, cap / Math.max(region.h, 0.001))
  const stripLo = min * region.h
  if (stripLo <= stripHi + EPS && stripLo <= region.w + EPS) {
    const w = clamp(pref * region.h, stripLo, stripHi)
    if (areaOk(w, region.h) && fitsAspect(photo, w, region.h)) {
      return { x: region.x, y: region.y, w, h: region.h }
    }
  }
  if (fitsAspect(photo, region.w, region.h) && areaOk(region.w, region.h)) return { ...region }
  if (g > region.w || g > region.h) return null
  return null
}

function restAfter(region: Rect, cell: Rect, gutter: number): Rect | null {
  const g = Math.max(0, gutter)
  const bottom = region.y + region.h - (cell.y + cell.h)
  if (bottom > g + EPS) {
    return { x: region.x, y: cell.y + cell.h + g, w: region.w, h: region.h - cell.h - g }
  }
  const right = region.x + region.w - (cell.x + cell.w)
  if (right > g + EPS) {
    return { x: cell.x + cell.w + g, y: region.y, w: region.w - cell.w - g, h: region.h }
  }
  return null
}

function splitOptions(region: Rect, gutter: number): [Rect, Rect][] {
  const g = Math.max(0, gutter)
  const vertical: [Rect, Rect] | null =
    region.w > g + 28
      ? (() => {
          const w1 = (region.w - g) / 2
          if (w1 < 12 || region.w - w1 - g < 12) return null
          return [
            { x: region.x, y: region.y, w: w1, h: region.h },
            { x: region.x + w1 + g, y: region.y, w: region.w - w1 - g, h: region.h },
          ]
        })()
      : null
  const horizontal: [Rect, Rect] | null =
    region.h > g + 28
      ? (() => {
          const h1 = (region.h - g) / 2
          if (h1 < 12 || region.h - h1 - g < 12) return null
          return [
            { x: region.x, y: region.y, w: region.w, h: h1 },
            { x: region.x, y: region.y + h1 + g, w: region.w, h: region.h - h1 - g },
          ]
        })()
      : null
  const out: [Rect, Rect][] = []
  if (region.w >= region.h) {
    if (vertical) out.push(vertical)
    if (horizontal) out.push(horizontal)
  } else {
    if (horizontal) out.push(horizontal)
    if (vertical) out.push(vertical)
  }
  return out
}

function halvesViable(
  photos: Photo[],
  parts: [Rect, Rect],
  gutter: number,
  includeAll: boolean,
  maxArea?: number,
): boolean {
  if (photos.length === 0) return false
  if (photos.length === 1) {
    return leftoverViable(photos, parts[0], gutter, includeAll, maxArea)
  }
  if (includeAll) {
    const [g0, g1] = splitPhotosByArea(photos, parts[0], parts[1])
    return (
      leftoverViable(g0, parts[0], gutter, true, maxArea) &&
      leftoverViable(g1, parts[1], gutter, true, maxArea)
    )
  }
  return leftoverViable(photos, parts[0], gutter, false, maxArea)
}

function chooseSlice(
  photo: Photo,
  region: Rect,
  restPhotos: Photo[],
  gutter: number,
  includeAll: boolean,
  targetArea: number,
  maxArea?: number,
): { cell: Rect; rest: Rect } | null {
  const remaining = restPhotos.length + 1
  if (region.w < 16 || region.h < 16) return null
  const { min, max } = legalAspectRange(photo)
  const g = Math.max(0, gutter)
  const regionArea = cellArea(region)
  const cap = maxArea ?? Number.POSITIVE_INFINITY
  const want = Math.min(
    includeAll ? regionArea / remaining : Math.min(targetArea, regionArea * 0.58),
    cap,
  )
  const pref = preferredAspect(photo)

  const vertical = (cellW: number): { cell: Rect; rest: Rect } | null => {
    if (cellW < 12 || cellW > region.w - g - 12) return null
    if (!fitsAspect(photo, cellW, region.h)) return null
    if (cellW * region.h > cap + EPS) return null
    const restW = region.w - cellW - g
    if (restW < 12) return null
    return {
      cell: { x: region.x, y: region.y, w: cellW, h: region.h },
      rest: { x: region.x + cellW + g, y: region.y, w: restW, h: region.h },
    }
  }
  const horizontal = (cellH: number): { cell: Rect; rest: Rect } | null => {
    if (cellH < 12 || cellH > region.h - g - 12) return null
    if (!fitsAspect(photo, region.w, cellH)) return null
    if (region.w * cellH > cap + EPS) return null
    const restH = region.h - cellH - g
    if (restH < 12) return null
    return {
      cell: { x: region.x, y: region.y, w: region.w, h: cellH },
      rest: { x: region.x, y: region.y + cellH + g, w: region.w, h: restH },
    }
  }

  const raw: { cell: Rect; rest: Rect }[] = []
  const push = (cut: { cell: Rect; rest: Rect } | null) => {
    if (!cut) return
    raw.push(cut)
  }
  const vLo = min * region.h
  const vHi = Math.min(max * region.h, region.w - g - 12, cap / Math.max(region.h, 0.001))
  if (vLo <= vHi + EPS) {
    push(vertical(clamp(want / region.h, vLo, vHi)))
    push(vertical(clamp(pref * region.h, vLo, vHi)))
    push(vertical(vLo))
    push(vertical(vHi))
  }
  const hLo = region.w / Math.max(max, 0.001)
  const hHi = Math.min(region.w / Math.max(min, 0.001), region.h - g - 12, cap / Math.max(region.w, 0.001))
  if (hLo <= hHi + EPS) {
    push(horizontal(clamp(want / region.w, hLo, hHi)))
    push(horizontal(clamp(region.w / Math.max(pref, 0.001), hLo, hHi)))
    push(horizontal(hLo))
    push(horizontal(hHi))
  }

  const seen = new Set<string>()
  const viable: { cell: Rect; rest: Rect }[] = []
  for (const cut of raw) {
    const key = `${cut.cell.w.toFixed(2)}x${cut.cell.h.toFixed(2)}`
    if (seen.has(key)) continue
    seen.add(key)
    if (!leftoverViable(restPhotos, cut.rest, gutter, includeAll, maxArea)) continue
    viable.push(cut)
  }
  if (viable.length === 0) return null
  viable.sort((a, b) => {
    const score = (cut: { cell: Rect; rest: Rect }) => {
      const aspect = cut.cell.w / Math.max(cut.cell.h, 0.001)
      return Math.abs(aspect - pref) + Math.abs(cellArea(cut.cell) - want) / Math.max(want, 1)
    }
    return score(a) - score(b)
  })
  return viable[0]
}

function packIntoHalves(
  photos: Photo[],
  parts: [Rect, Rect],
  gutter: number,
  includeAll: boolean,
  maxArea: number | undefined,
  goal: number,
  depth: number,
): Placement[] {
  if (includeAll && photos.length > 1) {
    const [g0, g1] = splitPhotosByArea(photos, parts[0], parts[1])
    return [
      ...slicePack(g0, parts[0], gutter, includeAll, maxArea, goal, depth + 1),
      ...slicePack(g1, parts[1], gutter, includeAll, maxArea, goal, depth + 1),
    ]
  }
  const first = slicePack(photos, parts[0], gutter, includeAll, maxArea, goal, depth + 1)
  const used = new Set(first.map((item) => item.photoId))
  return [
    ...first,
    ...slicePack(
      photos.filter((photo) => !used.has(photo.id)),
      parts[1],
      gutter,
      includeAll,
      maxArea,
      goal,
      depth + 1,
    ),
  ]
}

function rowPlan(photos: Photo[], region: Rect, gutter: number, includeAll: boolean): Placement[] | null {
  if (photos.length === 0) return null
  const sets = includeAll ? [photos] : photos.map((_, n) => photos.slice(0, n + 1))
  for (const set of sets) {
    const merged = mergeToFit(set, region.w, region.h, gutter)
    const rows = partitionCanFill(merged, region.w, region.h, gutter)
      ? merged
      : bestPartition(set, region.w, region.h, gutter)
    if (!partitionCanFill(rows, region.w, region.h, gutter)) continue
    return layoutRows(rows, region, gutter, true)
  }
  return null
}

function finiteCap(maxArea?: number): number | undefined {
  if (maxArea == null || !Number.isFinite(maxArea)) return undefined
  return maxArea
}

function cappedRowLimits(
  row: Photo[],
  width: number,
  gutter: number,
  maxArea?: number,
  minHeight = 0,
): Limits | null {
  const base = rowLimits(row, width, gutter)
  const cap = finiteCap(maxArea)
  const floor = Math.max(8, minHeight)
  if (cap == null) {
    if (floor <= base.hMin + 0.5) return base
    if (floor > base.hMax + 0.5) return null
    return { ...base, hMin: floor, hPref: clamp(base.hPref, floor, base.hMax) }
  }
  if (!(base.hMax + 1e-3 >= base.hMin)) return null
  const specs = row.map((photo) => legalAspectRange(photo))
  const ok = (h: number) => {
    if (h + 0.25 < floor) return false
    let sumMin = 0
    let sumMax = 0
    for (const spec of specs) {
      const upper = Math.min(spec.max, cap / (h * h))
      if (spec.min > upper + 1e-4) return false
      sumMin += spec.min
      sumMax += upper
    }
    const need = base.inner / h
    return sumMin <= need + 1e-3 && sumMax + 1e-3 >= need
  }
  const steps = 28
  const at = (i: number) => base.hMin + ((base.hMax - base.hMin) * i) / steps
  const good: number[] = []
  for (let i = 0; i <= steps; i++) if (ok(at(i))) good.push(i)
  if (good.length === 0) return null
  let runStart = good[0]
  let runEnd = good[0]
  let bestStart = good[0]
  let bestEnd = good[0]
  let bestDist = Infinity
  const pref = base.hPref
  const consider = (start: number, end: number) => {
    const mid = (at(start) + at(end)) / 2
    const dist = Math.abs(mid - pref)
    if (dist < bestDist) {
      bestDist = dist
      bestStart = start
      bestEnd = end
    }
  }
  for (let i = 1; i < good.length; i++) {
    if (good[i] === runEnd + 1) runEnd = good[i]
    else {
      consider(runStart, runEnd)
      runStart = good[i]
      runEnd = good[i]
    }
  }
  consider(runStart, runEnd)
  let lo = at(bestStart)
  let hi = at(bestEnd)
  if (bestStart > 0) {
    let a = at(bestStart - 1)
    let b = lo
    for (let i = 0; i < 12; i++) {
      const mid = (a + b) / 2
      if (ok(mid)) b = mid
      else a = mid
    }
    lo = b
  }
  if (bestEnd < steps) {
    let a = hi
    let b = at(bestEnd + 1)
    for (let i = 0; i < 12; i++) {
      const mid = (a + b) / 2
      if (ok(mid)) a = mid
      else b = mid
    }
    hi = a
  }
  if (hi < lo - 1e-3) return null
  return { inner: base.inner, hMin: lo, hMax: hi, hPref: clamp(pref, lo, hi) }
}

function exactWidths(row: Photo[], height: number, inner: number, cap?: number): number[] | null {
  const finite = finiteCap(cap)
  const specs = row.map((photo) => {
    const { min, max } = legalAspectRange(photo)
    const minW = min * height
    let maxW = max * height
    if (finite != null) maxW = Math.min(maxW, finite / Math.max(height, 0.001) - 0.08)
    maxW = Math.max(minW, maxW)
    return {
      minW,
      maxW,
      pref: clamp(preferredAspect(photo) * height, minW, maxW),
    }
  })
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)
  if (specs.some((spec) => spec.minW > spec.maxW + 0.75)) return null
  if (sum(specs.map((spec) => spec.minW)) > inner + 0.75) return null
  if (sum(specs.map((spec) => spec.maxW)) < inner - 0.75) return null
  let widths = specs.map((spec) => spec.pref)
  for (let iter = 0; iter < 12; iter++) {
    const diff = inner - sum(widths)
    if (Math.abs(diff) <= 0.2) break
    let roomSum = 0
    const room = widths.map((width, index) => {
      const space = diff > 0 ? specs[index].maxW - width : width - specs[index].minW
      const open = Math.max(0, space)
      roomSum += open
      return open
    })
    if (roomSum <= 0.01) break
    const take = Math.min(Math.abs(diff), roomSum)
    widths = widths.map(
      (width, index) => width + Math.sign(diff) * (room[index] / roomSum) * take,
    )
  }
  let drift = inner - sum(widths)
  if (Math.abs(drift) > 0.05) {
    for (let i = 0; i < widths.length && Math.abs(drift) > 0.05; i++) {
      const next = clamp(widths[i] + drift, specs[i].minW, specs[i].maxW)
      drift -= next - widths[i]
      widths[i] = next
    }
  }
  let err = inner - sum(widths)
  const last = widths.length - 1
  widths[last] += err
  if (widths[last] > specs[last].maxW) {
    let extra = widths[last] - specs[last].maxW
    widths[last] = specs[last].maxW
    for (let i = 0; i < last && extra > 0.01; i++) {
      const room = specs[i].maxW - widths[i]
      const take = Math.min(Math.max(0, room), extra)
      widths[i] += take
      extra -= take
    }
    err = extra
  } else {
    err = 0
  }
  if (widths[last] < specs[last].minW - 0.75) return null
  if (err > 1.5) return null
  if (finite != null && widths.some((width) => width * height > finite + 0.75 * height)) return null
  return widths
}

function layoutExact(
  rows: Photo[][],
  heights: number[],
  region: Rect,
  gutter: number,
  maxArea?: number,
): Placement[] | null {
  const placed: Placement[] = []
  let y = region.y
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]
    const lastRow = r === rows.length - 1
    const h = lastRow ? region.y + region.h - y : heights[r]
    if (!(h >= 8)) return null
    const gaps = Math.max(0, row.length - 1) * gutter
    const inner = region.w - gaps
    const widths = exactWidths(row, h, inner, maxArea)
    if (!widths) return null
    let x = region.x
    for (let i = 0; i < row.length; i++) {
      const w = widths[i]
      if (!(w >= 8)) return null
      const aspect = w / h
      const { min, max } = legalAspectRange(row[i])
      if (aspect < min - 1e-3 || aspect > max + 1e-3) return null
      const cap = finiteCap(maxArea)
      if (cap != null && w * h > cap + 0.5) return null
      placed.push(fillCell(row[i], { x, y, w, h }))
      x += w
      if (i < row.length - 1) x += gutter
    }
    if (Math.abs(x - (region.x + region.w)) > 1.25) return null
    y += h
    if (!lastRow) y += gutter
  }
  if (Math.abs(y - (region.y + region.h)) > 1.25) return null
  return placed
}

type RowCover = { rows: Photo[][]; heights: number[] }

function coveringPartition(
  photos: Photo[],
  width: number,
  height: number,
  gutter: number,
  maxArea?: number,
  minHeight = 0,
): RowCover | null {
  const n = photos.length
  if (n === 0 || width < 8 || height < 8) return null
  const limitsAt = new Map<string, Limits | null>()
  const limitsOf = (start: number, len: number) => {
    const key = `${start}:${len}`
    const cached = limitsAt.get(key)
    if (cached !== undefined) return cached
    const lim = cappedRowLimits(photos.slice(start, start + len), width, gutter, maxArea, minHeight)
    limitsAt.set(key, lim)
    return lim
  }
  const mergeIv = (list: { min: number; max: number }[]) => {
    if (list.length === 0) return []
    list.sort((a, b) => a.min - b.min || a.max - b.max)
    const merged = [{ min: list[0].min, max: list[0].max }]
    for (let i = 1; i < list.length; i++) {
      const last = merged[merged.length - 1]
      if (list[i].min <= last.max + 0.4) last.max = Math.max(last.max, list[i].max)
      else merged.push({ min: list[i].min, max: list[i].max })
    }
    return merged
  }
  const ach: { min: number; max: number }[][] = Array(n + 1)
  ach[n] = [{ min: 0, max: 0 }]
  for (let i = n - 1; i >= 0; i--) {
    const acc: { min: number; max: number }[] = []
    const remain = n - i
    for (let len = 1; len <= remain; len++) {
      const lim = limitsOf(i, len)
      const rest = ach[i + len]
      if (!lim || !rest) continue
      const gap = i + len === n ? 0 : gutter
      for (const iv of rest) {
        acc.push({ min: lim.hMin + gap + iv.min, max: lim.hMax + gap + iv.max })
      }
    }
    ach[i] = mergeIv(acc)
  }
  const root = ach[0] ?? []
  if (!root.some((iv) => height >= iv.min - EPS && height <= iv.max + EPS)) return null

  const buildMemo = new Map<string, RowCover | null>()
  const build = (index: number, heightLeft: number): RowCover | null => {
    const key = `${index}:${heightLeft.toFixed(2)}`
    if (buildMemo.has(key)) return buildMemo.get(key) ?? null
    if (index === n) {
      const done = Math.abs(heightLeft) <= 0.8 ? { rows: [], heights: [] } : null
      buildMemo.set(key, done)
      return done
    }
    const bands = ach[index] ?? []
    if (!bands.some((iv) => heightLeft >= iv.min - EPS && heightLeft <= iv.max + EPS)) {
      buildMemo.set(key, null)
      return null
    }
    for (let len = 1; len <= n - index; len++) {
      const lim = limitsOf(index, len)
      if (!lim) continue
      const last = index + len === n
      if (last) {
        if (heightLeft < lim.hMin - EPS || heightLeft > lim.hMax + EPS) continue
        const done = { rows: [photos.slice(index, index + len)], heights: [heightLeft] }
        buildMemo.set(key, done)
        return done
      }
      const rest = ach[index + len] ?? []
      for (const iv of rest) {
        const lo = Math.max(lim.hMin, heightLeft - gutter - iv.max)
        const hi = Math.min(lim.hMax, heightLeft - gutter - iv.min)
        if (lo > hi + EPS) continue
        const h = clamp(lim.hPref, lo, hi)
        const built = build(index + len, heightLeft - h - gutter)
        if (!built) continue
        const done = {
          rows: [photos.slice(index, index + len), ...built.rows],
          heights: [h, ...built.heights],
        }
        buildMemo.set(key, done)
        return done
      }
    }
    buildMemo.set(key, null)
    return null
  }
  return build(0, height)
}

function regionCovered(region: Rect, placed: Placement[], gutter: number): boolean {
  if (placed.length === 0) return false
  const slack = Math.max(1.5, gutter)
  return leftoverHoles(region, placed, gutter).every((hole) => Math.min(hole.w, hole.h) <= slack)
}

const coverMemo = new Map<string, Placement[] | null>()

function coverSplits(region: Rect, gutter: number): [Rect, Rect][] {
  const g = Math.max(0, gutter)
  const out: [Rect, Rect][] = []
  const addV = (fraction: number) => {
    if (region.w <= g + 36) return
    const w1 = (region.w - g) * fraction
    const w2 = region.w - g - w1
    if (w1 < 16 || w2 < 16) return
    out.push([
      { x: region.x, y: region.y, w: w1, h: region.h },
      { x: region.x + w1 + g, y: region.y, w: w2, h: region.h },
    ])
  }
  const addH = (fraction: number) => {
    if (region.h <= g + 36) return
    const h1 = (region.h - g) * fraction
    const h2 = region.h - g - h1
    if (h1 < 16 || h2 < 16) return
    out.push([
      { x: region.x, y: region.y, w: region.w, h: h1 },
      { x: region.x, y: region.y + h1 + g, w: region.w, h: h2 },
    ])
  }
  if (region.w >= region.h) {
    addV(0.5)
    addV(0.4)
    addV(0.6)
    addH(0.5)
  } else {
    addH(0.5)
    addH(0.4)
    addH(0.6)
    addV(0.5)
  }
  return out
}

function coverByRows(
  photos: Photo[],
  region: Rect,
  gutter: number,
  includeAll: boolean,
  maxArea?: number,
): Placement[] | null {
  const area = cellArea(region)
  const cap = finiteCap(maxArea)
  const start = !includeAll && cap != null ? Math.max(1, Math.ceil(area / cap) - 2) : 1
  const counts = includeAll ? [photos.length] : []
  if (!includeAll) {
    for (let k = start; k <= photos.length; k++) counts.push(k)
  }
  for (const count of counts) {
    if (count < 1 || count > photos.length) continue
    const fair = Math.min(cap ?? area, area / Math.max(1, count))
    const minH = Math.max(24, Math.sqrt((fair * 0.45) / 1.9))
    const part = coveringPartition(
      photos.slice(0, count),
      region.w,
      region.h,
      gutter,
      maxArea,
      minH,
    )
    if (!part) continue
    const placed = layoutExact(part.rows, part.heights, region, gutter, maxArea)
    if (placed && regionCovered(region, placed, gutter)) {
      if (!includeAll && placed.length > 1) {
        const areas = placed.map(cellArea)
        if (Math.min(...areas) < Math.max(...areas) * 0.4) continue
      }
      return placed
    }
  }
  return null
}

function coverRegion(
  photos: Photo[],
  region: Rect,
  gutter: number,
  includeAll: boolean,
  maxArea: number | undefined,
  depth: number,
): Placement[] | null {
  if (photos.length === 0 || region.w < 8 || region.h < 8) return null
  const capKey = finiteCap(maxArea) ?? 'inf'
  const key = [
    photos[0].id,
    photos.length,
    Math.round(region.x),
    Math.round(region.y),
    Math.round(region.w),
    Math.round(region.h),
    includeAll ? 1 : 0,
    capKey,
    Math.round(gutter * 10),
    depth,
  ].join(':')
  if (coverMemo.has(key)) return coverMemo.get(key) ?? null

  const rows = coverByRows(photos, region, gutter, includeAll, maxArea)
  if (rows) {
    coverMemo.set(key, rows)
    return rows
  }
  if (depth >= 1 || photos.length < 2) {
    coverMemo.set(key, null)
    return null
  }

  let best: Placement[] | null = null
  for (const parts of coverSplits(region, gutter)) {
    const maxK = photos.length - 1
    const share = cellArea(parts[0]) / Math.max(1, cellArea(parts[0]) + cellArea(parts[1]))
    const ideal = clamp(Math.round(photos.length * share), 1, maxK)
    const ks: number[] = []
    const span = includeAll ? Math.min(10, maxK) : maxK
    for (let delta = 0; delta <= span; delta++) {
      if (ideal - delta >= 1) ks.push(ideal - delta)
      if (delta > 0 && ideal + delta <= maxK) ks.push(ideal + delta)
    }
    for (const k of ks) {
      if (!includeAll && best && k >= best.length) continue
      const left = coverRegion(photos.slice(0, k), parts[0], gutter, true, maxArea, depth + 1)
      if (!left || left.length !== k) continue
      const right = coverRegion(photos.slice(k), parts[1], gutter, includeAll, maxArea, depth + 1)
      if (!right || right.length === 0) continue
      const placed = [...left, ...right]
      if (!regionCovered(region, placed, gutter)) continue
      if (includeAll && placed.length !== photos.length) continue
      if (!includeAll && best && placed.length >= best.length) continue
      best = placed
      if (includeAll || !includeAll) {
        coverMemo.set(key, best)
        return best
      }
    }
  }
  coverMemo.set(key, best)
  return best
}

function slicePack(
  photos: Photo[],
  region: Rect,
  gutter: number,
  includeAll: boolean,
  maxArea?: number,
  targetArea?: number,
  depth = 0,
): Placement[] {
  if (photos.length === 0 || region.w < 8 || region.h < 8) return []
  if (depth === 0 && Math.min(region.w, region.h) < 36) return []
  if (depth === 0) {
    const covered = coverRegion(photos, region, gutter, includeAll, maxArea, 0)
    if (
      covered &&
      covered.length > 0 &&
      regionCovered(region, covered, gutter) &&
      (!includeAll || covered.length === photos.length)
    ) {
      return covered
    }
    if (!includeAll) return []
  }
  const cap = maxArea ?? Number.POSITIVE_INFINITY
  const regionArea = cellArea(region)
  const goal = Math.min(
    targetArea ?? (includeAll ? regionArea / photos.length : healthyArea(region)),
    cap,
  )
  const areaCap = cap < Infinity ? cap : undefined
  const legalOne = (photo: Photo) => {
    if (fitsAspect(photo, region.w, region.h) && regionArea <= cap + EPS) {
      return fillCell(photo, region)
    }
    const cell = largestLegalCell(photo, region, gutter, areaCap)
    return cell ? fillCell(photo, cell) : null
  }

  if (depth > 48) {
    if (areaCap != null && regionArea > cap + EPS) {
      const capped = cappedCell(photos[0], region, cap, gutter)
      if (capped) return [capped]
    }
    const one = legalOne(photos[0])
    return one ? [one] : includeAll ? [fillCell(photos[0], region)] : []
  }

  const tooBig = areaCap != null && regionArea > cap + EPS
  if (tooBig) {
    for (const parts of splitOptions(region, gutter)) {
      if (!halvesViable(photos, parts, gutter, includeAll, maxArea)) continue
      return packIntoHalves(photos, parts, gutter, includeAll, maxArea, goal, depth)
    }
    const parts = splitRect(region, gutter)
    if (parts) return packIntoHalves(photos, parts, gutter, includeAll, maxArea, goal, depth)
  }

  if (photos.length === 1) {
    if (tooBig) {
      const cell = largestLegalCell(photos[0], region, gutter, areaCap)
      if (cell && cellArea(cell) <= cap + EPS) return [fillCell(photos[0], cell)]
      const capped = cappedCell(photos[0], region, cap, gutter)
      return capped ? [capped] : includeAll ? [fillCell(photos[0], region)] : []
    }
    const one = legalOne(photos[0])
    return one ? [one] : includeAll ? [fillCell(photos[0], region)] : []
  }

  if (
    !includeAll &&
    regionArea <= goal * 1.15 &&
    regionArea <= cap + EPS &&
    fitsAspect(photos[0], region.w, region.h)
  ) {
    return [fillCell(photos[0], region)]
  }

  for (let i = 0; i < photos.length; i++) {
    const restPhotos = i === 0 ? photos.slice(1) : photos.filter((_, index) => index !== i)
    const cut = chooseSlice(photos[i], region, restPhotos, gutter, includeAll, goal, maxArea)
    if (!cut) continue
    return [
      fillCell(photos[i], cut.cell),
      ...slicePack(restPhotos, cut.rest, gutter, includeAll, maxArea, goal, depth + 1),
    ]
  }

  for (const parts of splitOptions(region, gutter)) {
    if (!halvesViable(photos, parts, gutter, includeAll, maxArea)) continue
    return packIntoHalves(photos, parts, gutter, includeAll, maxArea, goal, depth)
  }

  const rows = rowPlan(photos, region, gutter, includeAll)
  if (rows) return rows

  const fallbackParts = splitRect(region, gutter)
  if (fallbackParts && photos.length > 1) {
    return packIntoHalves(photos, fallbackParts, gutter, includeAll, maxArea, goal, depth)
  }

  const cell = largestLegalCell(photos[0], region, gutter, areaCap)
  if (cell) {
    const rest = restAfter(region, cell, gutter)
    if (rest && photos.length > 1) {
      return [
        fillCell(photos[0], cell),
        ...slicePack(photos.slice(1), rest, gutter, includeAll, maxArea, goal, depth + 1),
      ]
    }
    return [fillCell(photos[0], cell)]
  }

  if (areaCap != null && regionArea > cap + EPS) {
    const capped = cappedCell(photos[0], region, cap, gutter)
    return capped ? [capped] : includeAll ? [fillCell(photos[0], region)] : []
  }
  return includeAll ? [fillCell(photos[0], region)] : []
}

function riverFill(
  photos: Photo[],
  region: Rect,
  gutter: number,
  targetH?: number,
  includeAll = true,
): Placement[] {
  if (photos.length === 0 || region.w < 8 || region.h < 8) return []
  if (photos.length === 1 && targetH == null) return [placeSingle(photos[0], region)]

  if (!includeAll && targetH == null) {
    const packed = slicePack(photos, region, gutter, false)
    return gapFill(packed, photos.filter((photo) => packed.some((item) => item.photoId === photo.id)), region, gutter)
  }

  const rows =
    targetH == null
      ? bestPartition(photos, region.w, region.h, gutter)
      : partitionByTarget(photos, region.w, gutter, targetH)
  if (rows.length === 0) {
    return photos[0] ? [placeSingle(photos[0], region)] : []
  }
  const fill = targetH == null
  let placements = layoutRows(rows, region, gutter, fill, targetH)
  if (fill) placements = distributeVertical(placements, region, gutter)
  return gapFill(placements, photos, region, gutter)
}

function planFocus(pageH: number, gutter: number, focusCount: number, nicheCount: number) {
  const focusPer = Math.max(1, Math.round(Math.sqrt(focusCount)))
  const nichePer = Math.max(1, Math.round(Math.sqrt(nicheCount) + 1))
  const focusRows = Math.max(1, Math.ceil(focusCount / focusPer))
  const nicheRows = Math.max(1, Math.ceil(nicheCount / nichePer))
  const gaps = gutter * Math.max(0, focusRows + nicheRows - 1)
  const available = Math.max(1, pageH - gaps)
  const nicheH = available / (focusRows * FOCUS_ROW_SCALE + nicheRows)
  const focusH = FOCUS_ROW_SCALE * nicheH
  const focusCap =
    focusRows * focusH + Math.max(0, focusRows - 1) * gutter
  return { focusH, focusCap: Math.min(focusCap, pageH - gutter - 36) }
}

function sideAndBottom(page: Rect, focus: Placement[], gutter: number): Rect[] {
  if (focus.length === 0) return [page]
  const rows: Placement[][] = []
  const ordered = [...focus].sort((a, b) => a.y - b.y || a.x - b.x)
  for (const placement of ordered) {
    const last = rows[rows.length - 1]
    if (!last || Math.abs(last[0].y - placement.y) > 1) rows.push([placement])
    else last.push(placement)
  }
  const rects: Rect[] = []
  for (const row of rows) {
    const y = Math.min(...row.map((p) => p.y))
    const bottom = Math.max(...row.map((p) => p.y + p.h))
    const h = bottom - y
    const minX = Math.min(...row.map((p) => p.x))
    const maxX = Math.max(...row.map((p) => p.x + p.w))
    if (minX > page.x + gutter + 64) {
      rects.push({ x: page.x, y, w: minX - page.x - gutter, h })
    }
    const right = maxX + gutter
    if (page.x + page.w - right > 64) {
      rects.push({ x: right, y, w: page.x + page.w - right, h })
    }
  }
  const focusBottom = Math.max(...focus.map((p) => p.y + p.h))
  const y = focusBottom + gutter
  const h = page.y + page.h - y
  if (h > 16) rects.push({ x: page.x, y, w: page.w, h })
  return rects.filter((rect) => rect.w > 48 && rect.h > 36)
}

function splitByArea(photos: Photo[], rects: Rect[]): Photo[][] {
  if (rects.length === 0) return []
  if (rects.length === 1) return [photos.slice()]
  const areas = rects.map((rect) => Math.max(1, rect.w * rect.h))
  const total = areas.reduce((sum, area) => sum + area, 0)
  const exact = areas.map((area) => (photos.length * area) / total)
  const counts = exact.map((value) => Math.floor(value))
  let left = photos.length - counts.reduce((sum, count) => sum + count, 0)
  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac)
  for (let i = 0; left > 0; i++, left--) counts[order[i % order.length].index] += 1

  const groups: Photo[][] = []
  let cursor = 0
  for (const count of counts) {
    groups.push(photos.slice(cursor, cursor + count))
    cursor += count
  }

  let main = 0
  areas.forEach((area, index) => {
    if (area > areas[main]) main = index
  })
  const needy = groups
    .map((group, index) => ({ index, group }))
    .filter((item) => item.index !== main && item.group.length === 0 && rects[item.index].w >= 64)
    .map((item) => item.index)
  const spare = Math.min(needy.length, Math.max(0, groups[main].length - 1))
  if (spare > 0) {
    const taken = groups[main].splice(groups[main].length - spare, spare)
    for (let i = 0; i < spare; i++) groups[needy[i]].push(taken[i])
  }
  return groups
}

function placeFeatured(photo: Photo, page: Rect, gutter: number, anchor: 'top' | 'center'): Placement {
  const g = Math.max(0, gutter)
  const short = Math.min(page.w, page.h)
  const inset = Math.max(g + 64, short * 0.2)
  const maxW = Math.max(64, page.w - 2 * inset)
  const maxH =
    anchor === 'center'
      ? Math.max(64, page.h - 2 * inset)
      : Math.max(64, page.h * 0.62)
  const { w, h } = fitSize(photo, maxW, maxH)
  const x = page.x + (page.w - w) / 2
  const y = anchor === 'center' ? page.y + (page.h - h) / 2 : page.y
  return fillCell(photo, { x, y, w, h })
}

function placeFocus(
  focus: Photo[],
  page: Rect,
  gutter: number,
  nicheCount: number,
  includeAll: boolean,
  anchor: 'top' | 'center' = 'top',
): Placement[] {
  if (focus.length === 1 && nicheCount > 0) {
    return [placeFeatured(focus[0], page, gutter, anchor)]
  }
  const targetA = minFocusCellArea(page, focus.length, nicheCount, includeAll)
  const { focusH, focusCap } = planFocus(page.h, gutter, focus.length, Math.max(1, nicheCount))
  const cols = Math.max(1, Math.round(Math.sqrt(focus.length)))
  const minRowH = targetA / Math.max(1, (page.w - (cols - 1) * gutter) / cols)
  let target = Math.max(focusH, minRowH)
  let rows = partitionByTarget(focus, page.w, gutter, target)
  const minLeftover = Math.max(36, page.h * 0.14)
  const maxH = Math.max(
    48,
    Math.min(
      page.h - gutter - minLeftover,
      Math.max(focusCap, rows.length * target + Math.max(0, rows.length - 1) * gutter),
    ),
  )
  for (let i = 0; i < 8; i++) {
    const probe = layoutRows(rows, { ...page, h: page.h }, gutter, false, target)
    const used = probe.reduce((max, placement) => Math.max(max, placement.y + placement.h), 0)
    if (used <= maxH + 1) break
    target = Math.max(minRowH * 0.9, target * 0.72)
    rows = partitionByTarget(focus, page.w, gutter, target)
  }
  const region = { x: page.x, y: page.y, w: page.w, h: maxH }
  return layoutRows(rows, region, gutter, false, target)
}

function packNicheRects(
  niche: Photo[],
  rects: Rect[],
  gutter: number,
  includeAll: boolean,
  maxArea: number,
): Placement[] {
  if (rects.length === 0 || niche.length === 0) return []
  const nichePlaced: Placement[] = []
  if (includeAll) {
    const groups = splitByArea(niche, rects)
    for (let index = 0; index < rects.length; index++) {
      const group = groups[index] ?? []
      if (group.length === 0) continue
      nichePlaced.push(...slicePack(group, rects[index], gutter, true, maxArea))
    }
    return nichePlaced
  }
  let remaining = niche.slice()
  for (const rect of rects) {
    if (remaining.length === 0) break
    const packed = slicePack(remaining, rect, gutter, false, maxArea)
    const used = new Set(packed.map((item) => item.photoId))
    remaining = remaining.filter((photo) => !used.has(photo.id))
    nichePlaced.push(...packed)
  }
  return nichePlaced
}

function packTopMixed(
  focus: Photo[],
  niche: Photo[],
  full: Rect,
  gutter: number,
  tagged: Photo[],
  includeAll: boolean,
): Placement[] {
  const focusPlaced = placeFocus(focus, full, gutter, niche.length, includeAll)
  const cap = nicheAreaCap(focusPlaced)
  const rects = sideAndBottom(full, focusPlaced, gutter)
  const nichePlaced = packNicheRects(niche, rects, gutter, includeAll, cap)
  const combined = [...focusPlaced, ...nichePlaced]
  const used = new Set(combined.map((item) => item.photoId))
  const leftover = niche.filter((photo) => !used.has(photo.id))
  const focusIds = new Set(focus.map((photo) => photo.id))
  return gapFill(
    combined,
    tagged,
    full,
    gutter,
    cap,
    GAP_PASSES,
    canGrowFocus(combined, leftover, focusIds),
  )
}

function flipY(placements: Placement[], pageH: number): Placement[] {
  return placements.map((placement) => ({
    ...placement,
    y: pageH - placement.y - placement.h,
  }))
}

function inflate(rect: Rect, pad: number): Rect {
  return { x: rect.x - pad, y: rect.y - pad, w: rect.w + pad * 2, h: rect.h + pad * 2 }
}

function subtractRect(free: Rect, used: Rect, gutter: number): Rect[] {
  const blocked = inflate(used, gutter)
  if (!boxesOverlap(free, blocked, 0)) return [free]
  const gap = gutter
  const out: Rect[] = []
  const minPiece = gutter + EPS
  const topH = blocked.y - gap - free.y
  if (topH > minPiece) out.push({ x: free.x, y: free.y, w: free.w, h: topH })
  const bottomY = blocked.y + blocked.h + gap
  const bottomH = free.y + free.h - bottomY
  if (bottomH > minPiece) out.push({ x: free.x, y: bottomY, w: free.w, h: bottomH })
  const top = Math.max(free.y, blocked.y)
  const bot = Math.min(free.y + free.h, blocked.y + blocked.h)
  const midH = bot - top
  if (midH > minPiece) {
    const leftW = blocked.x - gap - free.x
    if (leftW > minPiece) out.push({ x: free.x, y: top, w: leftW, h: midH })
    const rightX = blocked.x + blocked.w + gap
    const rightW = free.x + free.w - rightX
    if (rightW > minPiece) out.push({ x: rightX, y: top, w: rightW, h: midH })
  }
  return out
}

function freeRects(page: Rect, occupied: Placement[], gutter: number): Rect[] {
  let free = [page]
  for (const item of occupied) {
    free = free.flatMap((rect) => subtractRect(rect, item, gutter))
  }
  return free
}

function fillLeftovers(
  niche: Photo[],
  occupied: Placement[],
  page: Rect,
  gutter: number,
  tagged: Photo[],
  includeAll: boolean,
): Placement[] {
  const cap = nicheAreaCap(occupied)
  const rects = freeRects(page, occupied, gutter)
    .filter((rect) => rect.w > 48 && rect.h > 36)
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const focusIds = new Set(occupied.map((item) => item.photoId))
  if (rects.length === 0 || niche.length === 0) {
    return gapFill(
      occupied,
      tagged,
      page,
      gutter,
      cap,
      GAP_PASSES,
      canGrowFocus(occupied, niche, focusIds),
    )
  }
  const nichePlaced = packNicheRects(niche, rects, gutter, includeAll, cap)
  const combined = [...occupied, ...nichePlaced]
  const used = new Set(combined.map((item) => item.photoId))
  const leftover = niche.filter((photo) => !used.has(photo.id))
  return gapFill(
    combined,
    tagged,
    page,
    gutter,
    cap,
    GAP_PASSES,
    canGrowFocus(combined, leftover, focusIds),
  )
}

function ringOrder(focus: Photo[], niche: Photo[], includeAll: boolean): Photo[] {
  const pool = includeAll ? niche : niche.slice(0, Math.min(niche.length, Math.max(8, focus.length * 4)))
  const wide = pool.filter((photo) => preferredAspect(photo) >= 1)
  const tall = pool.filter((photo) => preferredAspect(photo) < 1)
  return [...focus, ...wide, ...tall]
}

function seatFocusOnRing(placed: Placement[], focus: Photo[], photos: Photo[], page: Rect): Placement[] {
  if (focus.length === 0 || placed.length === 0) return placed
  const byId = new Map(photos.map((photo) => [photo.id, photo]))
  const next = placed.map((item) => ({ ...item }))
  const corners = [
    { x: page.x, y: page.y },
    { x: page.x + page.w, y: page.y },
    { x: page.x + page.w, y: page.y + page.h },
    { x: page.x, y: page.y + page.h },
  ]
  const used = new Set<number>()
  for (let i = 0; i < focus.length; i++) {
    const photo = focus[i]
    const corner = corners[i % corners.length]
    let best = -1
    let bestD = Infinity
    next.forEach((cell, index) => {
      if (used.has(index) || cell.photoId === photo.id) return
      const d =
        (cell.x + cell.w / 2 - corner.x) ** 2 + (cell.y + cell.h / 2 - corner.y) ** 2
      if (d < bestD) {
        bestD = d
        best = index
      }
    })
    const focusIndex = next.findIndex((cell) => cell.photoId === photo.id)
    if (best < 0 || focusIndex < 0) continue
    const host = byId.get(next[best].photoId)
    const focusBox = { x: next[best].x, y: next[best].y, w: next[best].w, h: next[best].h }
    const otherBox = { x: next[focusIndex].x, y: next[focusIndex].y, w: next[focusIndex].w, h: next[focusIndex].h }
    if (!host || !fitsAspect(photo, focusBox.w, focusBox.h) || !fitsAspect(host, otherBox.w, otherBox.h)) continue
    next[best] = fillCell(photo, focusBox)
    next[focusIndex] = fillCell(host, otherBox)
    used.add(best)
  }
  return next
}

function rowHeightBand(row: Photo[], width: number, gutter: number): { min: number; max: number } | null {
  if (row.length === 0) return null
  const inner = width - Math.max(0, row.length - 1) * gutter
  if (inner < 16) return null
  let sumMin = 0
  let sumMax = 0
  for (const photo of row) {
    const range = legalAspectRange(photo)
    sumMin += range.min
    sumMax += Math.max(range.min, range.max)
  }
  if (sumMax <= 0) return null
  const min = inner / sumMax
  const max = inner / Math.max(sumMin, 0.001)
  if (max + 0.5 < min || min < 8) return null
  return { min, max: Math.max(min, max) }
}

function fitBands(bands: { min: number; max: number }[], total: number): number[] | null {
  let hs = bands.map((band) => clamp(total / bands.length, band.min, band.max))
  for (let iter = 0; iter < 24; iter++) {
    const sum = hs.reduce((acc, value) => acc + value, 0)
    const diff = total - sum
    if (Math.abs(diff) <= 0.4) return hs
    let room = 0
    const slack = hs.map((value, index) => {
      const space = diff > 0 ? bands[index].max - value : value - bands[index].min
      const open = Math.max(0, space)
      room += open
      return open
    })
    if (room <= 0.2) return null
    const take = Math.min(Math.abs(diff), room)
    hs = hs.map((value, index) => value + Math.sign(diff) * (slack[index] / room) * take)
  }
  return null
}

function layoutBandRows(
  rows: Photo[][],
  heights: number[],
  region: Rect,
  gutter: number,
): Placement[] | null {
  const placed: Placement[] = []
  let y = region.y
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]
    const last = r === rows.length - 1
    const h = last ? region.y + region.h - y : heights[r]
    if (h < 8) return null
    const inner = region.w - Math.max(0, row.length - 1) * gutter
    const widths = exactWidths(row, h, inner)
    if (!widths) return null
    let x = region.x
    for (let i = 0; i < row.length; i++) {
      const w = i === row.length - 1 ? region.x + region.w - x : widths[i]
      if (w < 8 || !fitsAspect(row[i], w, h)) return null
      placed.push(fillCell(row[i], { x, y, w, h }))
      x += w
      if (i < row.length - 1) x += gutter
    }
    y += h
    if (!last) y += gutter
  }
  if (Math.abs(y - (region.y + region.h)) > 1.5) return null
  return placed
}

function evenMosaic(photos: Photo[], region: Rect, gutter: number): Placement[] | null {
  if (photos.length === 0) return null
  const sorted = [...photos].sort((a, b) => preferredAspect(a) - preferredAspect(b))
  let best: Placement[] | null = null
  let bestSpread = Infinity
  const maxPer = Math.min(12, photos.length)
  for (let per = 2; per <= maxPer; per++) {
    const rows: Photo[][] = []
    for (let i = 0; i < sorted.length; i += per) rows.push(sorted.slice(i, i + per))
    if (rows.some((row) => row.length === 0)) continue
    const gaps = Math.max(0, rows.length - 1) * gutter
    const bands = rows.map((row) => rowHeightBand(row, region.w, gutter))
    if (bands.some((band) => band == null)) continue
    const heights = fitBands(bands as { min: number; max: number }[], region.h - gaps)
    if (!heights) continue
    const placed = layoutBandRows(rows, heights, region, gutter)
    if (!placed || placed.length !== photos.length) continue
    const areas = placed.map(cellArea)
    const spread = Math.max(...areas) / Math.max(1, Math.min(...areas))
    if (spread < bestSpread) {
      bestSpread = spread
      best = placed
    }
  }
  return best
}

function packRing(
  focus: Photo[],
  niche: Photo[],
  full: Rect,
  gutter: number,
  tagged: Photo[],
  includeAll: boolean,
): Placement[] {
  const pool = includeAll
    ? [...focus, ...niche]
    : [...focus, ...niche.slice(0, Math.min(niche.length, Math.max(6, focus.length * 2)))]
  const mosaic = evenMosaic(pool, full, gutter)
  if (mosaic && mosaic.length === pool.length) {
    const holes = leftoverHoles(full, mosaic, gutter).filter(
      (hole) => Math.min(hole.w, hole.h) > Math.max(gutter, 6),
    )
    if (holes.length === 0) return seatFocusOnRing(mosaic, focus, pool, full)
  }
  const ordered = ringOrder(focus, niche, includeAll)
  const packed = slicePack(ordered, full, gutter, includeAll)
  if (packed.length > focus.length) {
    return seatFocusOnRing(packed, focus, tagged, full)
  }
  const n = focus.length
  const targetA = minFocusCellArea(full, n, niche.length, includeAll)
  const cx = full.x + full.w / 2
  const cy = full.y + full.h / 2
  let size = Math.sqrt(Math.max(1, targetA))
  let rx = full.w * 0.33
  let ry = full.h * 0.33
  if (n > 1) {
    const spacing = (Math.PI * (rx + ry)) / n
    if (size > spacing * 0.85) {
      const grow = size / Math.max(1, spacing * 0.85)
      rx = Math.min(full.w * 0.42, rx * grow)
      ry = Math.min(full.h * 0.42, ry * grow)
    }
  }
  let focusPlaced: Placement[] = []
  for (let attempt = 0; attempt < 12; attempt++) {
    focusPlaced = focus.map((photo, index) => {
      const angle = -Math.PI / 2 + (n === 0 ? 0 : (2 * Math.PI * index) / n)
      const { w, h } = boxForArea(photo, targetA, full.w * 0.5, Math.max(size, Math.sqrt(targetA) * 1.35))
      const x = clamp(cx + Math.cos(angle) * rx - w / 2, full.x, full.x + full.w - w)
      const y = clamp(cy + Math.sin(angle) * ry - h / 2, full.y, full.y + full.h - h)
      return fillCell(photo, { x, y, w, h })
    })
    let hits = 0
    for (let i = 0; i < focusPlaced.length; i++) {
      for (let j = i + 1; j < focusPlaced.length; j++) {
        if (boxesOverlap(focusPlaced[i], focusPlaced[j], gutter)) hits += 1
      }
    }
    if (hits === 0) break
    rx = Math.min(full.w * 0.44, rx * 1.06)
    ry = Math.min(full.h * 0.44, ry * 1.06)
    if (attempt > 6) size = Math.max(Math.sqrt(targetA) * 0.9, size * 0.92)
  }
  return fillLeftovers(niche, focusPlaced, full, gutter, tagged, includeAll)
}

function centerFocusRows(placed: Placement[], focusIds: Set<string>, page: Rect, gutter: number): Placement[] {
  const rows: Placement[][] = []
  for (const cell of [...placed].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const last = rows[rows.length - 1]
    if (!last || Math.abs(last[0].y - cell.y) > 2) rows.push([cell])
    else last.push(cell)
  }
  const focusRows = rows.filter((row) => row.some((cell) => focusIds.has(cell.photoId)))
  const other = rows.filter((row) => !row.some((cell) => focusIds.has(cell.photoId)))
  const otherH = other.reduce((sum, row) => sum + row[0].h, 0)
  let above = 0
  let head = 0
  for (let i = 0; i < other.length; i++) {
    if (above + other[i][0].h / 2 >= otherH / 2) {
      head = i
      break
    }
    above += other[i][0].h
    head = i + 1
  }
  const order = [...other.slice(0, head), ...focusRows, ...other.slice(head)]
  const out: Placement[] = []
  let y = page.y
  order.forEach((row, index) => {
    for (const cell of row) out.push({ ...cell, y })
    y += row[0].h
    if (index < order.length - 1) y += gutter
  })
  return out
}

function packCenter(
  focus: Photo[],
  niche: Photo[],
  full: Rect,
  gutter: number,
  tagged: Photo[],
  includeAll: boolean,
): Placement[] {
  if (includeAll && focus.length > 1 && niche.length > 0) {
    const mosaic = evenMosaic([...focus, ...niche], full, gutter)
    if (mosaic && mosaic.length === focus.length + niche.length) {
      const holes = leftoverHoles(full, mosaic, gutter).filter(
        (hole) => Math.min(hole.w, hole.h) > Math.max(gutter, 6),
      )
      if (holes.length === 0) {
        return centerFocusRows(mosaic, new Set(focus.map((photo) => photo.id)), full, gutter)
      }
    }
  }
  const raw = placeFocus(focus, full, gutter, niche.length, includeAll, 'center')
  if (focus.length === 1 && niche.length > 0) {
    return fillLeftovers(niche, raw, full, gutter, tagged, includeAll)
  }
  const minY = Math.min(...raw.map((item) => item.y))
  const maxY = Math.max(...raw.map((item) => item.y + item.h))
  const dy = full.y + full.h / 2 - (minY + maxY) / 2
  const shifted = raw.map((item) => ({ ...item, y: item.y + dy }))
  return fillLeftovers(niche, shifted, full, gutter, tagged, includeAll)
}

function leftoverHoles(page: Rect, placements: Placement[], gutter: number): Rect[] {
  const minSide = gutter + EPS
  return freeRects(page, placements, gutter)
    .filter((rect) => rect.w > minSide && rect.h > minSide)
    .sort((a, b) => b.w * b.h - a.w * a.h)
}

function edgeSide(cell: Rect, hole: Rect, gutter: number): Dir | null {
  const g = Math.max(0, gutter)
  const tol = Math.max(2, g + 1)
  const vert = cell.y < hole.y + hole.h - EPS && hole.y < cell.y + cell.h - EPS
  const horz = cell.x < hole.x + hole.w - EPS && hole.x < cell.x + cell.w - EPS
  if (vert && Math.abs(cell.x + cell.w + g - hole.x) <= tol) return 'right'
  if (vert && Math.abs(hole.x + hole.w + g - cell.x) <= tol) return 'left'
  if (horz && Math.abs(cell.y + cell.h + g - hole.y) <= tol) return 'down'
  if (horz && Math.abs(hole.y + hole.h + g - cell.y) <= tol) return 'up'
  if (vert && hole.x >= cell.x + cell.w - EPS && hole.x - (cell.x + cell.w) <= g + tol) return 'right'
  if (vert && cell.x >= hole.x + hole.w - EPS && cell.x - (hole.x + hole.w) <= g + tol) return 'left'
  if (horz && hole.y >= cell.y + cell.h - EPS && hole.y - (cell.y + cell.h) <= g + tol) return 'down'
  if (horz && cell.y >= hole.y + hole.h - EPS && cell.y - (hole.y + hole.h) <= g + tol) return 'up'
  return null
}

function expandToward(
  placement: Placement,
  hole: Rect,
  side: Dir,
  photo: Photo,
  others: Placement[],
  page: Rect,
  gutter: number,
  maxArea?: number,
): Placement | null {
  const { min: aMin, max: aMax } = legalAspectRange(photo)
  const areaLimit = maxArea != null && Number.isFinite(maxArea) ? maxArea : Number.POSITIVE_INFINITY
  let x = placement.x
  let y = placement.y
  let w = placement.w
  let h = placement.h

  if (side === 'right' || side === 'left') {
    const limitW = Math.min(aMax * h, areaLimit / Math.max(h, 0.001))
    if (side === 'right') {
      w = Math.min(Math.max(w, hole.x + hole.w - x), limitW, page.x + page.w - x)
    } else {
      w = Math.min(Math.max(w, x + w - hole.x), limitW, x + w - page.x)
      x = placement.x + placement.w - w
    }
  } else {
    const limitH = Math.min(
      w / Math.max(aMin, 0.001),
      areaLimit / Math.max(w, 0.001),
    )
    if (side === 'down') {
      h = Math.min(Math.max(h, hole.y + hole.h - y), limitH, page.y + page.h - y)
    } else {
      h = Math.min(Math.max(h, y + h - hole.y), limitH, y + h - page.y)
      y = placement.y + placement.h - h
    }
  }

  if (w <= placement.w + EPS && h <= placement.h + EPS) return null
  if (
    x < page.x - EPS ||
    y < page.y - EPS ||
    x + w > page.x + page.w + EPS ||
    y + h > page.y + page.h + EPS
  ) {
    return null
  }
  const box = { x, y, w, h }
  for (const other of others) {
    if (other.photoId === placement.photoId) continue
    if (boxesOverlap(box, other, gutter)) return null
  }
  const next = fillCell(photo, box)
  if (cellArea(next) <= cellArea(placement) + EPS) return null
  return next
}

function placeIntoHole(
  remaining: Photo[],
  hole: Rect,
  gutter: number,
  includeAll: boolean,
  maxArea: number,
): Placement[] {
  if (remaining.length === 0 || hole.w <= gutter + EPS || hole.h <= gutter + EPS) return []
  const extra = slicePack(remaining, hole, gutter, includeAll, maxArea)
  if (extra.length > 0) return extra
  const parts = splitRect(hole, gutter)
  if (!parts) return []
  const first = slicePack(remaining, parts[0], gutter, includeAll, maxArea)
  if (first.length > 0) return first
  return slicePack(remaining, parts[1], gutter, includeAll, maxArea)
}

function canGrowFocus(placements: Placement[], remaining: Photo[], focusIds: Set<string>): boolean {
  if (remaining.length > 0) return false
  const nichesOnPage = placements.some((item) => !focusIds.has(item.photoId))
  const focusOnPage = placements.reduce((count, item) => count + (focusIds.has(item.photoId) ? 1 : 0), 0)
  return !(focusOnPage === 1 && nichesOnPage)
}

function coverPage(
  placed: Placement[],
  tagged: Photo[],
  page: Rect,
  gutter: number,
  unused: Photo[],
  includeAll: boolean,
): Placement[] {
  const byId = new Map(tagged.map((photo) => [photo.id, photo]))
  const focusIds = new Set(tagged.filter((photo) => photo.group === 'focus').map((photo) => photo.id))
  let placements = placed.map((item) => ({ ...item }))
  let remaining = unused.slice()

  for (let pass = 0; pass < 80; pass++) {
    const cap = nicheAreaCap(placements.filter((item) => focusIds.has(item.photoId)))
    const growFocus = canGrowFocus(placements, remaining, focusIds)
    placements = gapFill(placements, tagged, page, gutter, cap, 6, growFocus)

    const holes = leftoverHoles(page, placements, gutter)
    if (holes.length === 0) break

    let progressed = false
    for (const hole of holes) {
      const neighbors = placements
        .map((item, index) => ({ item, index, side: edgeSide(item, hole, gutter) }))
        .filter((entry) => entry.side)
        .filter((entry) => growFocus || !focusIds.has(entry.item.photoId))
        .sort((a, b) => {
          const af = Number(focusIds.has(a.item.photoId))
          const bf = Number(focusIds.has(b.item.photoId))
          if (af !== bf) return bf - af
          return cellArea(b.item) - cellArea(a.item)
        })
      for (const neighbor of neighbors) {
        const photo = byId.get(neighbor.item.photoId)
        if (!photo) continue
        const maxArea = photo.group === 'focus' ? undefined : cap
        const next = expandToward(
          neighbor.item,
          hole,
          neighbor.side as Dir,
          photo,
          placements,
          page,
          gutter,
          maxArea,
        )
        if (!next) continue
        placements[neighbor.index] = next
        progressed = true
        break
      }
      if (progressed) break
    }

    if (progressed) continue

    if (remaining.length > 0) {
      const nicheSizes = placements
        .filter((item) => !focusIds.has(item.photoId))
        .map(cellArea)
        .sort((a, b) => a - b)
      const typical =
        nicheSizes[Math.floor(nicheSizes.length / 2)] ?? healthyArea(page)
      for (const hole of holes) {
        if (!includeAll && typical > 0 && cellArea(hole) < typical * 0.5) continue
        const extra = placeIntoHole(remaining, hole, gutter, includeAll, cap).filter(
          (item) => includeAll || typical <= 0 || cellArea(item) >= typical * 0.45,
        )
        if (extra.length === 0) continue
        placements = [...placements, ...extra]
        remaining = remaining.filter((photo) => !extra.some((item) => item.photoId === photo.id))
        progressed = true
        break
      }
    }

    if (!progressed) break
  }

  const cap = nicheAreaCap(placements.filter((item) => focusIds.has(item.photoId)))
  return gapFill(
    placements,
    tagged,
    page,
    gutter,
    cap,
    10,
    canGrowFocus(placements, remaining, focusIds),
  )
}

function finish(placed: Placement[]): Placement[] {
  return placed.filter(
    (placement) => placement.w > 0 && placement.h > 0 && placement.sw > 0 && placement.sh > 0,
  )
}

function isWideAspect(aspect: number): boolean {
  return aspect >= 1
}

function targetCellAspect(photo: Photo): number {
  const { min, max } = legalAspectRange(photo)
  const pref = preferredAspect(photo)
  const want = pref >= 1 ? LAND_ASPECT : PORT_ASPECT
  if (want >= min - 1e-4 && want <= max + 1e-4) return want
  return pref
}

function sizedForShort(photo: Photo, shortSide: number): { w: number; h: number } {
  const a = Math.max(1e-4, targetCellAspect(photo))
  if (a >= 1) {
    const h = Math.max(8, shortSide)
    return { w: h * a, h }
  }
  const w = Math.max(8, shortSide)
  return { w, h: w / a }
}

function boundsOf(items: { x: number; y: number; w: number; h: number }[]): Rect {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const item of items) {
    x0 = Math.min(x0, item.x)
    y0 = Math.min(y0, item.y)
    x1 = Math.max(x1, item.x + item.w)
    y1 = Math.max(y1, item.y + item.h)
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 1, h: 1 }
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }
}

function centroidOf(items: Placement[]): { x: number; y: number } {
  if (items.length === 0) return { x: 0, y: 0 }
  let sx = 0
  let sy = 0
  let area = 0
  for (const item of items) {
    const weight = cellArea(item)
    sx += (item.x + item.w / 2) * weight
    sy += (item.y + item.h / 2) * weight
    area += weight
  }
  if (area < EPS) {
    return { x: items[0].x + items[0].w / 2, y: items[0].y + items[0].h / 2 }
  }
  return { x: sx / area, y: sy / area }
}

function shiftPlacements(items: Placement[], dx: number, dy: number): Placement[] {
  if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) return items
  return items.map((item) => ({ ...item, x: item.x + dx, y: item.y + dy }))
}

function normalizePlacements(items: Placement[]): Placement[] {
  if (items.length === 0) return items
  const box = boundsOf(items)
  return shiftPlacements(items, -box.x, -box.y)
}

function collide(box: Rect, others: Placement[], gutter: number): boolean {
  for (const other of others) {
    if (boxesOverlap(box, other, gutter)) return true
  }
  return false
}

function attachBox(neighbor: Placement, side: Dir, w: number, h: number, gutter: number, t: number): Rect {
  const g = Math.max(0, gutter)
  const along = clamp(t, 0, 1)
  if (side === 'right') {
    const span = Math.max(0, neighbor.h - h)
    return { x: neighbor.x + neighbor.w + g, y: neighbor.y + span * along, w, h }
  }
  if (side === 'left') {
    const span = Math.max(0, neighbor.h - h)
    return { x: neighbor.x - g - w, y: neighbor.y + span * along, w, h }
  }
  if (side === 'down') {
    const span = Math.max(0, neighbor.w - w)
    return { x: neighbor.x + span * along, y: neighbor.y + neighbor.h + g, w, h }
  }
  const span = Math.max(0, neighbor.w - w)
  return { x: neighbor.x + span * along, y: neighbor.y - g - h, w, h }
}

function sizeAgainstEdge(
  photo: Photo,
  neighbor: Placement,
  side: Dir,
  shortSide: number,
  maxArea: number,
  shareEdge: boolean,
): { w: number; h: number } {
  const a = clamp(targetCellAspect(photo), legalAspectRange(photo).min, legalAspectRange(photo).max)
  const natural = sizedForShort(photo, shortSide)
  const edge = side === 'left' || side === 'right' ? neighbor.h : neighbor.w
  let w: number
  let h: number
  if (shareEdge) {
    if (side === 'left' || side === 'right') {
      h = edge
      w = h * a
    } else {
      w = edge
      h = w / a
    }
    const natArea = natural.w * natural.h
    if (w * h > natArea * 1.45) {
      const scale = Math.sqrt((natArea * 1.45) / Math.max(w * h, 0.001))
      w *= scale
      h *= scale
    }
  } else {
    w = natural.w
    h = natural.h
  }
  if (Number.isFinite(maxArea) && w * h > maxArea + EPS) {
    const scale = Math.sqrt(maxArea / Math.max(w * h, 0.001))
    w *= scale
    h *= scale
  }
  if (Math.min(w, h) < shortSide * 0.72) {
    w = natural.w
    h = natural.h
  }
  return { w: Math.max(8, w), h: Math.max(8, h) }
}

type BoundlessSlot = {
  box: Rect
  neighbor: Placement
  side: Dir
  opposite: boolean
}

function collectEdgeSlots(
  photo: Photo,
  placed: Placement[],
  gutter: number,
  shortSide: number,
  maxArea: number,
  shareEdge: boolean,
): BoundlessSlot[] {
  const slots: BoundlessSlot[] = []
  const photoWide = isWideAspect(targetCellAspect(photo))
  for (const neighbor of placed) {
    const neighWide = isWideAspect(neighbor.w / Math.max(neighbor.h, 0.001))
    const opposite = photoWide !== neighWide
    for (const side of ['right', 'left', 'down', 'up'] as Dir[]) {
      const { w, h } = sizeAgainstEdge(photo, neighbor, side, shortSide, maxArea, shareEdge)
      for (const t of SLOT_ALIGNS) {
        const box = attachBox(neighbor, side, w, h, gutter, t)
        if (collide(box, placed, gutter)) continue
        slots.push({ box, neighbor, side, opposite })
      }
    }
  }
  return slots
}

function touchingCount(hole: Rect, placed: Placement[], gutter: number): number {
  let count = 0
  for (const item of placed) {
    if (edgeSide(item, hole, gutter)) count += 1
  }
  return count
}

function touchingDirs(hole: Rect, placed: Placement[], gutter: number): Dir[] {
  const dirs: Dir[] = []
  for (const item of placed) {
    const side = edgeSide(item, hole, gutter)
    if (side) dirs.push(side)
  }
  return dirs
}

function holeTouchesBounds(hole: Rect, box: Rect): boolean {
  return (
    hole.x <= box.x + EPS ||
    hole.y <= box.y + EPS ||
    hole.x + hole.w >= box.x + box.w - EPS ||
    hole.y + hole.h >= box.y + box.h - EPS
  )
}

function typicalCellArea(placements: Placement[]): number {
  const areas = placements.map(cellArea).sort((a, b) => a - b)
  if (areas.length === 0) return 0
  const small = areas.slice(0, Math.max(1, Math.ceil(areas.length * 0.65)))
  return small[Math.floor(small.length / 2)] ?? 0
}

function photoShapedPocket(
  hole: Rect,
  placed: Placement[],
  gutter: number,
  typical: number,
  box: Rect,
): boolean {
  const aspect = hole.w / Math.max(hole.h, 0.001)
  if (aspect < PHOTO_ASPECT_MIN || aspect > PHOTO_ASPECT_MAX) return false
  const minSide = Math.min(hole.w, hole.h)
  const minOk = Math.max(gutter + 16, typical > 0 ? Math.sqrt(typical) * 0.45 : 40)
  if (minSide < minOk) return false
  if (typical > 0 && cellArea(hole) < typical * 0.35) return false
  const dirs = [...new Set(touchingDirs(hole, placed, gutter))]
  if (dirs.length < 2) return false
  const opposite =
    (dirs.includes('left') && dirs.includes('right')) || (dirs.includes('up') && dirs.includes('down'))
  if (opposite || dirs.length >= 3) return true
  if (holeTouchesBounds(hole, box) && dirs.length <= 2) return false
  return touchingCount(hole, placed, gutter) >= 2
}

function rangeOverlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
}

function contactLength(box: Rect, placed: Placement[], gutter: number): number {
  const tol = Math.max(2, gutter + 1)
  const g = Math.max(0, gutter)
  let len = 0
  for (const item of placed) {
    const yOv = rangeOverlap(item.y, item.y + item.h, box.y, box.y + box.h)
    const xOv = rangeOverlap(item.x, item.x + item.w, box.x, box.x + box.w)
    const vert = yOv > EPS
    const horz = xOv > EPS
    if (vert && Math.abs(item.x + item.w + g - box.x) <= tol) len += yOv
    else if (vert && Math.abs(box.x + box.w + g - item.x) <= tol) len += yOv
    else if (horz && Math.abs(item.y + item.h + g - box.y) <= tol) len += xOv
    else if (horz && Math.abs(box.y + box.h + g - item.y) <= tol) len += xOv
  }
  return len
}

function rectOverlapArea(a: Rect, b: Rect): number {
  const w = rangeOverlap(a.x, a.x + a.w, b.x, b.x + b.w)
  const h = rangeOverlap(a.y, a.y + a.h, b.y, b.y + b.h)
  return w * h
}

function slotCenter(slot: BoundlessSlot): { x: number; y: number } {
  return { x: slot.box.x + slot.box.w / 2, y: slot.box.y + slot.box.h / 2 }
}

function clusterOrigin(placed: Placement[], focusIds: Set<string>): { x: number; y: number } {
  const focusPlaced = placed.filter((item) => focusIds.has(item.photoId))
  return focusPlaced.length > 0 ? centroidOf(focusPlaced) : centroidOf(placed)
}

function interleaveByOrientation(photos: Photo[]): Photo[] {
  const wide = photos.filter((photo) => isWideAspect(targetCellAspect(photo)))
  const tall = photos.filter((photo) => !isWideAspect(targetCellAspect(photo)))
  if (wide.length === 0 || tall.length === 0) return photos.slice()
  const [major, minor] = wide.length >= tall.length ? [wide, tall] : [tall, wide]
  const out: Photo[] = []
  let i = 0
  let j = 0
  while (i < major.length || j < minor.length) {
    if (i < major.length) out.push(major[i++])
    if (j < minor.length) out.push(minor[j++])
  }
  return out
}

function hintRadii(cluster: Rect, hintAspect: number, shortSide: number, rings: number): { rx: number; ry: number } {
  const hint = Math.max(hintAspect, 0.001)
  const extraX = shortSide * (hint >= 1 ? 0.9 + rings * 0.85 : 0.18 + rings * 0.28)
  const extraY = shortSide * (hint <= 1 ? 0.9 + rings * 0.85 : 0.18 + rings * 0.28)
  return { rx: cluster.w / 2 + extraX, ry: cluster.h / 2 + extraY }
}

function targetEllipse(cluster: Rect, hintAspect: number, pad: number): { rx: number; ry: number } {
  const hint = Math.max(hintAspect, 0.001)
  const area = Math.max(1, cellArea(cluster)) * 1.28
  const w = Math.sqrt(area * hint)
  const h = w / hint
  return { rx: w / 2 + pad, ry: h / 2 + pad }
}

function inEllipse(
  point: { x: number; y: number },
  origin: { x: number; y: number },
  rx: number,
  ry: number,
): boolean {
  const dx = (point.x - origin.x) / Math.max(rx, 1)
  const dy = (point.y - origin.y) / Math.max(ry, 1)
  return dx * dx + dy * dy <= 1 + 1e-6
}

function corridorSlots(
  photo: Photo,
  placed: Placement[],
  gutter: number,
  shortSide: number,
  maxArea: number,
): BoundlessSlot[] {
  const cluster = boundsOf(placed)
  const typical = typicalCellArea(placed)
  const natural = sizedForShort(photo, shortSide)
  const photoWide = isWideAspect(targetCellAspect(photo))
  const slots: BoundlessSlot[] = []
  for (const hole of leftoverHoles(cluster, placed, gutter)) {
    if (!photoShapedPocket(hole, placed, gutter, typical, cluster)) continue
    if (hole.w < natural.w * 0.45 || hole.h < natural.h * 0.45) continue
    const fitted = legalBox(photo, {
      x: hole.x,
      y: hole.y,
      w: Math.min(hole.w, natural.w * 1.35),
      h: Math.min(hole.h, natural.h * 1.35),
    })
    if (Number.isFinite(maxArea) && cellArea(fitted) > maxArea) {
      const scale = Math.sqrt(maxArea / Math.max(cellArea(fitted), 0.001))
      fitted.w *= scale
      fitted.h *= scale
    }
    fitted.x = hole.x + Math.max(0, (hole.w - fitted.w) / 2)
    fitted.y = hole.y + Math.max(0, (hole.h - fitted.h) / 2)
    if (collide(fitted, placed, gutter)) continue
    let neighbor = placed[0]
    let best = Number.POSITIVE_INFINITY
    for (const item of placed) {
      const d =
        Math.abs(item.x + item.w / 2 - (fitted.x + fitted.w / 2)) +
        Math.abs(item.y + item.h / 2 - (fitted.y + fitted.h / 2))
      if (d < best) {
        best = d
        neighbor = item
      }
    }
    const neighWide = isWideAspect(neighbor.w / Math.max(neighbor.h, 0.001))
    slots.push({
      box: fitted,
      neighbor,
      side: 'down',
      opposite: photoWide !== neighWide,
    })
  }
  return slots
}

function scoreSlot(
  slot: BoundlessSlot,
  photo: Photo,
  placed: Placement[],
  focusIds: Set<string>,
  hintAspect: number,
  shortSide: number,
  gutter: number,
  kernel: boolean,
): number {
  const origin = clusterOrigin(placed, focusIds)
  const c = slotCenter(slot)
  const dist = Math.hypot(c.x - origin.x, c.y - origin.y)
  const probe: Placement = {
    photoId: photo.id,
    x: slot.box.x,
    y: slot.box.y,
    w: slot.box.w,
    h: slot.box.h,
    sx: 0,
    sy: 0,
    sw: 1,
    sh: 1,
  }
  const cluster = boundsOf(placed)
  const nextBox = boundsOf([...placed, probe])
  const hint = Math.max(hintAspect, 0.001)
  const current = cluster.w / Math.max(cluster.h, 0.001)
  const grown = nextBox.w / Math.max(nextBox.h, 0.001)
  const hintBefore = Math.abs(Math.log(current / hint))
  const hintAfter = Math.abs(Math.log(grown / hint))
  const nextItems = [...placed, probe]
  const recenter = Math.hypot(centroidOf(nextItems).x - origin.x, centroidOf(nextItems).y - origin.y)
  const contact = contactLength(slot.box, placed, gutter)
  const nestle = rectOverlapArea(slot.box, cluster) / Math.max(cellArea(slot.box), 1)
  let score = slot.opposite ? 0 : shortSide * 1.35
  if (kernel) {
    score += dist * 0.22
    score += hintAfter * shortSide * 2.1
    score += (hintAfter - hintBefore) * shortSide * 2.4
    score += recenter * 0.28
    if (slot.side === 'left' || slot.side === 'right') {
      score += Math.max(0, Math.log(current / hint)) * shortSide * 2.2
    } else {
      score += Math.max(0, Math.log(hint / current)) * shortSide * 2.2
    }
    return score
  }
  const { rx, ry } = targetEllipse(cluster, hint, shortSide * 0.55)
  const dx = (c.x - origin.x) / Math.max(rx, 1)
  const dy = (c.y - origin.y) / Math.max(ry, 1)
  score += dist * 0.48
  score += hintAfter * shortSide * 4.4
  score += (hintAfter - hintBefore) * shortSide * 5.2
  score += (dx * dx + dy * dy) * shortSide * 3.1
  score += recenter * 0.3
  if (slot.side === 'left' || slot.side === 'right') {
    score += Math.max(0, Math.log(current / hint)) * shortSide * 4.6
  } else {
    score += Math.max(0, Math.log(hint / current)) * shortSide * 4.6
  }
  score -= contact * 0.16
  score -= nestle * shortSide * 0.7
  return score
}

function pickSlot(
  photo: Photo,
  placed: Placement[],
  gutter: number,
  shortSide: number,
  maxArea: number,
  focusIds: Set<string>,
  hintAspect: number,
  shareEdge: boolean,
  relax: boolean,
  maxRadius?: number,
): BoundlessSlot | null {
  const origin = clusterOrigin(placed, focusIds)
  const cluster = boundsOf(placed)
  const within = (slots: BoundlessSlot[]) => {
    if (maxRadius == null || !Number.isFinite(maxRadius) || maxRadius <= 0) return slots
    const { rx, ry } = hintRadii(cluster, hintAspect, shortSide, maxRadius)
    return slots.filter((slot) => inEllipse(slotCenter(slot), origin, rx, ry))
  }
  let slots = within(collectEdgeSlots(photo, placed, gutter, shortSide, maxArea, shareEdge))
  if (!relax) {
    const opposite = slots.filter((slot) => slot.opposite)
    const hint = Math.max(hintAspect, 0.001)
    const current = cluster.w / Math.max(cluster.h, 0.001)
    const before = Math.abs(Math.log(current / hint))
    const keepsHint = (list: BoundlessSlot[]) =>
      list.filter((slot) => {
        const next = boundsOf([
          ...placed,
          { photoId: photo.id, x: slot.box.x, y: slot.box.y, w: slot.box.w, h: slot.box.h, sx: 0, sy: 0, sw: 1, sh: 1 },
        ])
        const after = Math.abs(Math.log(next.w / Math.max(next.h, 0.001) / hint))
        return after <= before + 0.12
      })
    const oppositeHint = keepsHint(opposite)
    const anyHint = keepsHint(slots)
    if (oppositeHint.length > 0) slots = oppositeHint
    else if (anyHint.length > 0) slots = anyHint
    else if (opposite.length > 0) slots = opposite
  }
  if (slots.length === 0) slots = within(corridorSlots(photo, placed, gutter, shortSide, maxArea))
  slots = slots.filter((slot) => Math.min(slot.box.w, slot.box.h) >= shortSide * 0.72 - EPS)
  if (slots.length === 0 && relax) {
    slots = within(collectEdgeSlots(photo, placed, gutter, shortSide, maxArea, shareEdge)).filter(
      (slot) => Math.min(slot.box.w, slot.box.h) >= shortSide * 0.72 - EPS,
    )
  }
  if (slots.length === 0) return null
  let best = slots[0]
  let bestScore = scoreSlot(best, photo, placed, focusIds, hintAspect, shortSide, gutter, shareEdge)
  for (let i = 1; i < slots.length; i++) {
    const score = scoreSlot(slots[i], photo, placed, focusIds, hintAspect, shortSide, gutter, shareEdge)
    if (score < bestScore) {
      best = slots[i]
      bestScore = score
    }
  }
  return best
}

function attachPhotos(
  photos: Photo[],
  seed: Placement[],
  gutter: number,
  shortSide: number,
  maxArea: number,
  focusIds: Set<string>,
  hintAspect: number,
  shareEdge: boolean,
  maxRadius?: number,
): Placement[] {
  let placed = seed.slice()
  const tryOne = (photo: Photo, relax: boolean): boolean => {
    const slot = pickSlot(
      photo,
      placed,
      gutter,
      shortSide,
      maxArea,
      focusIds,
      hintAspect,
      shareEdge,
      relax,
      maxRadius,
    )
    if (!slot) return false
    placed.push(fillCell(photo, slot.box))
    return true
  }
  const leftover = photos.filter((photo) => !tryOne(photo, false))
  for (const photo of leftover) tryOne(photo, true)
  return placed
}

function orderFocus(focus: Photo[], hintAspect: number): Photo[] {
  const ordered = interleaveByOrientation(focus)
  if (ordered.length <= 1) return ordered
  const hint = Math.max(hintAspect, 0.001)
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < ordered.length; i++) {
    const dist = Math.abs(Math.log(targetCellAspect(ordered[i]) / hint))
    if (dist < bestD) {
      bestD = dist
      best = i
    }
  }
  return [...ordered.slice(best), ...ordered.slice(0, best)]
}

function packFocusKernel(focus: Photo[], gutter: number, hintAspect: number): Placement[] {
  if (focus.length === 0) return []
  const ordered = orderFocus(focus, hintAspect)
  const short = PAGE_WIDTH * 0.28
  const size = sizedForShort(ordered[0], short)
  let placed = [fillCell(ordered[0], { x: 0, y: 0, w: size.w, h: size.h })]
  const ids = new Set(ordered.map((photo) => photo.id))
  const cap = cellArea(placed[0]) * 1.25
  placed = attachPhotos(ordered.slice(1), placed, gutter, short, cap, ids, hintAspect, true)
  const center = centroidOf(placed)
  return shiftPlacements(placed, -center.x, -center.y)
}

function fillOnePocket(photo: Photo, hole: Rect, maxArea: number, minSide = 0): Placement | null {
  const box = fitsAspect(photo, hole.w, hole.h) ? { ...hole } : legalBox(photo, hole)
  if (box.w < hole.w * 0.5 || box.h < hole.h * 0.5) return null
  if (Number.isFinite(maxArea) && cellArea(box) > maxArea * 1.2) {
    const scale = Math.sqrt((maxArea * 1.2) / Math.max(cellArea(box), 0.001))
    box.w *= scale
    box.h *= scale
  }
  if (Math.min(box.w, box.h) < Math.max(24, minSide) - EPS) return null
  const aspect = box.w / Math.max(box.h, 0.001)
  if (aspect < PHOTO_ASPECT_MIN || aspect > PHOTO_ASPECT_MAX) return null
  box.x = hole.x + Math.max(0, (hole.w - box.w) / 2)
  box.y = hole.y + Math.max(0, (hole.h - box.h) / 2)
  return fillCell(photo, box)
}

function inRegion(box: Rect, region: Rect): boolean {
  return (
    box.x >= region.x - EPS &&
    box.y >= region.y - EPS &&
    box.x + box.w <= region.x + region.w + EPS &&
    box.y + box.h <= region.y + region.h + EPS
  )
}

type FacingHit = { other: Placement; gap: number; overlap: number }

function oppositeDir(dir: Dir): Dir {
  if (dir === 'right') return 'left'
  if (dir === 'left') return 'right'
  if (dir === 'down') return 'up'
  return 'down'
}

function facingHits(item: Placement, others: Placement[], dir: Dir): FacingHit[] {
  const hits: FacingHit[] = []
  for (const other of others) {
    if (other.photoId === item.photoId) continue
    if (dir === 'right' || dir === 'left') {
      const overlap = rangeOverlap(item.y, item.y + item.h, other.y, other.y + other.h)
      if (overlap <= 8) continue
      const gap = dir === 'right' ? other.x - (item.x + item.w) : item.x - (other.x + other.w)
      if (gap < -EPS) continue
      if (dir === 'right' && other.x + EPS < item.x + item.w) continue
      if (dir === 'left' && other.x + other.w > item.x + EPS) continue
      hits.push({ other, gap, overlap })
    } else {
      const overlap = rangeOverlap(item.x, item.x + item.w, other.x, other.x + other.w)
      if (overlap <= 8) continue
      const gap = dir === 'down' ? other.y - (item.y + item.h) : item.y - (other.y + other.h)
      if (gap < -EPS) continue
      if (dir === 'down' && other.y + EPS < item.y + item.h) continue
      if (dir === 'up' && other.y + other.h > item.y + EPS) continue
      hits.push({ other, gap, overlap })
    }
  }
  hits.sort((a, b) => a.gap - b.gap || b.overlap - a.overlap)
  return hits
}

function sideExtra(item: Placement, others: Placement[], dir: Dir, gutter: number): number | null {
  const hits = facingHits(item, others, dir)
  if (hits.length === 0) return null
  return Math.max(0, hits[0].gap - gutter)
}

function occupiedSideWorsened(
  before: Placement,
  after: Placement,
  others: Placement[],
  gutter: number,
): boolean {
  for (const dir of ['right', 'left', 'down', 'up'] as Dir[]) {
    const prev = sideExtra(before, others, dir, gutter)
    if (prev == null) continue
    const next = sideExtra(after, others, dir, gutter)
    if (next == null) {
      if (prev <= gutter + 1.5) return true
      continue
    }
    if (next > prev + 0.75) return true
  }
  return false
}

function extraSum(item: Placement, others: Placement[], gutter: number): number {
  let sum = 0
  for (const dir of ['right', 'left', 'down', 'up'] as Dir[]) {
    const extra = sideExtra(item, others, dir, gutter)
    if (extra != null) sum += extra
  }
  return sum
}

function shiftedPlacement(item: Placement, dx: number, dy: number): Placement {
  return { ...item, x: item.x + dx, y: item.y + dy }
}

function legalShift(
  item: Placement,
  dx: number,
  dy: number,
  placed: Placement[],
  gutter: number,
  region: Rect,
): Placement | null {
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return null
  const next = shiftedPlacement(item, dx, dy)
  if (!inRegion(next, region)) return null
  const others = placed.filter((other) => other.photoId !== item.photoId)
  if (collide(next, others, gutter)) return null
  return next
}

function maxLegalShift(
  item: Placement,
  dx: number,
  dy: number,
  placed: Placement[],
  gutter: number,
  region: Rect,
): Placement | null {
  const direct = legalShift(item, dx, dy, placed, gutter, region)
  if (direct) return direct
  let lo = 0
  let hi = 1
  let best: Placement | null = null
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2
    const trial = legalShift(item, dx * mid, dy * mid, placed, gutter, region)
    if (trial) {
      best = trial
      lo = mid
    } else {
      hi = mid
    }
  }
  if (!best) return null
  if (Math.hypot(best.x - item.x, best.y - item.y) < 0.75) return null
  return best
}

function replacePlacement(placed: Placement[], next: Placement): Placement[] {
  return placed.map((item) => (item.photoId === next.photoId ? next : item))
}

function bestSlideFor(
  item: Placement,
  placed: Placement[],
  gutter: number,
  region: Rect,
): Placement | null {
  const g = Math.max(0, gutter)
  const others = placed.filter((other) => other.photoId !== item.photoId)
  const beforeExtra = extraSum(item, others, g)
  const beforeContact = contactLength(item, others, g)
  let best: Placement | null = null
  let bestExtra = beforeExtra
  let bestContact = beforeContact
  const consider = (dx: number, dy: number) => {
    const moved = maxLegalShift(item, dx, dy, placed, g, region)
    if (!moved) return
    if (occupiedSideWorsened(item, moved, others, g)) return
    const extra = extraSum(moved, others, g)
    const contact = contactLength(moved, others, g)
    const extraDrop = beforeExtra - extra
    const contactGain = contact - beforeContact
    if (extraDrop < 0.5 && contactGain < 0.75) return
    if (
      extra < bestExtra - 0.25 ||
      (Math.abs(extra - bestExtra) <= 0.25 && contact > bestContact + 0.5)
    ) {
      best = moved
      bestExtra = extra
      bestContact = contact
    }
  }
  for (const dir of ['right', 'left', 'down', 'up'] as Dir[]) {
    const hits = facingHits(item, others, dir)
    if (hits.length === 0) continue
    const extra = Math.max(0, hits[0].gap - g)
    const opp = sideExtra(item, others, oppositeDir(dir), g)
    const slack = opp == null ? extra : Math.max(0, opp)
    const move = Math.min(extra, slack)
    if (move > 0.75) {
      if (dir === 'right') consider(move, 0)
      if (dir === 'left') consider(-move, 0)
      if (dir === 'down') consider(0, move)
      if (dir === 'up') consider(0, -move)
    }
    for (const hit of hits) {
      if (dir === 'right' || dir === 'left') {
        consider(0, hit.other.y - item.y)
        consider(0, hit.other.y + hit.other.h - (item.y + item.h))
      } else {
        consider(hit.other.x - item.x, 0)
        consider(hit.other.x + hit.other.w - (item.x + item.w), 0)
      }
    }
  }
  return best
}

function holeEdgeContact(item: Placement, hole: Rect, side: Dir): number {
  if (side === 'right' || side === 'left') {
    return rangeOverlap(item.y, item.y + item.h, hole.y, hole.y + hole.h)
  }
  return rangeOverlap(item.x, item.x + item.w, hole.x, hole.x + hole.w)
}

function settleEdgeSide(cell: Rect, hole: Rect, gutter: number): Dir | null {
  const g = Math.max(0, gutter)
  const tol = Math.max(12, 2 * g + 8)
  const vert = cell.y < hole.y + hole.h - EPS && hole.y < cell.y + cell.h - EPS
  const horz = cell.x < hole.x + hole.w - EPS && hole.x < cell.x + cell.w - EPS
  if (vert && hole.x >= cell.x + cell.w - EPS && hole.x - (cell.x + cell.w) <= tol) return 'right'
  if (vert && cell.x >= hole.x + hole.w - EPS && cell.x - (hole.x + hole.w) <= tol) return 'left'
  if (horz && hole.y >= cell.y + cell.h - EPS && hole.y - (cell.y + cell.h) <= tol) return 'down'
  if (horz && cell.y >= hole.y + hole.h - EPS && cell.y - (hole.y + hole.h) <= tol) return 'up'
  return edgeSide(cell, hole, gutter)
}

function settleHoleNeighbors(
  hole: Rect,
  placed: Placement[],
  gutter: number,
): { item: Placement; side: Dir; contact: number }[] {
  return placed
    .map((item) => {
      const side = settleEdgeSide(item, hole, gutter)
      if (!side) return null
      const contact = holeEdgeContact(item, hole, side)
      if (contact <= 2) return null
      return { item, side, contact }
    })
    .filter((entry): entry is { item: Placement; side: Dir; contact: number } => entry != null)
}

function closeableSettleHole(
  hole: Rect,
  placed: Placement[],
  region: Rect,
  gutter: number,
  typical: number,
): boolean {
  const neighbors = settleHoleNeighbors(hole, placed, gutter)
  const n = neighbors.length
  if (n === 0) return false
  const dirs = [...new Set(neighbors.map((entry) => entry.side))]
  const interior = !holeTouchesBounds(hole, region)
  const typicalSide = Math.sqrt(Math.max(typical, 1))
  const minSide = Math.min(hole.w, hole.h)
  const thin = minSide < Math.max(gutter + 36, typicalSide * 0.55)
  const opposite =
    (dirs.includes('left') && dirs.includes('right')) || (dirs.includes('up') && dirs.includes('down'))
  if (opposite) return true
  if (interior) return true
  if (dirs.length >= 2) return true
  return thin && n >= 1
}

function paddedHole(hole: Rect, side: Dir, gutter: number): Rect {
  const pad = Math.max(0, gutter)
  if (side === 'right') return { ...hole, w: hole.w + pad }
  if (side === 'left') return { ...hole, x: hole.x - pad, w: hole.w + pad }
  if (side === 'down') return { ...hole, h: hole.h + pad }
  return { ...hole, y: hole.y - pad, h: hole.h + pad }
}

function clipHoleToJog(
  hole: Rect,
  grower: Placement,
  side: Dir,
  neighbors: { item: Placement; side: Dir; contact: number }[],
): Rect {
  const others = neighbors.filter((entry) => entry.item.photoId !== grower.photoId)
  const opposite = others.filter((entry) => entry.side === oppositeDir(side))
  if (opposite.length > 0) return hole
  const perp = others.filter((entry) => entry.side !== side)
  if (perp.length === 0) return hole
  let x0 = hole.x
  let y0 = hole.y
  let x1 = hole.x + hole.w
  let y1 = hole.y + hole.h
  if (side === 'right') {
    x1 = Math.min(x1, Math.max(...perp.map((entry) => entry.item.x + entry.item.w)))
  } else if (side === 'left') {
    x0 = Math.max(x0, Math.min(...perp.map((entry) => entry.item.x)))
  } else if (side === 'down') {
    y1 = Math.min(y1, Math.max(...perp.map((entry) => entry.item.y + entry.item.h)))
  } else {
    y0 = Math.max(y0, Math.min(...perp.map((entry) => entry.item.y)))
  }
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }
}

function lerpGrowHole(placement: Placement, hole: Rect, side: Dir, t: number): Rect {
  const u = clamp(t, 0, 1)
  if (side === 'right') {
    const to = hole.x + hole.w
    const from = placement.x + placement.w
    return { ...hole, w: from + (to - from) * u - hole.x }
  }
  if (side === 'left') {
    const to = hole.x
    const from = placement.x
    const x = from + (to - from) * u
    return { ...hole, x, w: hole.x + hole.w - x }
  }
  if (side === 'down') {
    const to = hole.y + hole.h
    const from = placement.y + placement.h
    return { ...hole, h: from + (to - from) * u - hole.y }
  }
  const to = hole.y
  const from = placement.y
  const y = from + (to - from) * u
  return { ...hole, y, h: hole.y + hole.h - y }
}

function growTowardLegal(
  placement: Placement,
  hole: Rect,
  side: Dir,
  photo: Photo,
  others: Placement[],
  region: Rect,
  gutter: number,
  maxArea?: number,
): Placement | null {
  const direct = expandToward(placement, hole, side, photo, others, region, gutter, maxArea)
  if (direct && inRegion(direct, region) && cellArea(direct) > cellArea(placement) + 0.75) return direct
  let lo = 0
  let hi = 1
  let best: Placement | null = null
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2
    const trial = expandToward(
      placement,
      lerpGrowHole(placement, hole, side, mid),
      side,
      photo,
      others,
      region,
      gutter,
      maxArea,
    )
    if (trial && inRegion(trial, region) && cellArea(trial) > cellArea(placement) + 0.75) {
      best = trial
      lo = mid
    } else {
      hi = mid
    }
  }
  return best
}

function tJunctionHoles(placed: Placement[], gutter: number, region: Rect): Rect[] {
  const g = Math.max(0, gutter)
  const out: Rect[] = []
  const push = (hole: Rect) => {
    if (hole.w <= g + 1 || hole.h <= g + 1) return
    if (!inRegion({ x: hole.x, y: hole.y, w: Math.min(hole.w, region.w), h: Math.min(hole.h, region.h) }, {
      x: region.x - 1,
      y: region.y - 1,
      w: region.w + 2,
      h: region.h + 2,
    })) return
    const clipped = {
      x: Math.max(hole.x, region.x),
      y: Math.max(hole.y, region.y),
      w: Math.min(hole.x + hole.w, region.x + region.w) - Math.max(hole.x, region.x),
      h: Math.min(hole.y + hole.h, region.y + region.h) - Math.max(hole.y, region.y),
    }
    if (clipped.w <= g + 1 || clipped.h <= g + 1) return
    for (const item of placed) {
      if (boxesOverlap(clipped, item, g)) return
    }
    out.push(clipped)
  }
  for (const a of placed) {
    for (const b of placed) {
      if (a.photoId === b.photoId) continue
      const yOv = rangeOverlap(a.y, a.y + a.h, b.y, b.y + b.h)
      if (yOv > 8) {
        const gap = b.x - (a.x + a.w)
        if (gap >= -EPS && gap <= Math.max(80, g + 48)) {
          const x = a.x + a.w + g
          const w = Math.max(1, b.x + b.w - x)
          if (a.y < b.y - g - 2) push({ x, y: a.y, w, h: b.y - g - a.y })
          if (a.y + a.h > b.y + b.h + g + 2) push({ x, y: b.y + b.h + g, w, h: a.y + a.h - (b.y + b.h + g) })
        }
      }
      const xOv = rangeOverlap(a.x, a.x + a.w, b.x, b.x + b.w)
      if (xOv > 8) {
        const gap = b.y - (a.y + a.h)
        if (gap >= -EPS && gap <= Math.max(80, g + 48)) {
          const y = a.y + a.h + g
          const h = Math.max(1, b.y + b.h - y)
          if (a.x < b.x - g - 2) push({ x: a.x, y, w: b.x - g - a.x, h })
          if (a.x + a.w > b.x + b.w + g + 2) push({ x: b.x + b.w + g, y, w: a.x + a.w - (b.x + b.w + g), h })
        }
      }
    }
  }
  return out
}

function settleExpandPass(
  placed: Placement[],
  byId: Map<string, Photo>,
  gutter: number,
  region: Rect,
  capOf: (photo: Photo) => number | undefined,
): Placement[] | null {
  const g = Math.max(0, gutter)
  let next = placed.map((item) => ({ ...item }))
  let changed = false
  const used = new Set<string>()
  const liveCap = (photo: Photo) => {
    if (photo.group === 'focus') return undefined
    const focusPlaced = next.filter((item) => byId.get(item.photoId)?.group === 'focus')
    if (focusPlaced.length > 0) return nicheAreaCap(focusPlaced)
    return capOf(photo)
  }
  const holeRank = (hole: Rect) => {
    const neighbors = settleHoleNeighbors(hole, next, g)
    const dirs = [...new Set(neighbors.map((entry) => entry.side))]
    const opposite =
      (dirs.includes('left') && dirs.includes('right')) || (dirs.includes('up') && dirs.includes('down'))
    const interior = !holeTouchesBounds(hole, region)
    const contact = neighbors.reduce((sum, entry) => sum + entry.contact, 0)
    return (
      (opposite ? 4_000_000 : 0) +
      (interior ? 2_000_000 : 0) +
      (dirs.length >= 2 ? 1_000_000 : 0) +
      contact * 10 -
      Math.min(hole.w, hole.h)
    )
  }
  const collectHoles = () =>
    [...leftoverHoles(region, next, g), ...tJunctionHoles(next, g, region)]
      .filter((hole) => closeableSettleHole(hole, next, region, g, typicalCellArea(next)))
      .sort((a, b) => holeRank(b) - holeRank(a))

  const widenHoles = (focusOnly: boolean) => {
    for (const hole of collectHoles()) {
      const neighbors = settleHoleNeighbors(hole, next, g)
        .filter((entry) => {
          if (used.has(entry.item.photoId)) return false
          const photo = byId.get(entry.item.photoId)
          if (!photo) return false
          return focusOnly ? photo.group === 'focus' : photo.group !== 'focus'
        })
        .sort((a, b) => b.contact - a.contact)
      for (const neighbor of neighbors) {
        const photo = byId.get(neighbor.item.photoId)
        if (!photo) continue
        const current = next.find((item) => item.photoId === neighbor.item.photoId) ?? neighbor.item
        const cap = liveCap(photo)
        if (cap != null && cellArea(current) >= cap - 0.75) continue
        const dirs = [...new Set(settleHoleNeighbors(hole, next, g).map((entry) => entry.side))]
        const opposite =
          (dirs.includes('left') && dirs.includes('right')) ||
          (dirs.includes('up') && dirs.includes('down'))
        const clipped = clipHoleToJog(hole, current, neighbor.side, settleHoleNeighbors(hole, next, g))
        const target = opposite ? paddedHole(clipped, neighbor.side, g) : clipped
        let grown = growTowardLegal(current, target, neighbor.side, photo, next, region, g, cap)
        if (!grown) {
          const extra = tryExpand(current, neighbor.side, next, photo, region, g, cap)
          if (!extra || extra.area < 0.75 || !inRegion(extra.next, region)) continue
          grown = extra.next
        }
        next = replacePlacement(next, grown)
        used.add(current.photoId)
        changed = true
        break
      }
    }
  }

  const widenExtras = (focusOnly: boolean) => {
    for (const start of next.slice()) {
      const item = next.find((entry) => entry.photoId === start.photoId) ?? start
      if (used.has(item.photoId)) continue
      const photo = byId.get(item.photoId)
      if (!photo) continue
      if (focusOnly ? photo.group !== 'focus' : photo.group === 'focus') continue
      let best: { extra: number; area: number; grown: Placement } | null = null
      for (const dir of ['right', 'left', 'down', 'up'] as Dir[]) {
        const extra = sideExtra(item, next, dir, g)
        if (extra == null || extra <= 0.75) continue
        const grown = tryExpand(item, dir, next, photo, region, g, liveCap(photo))
        if (!grown || grown.area < 0.75 || !inRegion(grown.next, region)) continue
        if (
          !best ||
          extra > best.extra + 0.75 ||
          (Math.abs(extra - best.extra) <= 0.75 && grown.area > best.area)
        ) {
          best = { extra, area: grown.area, grown: grown.next }
        }
      }
      if (best) {
        next = replacePlacement(next, best.grown)
        used.add(item.photoId)
        changed = true
      }
    }
  }

  widenHoles(true)
  widenExtras(true)
  used.clear()
  widenHoles(false)
  widenExtras(false)
  return changed ? next : null
}

export function settlePlacements(
  photos: Photo[],
  placements: Placement[],
  gutter: number,
  caps: { nicheMaxArea?: number },
  region: Rect,
): Placement[] {
  if (placements.length < 2 || region.w < 8 || region.h < 8) return placements
  const byId = new Map(photos.map((photo) => [photo.id, photo]))
  let placed = placements.map((item) => ({ ...item }))
  let nicheCap = caps.nicheMaxArea
  const refreshCap = () => {
    const focusPlaced = placed.filter((item) => byId.get(item.photoId)?.group === 'focus')
    nicheCap = focusPlaced.length > 0 ? nicheAreaCap(focusPlaced) : caps.nicheMaxArea
  }
  const capOf = (photo: Photo) =>
    photo.group === 'focus' || nicheCap == null || !Number.isFinite(nicheCap) ? undefined : nicheCap

  for (let iter = 0; iter < 72; iter++) {
    let better = false
    for (let i = 0; i < placed.length; i++) {
      const moved = bestSlideFor(placed[i], placed, gutter, region)
      if (!moved) continue
      placed[i] = moved
      better = true
    }
    const expanded = settleExpandPass(placed, byId, gutter, region, capOf)
    if (expanded) {
      placed = expanded
      better = true
      refreshCap()
    }
    if (!better) break
  }
  return placed
}

function fillPhotoPockets(
  placed: Placement[],
  leftover: Photo[],
  gutter: number,
  maxArea: number,
): Placement[] {
  let remaining = leftover.slice()
  let out = placed.slice()
  for (let pass = 0; pass < 24 && remaining.length > 0; pass++) {
    const box = boundsOf(out)
    const typical = typicalCellArea(out)
    const holes = leftoverHoles(box, out, gutter)
      .filter((hole) => photoShapedPocket(hole, out, gutter, typical, box))
      .sort((a, b) => cellArea(b) - cellArea(a))
    if (holes.length === 0) break
    let progressed = false
    for (const hole of holes) {
      const holeAspect = hole.w / Math.max(hole.h, 0.001)
      const ranked = remaining
        .map((photo) => ({ photo, d: Math.abs(Math.log(targetCellAspect(photo) / holeAspect)) }))
        .sort((a, b) => a.d - b.d)
      for (const entry of ranked) {
        const extra = fillOnePocket(entry.photo, hole, maxArea, Math.sqrt(Math.max(typical, 1)) * 0.55)
        if (!extra || collide(extra, out, gutter)) continue
        out = [...out, extra]
        remaining = remaining.filter((photo) => photo.id !== extra.photoId)
        progressed = true
        break
      }
      if (progressed) break
    }
    if (!progressed) break
  }
  return out
}

function packBoundless(
  focus: Photo[],
  niche: Photo[],
  gutter: number,
  tagged: Photo[],
  includeAll: boolean,
  page: Page,
): Placement[] {
  const hintAspect =
    page.width >= 1 && page.height >= 1 ? page.width / page.height : LAND_ASPECT
  const g = Math.max(0, gutter)
  const focusIds = new Set(focus.map((photo) => photo.id))

  let placed: Placement[]
  let pool: Photo[]
  if (focus.length > 0) {
    placed = packFocusKernel(focus, g, hintAspect)
    pool = niche.slice()
  } else if (niche.length > 0) {
    const short = PAGE_WIDTH * 0.16
    const size = sizedForShort(niche[0], short)
    placed = [fillCell(niche[0], { x: 0, y: 0, w: size.w, h: size.h })]
    pool = niche.slice(1)
  } else {
    return []
  }

  const focusPlaced = placed.filter((item) => focusIds.has(item.photoId))
  const focusShorts = focusPlaced.map((item) => Math.min(item.w, item.h)).sort((a, b) => a - b)
  const focusShort =
    focusShorts.length > 0 ? focusShorts[Math.floor(focusShorts.length / 2)] : PAGE_WIDTH * 0.16
  const nicheShort = Math.max(24, focusShort * 0.5)
  const sizeCap = nicheShort * nicheShort * LAND_ASPECT
  const ratioCap = focusPlaced.length > 0 ? nicheAreaCap(focusPlaced) : sizeCap
  const cap = Math.min(sizeCap, ratioCap)
  const attachIds = focusIds.size > 0 ? focusIds : new Set(placed.map((item) => item.photoId))
  const wrapRings = includeAll ? undefined : 2.15

  if (!includeAll) {
    const budget = Math.max(16, focus.length === 0 ? 18 : focus.length * 6 + 8)
    pool = pool.slice(0, Math.min(pool.length, budget))
  }

  placed = attachPhotos(pool, placed, g, nicheShort, cap, attachIds, hintAspect, false, wrapRings)

  const used = new Set(placed.map((item) => item.photoId))
  let leftover = tagged.filter((photo) => !used.has(photo.id) && (focusIds.size === 0 || !focusIds.has(photo.id)))
  placed = fillPhotoPockets(placed, leftover, g, cap)

  if (includeAll) {
    leftover = tagged.filter((photo) => !placed.some((item) => item.photoId === photo.id))
    if (leftover.length > 0) {
      placed = attachPhotos(leftover, placed, g, nicheShort, cap, attachIds, hintAspect, false)
    }
    leftover = tagged.filter((photo) => !placed.some((item) => item.photoId === photo.id))
    for (const photo of leftover) {
      const slot = pickSlot(photo, placed, g, nicheShort, cap, attachIds, hintAspect, false, true)
      if (slot) placed.push(fillCell(photo, slot.box))
    }
  } else {
    leftover = tagged.filter((photo) => !placed.some((item) => item.photoId === photo.id))
    placed = fillPhotoPockets(placed, leftover, g, cap)
  }

  const settleBox = boundsOf(placed)
  const settleCap = nicheAreaCap(placed.filter((item) => focusIds.has(item.photoId)))
  placed = settlePlacements(tagged, placed, g, { nicheMaxArea: settleCap }, settleBox)

  return normalizePlacements(placed)
}

export function pack(photos: Photo[], page: Page, options: PackOptions): Placement[] {
  coverMemo.clear()
  const gutter = Math.max(0, options.gutter)
  const breakIndex = Number.isFinite(options.breakIndex) ? options.breakIndex : 0
  const layout: LayoutMode = options.layout ?? 'center'
  const includeAll = options.includeAll !== false
  const tagged = tagGroups(photos, breakIndex)
  if (tagged.length === 0) return []
  if (layout !== 'boundless' && (page.width < 1 || page.height < 1)) return []

  const breakAt = clamp(Math.trunc(breakIndex), 0, tagged.length)
  const focus = tagged.slice(0, breakAt)
  const niche = tagged.slice(breakAt)

  if (layout === 'boundless') {
    return finish(packBoundless(focus, niche, gutter, tagged, includeAll, page))
  }

  const full: Rect = { x: 0, y: 0, w: page.width, h: page.height }

  let placed: Placement[]
  if (focus.length === 0) {
    placed = riverFill(niche, full, gutter, undefined, includeAll)
  } else if (niche.length === 0) {
    placed = riverFill(focus, full, gutter, undefined, true)
  } else if (layout === 'bottom') {
    placed = flipY(packTopMixed(focus, niche, full, gutter, tagged, includeAll), full.h)
  } else if (layout === 'ring') {
    placed = packRing(focus, niche, full, gutter, tagged, includeAll)
  } else if (layout === 'center') {
    placed = packCenter(focus, niche, full, gutter, tagged, includeAll)
  } else {
    placed = packTopMixed(focus, niche, full, gutter, tagged, includeAll)
  }

  const used = new Set(placed.map((item) => item.photoId))
  const leftover = niche.filter((photo) => !used.has(photo.id))
  placed = coverPage(placed, tagged, full, gutter, leftover, includeAll)

  return finish(placed)
}

export function spareHoles(page: Page, placements: Placement[], gutter: number): Rect[] {
  const g = Math.max(0, gutter)
  const minSide = Math.max(40, g + 16)
  const full: Rect = { x: 0, y: 0, w: page.width, h: page.height }
  const typical = typicalCellArea(placements)
  return leftoverHoles(full, placements, g)
    .filter((hole) => hole.w >= minSide && hole.h >= minSide)
    .filter((hole) => photoShapedPocket(hole, placements, g, typical, full))
    .sort((a, b) => b.w * b.h - a.w * a.h)
}

export function fillSpareHole(
  placements: Placement[],
  photos: Photo[],
  page: Page,
  gutter: number,
  hole: Rect,
  layout?: LayoutMode,
): Placement[] {
  const g = Math.max(0, gutter)
  const used = new Set(placements.map((item) => item.photoId))
  const remaining = photos.filter((photo) => !used.has(photo.id))
  if (remaining.length === 0) return placements
  const byId = new Map(photos.map((photo) => [photo.id, photo]))
  const focusPlaced = placements.filter((item) => byId.get(item.photoId)?.group === 'focus')
  const cap = nicheAreaCap(focusPlaced)
  if (layout === 'boundless') {
    const holeAspect = hole.w / Math.max(hole.h, 0.001)
    const ranked = remaining
      .slice()
      .sort(
        (a, b) =>
          Math.abs(Math.log(targetCellAspect(a) / holeAspect)) -
          Math.abs(Math.log(targetCellAspect(b) / holeAspect)),
      )
    for (const photo of ranked) {
      const extra = fillOnePocket(photo, hole, cap)
      if (!extra || collide(extra, placements, g)) continue
      return finish(normalizePlacements([...placements, extra]))
    }
    return placements
  }
  let extra = placeIntoHole(remaining, hole, g, false, cap)
  if (extra.length === 0) extra = placeIntoHole(remaining.slice(0, 1), hole, g, true, cap)
  if (extra.length === 0) return placements
  const full: Rect = { x: 0, y: 0, w: page.width, h: page.height }
  const combined = [...placements, ...extra]
  const leftover = remaining.filter((photo) => !extra.some((item) => item.photoId === photo.id))
  const focusIds = new Set(focusPlaced.map((item) => item.photoId))
  return finish(
    gapFill(combined, photos, full, g, cap, GAP_PASSES, canGrowFocus(combined, leftover, focusIds)),
  )
}
