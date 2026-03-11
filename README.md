# Mycelium

A local-first creative tool for building layered digital collages with generative effects. Import images, clip them with freehand lasso, layer and transform fragments, apply glitch effects, and grow living reaction-diffusion patterns that warp and mutate your images in real-time.

## Features

- **Canvas** -- 1200x800 working surface with pan/zoom
- **Image import** -- Drag-and-drop, file browse, clipboard paste
- **Layer system** -- Reorder, hide, lock, duplicate, delete
- **Per-layer controls** -- Opacity, scale, rotation, 12 blend modes
- **Freehand lasso** -- Draw clip paths to mask layers
- **Drawing tool** -- Freehand brush with color picker and size control
- **Undo/Redo** -- Full history stack with Ctrl+Z / Ctrl+Shift+Z
- **8 pixel effects** -- Dither, Pixel Sort, Invert, Posterize, Chromatic Aberration, Glitch, Threshold, Halftone
- **Autosave** -- State persisted to localStorage
- **Export** -- Download canvas as PNG

### Dream Mode: Reaction-Diffusion

Grow organic, self-organizing patterns directly on your canvas using the Gray-Scott reaction-diffusion model.

- **8 pattern presets** -- Mitosis, Coral, Spirals, Labyrinth, Leopard, Worms, Chaos, Fingerprint
- **3 seed modes** -- Random, Layer (sample from image pixels), Paint (click to place)
- **7 colormaps** -- Organic, Heat, Acid, Bone, Neon, Image (source colors), **Warp** (pixel displacement)
- **Warp mode** -- RD field displaces actual image pixels, warping and mutating the source image in real-time
- **Live controls** -- Speed, resolution, warp strength, colormap switching while running
- **Freeze to layer** -- Capture any dream state as a new compositable layer
- **Interactive seeding** -- Click inside active dream to inject perturbations

## Getting Started

### Prerequisites

- Node.js 18+

### Install

```bash
npm install
```

### Run

```bash
npm run dev
```

Open http://localhost:5173 in your browser.

### Build

```bash
npm run build
```

## Tech Stack

- React 18
- Vite
- Tailwind CSS v4
- HTML5 Canvas API
- Gray-Scott reaction-diffusion engine (Float32 arrays, 5-point stencil Laplacian)

## Roadmap

- Neural Cellular Automata (NCA) -- trained neural networks that grow/regenerate textures
- Tauri desktop shell with SQLite persistence
- ComfyUI integration for AI generation (ControlNet, inpainting, img2img)
- Deep Dream integration
- Texture generators (Perlin, Voronoi)

## License

MIT
