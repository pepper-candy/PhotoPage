import { clamp, legalAspectRange, preferredAspect, sourceRectForAspect } from './crop.ts'
import type { LayoutMode, PackOptions, Page, Photo, PhotoGroup, Placement, Rect } from './types.ts'

const EPS = 0.6
const FOCUS_ROW_SCALE = 2.2
const FOCUS_MIN_RATIO = 1.5
const GAP_PASSES = 5

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

function placeFocus(
  focus: Photo[],
  page: Rect,
  gutter: number,
  nicheCount: number,
  includeAll: boolean,
): Placement[] {
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
  return gapFill([...focusPlaced, ...nichePlaced], tagged, full, gutter, cap)
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
  if (rects.length === 0 || niche.length === 0) {
    return gapFill(occupied, tagged, page, gutter, cap)
  }
  const nichePlaced = packNicheRects(niche, rects, gutter, includeAll, cap)
  return gapFill([...occupied, ...nichePlaced], tagged, page, gutter, cap)
}

function splitRegions(rect: Rect, count: number, gutter: number): Rect[] {
  if (count <= 1) return [{ ...rect }]
  const leftN = Math.ceil(count / 2)
  const rightN = count - leftN
  const g = Math.max(0, gutter)
  if (rect.w >= rect.h) {
    const inner = Math.max(1, rect.w - g)
    const w1 = inner * (leftN / count)
    const left = { x: rect.x, y: rect.y, w: w1, h: rect.h }
    const right = { x: rect.x + w1 + g, y: rect.y, w: Math.max(1, rect.w - w1 - g), h: rect.h }
    return [...splitRegions(left, leftN, gutter), ...splitRegions(right, rightN, gutter)]
  }
  const inner = Math.max(1, rect.h - g)
  const h1 = inner * (leftN / count)
  const top = { x: rect.x, y: rect.y, w: rect.w, h: h1 }
  const bottom = { x: rect.x, y: rect.y + h1 + g, w: rect.w, h: Math.max(1, rect.h - h1 - g) }
  return [...splitRegions(top, leftN, gutter), ...splitRegions(bottom, rightN, gutter)]
}

function bandCut(
  photo: Photo,
  region: Rect,
  areaWanted: number,
  anchor: number,
  gutter: number,
): { box: Rect; rest: Rect } | null {
  const { min, max } = legalAspectRange(photo)
  const g = Math.max(0, gutter)
  const options: { box: Rect; rest: Rect; score: number }[] = []
  const hLo = region.w / max
  const hHi = Math.min(region.w / min, region.h - g - 28)
  if (hLo <= hHi + 0.5 && hHi >= 18) {
    const h = clamp(areaWanted / Math.max(region.w, 1), Math.max(18, hLo), hHi)
    if (region.h - h - g >= 28) {
      const top = anchor % 2 === 0
      const box = { x: region.x, y: top ? region.y : region.y + region.h - h, w: region.w, h }
      const rest = {
        x: region.x,
        y: top ? region.y + h + g : region.y,
        w: region.w,
        h: region.h - h - g,
      }
      options.push({ box, rest, score: Math.abs(box.w * box.h - areaWanted) })
    }
  }
  const wLo = region.h * min
  const wHi = Math.min(region.h * max, region.w - g - 28)
  if (wLo <= wHi + 0.5 && wHi >= 18) {
    const w = clamp(areaWanted / Math.max(region.h, 1), Math.max(18, wLo), wHi)
    if (region.w - w - g >= 28) {
      const left = anchor % 4 < 2
      const box = { x: left ? region.x : region.x + region.w - w, y: region.y, w, h: region.h }
      const rest = {
        x: left ? region.x + w + g : region.x,
        y: region.y,
        w: region.w - w - g,
        h: region.h,
      }
      options.push({ box, rest, score: Math.abs(box.w * box.h - areaWanted) })
    }
  }
  options.sort((a, b) => a.score - b.score)
  return options[0] ?? null
}

function stackBeside(
  focus: Photo,
  niches: Photo[],
  region: Rect,
  gutter: number,
  focusLeft: boolean,
  minRatio = FOCUS_MIN_RATIO,
): Placement[] | null {
  const g = Math.max(0, gutter)
  if (niches.length === 0) {
    if (!fitsAspect(focus, region.w, region.h)) return null
    return [fillCell(focus, region)]
  }
  const gaps = g * (niches.length - 1)
  const rh = (region.h - gaps) / niches.length
  if (rh < 24) return null
  let rwLo = 0
  let rwHi = Number.POSITIVE_INFINITY
  for (const photo of niches) {
    const range = legalAspectRange(photo)
    rwLo = Math.max(rwLo, range.min * rh)
    rwHi = Math.min(rwHi, range.max * rh)
  }
  if (!(rwLo <= rwHi)) return null
  const { min, max } = legalAspectRange(focus)
  const inner = region.w - g
  const fwMin = Math.max(min * region.h, inner - rwHi)
  const fwMax = Math.min(max * region.h, inner - rwLo, region.w - g - 24)
  if (!(fwMin <= fwMax)) return null
  const fwIdeal = (FOCUS_MIN_RATIO * rh * inner) / (region.h + FOCUS_MIN_RATIO * rh)
  const fw = clamp(fwIdeal, fwMin, fwMax)
  const rw = inner - fw
  const ratio = (fw * region.h) / Math.max(rw * rh, 1)
  if (ratio < minRatio - 0.03 || ratio > 4.5) return null
  if (niches.some((photo) => !fitsAspect(photo, rw, rh))) return null
  const fx = focusLeft ? region.x : region.x + region.w - fw
  const rx = focusLeft ? region.x + fw + g : region.x
  const placed: Placement[] = [fillCell(focus, { x: fx, y: region.y, w: fw, h: region.h })]
  let y = region.y
  niches.forEach((photo, index) => {
    const h = index === niches.length - 1 ? region.y + region.h - y : rh
    if (!fitsAspect(photo, rw, h)) return
    placed.push(fillCell(photo, { x: rx, y, w: rw, h }))
    y += h + g
  })
  if (placed.length !== niches.length + 1) return null
  return placed
}

function stackUnder(
  focus: Photo,
  niches: Photo[],
  region: Rect,
  gutter: number,
  focusTop: boolean,
  minRatio = FOCUS_MIN_RATIO,
): Placement[] | null {
  const g = Math.max(0, gutter)
  if (niches.length === 0) return null
  const gaps = g * (niches.length - 1)
  const rw = (region.w - gaps) / niches.length
  if (rw < 24) return null
  let rhLo = 0
  let rhHi = Number.POSITIVE_INFINITY
  for (const photo of niches) {
    const range = legalAspectRange(photo)
    rhLo = Math.max(rhLo, rw / range.max)
    rhHi = Math.min(rhHi, rw / range.min)
  }
  if (!(rhLo <= rhHi)) return null
  const { min, max } = legalAspectRange(focus)
  const inner = region.h - g
  const fhMin = Math.max(region.w / max, inner - rhHi)
  const fhMax = Math.min(region.w / min, inner - rhLo, region.h - g - 24)
  if (!(fhMin <= fhMax)) return null
  const fh = clamp(region.h * (FOCUS_MIN_RATIO / (FOCUS_MIN_RATIO + niches.length)), fhMin, fhMax)
  const rh = inner - fh
  if (niches.some((photo) => !fitsAspect(photo, rw, rh))) return null
  const nicheArea = rw * rh
  const ratio = (region.w * fh) / Math.max(nicheArea, 1)
  if (ratio < minRatio - 0.03 || ratio > 4.5) return null
  const fy = focusTop ? region.y : region.y + region.h - fh
  const ny = focusTop ? region.y + fh + g : region.y
  const placed: Placement[] = [fillCell(focus, { x: region.x, y: fy, w: region.w, h: fh })]
  let x = region.x
  niches.forEach((photo, index) => {
    const w = index === niches.length - 1 ? region.x + region.w - x : rw
    if (!fitsAspect(photo, w, rh)) return
    placed.push(fillCell(photo, { x, y: ny, w, h: rh }))
    x += w + g
  })
  if (placed.length !== niches.length + 1) return null
  return placed
}

function bestQuadrant(
  focus: Photo,
  niches: Photo[],
  region: Rect,
  gutter: number,
  minRatio = FOCUS_MIN_RATIO,
): Placement[] | null {
  const found = [
    stackBeside(focus, niches, region, gutter, true, minRatio),
    stackBeside(focus, niches, region, gutter, false, minRatio),
    stackUnder(focus, niches, region, gutter, true, minRatio),
    stackUnder(focus, niches, region, gutter, false, minRatio),
  ].filter((item): item is Placement[] => item != null)
  if (found.length === 0) return null
  const score = (placed: Placement[]) => {
    const focusCell = placed[0]
    const rest = placed.slice(1)
    const focusArea = cellArea(focusCell)
    const nicheArea = rest.length ? Math.max(...rest.map(cellArea)) : focusArea
    return Math.abs(focusArea / nicheArea - FOCUS_MIN_RATIO)
  }
  found.sort((a, b) => score(a) - score(b))
  return found[0]
}

function packScattered(
  focus: Photo[],
  niche: Photo[],
  full: Rect,
  gutter: number,
  tagged: Photo[],
  includeAll: boolean,
): Placement[] {
  if (focus.length === 0) {
    const placed = slicePack(niche, full, gutter, includeAll)
    return gapFill(
      placed,
      includeAll ? niche : niche.filter((photo) => placed.some((item) => item.photoId === photo.id)),
      full,
      gutter,
    )
  }

  if (!includeAll) {
    const regions = splitRegions(full, focus.length, gutter)
    const placed: Placement[] = []
    let rest = niche.slice()
    regions.forEach((region, index) => {
      const photo = focus[Math.min(index, focus.length - 1)]
      const hit =
        bestQuadrant(photo, rest.slice(0, 2), region, gutter) ??
        bestQuadrant(photo, rest.slice(0, 1), region, gutter) ??
        bestQuadrant(photo, rest.slice(0, 2), region, gutter, 0.85) ??
        bestQuadrant(photo, rest.slice(0, 1), region, gutter, 0.85)
      if (!hit) {
        const range = legalAspectRange(photo)
        const pref = preferredAspect(photo)
        let fh = region.h
        let fw = clamp(pref * fh, range.min * fh, range.max * fh)
        if (fw > region.w - 48) {
          fw = Math.min(fw, region.w * 0.48)
          fh = clamp(fw / pref, fw / range.max, Math.min(region.h, fw / range.min))
        }
        fw = Math.min(fw, region.w)
        fh = Math.min(fh, region.h)
        const box = { x: region.x, y: region.y, w: fw, h: fh }
        const manual: Placement[] = [fillCell(photo, box)]
        const niche = rest[0]
        const sideW = region.w - fw - gutter
        if (niche && sideW > 64 && fh > 64) {
          const nicheRange = legalAspectRange(niche)
          const nw = clamp(preferredAspect(niche) * fh, nicheRange.min * fh, nicheRange.max * fh)
          if (nw >= 48 && nw <= sideW + 2) {
            manual.push(fillCell(niche, { x: region.x + fw + gutter, y: region.y, w: Math.min(nw, sideW), h: fh }))
          }
        }
        placed.push(...manual)
        const used = new Set(manual.map((item) => item.photoId))
        rest = rest.filter((item) => !used.has(item.id))
        return
      }
      placed.push(...hit)
      const used = new Set(hit.map((item) => item.photoId))
      rest = rest.filter((item) => !used.has(item.id))
    })
    return placed
  }

  const targetA = minFocusCellArea(full, focus.length, niche.length, includeAll)
  const regions = splitRegions(full, focus.length, gutter)
  const perRegion = includeAll
    ? Math.max(1, Math.ceil(niche.length / Math.max(1, focus.length)))
    : 2
  const focusArea = Math.max(
    targetA * 0.55,
    (cellArea(full) * FOCUS_MIN_RATIO) / (focus.length * (FOCUS_MIN_RATIO + perRegion)),
  )
  const leftover: Rect[] = []
  const focusPlaced = focus.map((photo, index) => {
    const region = regions[Math.min(index, regions.length - 1)]
    const wanted = Math.min(focusArea, cellArea(region) * 0.62)
    const cut = bandCut(photo, region, wanted, index, gutter)
    const bandArea = cut ? cut.box.w * cut.box.h : 0
    if (
      cut &&
      cut.rest.w > 36 &&
      cut.rest.h > 36 &&
      bandArea <= wanted * 1.35 &&
      bandArea >= wanted * 0.62
    ) {
      leftover.push(cut.rest)
      return fillCell(photo, cut.box)
    }
    const { min, max } = legalAspectRange(photo)
    const aspect = clamp(preferredAspect(photo), min, max)
    let fh = Math.sqrt(Math.max(wanted, 1) / aspect)
    let fw = fh * aspect
    const fit = Math.min(1, (region.w * 0.7) / fw, (region.h * 0.7) / fh)
    fw *= fit
    fh *= fit
    const left = index % 2 === 0
    const top = index % 4 < 2
    const box = {
      x: left ? region.x : region.x + region.w - fw,
      y: top ? region.y : region.y + region.h - fh,
      w: fw,
      h: fh,
    }
    const g = Math.max(0, gutter)
    if (left && region.w - fw - g > 40) {
      leftover.push({ x: box.x + fw + g, y: box.y, w: region.x + region.w - (box.x + fw + g), h: fh })
    } else if (!left && box.x - region.x - g > 40) {
      leftover.push({ x: region.x, y: box.y, w: box.x - region.x - g, h: fh })
    }
    if (top && region.h - fh - g > 40) {
      leftover.push({
        x: region.x,
        y: box.y + fh + g,
        w: region.w,
        h: region.y + region.h - (box.y + fh + g),
      })
    } else if (!top && box.y - region.y - g > 40) {
      leftover.push({ x: region.x, y: region.y, w: region.w, h: box.y - region.y - g })
    }
    return fillCell(photo, box)
  })
  if (niche.length === 0) {
    return gapFill(focusPlaced, focus, full, gutter)
  }

  const cap = nicheAreaCap(focusPlaced)
  const rects = (leftover.length ? leftover : freeRects(full, focusPlaced, gutter))
    .filter((rect) => rect.w > 40 && rect.h > 40)
    .sort((a, b) => a.y - b.y || a.x - b.x)
  if (rects.length === 0) return gapFill(focusPlaced, tagged, full, gutter, cap)

  const nichePlaced = packNicheRects(niche, rects, gutter, includeAll, cap)
  return gapFill([...focusPlaced, ...nichePlaced], tagged, full, gutter, cap)
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
  if (includeAll && focus.length > 0 && niche.length > 0) {
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
  const raw = placeFocus(focus, full, gutter, niche.length, includeAll)
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
    placements = gapFill(placements, tagged, page, gutter, cap, 6)

    const holes = leftoverHoles(page, placements, gutter)
    if (holes.length === 0) break

    let progressed = false
    for (const hole of holes) {
      const neighbors = placements
        .map((item, index) => ({ item, index, side: edgeSide(item, hole, gutter) }))
        .filter((entry) => entry.side)
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
      const sizes = placements.map(cellArea).sort((a, b) => a - b)
      const typical = sizes[Math.floor(sizes.length / 2)] ?? 0
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
  return gapFill(placements, tagged, page, gutter, cap, 10)
}

function finish(placed: Placement[]): Placement[] {
  return placed.filter(
    (placement) => placement.w > 0 && placement.h > 0 && placement.sw > 0 && placement.sh > 0,
  )
}

export function pack(photos: Photo[], page: Page, options: PackOptions): Placement[] {
  coverMemo.clear()
  const gutter = Math.max(0, options.gutter)
  const breakIndex = Number.isFinite(options.breakIndex) ? options.breakIndex : 0
  const layout: LayoutMode = options.layout ?? 'top'
  const includeAll = options.includeAll !== false
  const tagged = tagGroups(photos, breakIndex)
  if (tagged.length === 0 || page.width < 1 || page.height < 1) return []

  const full: Rect = { x: 0, y: 0, w: page.width, h: page.height }
  const breakAt = clamp(Math.trunc(breakIndex), 0, tagged.length)
  const focus = tagged.slice(0, breakAt)
  const niche = tagged.slice(breakAt)

  let placed: Placement[]
  if (layout === 'scattered') {
    placed = packScattered(focus, niche, full, gutter, tagged, includeAll)
  } else if (focus.length === 0) {
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
