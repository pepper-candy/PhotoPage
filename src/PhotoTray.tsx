import { useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { Photo } from './types.ts'

type Props = {
  photos: Photo[]
  breakIndex: number
  selectedId: string | null
  onSelect: (id: string | null) => void
  onMove: (from: number, targetIndex: number, place: 'before' | 'after') => void
  onMoveToSection: (from: number, section: 'focus' | 'niche') => void
  onMoveToNicheStart: (from: number) => void
  onBreakIndex: (index: number) => void
}

function isFileDrag(event: DragEvent): boolean {
  return event.dataTransfer.types.includes('Files')
}

export default function PhotoTray({
  photos,
  breakIndex,
  selectedId,
  onSelect,
  onMove,
  onMoveToSection,
  onMoveToNicheStart,
  onBreakIndex,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null)
  const dragIndex = useRef<number | null>(null)
  const skipClick = useRef(false)
  const breakRef = useRef(breakIndex)
  const [overKey, setOverKey] = useState<string | null>(null)
  breakRef.current = breakIndex

  function indexFromPointer(clientY: number): number {
    const root = listRef.current
    if (!root) return breakRef.current
    const nodes = root.querySelectorAll<HTMLElement>('[data-photo-index]')
    let count = 0
    nodes.forEach((el) => {
      const rect = el.getBoundingClientRect()
      if (rect.top + rect.height / 2 <= clientY) count += 1
    })
    return count
  }

  function onBreakPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault()
    event.stopPropagation()
    const move = (ev: PointerEvent) => {
      const next = indexFromPointer(ev.clientY)
      if (next !== breakRef.current) {
        breakRef.current = next
        onBreakIndex(next)
      }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  function allowMove(event: DragEvent) {
    if (isFileDrag(event) || dragIndex.current == null) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }

  function droppedIndex(): number | null {
    const from = dragIndex.current
    dragIndex.current = null
    setOverKey(null)
    return from
  }

  const focus = photos.slice(0, breakIndex)
  const niche = photos.slice(breakIndex)

  function renderPhoto(photo: Photo, index: number) {
    const over = overKey === `before:${photo.id}` || overKey === `after:${photo.id}`
    return (
      <div
        key={photo.id}
        data-photo-index={index}
        className={`seq-item${selectedId === photo.id ? ' selected' : ''}${over ? ' over' : ''}`}
        draggable
        onPointerDown={() => {
          skipClick.current = false
        }}
        onDragStart={(event) => {
          skipClick.current = true
          dragIndex.current = index
          event.dataTransfer.setData('text/plain', String(index))
          event.dataTransfer.effectAllowed = 'move'
        }}
        onDragEnd={() => {
          dragIndex.current = null
          setOverKey(null)
        }}
        onDragOver={(event) => {
          if (isFileDrag(event)) return
          allowMove(event)
          const rect = event.currentTarget.getBoundingClientRect()
          const place = event.clientY > rect.top + rect.height / 2 ? 'after' : 'before'
          setOverKey(`${place}:${photo.id}`)
        }}
        onDrop={(event) => {
          if (isFileDrag(event)) return
          event.preventDefault()
          event.stopPropagation()
          const from = droppedIndex()
          if (from == null) return
          const rect = event.currentTarget.getBoundingClientRect()
          const place = event.clientY > rect.top + rect.height / 2 ? 'after' : 'before'
          onMove(from, index, place)
        }}
        onClick={() => {
          if (skipClick.current) {
            skipClick.current = false
            return
          }
          onSelect(selectedId === photo.id ? null : photo.id)
        }}
        title={photo.name}
      >
        <img src={photo.objectUrl} alt="" draggable={false} />
        <span className="seq-name">{photo.name}</span>
      </div>
    )
  }

  return (
    <div className="sequence" ref={listRef} aria-label="Photo sequence">
      <div className="section-label">Focus</div>
      {focus.length === 0 ? (
        <div
          className={`drop-hint${overKey === 'focus' ? ' over' : ''}`}
          onDragOver={(event) => {
            allowMove(event)
            setOverKey('focus')
          }}
          onDrop={(event) => {
            if (isFileDrag(event)) return
            event.preventDefault()
            event.stopPropagation()
            const from = droppedIndex()
            if (from == null) return
            onMoveToSection(from, 'focus')
          }}
        >
          Drag photos here to make them stand out.
        </div>
      ) : (
        focus.map((photo, index) => renderPhoto(photo, index))
      )}

      <div
        className="break-handle"
        onPointerDown={onBreakPointerDown}
        onDragOver={allowMove}
        onDrop={(event) => {
          if (isFileDrag(event)) return
          event.preventDefault()
          event.stopPropagation()
          const from = droppedIndex()
          if (from == null) return
          const rect = event.currentTarget.getBoundingClientRect()
          if (event.clientY < rect.top + rect.height / 2) onMoveToSection(from, 'focus')
          else onMoveToNicheStart(from)
        }}
        title="Drag to move the break. Photos above are focus."
      >
        <span className="grip" aria-hidden />
        <span className="break-title">Break</span>
        <span className="break-note">Focus above · niche below</span>
      </div>

      <div className="section-label">Niche</div>
      {niche.map((photo, index) => renderPhoto(photo, breakIndex + index))}
      <div
        className={`drop-tail${overKey === 'end' ? ' over' : ''}`}
        onDragOver={(event) => {
          allowMove(event)
          setOverKey('end')
        }}
        onDrop={(event) => {
          if (isFileDrag(event)) return
          event.preventDefault()
          const from = droppedIndex()
          if (from == null) return
          onMoveToSection(from, 'niche')
        }}
      />
    </div>
  )
}
