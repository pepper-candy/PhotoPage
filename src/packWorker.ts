import { pack } from './packer.ts'
import type { PackJob, PackResult } from './types.ts'

self.onmessage = (event: MessageEvent<PackJob>) => {
  const { id, photos, page, options } = event.data
  const placements = pack(photos, page, options)
  self.postMessage({ id, placements } satisfies PackResult)
}
