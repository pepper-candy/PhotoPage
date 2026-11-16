import { useEffect, useMemo, useRef, type CSSProperties, type PointerEvent, type ReactElement } from 'react'
import { canPan, panSource, zoomSource } from './crop.ts'
import { findCuts, nudgeCut, type Cut } from './seams.ts'
import type { Page, Photo, Placement, Rect } from './types.ts'

type Props = {
  page: Page
  photos: Photo[]
  placements: Placement[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onPlacements?: (next: Placement[]) => void
  gutter?: number
  packing?: boolean
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

function CroppedPhoto({
  photo,
  placement,
  page,
  selected,
  action,
  interactive,
  onActivate,
  onSource,
}: {
  photo: Photo
  placement: Placement
  page: Page
  selected: boolean
  action: 'delete' | 'star' | null
  interactive: boolean
  onActivate: () => void
  onSource: (src: Rect) => void
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
    moved: boolean
  }>({ pointers: new Map(), pinch: null, pan: null, moved: false })

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
    if (live.pointers.size === 2) {
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
    if (live.pointers.size < 2) live.pinch = null
  }

  return (
    <button
      ref={cellRef}
      type="button"
      className={`placed${selected ? ' selected' : ''}${action ? ` ${action}` : ''}`}
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
        src={photo.objectUrl}
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

function pagePoint(event: PointerEvent, el: HTMLElement, page: Page): { x: number; y: number } {
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

  const cuts = useMemo(
    () => (action || packing ? [] : findCuts(placements, gutter)),
    [action, packing, placements, gutter],
  )

  function patchSource(photoId: string, src: Rect) {
    if (!onPlacements || packing) return
    onPlacements(
      placementsRef.current.map((item) => (item.photoId === photoId ? withSource(item, src) : item)),
    )
  }

  function onCutDown(event: PointerEvent<HTMLDivElement>, cut: Cut) {
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
      className={`page${action ? ` ${action === 'delete' ? 'modifying' : 'starring'}` : ''}`}
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
            onActivate={() => {
              if (modifying) onDelete?.(placement.photoId)
              else if (starring) onStar?.(placement.photoId)
              else onSelect(placement.photoId)
            }}
            onSource={(src) => patchSource(placement.photoId, src)}
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
    </div>
  )
}
