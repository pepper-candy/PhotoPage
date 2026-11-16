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

function spanSlice(
  photo: Photo,
  region: Rect,
  gutter: number,
  toward: number,
  share: number,
): { box: Rect; rest: Rect } | null {
  const { min, max } = legalAspectRange(photo)
  const pref = preferredAspect(photo)
  const tryH = () => {
    const hLo = region.w / max
    const hHi = region.w / min
    if (hLo > region.h - gutter - 8 || hHi < 12) return null
    let h = clamp(region.w / pref, hLo, hHi)
    h = Math.min(h, Math.max(12, (region.h - gutter) * share), region.h - gutter - 12)
    if (h < 12) return null
    const fromTop = toward % 4 < 2
    const box = {
      x: region.x,
      y: fromTop ? region.y : region.y + region.h - h,
      w: region.w,
      h,
    }
    const restH = region.h - h - gutter
    if (restH < 8) return null
    const rest = {
      x: region.x,
      y: fromTop ? region.y + h + gutter : region.y,
      w: region.w,
      h: restH,
    }
    return { box, rest }
  }
  const tryW = () => {
    const wLo = region.h * min
    const wHi = region.h * max
    if (wLo > region.w - gutter - 8 || wHi < 12) return null
    let w = clamp(pref * region.h, wLo, wHi)
    w = Math.min(w, Math.max(12, (region.w - gutter) * share), region.w - gutter - 12)
    if (w < 12) return null
    const fromLeft = toward % 4 === 1 || toward % 4 === 2
    const box = {
      x: fromLeft ? region.x : region.x + region.w - w,
      y: region.y,
      w,
      h: region.h,
    }
    const restW = region.w - w - gutter
    if (restW < 8) return null
    const rest = {
      x: fromLeft ? region.x + w + gutter : region.x,
      y: region.y,
      w: restW,
      h: region.h,
    }
    return { box, rest }
  }
  return toward % 2 === 1 ? (tryW() ?? tryH()) : (tryH() ?? tryW())
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

  const targetA = minFocusCellArea(full, focus.length, niche.length, includeAll)
  const regions = splitRegions(full, focus.length, gutter)
  const leftover: Rect[] = []
  const focusPlaced = focus.map((photo, index) => {
    const region = regions[Math.min(index, regions.length - 1)]
    const share = clamp(Math.max(0.64, targetA / Math.max(1, cellArea(region))), 0.64, 0.86)
    const cut = spanSlice(photo, region, gutter, index + 1, share)
    if (cut) {
      if (cut.rest.w > 40 && cut.rest.h > 40) leftover.push(cut.rest)
      return fillCell(photo, cut.box)
    }
    const fallback = boxForArea(photo, targetA, region.w * 0.9, region.h * 0.86)
    const box = {
      x: region.x + (index % 2 === 0 ? 0 : Math.max(0, region.w - fallback.w)),
      y: region.y + (index % 4 < 2 ? 0 : Math.max(0, region.h - fallback.h)),
      w: fallback.w,
      h: fallback.h,
    }
    leftover.push(
      ...freeRects(region, [{ ...box, photoId: photo.id, sx: 0, sy: 0, sw: 1, sh: 1 }], gutter),
    )
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

function packRing(
  focus: Photo[],
  niche: Photo[],
  full: Rect,
  gutter: number,
  tagged: Photo[],
  includeAll: boolean,
): Placement[] {
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

function packCenter(
  focus: Photo[],
  niche: Photo[],
  full: Rect,
  gutter: number,
  tagged: Photo[],
  includeAll: boolean,
): Placement[] {
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
      for (const hole of holes) {
        const extra = placeIntoHole(remaining, hole, gutter, includeAll, cap)
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
