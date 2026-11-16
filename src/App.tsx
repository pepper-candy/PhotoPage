import { useEffect, useMemo, useRef, useState } from 'react'
import CropEditor from './CropEditor.tsx'
import PagePreview from './PagePreview.tsx'
import PhotoTray from './PhotoTray.tsx'
import { EXPORT_SIZES, exportPackedPage, type ExportSizeId } from './exportPage.ts'
import { pack } from './packer.ts'
import PackWorker from './packWorker.ts?worker'
import {
  DEFAULT_GUTTER,
  DEFAULT_LAYOUT,
  pageSize,
  type LayoutMode,
  type PackJob,
  type PackResult,
  type Photo,
  type PhotoGroup,
  type Placement,
  type Rect,
} from './types.ts'
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

const LAYOUTS: { id: LayoutMode; label: string }[] = [
  { id: 'top', label: 'Top' },
  { id: 'bottom', label: 'Bottom' },
  { id: 'scattered', label: 'Scattered' },
  { id: 'ring', label: 'Ring' },
  { id: 'center', label: 'Center' },
]

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
  const [layout, setLayout] = useState<LayoutMode>(DEFAULT_LAYOUT)
  const [includeAll, setIncludeAll] = useState(true)
  const [exportSize, setExportSize] = useState<ExportSizeId>('original')
  const [exportError, setExportError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [modifying, setModifying] = useState(false)
  const [placements, setPlacements] = useState<Placement[]>([])
  const [packing, setPacking] = useState(false)
  const packId = useRef(0)

  const activePreset = PRESETS.find((item) => item.id === preset) ?? PRESETS[1]
  const aspectW = preset === 'custom' ? customW : activePreset.w
  const aspectH = preset === 'custom' ? customH : activePreset.h
  const safeW = aspectW > 0 ? aspectW : 1
  const safeH = aspectH > 0 ? aspectH : 1

  const page = useMemo(() => pageSize(safeW, safeH), [safeW, safeH])
  const packedIds = useMemo(
    () => new Set(placements.map((item) => item.photoId)),
    [placements],
  )
  const focusCount = Math.min(breakIndex, photos.length)
  const selected = photos.find((photo) => photo.id === selectedId) ?? null
  const packOptions = useMemo(
    () => ({ gutter, breakIndex, layout, includeAll }),
    [gutter, breakIndex, layout, includeAll],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const id = ++packId.current
    if (photos.length === 0) {
      setPlacements([])
      setPacking(false)
      return
    }
    setPacking(true)
    const job: PackJob = { id, photos, page, options: packOptions }
    let worker: Worker
    try {
      worker = new PackWorker()
    } catch {
      const next = pack(job.photos, job.page, job.options)
      if (id === packId.current) {
        setPlacements(next)
        setPacking(false)
      }
      return
    }
    worker.onmessage = (event: MessageEvent<PackResult>) => {
      if (event.data.id !== packId.current) return
      setPlacements(event.data.placements)
      setPacking(false)
    }
    worker.onerror = () => {
      if (id !== packId.current) return
      setPlacements(pack(job.photos, job.page, job.options))
      setPacking(false)
    }
    worker.postMessage(job)
    return () => {
      worker.terminate()
    }
  }, [photos, page, packOptions])

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
    setModifying(false)
  }

  function deletePhoto(id: string) {
    const index = photos.findIndex((photo) => photo.id === id)
    if (index < 0) return
    const next = photos.slice()
    const [removed] = next.splice(index, 1)
    URL.revokeObjectURL(removed.objectUrl)
    if (selectedId === id) setSelectedId(null)
    commit(next, index < breakIndex ? breakIndex - 1 : breakIndex)
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

  function shuffleNiche() {
    const start = Math.max(0, Math.min(breakIndex, photos.length))
    if (photos.length - start < 2) return
    const next = photos.slice()
    for (let i = next.length - 1; i > start; i--) {
      const j = start + Math.floor(Math.random() * (i - start + 1))
      const swap = next[i]
      next[i] = next[j]
      next[j] = swap
    }
    commit(next, start)
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

        <span className="toolbar-split" aria-hidden />

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
          Layout
          <select
            value={layout}
            onChange={(event) => setLayout(event.target.value as LayoutMode)}
          >
            {LAYOUTS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

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

        <span className="toolbar-split" aria-hidden />

        <span className="export-ctrl">
          <select
            value={exportSize}
            aria-label="Export size"
            onChange={(event) => {
              setExportSize(event.target.value as ExportSizeId)
              setExportError(null)
            }}
          >
            {EXPORT_SIZES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={exporting || placements.length === 0}
            onClick={() => {
              setExportError(null)
              setExporting(true)
              void exportPackedPage(page, photos, placements, exportSize, focusCount)
                .catch((error: unknown) => {
                  setExportError(error instanceof Error ? error.message : 'Export failed.')
                })
                .finally(() => setExporting(false))
            }}
          >
            {exporting ? 'Exporting…' : 'Export'}
          </button>
        </span>
        {exportError ? <span className="export-error">{exportError}</span> : null}

        <span className="toolbar-end">
          <span className="counts-wrap">
            <span
              className={`preview-spin${packing ? ' on' : ''}`}
              role={packing ? 'status' : undefined}
              aria-live="polite"
              aria-label={packing ? 'Updating preview' : undefined}
              aria-hidden={!packing}
              title={packing ? 'Updating preview' : undefined}
            >
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
                <circle
                  cx="8"
                  cy="8"
                  r="5.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeDasharray="18 16"
                />
              </svg>
            </span>
            <span className="counts">{countLabel}</span>
          </span>
          <span className="toolbar-split" aria-hidden />
          <button
            type="button"
            className={`icon-btn${modifying ? ' on' : ''}`}
            aria-label="Delete photos"
            aria-pressed={modifying}
            title="Click a photo in the sequence to delete it"
            onClick={() => {
              setModifying((on) => !on)
              setSelectedId(null)
            }}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <path
                fill="currentColor"
                d="M11.8 1.2a1.4 1.4 0 0 1 2 2L5.4 11.6 2 12.8l1.2-3.4 8.6-8.2zM3.1 13.5h10.4v1.3H3.1z"
              />
            </svg>
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Clear"
            title="Clear all photos"
            onClick={clearAll}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <path
                fill="currentColor"
                d="M3.2 3.2 4.3 2.1 8 5.8l3.7-3.7 1.1 1.1L9.1 6.9l3.7 3.7-1.1 1.1L8 8l-3.7 3.7-1.1-1.1L6.9 6.9 3.2 3.2z"
              />
            </svg>
          </button>
        </span>
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
          includeAll={includeAll}
          onIncludeAll={setIncludeAll}
          onShuffleNiche={shuffleNiche}
          packedIds={packedIds}
          modifying={modifying}
          onDelete={deletePhoto}
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
