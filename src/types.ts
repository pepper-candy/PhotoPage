export type PhotoGroup = 'focus' | 'niche'
export type LayoutMode = 'top' | 'bottom' | 'ring' | 'center' | 'boundless'

export type Rect = {
  x: number
  y: number
  w: number
  h: number
}

export type Photo = {
  id: string
  name: string
  objectUrl: string
  previewUrl: string
  width: number
  height: number
  group: PhotoGroup
  safe: Rect
}

export const PROXY_LONG_EDGE = 1280

export function displayUrl(photo: Photo): string {
  return photo.previewUrl || photo.objectUrl
}

export function revokePhoto(photo: Photo) {
  URL.revokeObjectURL(photo.objectUrl)
  if (photo.previewUrl && photo.previewUrl !== photo.objectUrl) {
    URL.revokeObjectURL(photo.previewUrl)
  }
}

export type Page = {
  width: number
  height: number
}

export type PackOptions = {
  gutter: number
  breakIndex: number
  layout: LayoutMode
  includeAll: boolean
}

export type PackJob = {
  id: number
  photos: Photo[]
  page: Page
  options: PackOptions
  fill?: { placements: Placement[]; hole: Rect }
}

export type PackResult = {
  id: number
  placements: Placement[]
}

export type Placement = {
  photoId: string
  x: number
  y: number
  w: number
  h: number
  sx: number
  sy: number
  sw: number
  sh: number
}

export const PAGE_WIDTH = 1000
export const FOCUS_MAX_CROP = 0.1
export const NICHE_MAX_CROP = 0.25
export const DEFAULT_GUTTER = 5
export const DEFAULT_LAYOUT: LayoutMode = 'center'

export function pageSize(aspectW: number, aspectH: number): Page {
  return { width: PAGE_WIDTH, height: PAGE_WIDTH * (aspectH / aspectW) }
}

export function maxCropForGroup(group: PhotoGroup): number {
  return group === 'focus' ? FOCUS_MAX_CROP : NICHE_MAX_CROP
}
