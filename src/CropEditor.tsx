import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { clamp } from './crop.ts'
import { displayUrl, type Photo, type Rect } from './types.ts'

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'move'

const HANDLES: Handle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

function east(handle: Handle) {
  return handle === 'e' || handle === 'ne' || handle === 'se'
}
function west(handle: Handle) {
  return handle === 'w' || handle === 'nw' || handle === 'sw'
}
function north(handle: Handle) {
  return handle === 'n' || handle === 'ne' || handle === 'nw'
}
function south(handle: Handle) {
  return handle === 's' || handle === 'se' || handle === 'sw'
}

type Props = {
  photo: Photo | null
  onChange: (id: string, safe: Rect) => void
  onClose: () => void
}

export default function CropEditor({ photo, onChange, onClose }: Props) {
  const imgRef = useRef<HTMLImageElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const img = imgRef.current
    if (!img) return
    const update = () => setBox({ w: img.clientWidth, h: img.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(img)
    return () => ro.disconnect()
  }, [photo?.id])

  if (!photo) return null

  const current = photo
  const scaleX = box.w > 0 ? box.w / current.width : 0
  const scaleY = box.h > 0 ? box.h / current.height : 0
  const r = current.safe

  function applyHandle(handle: Handle, start: Rect, dx: number, dy: number): Rect {
    let { x, y, w, h } = start

    if (handle === 'move') {
      x += dx
      y += dy
    } else {
      if (west(handle)) {
        x += dx
        w -= dx
      } else if (east(handle)) {
        w += dx
      }
      if (north(handle)) {
        y += dy
        h -= dy
      } else if (south(handle)) {
        h += dy
      }
    }

    if (w < 1) {
      if (west(handle)) x = start.x + start.w - 1
      w = 1
    }
    if (h < 1) {
      if (north(handle)) y = start.y + start.h - 1
      h = 1
    }
    x = clamp(x, 0, current.width - w)
    y = clamp(y, 0, current.height - h)
    w = clamp(w, 1, current.width - x)
    h = clamp(h, 1, current.height - y)
    return { x, y, w, h }
  }

  function onHandleDown(handle: Handle, e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const originX = e.clientX
    const originY = e.clientY
    const start = { ...current.safe }

    const move = (ev: PointerEvent) => {
      const dx = scaleX ? (ev.clientX - originX) / scaleX : 0
      const dy = scaleY ? (ev.clientY - originY) / scaleY : 0
      onChange(current.id, applyHandle(handle, start, dx, dy))
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  return (
    <div className="crop-view">
      <div className="crop-bar">
        <button type="button" onClick={onClose}>
          Back
        </button>
        <p className="crop-caption">
          {photo.name} · {photo.width}×{photo.height}
        </p>
      </div>
      <div
        className="crop-stage"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
      >
        <div className="crop-inner">
          <img
            ref={imgRef}
            src={displayUrl(photo)}
            alt={photo.name}
            draggable={false}
            onLoad={() => {
              const img = imgRef.current
              if (img) setBox({ w: img.clientWidth, h: img.clientHeight })
            }}
          />
          {scaleX > 0 && (
            <div
              className="safe-rect"
              style={{
                left: r.x * scaleX,
                top: r.y * scaleY,
                width: r.w * scaleX,
                height: r.h * scaleY,
              }}
              onPointerDown={(e) => onHandleDown('move', e)}
            >
              {HANDLES.map((handle) => (
                <div
                  key={handle}
                  className={`handle ${handle}`}
                  onPointerDown={(e) => onHandleDown(handle, e)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
