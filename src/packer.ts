import { clamp, legalAspectRange, preferredAspect, sourceRectForAspect } from './crop.ts'
import type { PackOptions, Page, Photo, PhotoGroup, Placement, Rect } from './types.ts'

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

function toPlacement(photo: Photo, box: Rect): Placement {
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
    hs = hs.map((h) => Math.max(1, h * gain))
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
  const total = widths.reduce((sum, w) => sum + w, 0)
  if (total > inner + 0.5) {
    const gain = inner / total
    widths = widths.map((w) => w * gain)
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
    const height = heights[rowIndex]
    let widths = assignWidths(row, height, limits[rowIndex].inner)
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

function placeSingle(photo: Photo, region: Rect): Placement {
  const { min, max } = legalAspectRange(photo)
  const aspect = clamp(region.w / Math.max(region.h, 1), min, max)
  let w = region.w
  let h = w / aspect
  if (h > region.h) {
    h = region.h
    w = h * aspect
  }
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
          best = { dir: candidate.dir, area: candidate.area }
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

function riverFill(photos: Photo[], region: Rect, gutter: number, targetH?: number): Placement[] {
  if (photos.length === 0 || region.w < 8 || region.h < 8) return []
  if (photos.length === 1 && targetH == null) return [placeSingle(photos[0], region)]

  const rows =
    targetH == null
      ? bestPartition(photos, region.w, region.h, gutter)
      : partitionByTarget(photos, region.w, gutter, targetH)
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

export function pack(photos: Photo[], page: Page, options: PackOptions): Placement[] {
  const gutter = Math.max(0, options.gutter)
  const breakIndex = Number.isFinite(options.breakIndex) ? options.breakIndex : 0
  const tagged = tagGroups(photos, breakIndex)
  if (tagged.length === 0 || page.width < 1 || page.height < 1) return []

  const full: Rect = { x: 0, y: 0, w: page.width, h: page.height }
  const breakAt = clamp(Math.trunc(breakIndex), 0, tagged.length)
  const focus = tagged.slice(0, breakAt)
  const niche = tagged.slice(breakAt)

  let placed: Placement[]
  if (focus.length === 0) placed = riverFill(niche, full, gutter)
  else if (niche.length === 0) placed = riverFill(focus, full, gutter)
  else {
    const focusPlaced = placeFocus(focus, full, gutter, niche.length)
    const rects = sideAndBottom(full, focusPlaced, gutter)
    const groups = splitByArea(niche, rects)
    const nichePlaced = rects.flatMap((rect, index) => riverFill(groups[index] ?? [], rect, gutter))
    placed = gapFill([...focusPlaced, ...nichePlaced], tagged, full, gutter)
  }

  return placed.filter(
    (placement) => placement.w > 0 && placement.h > 0 && placement.sw > 0 && placement.sh > 0,
  )
}
