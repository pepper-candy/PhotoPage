import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactElement,
} from 'react'
import { adaptSource, canPan, panSource, zoomSource } from './crop.ts'
import { spareHoles } from './packer.ts'
import { findCuts, nudgeCut, type Cut } from './seams.ts'
import { displayUrl, type Page, type Photo, type Placement, type Rect } from './types.ts'

const SWAP_SLOP = 10

type Props = {
  page: Page
  photos: Photo[]
  placements: Placement[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onPlacements?: (next: Placement[]) => void
  gutter?: number
  packing?: boolean
  onFillHole?: (hole: Rect) => void
  boundless?: boolean
  spares?: Photo[]
  modifying?: boolean
  starring?: boolean
  onDelete?: (id: string) => void
  onStar?: (id: string) => void
}

function srcOf(placement: Placement): Rect {
  return { x: placement.sx, y: placement.sy, w: placement.sw, h: placement.sh }
}

function withSource(placement: Placement, src: Rect): Placement {
  return { ...placement, sx: src.x, sy: src.y, sw: src.w, sh: src.h }
}

function cellIdAt(clientX: number, clientY: number, ignoreId?: string): string | null {
  const stack = document.elementsFromPoint(clientX, clientY)
  for (const node of stack) {
    const host = node instanceof Element ? node.closest('.placed') : null
    if (!(host instanceof HTMLElement)) continue
    const id = host.dataset.photoId
    if (id && id !== ignoreId) return id
  }
  return null
}

function swapCells(
  placements: Placement[],
  photos: Map<string, Photo>,
  fromId: string,
  toId: string,
): Placement[] | null {
  if (fromId === toId) return null
  const a = placements.find((item) => item.photoId === fromId)
  const b = placements.find((item) => item.photoId === toId)
  const photoA = photos.get(fromId)
  const photoB = photos.get(toId)
  if (!a || !b || !photoA || !photoB) return null
  const srcA = adaptSource(photoA, b.w / Math.max(b.h, 0.001), srcOf(a))
  const srcB = adaptSource(photoB, a.w / Math.max(a.h, 0.001), srcOf(b))
  return placements.map((item) => {
    if (item.photoId === fromId) {
      return { x: a.x, y: a.y, w: a.w, h: a.h, photoId: toId, sx: srcB.x, sy: srcB.y, sw: srcB.w, sh: srcB.h }
    }
    if (item.photoId === toId) {
      return { x: b.x, y: b.y, w: b.w, h: b.h, photoId: fromId, sx: srcA.x, sy: srcA.y, sw: srcA.w, sh: srcA.h }
    }
    return item
  })
}

function CroppedPhoto({
  photo,
  placement,
  page,
  selected,
  action,
  interactive,
  swapFrom,
  swapOver,
  onActivate,
  onSource,
  onSwapTravel,
  onSwapEnd,
}: {
  photo: Photo
  placement: Placement
  page: Page
  selected: boolean
  action: 'delete' | 'star' | null
  interactive: boolean
  swapFrom: string | null
  swapOver: string | null
  onActivate: () => void
  onSource: (src: Rect) => void
  onSwapTravel: (fromId: string, overId: string | null, x: number, y: number, w: number, h: number) => void
  onSwapEnd: (fromId: string, toId: string | null) => void
}): ReactElement {
  const { x, y, w, h, sx, sy, sw, sh } = placement
  const scale = Math.min(w / Math.max(sw, 0.001), h / Math.max(sh, 0.001))
  const cellRef = useRef<HTMLButtonElement>(null)
  const placementRef = useRef(placement)
  const photoRef = useRef(photo)
  const onSourceRef = useRef(onSource)
  placementRef.current = placement
  photoRef.current = photo
  onSourceRef.current = onSource
  const gesture = useRef<{
    pointers: Map<number, { x: number; y: number }>
    pinch:
      | {
          dist: number
          midX: number
          midY: number
          src: Rect
        }
      | null
    pan:
      | {
          pointer: number
          startX: number
          startY: number
          src: Rect
        }
      | null
    swap:
      | {
          pointer: number
          startX: number
          startY: number
          width: number
          height: number
        }
      | null
    moved: boolean
  }>({ pointers: new Map(), pinch: null, pan: null, swap: null, moved: false })

  const pannable = interactive && canPan(photo, srcOf(placement))

  function cellOrigin(clientX: number, clientY: number): { ox: number; oy: number } {
    const el = cellRef.current
    if (!el) return { ox: 0.5, oy: 0.5 }
    const rect = el.getBoundingClientRect()
    return {
      ox: (clientX - rect.left) / Math.max(rect.width, 1),
      oy: (clientY - rect.top) / Math.max(rect.height, 1),
    }
  }

  function clientToSourceDelta(dx: number, dy: number, src: Rect): { dx: number; dy: number } {
    const el = cellRef.current
    if (!el) return { dx: 0, dy: 0 }
    const rect = el.getBoundingClientRect()
    return {
      dx: (-dx * src.w) / Math.max(rect.width, 1),
      dy: (-dy * src.h) / Math.max(rect.height, 1),
    }
  }

  useEffect(() => {
    const el = cellRef.current
    if (!el || !interactive) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const origin = cellOrigin(event.clientX, event.clientY)
      const raw = event.ctrlKey ? Math.exp(event.deltaY * 0.01) : event.deltaY > 0 ? 1.1 : 1 / 1.1
      const factor = Math.min(1.25, Math.max(0.8, raw))
      const current = placementRef.current
      onSourceRef.current(zoomSource(photoRef.current, srcOf(current), factor, origin.ox, origin.oy))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [interactive])

  function onPanDown(event: PointerEvent<HTMLSpanElement>) {
    if (!interactive) return
    event.preventDefault()
    event.stopPropagation()
    const live = gesture.current
    live.pan = {
      pointer: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      src: srcOf(placement),
    }
    live.moved = false
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function onPanMove(event: PointerEvent<HTMLSpanElement>) {
    const live = gesture.current
    if (!live.pan || live.pan.pointer !== event.pointerId) return
    const dx = event.clientX - live.pan.startX
    const dy = event.clientY - live.pan.startY
    if (!live.moved && dx * dx + dy * dy < 4) return
    live.moved = true
    const delta = clientToSourceDelta(dx, dy, live.pan.src)
    onSource(panSource(photo, live.pan.src, delta.dx, delta.dy))
  }

  function onPanUp(event: PointerEvent<HTMLSpanElement>) {
    const live = gesture.current
    if (!live.pan || live.pan.pointer !== event.pointerId) return
    live.pan = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function onCellDown(event: PointerEvent<HTMLButtonElement>) {
    if (!interactive) return
    const live = gesture.current
    live.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (live.pointers.size === 1) {
      const rect = cellRef.current?.getBoundingClientRect()
      live.swap = {
        pointer: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        width: rect?.width ?? placement.w,
        height: rect?.height ?? placement.h,
      }
    }
    if (live.pointers.size === 2) {
      live.swap = null
      onSwapEnd(photo.id, null)
      const pts = [...live.pointers.values()]
      const dx = pts[1].x - pts[0].x
      const dy = pts[1].y - pts[0].y
      live.pinch = {
        dist: Math.max(1, Math.hypot(dx, dy)),
        midX: (pts[0].x + pts[1].x) / 2,
        midY: (pts[0].y + pts[1].y) / 2,
        src: srcOf(placementRef.current),
      }
      live.moved = true
      event.preventDefault()
      cellRef.current?.setPointerCapture(event.pointerId)
    }
  }

  function onCellMove(event: PointerEvent<HTMLButtonElement>) {
    const live = gesture.current
    if (!live.pointers.has(event.pointerId)) return
    live.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (live.swap && live.swap.pointer === event.pointerId && live.pointers.size < 2 && !live.pinch) {
      const dx = event.clientX - live.swap.startX
      const dy = event.clientY - live.swap.startY
      if (!live.moved && dx * dx + dy * dy < SWAP_SLOP * SWAP_SLOP) return
      if (!live.moved) {
        live.moved = true
        cellRef.current?.setPointerCapture(event.pointerId)
      }
      onSwapTravel(
        photo.id,
        cellIdAt(event.clientX, event.clientY, photo.id),
        event.clientX,
        event.clientY,
        live.swap.width,
        live.swap.height,
      )
      event.preventDefault()
      return
    }
    if (!live.pinch || live.pointers.size < 2) return
    const pts = [...live.pointers.values()]
    const dx = pts[1].x - pts[0].x
    const dy = pts[1].y - pts[0].y
    const dist = Math.max(1, Math.hypot(dx, dy))
    const midX = (pts[0].x + pts[1].x) / 2
    const midY = (pts[0].y + pts[1].y) / 2
    const origin = cellOrigin(live.pinch.midX, live.pinch.midY)
    const zoomed = zoomSource(photo, live.pinch.src, live.pinch.dist / dist, origin.ox, origin.oy)
    const delta = clientToSourceDelta(midX - live.pinch.midX, midY - live.pinch.midY, zoomed)
    onSource(panSource(photo, zoomed, delta.dx, delta.dy))
    event.preventDefault()
  }

  function onCellUp(event: PointerEvent<HTMLButtonElement>) {
    const live = gesture.current
    live.pointers.delete(event.pointerId)
    if (live.swap && live.swap.pointer === event.pointerId) {
      const toId = live.moved ? cellIdAt(event.clientX, event.clientY, photo.id) : null
      live.swap = null
      if (cellRef.current?.hasPointerCapture(event.pointerId)) {
        cellRef.current.releasePointerCapture(event.pointerId)
      }
      onSwapEnd(photo.id, toId)
    }
    if (live.pointers.size < 2) live.pinch = null
  }

  return (
    <button
      ref={cellRef}
      type="button"
      className={`placed${selected ? ' selected' : ''}${action ? ` ${action}` : ''}${swapFrom === photo.id ? ' swap-source' : ''}${swapOver === photo.id ? ' swap-target' : ''}`}
      data-photo-id={photo.id}
      style={{
        left: `${(x / page.width) * 100}%`,
        top: `${(y / page.height) * 100}%`,
        width: `${(w / page.width) * 100}%`,
        height: `${(h / page.height) * 100}%`,
      }}
      onClick={(event) => {
        event.stopPropagation()
        if (gesture.current.moved) {
          gesture.current.moved = false
          return
        }
        onActivate()
      }}
      onPointerDown={onCellDown}
      onPointerMove={onCellMove}
      onPointerUp={onCellUp}
      onPointerCancel={onCellUp}
      title={action === 'delete' ? `Delete ${photo.name}` : action === 'star' ? `Focus ${photo.name}` : photo.name}
    >
      <img
        src={displayUrl(photo)}
        alt={photo.name}
        draggable={false}
        style={{
          width: `${((photo.width * scale) / w) * 100}%`,
          height: `${((photo.height * scale) / h) * 100}%`,
          left: `${((-sx * scale) / w) * 100}%`,
          top: `${((-sy * scale) / h) * 100}%`,
        }}
      />
      {pannable ? (
        <span
          className="pan-handle"
          aria-label={`Move ${photo.name}`}
          onPointerDown={onPanDown}
          onPointerMove={onPanMove}
          onPointerUp={onPanUp}
          onPointerCancel={onPanUp}
          onClick={(event) => event.stopPropagation()}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
            <path
              fill="currentColor"
              d="M8 1.1 10.2 3.4H8.7v2.9h2.9V4.8L14.9 8l-3.3 3.2V9.7H8.7v2.9h1.5L8 14.9 5.8 12.6H7.3V9.7H4.4v1.5L1.1 8l3.3-3.2v1.5h2.9V3.4H5.8L8 1.1z"
            />
          </svg>
        </span>
      ) : null}
    </button>
  )
}

function pagePoint(event: { clientX: number; clientY: number }, el: HTMLElement, page: Page): { x: number; y: number } {
  const rect = el.getBoundingClientRect()
  return {
    x: ((event.clientX - rect.left) / Math.max(rect.width, 1)) * page.width,
    y: ((event.clientY - rect.top) / Math.max(rect.height, 1)) * page.height,
  }
}

function cutStyle(cut: Cut, page: Page, gutter: number): CSSProperties {
  const gap = Math.max(gutter, 0)
  if (cut.axis === 'v') {
    const mid = cut.pos + gap / 2
    return {
      left: `${(mid / page.width) * 100}%`,
      top: `${(cut.start / page.height) * 100}%`,
      height: `${((cut.end - cut.start) / page.height) * 100}%`,
    }
  }
  const mid = cut.pos + gap / 2
  return {
    left: `${(cut.start / page.width) * 100}%`,
    top: `${(mid / page.height) * 100}%`,
    width: `${((cut.end - cut.start) / page.width) * 100}%`,
  }
}

export default function PagePreview({
  page,
  photos,
  placements,
  selectedId,
  onSelect,
  onPlacements,
  gutter = 0,
  packing = false,
  onFillHole,
  boundless = false,
  spares = [],
  modifying = false,
  starring = false,
  onDelete,
  onStar,
}: Props) {
  const byId = new Map(photos.map((photo) => [photo.id, photo]))
  const action = modifying ? 'delete' : starring ? 'star' : null
  const pageRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{
    cut: Cut
    origin: Placement[]
    start: number
    pointer: number
    moved: boolean
  } | null>(null)
  const placementsRef = useRef(placements)
  placementsRef.current = placements
  const ghostRef = useRef<HTMLDivElement>(null)
  const ghostPos = useRef({ x: 0, y: 0, w: 0, h: 0 })
  const [swapFrom, setSwapFrom] = useState<string | null>(null)
  const [swapOver, setSwapOver] = useState<string | null>(null)

  function placeGhost(clientX: number, clientY: number, w: number, h: number) {
    const rect = pageRef.current?.getBoundingClientRect()
    const x = clientX - (rect?.left ?? 0) - w / 2
    const y = clientY - (rect?.top ?? 0) - h / 2
    ghostPos.current = { x, y, w, h }
    const ghost = ghostRef.current
    if (!ghost) return
    ghost.style.width = `${w}px`
    ghost.style.height = `${h}px`
    ghost.style.transform = `translate(${x}px, ${y}px)`
  }

  useLayoutEffect(() => {
    if (!swapFrom) return
    const { x, y, w, h } = ghostPos.current
    const ghost = ghostRef.current
    if (!ghost || w <= 0) return
    ghost.style.width = `${w}px`
    ghost.style.height = `${h}px`
    ghost.style.transform = `translate(${x}px, ${y}px)`
  }, [swapFrom])

  const cuts = useMemo(
    () => (action || packing ? [] : findCuts(placements, gutter)),
    [action, packing, placements, gutter],
  )

  const gaps = useMemo(() => {
    if (action || packing || swapFrom || spares.length === 0) return []
    return spareHoles(page, placements, gutter)
  }, [action, packing, swapFrom, spares.length, page, placements, gutter])

  function patchSource(photoId: string, src: Rect) {
    if (!onPlacements || packing) return
    onPlacements(
      placementsRef.current.map((item) => (item.photoId === photoId ? withSource(item, src) : item)),
    )
  }

  function onSwapTravel(fromId: string, overId: string | null, x: number, y: number, w: number, h: number) {
    setSwapFrom(fromId)
    setSwapOver(overId)
    placeGhost(x, y, w, h)
  }

  function onSwapEnd(fromId: string, toId: string | null) {
    setSwapFrom(null)
    setSwapOver(null)
    if (!onPlacements || packing || !toId || toId === fromId) return
    const next = swapCells(placementsRef.current, byId, fromId, toId)
    if (next) onPlacements(next)
  }

  function onCutDown(event: PointerEvent<HTMLButtonElement>, cut: Cut) {
    if (action || packing || !onPlacements) return
    event.preventDefault()
    event.stopPropagation()
    const host = pageRef.current
    if (!host) return
    const point = pagePoint(event, host, page)
    drag.current = {
      cut,
      origin: placements,
      start: cut.axis === 'v' ? point.x : point.y,
      pointer: event.pointerId,
      moved: false,
    }
    host.setPointerCapture(event.pointerId)
  }

  function onPageMove(event: PointerEvent<HTMLDivElement>) {
    const live = drag.current
    if (!live || live.pointer !== event.pointerId || !onPlacements) return
    const host = pageRef.current
    if (!host) return
    const point = pagePoint(event, host, page)
    const along = live.cut.axis === 'v' ? point.x : point.y
    const delta = along - live.start
    if (!live.moved && Math.abs(delta) < 1) return
    live.moved = true
    onPlacements(nudgeCut(live.origin, photos, live.cut, delta, page))
  }

  function onPageUp(event: PointerEvent<HTMLDivElement>) {
    const live = drag.current
    if (!live || live.pointer !== event.pointerId) return
    const moved = live.moved
    drag.current = null
    const host = pageRef.current
    if (host?.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId)
    if (moved) {
      const block = (next: Event) => {
        next.stopPropagation()
        next.preventDefault()
        window.removeEventListener('click', block, true)
      }
      window.addEventListener('click', block, true)
    }
  }

  return (
    <div
      ref={pageRef}
      className={`page${boundless ? ' boundless' : ''}${action ? ` ${action === 'delete' ? 'modifying' : 'starring'}` : ''}${swapFrom ? ' swapping' : ''}`}
      style={
        {
          '--pw': page.width,
          '--ph': page.height,
        } as CSSProperties
      }
      onPointerMove={onPageMove}
      onPointerUp={onPageUp}
      onPointerCancel={onPageUp}
      onClick={() => {
        if (!action) onSelect(null)
      }}
    >
      {placements.map((placement) => {
        const photo = byId.get(placement.photoId)
        if (!photo) return null
        return (
          <CroppedPhoto
            key={placement.photoId}
            photo={photo}
            placement={placement}
            page={page}
            selected={!action && selectedId === placement.photoId}
            action={action}
            interactive={!action && !packing && !!onPlacements}
            swapFrom={swapFrom}
            swapOver={swapOver}
            onActivate={() => {
              if (modifying) onDelete?.(placement.photoId)
              else if (starring) onStar?.(placement.photoId)
              else onSelect(placement.photoId)
            }}
            onSource={(src) => patchSource(placement.photoId, src)}
            onSwapTravel={onSwapTravel}
            onSwapEnd={onSwapEnd}
          />
        )
      })}
      {cuts.map((cut) => (
        <button
          key={cut.id}
          type="button"
          className={`gutter-cut ${cut.axis === 'v' ? 'vertical' : 'horizontal'}`}
          aria-label={cut.axis === 'v' ? 'Adjust vertical split' : 'Adjust horizontal split'}
          style={cutStyle(cut, page, gutter)}
          onPointerDown={(event) => onCutDown(event, cut)}
          onKeyDown={(event) => {
            if (!onPlacements || packing) return
            const step = event.shiftKey ? 24 : 8
            let delta = 0
            if (cut.axis === 'v' && event.key === 'ArrowRight') delta = step
            else if (cut.axis === 'v' && event.key === 'ArrowLeft') delta = -step
            else if (cut.axis === 'h' && event.key === 'ArrowDown') delta = step
            else if (cut.axis === 'h' && event.key === 'ArrowUp') delta = -step
            else return
            event.preventDefault()
            event.stopPropagation()
            onPlacements(nudgeCut(placements, photos, cut, delta, page))
          }}
          onClick={(event) => event.stopPropagation()}
        />
      ))}
      {gaps.map((hole) => (
        <button
          key={`gap:${Math.round(hole.x)}:${Math.round(hole.y)}:${Math.round(hole.w)}:${Math.round(hole.h)}`}
          type="button"
          className="gap-fill"
          aria-label="Fill gap with unused photo"
          title="Fill gap with unused photo"
          style={{
            left: `${(hole.x / page.width) * 100}%`,
            top: `${(hole.y / page.height) * 100}%`,
            width: `${(hole.w / page.width) * 100}%`,
            height: `${(hole.h / page.height) * 100}%`,
          }}
          onClick={(event) => {
            event.stopPropagation()
            if (!onFillHole || packing) return
            onFillHole(hole)
          }}
        >
          <span className="gap-fill-plus" aria-hidden>
            <svg viewBox="0 0 16 16" width="16" height="16">
              <path fill="currentColor" d="M7.1 3.2h1.8v3.9h3.9v1.8H8.9v3.9H7.1V8.9H3.2V7.1h3.9V3.2z" />
            </svg>
          </span>
        </button>
      ))}
      {swapFrom ? (
        <div ref={ghostRef} className="swap-ghost" aria-hidden>
          {(() => {
            const item = placements.find((placement) => placement.photoId === swapFrom)
            const photo = item ? byId.get(item.photoId) : undefined
            if (!item || !photo) return null
            const scale = Math.min(
              item.w / Math.max(item.sw, 0.001),
              item.h / Math.max(item.sh, 0.001),
            )
            return (
              <img
                src={displayUrl(photo)}
                alt=""
                draggable={false}
                style={{
                  width: `${((photo.width * scale) / item.w) * 100}%`,
                  height: `${((photo.height * scale) / item.h) * 100}%`,
                  left: `${((-item.sx * scale) / item.w) * 100}%`,
                  top: `${((-item.sy * scale) / item.h) * 100}%`,
                }}
              />
            )
          })()}
        </div>
      ) : null}
    </div>
  )
}
