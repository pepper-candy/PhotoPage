import { clamp, legalAspectRange, preferredAspect, sourceRectForAspect } from './crop.ts'
import type { LayoutMode, PackOptions, Page, Photo, PhotoGroup, Placement, Rect } from './types.ts'

const EPS = 0.6
const FOCUS_ROW_SCALE = 2.2
const GAP_PASSES = 5

type Dir = 'right' | 'down' | 'left' | 'up'
type Limits = { inner: number; hMin: number; hMax: number; hPref: number }

function tagGroups(photos: Photo[], breakIndex: number): Photo[] {
  const b = clamp(Math.trunc(breakIndex), 0, photos.length)
  return photos.map((photo, index) => {
    const group: PhotoGroup = index < b ? 'focus' : 'niche'
    return photo.group === group ? photo : { ...photo, group }
  })
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
    x: box.x + (box.w - w) / 2,
    y: box.y + (box.h - h) / 2,
    w: Math.max(1, w),
    h: Math.max(1, h),
  }
}

function toPlacement(photo: Photo, box: Rect): Placement {
  const fitted = legalBox(photo, box)
  const src = sourceRectForAspect(photo, fitted.w / Math.max(fitted.h, 0.001))
  const aspect = src.w / Math.max(src.h, 0.001)
  let w = fitted.w
  let h = w / aspect
  if (h > fitted.h + EPS) {
    h = fitted.h
    w = h * aspect
  }
  return {
    photoId: photo.id,
    x: fitted.x + (fitted.w - w) / 2,
    y: fitted.y + (fitted.h - h) / 2,
    w: Math.max(1, w),
    h: Math.max(1, h),
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

function bestPartition(photos: Photo[], width: number, height: number, gutter: number): Photo[][] {
  if (photos.length <= 1) return photos.length ? [[...photos]] : []

  const scoreOf = (rows: Photo[][]) => Math.abs(naturalTotal(rows, width, gutter) - height)
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
    const sumW = widths.reduce((sum, w) => sum + w, 0)
    const baseGaps = Math.max(0, row.length - 1) * gutter
    let leftover = region.w - sumW - baseGaps
    if (leftover < 0) leftover = 0
    const extra = leftover > 1 ? leftover / (row.length + 1) : 0
    let x = region.x + extra
    const gap = gutter + extra
    for (let i = 0; i < row.length; i++) {
      const w = Math.max(1, widths[i])
      placements.push(toPlacement(row[i], { x, y, w, h: height }))
      x += w + gap
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
  return toPlacement(photo, {
    x: region.x + (region.w - w) / 2,
    y: region.y + (region.h - h) / 2,
    w,
    h,
  })
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
  return { area: w * h - placement.w * placement.h, next: toPlacement(photo, box) }
}

function gapFill(
  start: Placement[],
  photos: Photo[],
  region: Rect,
  gutter: number,
): Placement[] {
  const byId = new Map(photos.map((photo) => [photo.id, photo]))
  const order = new Map(photos.map((photo, index) => [photo.id, index]))
  const placements = start.map((placement) => ({ ...placement }))
  const dirs: Dir[] = ['down', 'right', 'up', 'left']

  for (let pass = 0; pass < GAP_PASSES; pass++) {
    const candidates: { photoId: string; dir: Dir; area: number }[] = []
    for (const placement of placements) {
      const photo = byId.get(placement.photoId)
      if (!photo) continue
      let best: { dir: Dir; area: number } | null = null
      for (const dir of dirs) {
        const candidate = tryExpand(placement, dir, placements, photo, region, gutter)
        if (candidate && (!best || candidate.area > best.area)) {
          best = { dir, area: candidate.area }
        }
      }
      if (best) candidates.push({ photoId: placement.photoId, dir: best.dir, area: best.area })
    }
    candidates.sort(
      (a, b) => (order.get(b.photoId) ?? 0) - (order.get(a.photoId) ?? 0) || b.area - a.area,
    )
    for (const candidate of candidates) {
      const placement = placements.find((item) => item.photoId === candidate.photoId)
      const photo = byId.get(candidate.photoId)
      if (!placement || !photo) continue
      const fresh = tryExpand(placement, candidate.dir, placements, photo, region, gutter)
      if (!fresh || fresh.area < EPS) continue
      placements[placements.indexOf(placement)] = fresh.next
    }
  }
  return placements
}

function distributeVertical(placements: Placement[], region: Rect, gutter: number): Placement[] {
  if (placements.length === 0) return placements
  const sorted = [...placements].sort((a, b) => a.y - b.y || a.x - b.x)
  const rows: Placement[][] = []
  for (const placement of sorted) {
    const last = rows[rows.length - 1]
    if (!last || Math.abs(last[0].y - placement.y) > 1) rows.push([placement])
    else last.push(placement)
  }
  const top = Math.min(...placements.map((p) => p.y))
  const bottom = Math.max(...placements.map((p) => p.y + p.h))
  const slack = region.h - (bottom - top)
  if (slack < 2) return placements

  const extra = slack / (rows.length + 1)
  const shift = new Map<string, number>()
  let y = region.y + extra
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const rowTop = Math.min(...row.map((p) => p.y))
    const rowBottom = Math.max(...row.map((p) => p.y + p.h))
    const dy = y - rowTop
    for (const placement of row) shift.set(placement.photoId, dy)
    const nextTop = i < rows.length - 1 ? Math.min(...rows[i + 1].map((p) => p.y)) : rowBottom
    const existingGap = i < rows.length - 1 ? Math.max(gutter, nextTop - rowBottom) : 0
    y += rowBottom - rowTop + existingGap + extra
  }
  return placements.map((placement) => ({
    ...placement,
    y: placement.y + (shift.get(placement.photoId) ?? 0),
  }))
}

function healthyArea(region: Rect): number {
  const edge = Math.max(120, Math.min(region.w, region.h) * 0.22)
  return edge * edge
}

function fillCell(photo: Photo, box: Rect): Placement {
  const a = box.w / Math.max(box.h, 0.001)
  const { min, max } = legalAspectRange(photo)
  if (a + 1e-4 < min || a - 1e-4 > max) return toPlacement(photo, box)
  const src = sourceRectForAspect(photo, a)
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

function chooseSlice(
  photo: Photo,
  region: Rect,
  remaining: number,
  gutter: number,
  includeAll: boolean,
  targetArea: number,
  depth: number,
): { cell: Rect; rest: Rect } | null {
  if (remaining <= 1 || region.w < 16 || region.h < 16) return null
  const { min, max } = legalAspectRange(photo)
  const g = Math.max(0, gutter)
  const regionArea = region.w * region.h
  const want = includeAll ? regionArea / remaining : Math.min(targetArea, regionArea * 0.58)
  const minRest = includeAll ? 12 : Math.sqrt(targetArea) * 0.55

  const vertical = (cellW: number): { cell: Rect; rest: Rect } | null => {
    if (cellW < 12 || cellW > region.w - g - 12) return null
    const aspect = cellW / region.h
    if (aspect < min - 0.02 || aspect > max + 0.02) return null
    const restW = region.w - cellW - g
    if (restW < minRest && !includeAll) return null
    if (restW < 12) return null
    return {
      cell: { x: region.x, y: region.y, w: cellW, h: region.h },
      rest: { x: region.x + cellW + g, y: region.y, w: restW, h: region.h },
    }
  }
  const horizontal = (cellH: number): { cell: Rect; rest: Rect } | null => {
    if (cellH < 12 || cellH > region.h - g - 12) return null
    const aspect = region.w / cellH
    if (aspect < min - 0.02 || aspect > max + 0.02) return null
    const restH = region.h - cellH - g
    if (restH < minRest && !includeAll) return null
    if (restH < 12) return null
    return {
      cell: { x: region.x, y: region.y, w: region.w, h: cellH },
      rest: { x: region.x, y: region.y + cellH + g, w: region.w, h: restH },
    }
  }

  const vFromArea = clamp(want / region.h, min * region.h, max * region.h)
  const hFromArea = clamp(want / region.w, region.w / max, region.w / min)
  const preferV = depth % 2 === 0 ? region.w >= region.h : region.w > region.h * 1.12
  if (preferV) return vertical(vFromArea) ?? horizontal(hFromArea) ?? vertical(min * region.h) ?? horizontal(region.w / max)
  return horizontal(hFromArea) ?? vertical(vFromArea) ?? horizontal(region.w / max) ?? vertical(min * region.h)
}

function slicePack(
  photos: Photo[],
  region: Rect,
  gutter: number,
  includeAll: boolean,
  targetArea?: number,
  depth = 0,
): Placement[] {
  if (photos.length === 0 || region.w < 8 || region.h < 8) return []
  const goal = targetArea ?? (includeAll ? (region.w * region.h) / photos.length : healthyArea(region))
  if (photos.length === 1) return [fillCell(photos[0], region)]

  if (!includeAll && region.w * region.h <= goal * 1.15) {
    return [fillCell(photos[0], region)]
  }

  const cut = chooseSlice(photos[0], region, photos.length, gutter, includeAll, goal, depth)
  if (!cut) return [fillCell(photos[0], region)]

  return [
    fillCell(photos[0], cut.cell),
    ...slicePack(photos.slice(1), cut.rest, gutter, includeAll, goal, depth + 1),
  ]
}

function fillRemainingHoles(
  placed: Placement[],
  unused: Photo[],
  page: Rect,
  gutter: number,
  tagged: Photo[],
  includeAll: boolean,
): Placement[] {
  let placements = placed.slice()
  let remaining = unused.slice()
  const minCell = Math.max(28, gutter + 8)
  for (let pass = 0; pass < 24 && remaining.length > 0; pass++) {
    const holes = freeRects(page, placements, gutter)
      .filter((rect) => rect.w >= minCell && rect.h >= minCell)
      .sort((a, b) => b.w * b.h - a.w * a.h)
    if (holes.length === 0) break
    const hole = holes[0]
    const extra = slicePack(remaining, hole, gutter, includeAll)
    if (extra.length === 0) break
    placements = [...placements, ...extra]
    remaining = remaining.filter((photo) => !extra.some((item) => item.photoId === photo.id))
  }
  return gapFill(placements, tagged, page, gutter)
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

function placeFocus(focus: Photo[], page: Rect, gutter: number, nicheCount: number): Placement[] {
  const { focusH, focusCap } = planFocus(page.h, gutter, focus.length, nicheCount)
  let target = focusH
  let rows = partitionByTarget(focus, page.w, gutter, target)
  const maxH = Math.max(48, focusCap)
  for (let i = 0; i < 8; i++) {
    const probe = layoutRows(rows, { ...page, h: page.h }, gutter, false, target)
    const used = probe.reduce((max, placement) => Math.max(max, placement.y + placement.h), 0)
    if (used <= maxH + 1) break
    target = Math.max(32, target * 0.72)
    rows = partitionByTarget(focus, page.w, gutter, target)
  }
  const region = { x: page.x, y: page.y, w: page.w, h: maxH }
  return layoutRows(rows, region, gutter, false, target)
}

function packTopMixed(
  focus: Photo[],
  niche: Photo[],
  full: Rect,
  gutter: number,
  tagged: Photo[],
  includeAll: boolean,
): Placement[] {
  const focusPlaced = placeFocus(focus, full, gutter, includeAll ? niche.length : Math.max(1, Math.min(niche.length, 8)))
  const rects = sideAndBottom(full, focusPlaced, gutter)
  let nichePlaced: Placement[]
  if (includeAll) {
    const groups = splitByArea(niche, rects)
    nichePlaced = rects.flatMap((rect, index) => riverFill(groups[index] ?? [], rect, gutter, undefined, true))
  } else {
    let remaining = niche.slice()
    nichePlaced = []
    for (const rect of rects) {
      if (remaining.length === 0) break
      const placed = riverFill(remaining, rect, gutter, undefined, false)
      const used = new Set(placed.map((item) => item.photoId))
      remaining = remaining.filter((photo) => !used.has(photo.id))
      nichePlaced.push(...placed)
    }
  }
  return gapFill([...focusPlaced, ...nichePlaced], tagged, full, gutter)
}

function flipY(placements: Placement[], pageH: number): Placement[] {
  return placements.map((placement) => ({
    ...placement,
    y: pageH - placement.y - placement.h,
  }))
}

function sizedBox(photo: Photo, maxW: number, maxH: number): { w: number; h: number } {
  const { min, max } = legalAspectRange(photo)
  const aspect = clamp(preferredAspect(photo), min, max)
  let w = Math.max(1, maxW)
  let h = w / aspect
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

function inflate(rect: Rect, pad: number): Rect {
  return { x: rect.x - pad, y: rect.y - pad, w: rect.w + pad * 2, h: rect.h + pad * 2 }
}

function subtractRect(free: Rect, used: Rect, gutter: number): Rect[] {
  const blocked = inflate(used, gutter)
  if (!boxesOverlap(free, blocked, 0)) return [free]
  const gap = gutter
  const out: Rect[] = []
  const topH = blocked.y - gap - free.y
  if (topH > 8) out.push({ x: free.x, y: free.y, w: free.w, h: topH })
  const bottomY = blocked.y + blocked.h + gap
  const bottomH = free.y + free.h - bottomY
  if (bottomH > 8) out.push({ x: free.x, y: bottomY, w: free.w, h: bottomH })
  const top = Math.max(free.y, blocked.y)
  const bot = Math.min(free.y + free.h, blocked.y + blocked.h)
  const midH = bot - top
  if (midH > 8) {
    const leftW = blocked.x - gap - free.x
    if (leftW > 8) out.push({ x: free.x, y: top, w: leftW, h: midH })
    const rightX = blocked.x + blocked.w + gap
    const rightW = free.x + free.w - rightX
    if (rightW > 8) out.push({ x: rightX, y: top, w: rightW, h: midH })
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

function splitForStrips(photos: Photo[], rects: Rect[]): Photo[][] {
  if (rects.length === 0) return []
  if (rects.length === 1) return [photos.slice()]
  const assigned = rects.map((rect) => {
    const aspect = rect.w / Math.max(1, rect.h)
    if (aspect >= 2.2) return Math.max(1, Math.round(rect.w / (rect.h * 1.35)))
    if (aspect <= 0.45) return Math.max(1, Math.round(rect.h / (rect.w * 1.35)))
    return 1
  })
  let total = assigned.reduce((sum, count) => sum + count, 0)
  const areaOf = (index: number) => rects[index].w * rects[index].h
  while (total > photos.length) {
    let idx = -1
    assigned.forEach((count, index) => {
      if (count <= 0) return
      if (idx < 0 || count > assigned[idx] || (count === assigned[idx] && areaOf(index) < areaOf(idx))) {
        idx = index
      }
    })
    if (idx < 0 || (assigned[idx] <= 1 && total - 1 < rects.filter((_, i) => assigned[i] > 0).length)) {
      if (idx < 0) break
      assigned[idx] -= 1
      total -= 1
      continue
    }
    assigned[idx] -= 1
    total -= 1
  }
  if (total < photos.length) {
    const order = rects
      .map((rect, index) => ({ index, area: rect.w * rect.h }))
      .sort((a, b) => b.area - a.area)
    let extra = photos.length - total
    for (let i = 0; extra > 0; i++, extra--) assigned[order[i % order.length].index] += 1
  }
  const groups: Photo[][] = []
  let cursor = 0
  for (const count of assigned) {
    groups.push(photos.slice(cursor, cursor + count))
    cursor += count
  }
  return groups
}

function fillLeftovers(
  niche: Photo[],
  occupied: Placement[],
  page: Rect,
  gutter: number,
  tagged: Photo[],
  includeAll: boolean,
): Placement[] {
  const rects = freeRects(page, occupied, gutter)
    .filter((rect) => rect.w > 48 && rect.h > 36)
    .sort((a, b) => a.y - b.y || a.x - b.x)
  if (rects.length === 0 || niche.length === 0) {
    return gapFill(occupied, tagged, page, gutter)
  }
  let remaining = niche.slice()
  const nichePlaced: Placement[] = []
  if (includeAll) {
    const groups = splitForStrips(niche, rects)
    for (let index = 0; index < rects.length; index++) {
      const group = groups[index] ?? []
      if (group.length === 0) continue
      nichePlaced.push(...slicePack(group, rects[index], gutter, true))
    }
  } else {
    for (const rect of rects) {
      if (remaining.length === 0) break
      const packed = slicePack(remaining, rect, gutter, false)
      const used = new Set(packed.map((item) => item.photoId))
      remaining = remaining.filter((photo) => !used.has(photo.id))
      nichePlaced.push(...packed)
    }
  }
  return gapFill([...occupied, ...nichePlaced], tagged, page, gutter)
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

  const regions = splitRegions(full, focus.length, gutter)
  const leftover: Rect[] = []
  const focusPlaced = focus.map((photo, index) => {
    const region = regions[Math.min(index, regions.length - 1)]
    const cut = spanSlice(photo, region, gutter, index + 1, 0.7)
    if (cut) {
      if (cut.rest.w > 40 && cut.rest.h > 40) leftover.push(cut.rest)
      return toPlacement(photo, cut.box)
    }
    const fallback = sizedBox(photo, region.w * 0.9, region.h * 0.82)
    const box = {
      x: region.x + (index % 2 === 0 ? 0 : Math.max(0, region.w - fallback.w)),
      y: region.y + (index % 4 < 2 ? 0 : Math.max(0, region.h - fallback.h)),
      w: fallback.w,
      h: fallback.h,
    }
    leftover.push(
      ...freeRects(region, [{ ...box, photoId: photo.id, sx: 0, sy: 0, sw: 1, sh: 1 }], gutter),
    )
    return toPlacement(photo, box)
  })
  if (niche.length === 0) {
    return gapFill(focusPlaced, focus, full, gutter)
  }

  const rects = (leftover.length ? leftover : freeRects(full, focusPlaced, gutter))
    .filter((rect) => rect.w > 40 && rect.h > 40)
    .sort((a, b) => a.y - b.y || a.x - b.x)
  if (rects.length === 0) return gapFill(focusPlaced, tagged, full, gutter)

  let remaining = niche.slice()
  const nichePlaced: Placement[] = []
  if (includeAll) {
    const groups = splitByArea(niche, rects)
    for (let index = 0; index < rects.length; index++) {
      const group = groups[index] ?? []
      if (group.length === 0) continue
      nichePlaced.push(...slicePack(group, rects[index], gutter, true))
    }
  } else {
    for (const rect of rects) {
      if (remaining.length === 0) break
      const packed = slicePack(remaining, rect, gutter, false)
      const used = new Set(packed.map((item) => item.photoId))
      remaining = remaining.filter((photo) => !used.has(photo.id))
      nichePlaced.push(...packed)
    }
  }
  return gapFill([...focusPlaced, ...nichePlaced], tagged, full, gutter)
}

function packRing(
  focus: Photo[],
  niche: Photo[],
  full: Rect,
  gutter: number,
  tagged: Photo[],
  includeAll: boolean,
): Placement[] {
  const { focusH } = planFocus(full.h, gutter, focus.length, Math.max(1, niche.length))
  const cx = full.x + full.w / 2
  const cy = full.y + full.h / 2
  const n = focus.length
  let size = focusH
  let rx = full.w * 0.33
  let ry = full.h * 0.33
  if (n > 1) {
    const spacing = (Math.PI * (rx + ry)) / n
    size = Math.min(size, spacing * 0.7)
  }

  let focusPlaced: Placement[] = []
  for (let attempt = 0; attempt < 12; attempt++) {
    focusPlaced = focus.map((photo, index) => {
      const angle = -Math.PI / 2 + (n === 0 ? 0 : (2 * Math.PI * index) / n)
      const { w, h } = sizedBox(photo, full.w * 0.46, size)
      const x = clamp(cx + Math.cos(angle) * rx - w / 2, full.x, full.x + full.w - w)
      const y = clamp(cy + Math.sin(angle) * ry - h / 2, full.y, full.y + full.h - h)
      return toPlacement(photo, { x, y, w, h })
    })
    let hits = 0
    for (let i = 0; i < focusPlaced.length; i++) {
      for (let j = i + 1; j < focusPlaced.length; j++) {
        if (boxesOverlap(focusPlaced[i], focusPlaced[j], gutter)) hits += 1
      }
    }
    if (hits === 0) break
    size = Math.max(36, size * 0.82)
    rx = Math.min(full.w * 0.4, rx * 1.04)
    ry = Math.min(full.h * 0.4, ry * 1.04)
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
  const raw = placeFocus(focus, full, gutter, includeAll ? niche.length : Math.max(1, Math.min(niche.length, 8)))
  const minY = Math.min(...raw.map((item) => item.y))
  const maxY = Math.max(...raw.map((item) => item.y + item.h))
  const dy = full.y + full.h / 2 - (minY + maxY) / 2
  const shifted = raw.map((item) => ({ ...item, y: item.y + dy }))
  return fillLeftovers(niche, shifted, full, gutter, tagged, includeAll)
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

  if (!includeAll) {
    const used = new Set(placed.map((item) => item.photoId))
    const leftover = niche.filter((photo) => !used.has(photo.id))
    if (leftover.length > 0) {
      placed = fillRemainingHoles(placed, leftover, full, gutter, tagged, false)
    }
  }

  return finish(placed)
}
