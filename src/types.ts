export type PhotoGroup = 'focus' | 'niche'
export type LayoutMode = 'top' | 'bottom' | 'ring' | 'center'

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
  width: number
  height: number
  group: PhotoGroup
  safe: Rect
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
