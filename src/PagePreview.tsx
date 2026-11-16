import type { CSSProperties } from 'react'
import type { Page, Photo, Placement } from './types.ts'

type Props = {
  page: Page
  photos: Photo[]
  placements: Placement[]
  selectedId: string | null
  onSelect: (id: string | null) => void
}

function CroppedPhoto({
  photo,
  placement,
  page,
  selected,
  onSelect,
}: {
  photo: Photo
  placement: Placement
  page: Page
  selected: boolean
  onSelect: () => void
}) {
  const { x, y, w, h, sx, sy, sw, sh } = placement
  const scale = Math.min(w / Math.max(sw, 0.001), h / Math.max(sh, 0.001))
  return (
    <button
      type="button"
      className={`placed${selected ? ' selected' : ''}`}
      style={{
        left: `${(x / page.width) * 100}%`,
        top: `${(y / page.height) * 100}%`,
        width: `${(w / page.width) * 100}%`,
        height: `${(h / page.height) * 100}%`,
      }}
      onClick={(event) => {
        event.stopPropagation()
        onSelect()
      }}
      title={photo.name}
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
    </button>
  )
}

export default function PagePreview({ page, photos, placements, selectedId, onSelect }: Props) {
  const byId = new Map(photos.map((photo) => [photo.id, photo]))

  return (
    <div
      className="page"
      style={
        {
          '--pw': page.width,
          '--ph': page.height,
        } as CSSProperties
      }
      onClick={() => onSelect(null)}
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
            selected={selectedId === placement.photoId}
            onSelect={() => onSelect(placement.photoId)}
          />
        )
      })}
    </div>
  )
}
