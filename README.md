# Photo page layout

Pack a batch of photos onto one page. Import a handful or around a hundred, pick an aspect ratio, and the tool fills the page without stretching any picture.

Use it here: [photomixpage.vercel.app](https://photomixpage.vercel.app)

## How it works

Photos stay in import order on the left, which is also their packing priority. Drag to reorder. Drop files on the window, or use Import, to add them. Click a photo to crop it or mark a safe crop boundary — the packed crop stays inside that boundary.

A divider in the list splits the batch into two groups:

- **Focus** (above the divider) stay larger and are cropped only lightly, about 10%, so the subject still reads complete.
- **Niche** (below the divider) fill the leftover space. They can be cropped more, up to 25%.

On a fresh import, the first photo starts in focus and the rest start as niche. Drag photos across the divider, or drag the divider itself, to change the groups.

**Include all** is off by default. The packer then keeps the focus photos and packs niche in list order at a healthier size; later niche photos may stay in the tray (they appear greyed) and can still be dragged. Turn **Include all** on to put every photo on the page.

## Layouts

- **Top**, **Bottom**, **Ring**, and **Center** fill the chosen page aspect completely.
- **Boundless** builds a tight irregular cluster. The aspect is only a hint for how the cluster should grow — for example, 9:16 prefers a taller arrangement. Export frames the photos themselves, with a transparent background, instead of forcing a page rectangle.

Aspect presets include 1:1, 9:16, 4:5, 3:4, 3:2, 4:3, 16:9, 2:1, 2.39:1, A4 portrait, and a custom ratio. Gutter controls the gap between photos.

## Export

Export is a PNG. Choose **Original**, **16K**, **8K**, **4K**, **2K**, **1080p**, or **720p**. Named sizes set the long edge (15360, 7680, 3840, 2560, 1920, or 1280 pixels) and keep the page aspect. **Original** scales so no focus photo drops below its source resolution.

## Run locally

```bash
npm install
npm run dev
```

Open the local URL Vite prints.
```