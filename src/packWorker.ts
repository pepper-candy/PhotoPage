import { fillSpareHole, pack } from './packer.ts'
import type { PackJob, PackResult } from './types.ts'

self.onmessage = (event: MessageEvent<PackJob>) => {
  const { id, photos, page, options, fill } = event.data
  const placements = fill
    ? fillSpareHole(fill.placements, photos, page, options.gutter, fill.hole, options.layout)
    : pack(photos, page, options)
  self.postMessage({ id, placements } satisfies PackResult)
}
