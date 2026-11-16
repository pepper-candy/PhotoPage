import { useEffect, useMemo, useRef, useState } from 'react'
import CropEditor from './CropEditor.tsx'
import PagePreview from './PagePreview.tsx'
import PhotoTray from './PhotoTray.tsx'
import { pack } from './packer.ts'
import { DEFAULT_GUTTER, pageSize, type Photo, type PhotoGroup, type Rect } from './types.ts'
import './App.css'

const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,.jpg,.jpeg,.png,.webp,.gif'

const PRESETS = [
  { id: '1:1', label: '1:1', w: 1, h: 1 },
  { id: '4:5', label: '4:5', w: 4, h: 5 },
  { id: '3:2', label: '3:2', w: 3, h: 2 },
  { id: '4:3', label: '4:3', w: 4, h: 3 },
  { id: '16:9', label: '16:9', w: 16, h: 9 },
  { id: 'a4', label: 'A4 portrait', w: 1, h: 1.414 },
  { id: 'custom', label: 'Custom', w: 0, h: 0 },
] as const

function isRaster(file: File): boolean {
  const type = file.type.toLowerCase()
  if (
    type === 'image/jpeg' ||
    type === 'image/png' ||
    type === 'image/webp' ||
    type === 'image/gif'
  ) {
    return true
  }
  const name = file.name.toLowerCase()
  return (
    name.endsWith('.jpg') ||
    name.endsWith('.jpeg') ||
    name.endsWith('.png') ||
    name.endsWith('.webp') ||
    name.endsWith('.gif')
  )
}

function loadPhoto(file: File): Promise<Photo> {
  const objectUrl = URL.createObjectURL(file)
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      resolve({
        id: crypto.randomUUID(),
        name: file.name,
        objectUrl,
        width: img.naturalWidth,
        height: img.naturalHeight,
        group: 'niche',
        safe: { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight },
      })
    }
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error(`Could not load ${file.name}`))
    }
    img.src = objectUrl
  })
}

function stamp(list: Photo[], breakAt: number): Photo[] {
  const cut = Math.max(0, Math.min(list.length, breakAt))
  return list.map((photo, index) => {
    const group: PhotoGroup = index < cut ? 'focus' : 'niche'
    return photo.group === group ? photo : { ...photo, group }
  })
}

function App() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [photos, setPhotos] = useState<Photo[]>([])
  const [breakIndex, setBreakIndex] = useState(0)
  const [preset, setPreset] = useState<string>('4:5')
  const [customW, setCustomW] = useState(4)
  const [customH, setCustomH] = useState(5)
  const [gutter, setGutter] = useState(DEFAULT_GUTTER)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const activePreset = PRESETS.find((item) => item.id === preset) ?? PRESETS[1]
  const aspectW = preset === 'custom' ? customW : activePreset.w
  const aspectH = preset === 'custom' ? customH : activePreset.h
  const safeW = aspectW > 0 ? aspectW : 1
  const safeH = aspectH > 0 ? aspectH : 1

  const page = useMemo(() => pageSize(safeW, safeH), [safeW, safeH])
  const placements = useMemo(
    () => pack(photos, page, { gutter, breakIndex }),
    [photos, page, gutter, breakIndex],
  )
  const focusCount = Math.min(breakIndex, photos.length)
  const selected = photos.find((photo) => photo.id === selectedId) ?? null

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function commit(list: Photo[], breakAt: number) {
    const cut = Math.max(0, Math.min(list.length, breakAt))
    setBreakIndex(cut)
    setPhotos(stamp(list, cut))
  }

  async function importFiles(list: FileList | File[]) {
    const files = Array.from(list).filter(isRaster)
    if (files.length === 0) return
    const loaded = await Promise.all(files.map(loadPhoto))
    setPhotos((prev) => [...prev, ...loaded])
  }

  function clearAll() {
    setPhotos((prev) => {
      for (const photo of prev) URL.revokeObjectURL(photo.objectUrl)
      return []
    })
    setBreakIndex(0)
    setSelectedId(null)
  }

  function movePhoto(from: number, targetIndex: number, place: 'before' | 'after') {
    if (from < 0 || targetIndex < 0 || targetIndex >= photos.length || from >= photos.length) return
    const asFocus = targetIndex < breakIndex
    const flags = photos.map((_, index) => index < breakIndex)
    const next = photos.slice()
    const [item] = next.splice(from, 1)
    flags.splice(from, 1)
    let index = targetIndex > from ? targetIndex - 1 : targetIndex
    if (place === 'after') index += 1
    index = Math.max(0, Math.min(index, next.length))
    next.splice(index, 0, item)
    flags.splice(index, 0, asFocus)
    const cut = flags.indexOf(false)
    commit(next, cut < 0 ? flags.length : cut)
  }

  function moveToSection(from: number, section: 'focus' | 'niche') {
    if (from < 0 || from >= photos.length) return
    const next = photos.slice()
    const [item] = next.splice(from, 1)
    let cut = breakIndex
    if (from < cut) cut -= 1
    if (section === 'focus') {
      next.splice(cut, 0, item)
      cut += 1
    } else {
      next.push(item)
    }
    commit(next, cut)
  }

  function moveToNicheStart(from: number) {
    if (from < 0 || from >= photos.length) return
    const next = photos.slice()
    const [item] = next.splice(from, 1)
    let cut = breakIndex
    if (from < cut) cut -= 1
    next.splice(cut, 0, item)
    commit(next, cut)
  }

  const countLabel = `${photos.length} ${photos.length === 1 ? 'photo' : 'photos'} · ${focusCount} focus`

  return (
    <div
      className="app"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault()
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return
        event.preventDefault()
        void importFiles(event.dataTransfer.files)
      }}
    >
      <header className="toolbar">
        <button type="button" onClick={() => fileRef.current?.click()}>
          Import
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files) void importFiles(event.target.files)
            event.target.value = ''
          }}
        />

        <label>
          Aspect
          <select value={preset} onChange={(event) => setPreset(event.target.value)}>
            {PRESETS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {preset === 'custom' && (
          <span className="custom-aspect">
            <input
              type="number"
              min={0.01}
              step={0.01}
              value={customW}
              onChange={(event) => setCustomW(Number(event.target.value) || 0)}
              aria-label="Custom width"
            />
            :
            <input
              type="number"
              min={0.01}
              step={0.01}
              value={customH}
              onChange={(event) => setCustomH(Number(event.target.value) || 0)}
              aria-label="Custom height"
            />
          </span>
        )}

        <label>
          Gutter
          <input
            type="number"
            min={0}
            step={1}
            value={gutter}
            onChange={(event) => setGutter(Math.max(0, Number(event.target.value) || 0))}
          />
        </label>

        <button type="button" onClick={clearAll}>
          Clear
        </button>

        <span className="counts">{countLabel}</span>
      </header>

      <div className="workspace">
        <PhotoTray
          photos={photos}
          breakIndex={focusCount}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onMove={movePhoto}
          onMoveToSection={moveToSection}
          onMoveToNicheStart={moveToNicheStart}
          onBreakIndex={(index) => commit(photos, index)}
        />
        <div className={selected ? 'stage editing' : 'stage preview'}>
          {selected ? (
            <CropEditor
              photo={selected}
              onChange={(id, safe: Rect) => {
                setPhotos((prev) => prev.map((photo) => (photo.id === id ? { ...photo, safe } : photo)))
              }}
              onClose={() => setSelectedId(null)}
            />
          ) : (
            <PagePreview
              page={page}
              photos={photos}
              placements={placements}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
        </div>
      </div>
    </div>
  )
}

export default App
