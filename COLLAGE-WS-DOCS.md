# COLLAGE.WS — Digital Collage Workspace

A local-first creative tool for building weird, layered digital collages with generative effects and AI-assisted generation via ComfyUI.

## Overview

COLLAGE.WS is a Tauri-based desktop app with an HTML5 Canvas frontend. You import images, clip them with freehand lasso, layer and transform fragments, apply glitch effects, grow reaction-diffusion patterns from your images, and generate new fragments via ControlNet, inpainting, and img2img — all powered by your local ComfyUI instance.

The app autosaves your work. When you open it, your last collage is waiting.

---

## Current Prototype (v0.2.0)

The React prototype implements the core canvas interaction model plus live reaction-diffusion Dream Mode.

### Features in v0.2

- **Canvas** — 1200×800 working surface with pan/zoom
- **Image import** — Drag-and-drop, file browse, clipboard paste
- **Layer system** — Reorder, hide, lock, duplicate, delete
- **Per-layer controls** — Opacity, scale, rotation, blend modes (12 modes)
- **Freehand lasso** — Draw a clip path on any layer to mask it
- **Drawing tool** — Freehand brush with color picker and size control
- **Effects engine** — 8 destructive pixel effects:
  - Dither, Pixel Sort, Invert, Posterize
  - Chromatic Aberration, Glitch (scanline shift), Threshold, Halftone
- **Dream Mode** — Live reaction-diffusion simulation (see below)
- **Autosave** — State persisted every 3 seconds of inactivity
- **Export** — Download canvas as PNG

---

## Dream Mode: Reaction-Diffusion

Dream Mode lets you grow organic, self-organizing patterns directly on the canvas. It implements the **Gray-Scott reaction-diffusion model** — two virtual chemicals (U and V) diffuse across a pixel grid and react with each other, producing Turing patterns: spots, stripes, labyrinths, coral-like branching structures, and chaotic turbulence.

### How it works

The Gray-Scott model simulates two chemicals on a 2D grid:

```
U + 2V → 3V       (autocatalytic reaction)
U is continuously fed, V is continuously removed
```

At each simulation step, for every pixel:

```
ΔU = Du·∇²U − U·V² + F·(1 − U)
ΔV = Dv·∇²V + U·V² − (F + k)·V
```

Where:
- **Du, Dv** — diffusion rates of each chemical
- **F** (feed rate) — how fast chemical U is replenished from outside
- **k** (kill rate) — how fast chemical V decays
- **∇²** — Laplacian (sum of 4 neighbors minus 4× center)

Tiny changes in F and k produce radically different pattern families. The 8 built-in presets each target a different region of this parameter space.

### Presets

| Preset | F | k | Behavior |
|---|---|---|---|
| Mitosis | 0.0367 | 0.0649 | Blob-like shapes that split and divide |
| Coral | 0.0545 | 0.062 | Branching growth reminiscent of coral reefs |
| Spirals | 0.014 | 0.045 | Rotating spiral waves |
| Labyrinth | 0.029 | 0.057 | Dense maze-like Turing stripes |
| Leopard | 0.035 | 0.065 | Isolated circular spots |
| Worms | 0.078 | 0.061 | Writhing tendril-like structures |
| Chaos | 0.026 | 0.051 | Turbulent, unstable dynamics |
| Fingerprint | 0.055 | 0.062 | Dense parallel ridge patterns |

### Seed modes

The initial state of the simulation determines how patterns grow:

- **Random** — Scatter 15 random circular seed points across the region. Patterns grow outward from each seed and interact when they meet.
- **Layer** — Sample pixel luminance from the selected layer within the dream region. Darker pixels get higher initial V concentration, so the image's tonal structure seeds the RD evolution. This creates patterns that follow the contours and textures of your existing collage.
- **Paint** — Click on the canvas to place individual seed points, then drag to define the simulation region. Gives precise control over where growth originates.

### Colormaps

Five colormaps render the chemical concentrations as visible color:

- **Organic** — Dark greens and blue-purples (default, biological feel)
- **Heat** — Black → red → orange → white thermal gradient
- **Acid** — Vivid green with purple undertones
- **Bone** — High-contrast black and white
- **Neon** — Sinusoidal RGB cycling, psychedelic

Colormaps can be switched live while the simulation runs.

### Interaction

- **Drag** a region on the canvas to define where the simulation runs
- **Start** to begin evolution — patterns grow and change in real-time
- **Click inside** the active dream region to inject new seed points, perturbing the simulation
- **Speed** slider controls steps per animation frame (1–30)
- **Pause/Resume** to freeze time and study the pattern
- **Freeze** captures the current RD state as a new canvas layer, positioned exactly over the dream region. You can then apply blend modes, adjust opacity, stack multiple dream layers, apply glitch effects to them, or use them as seeds for further dreaming.
- **Resolution** slider (64–400) controls the simulation grid size. Lower = faster and more organic, higher = finer detail.

### Technical details

The simulation runs on an offscreen canvas at the configured resolution, separate from the main canvas. Each animation frame:

1. Run N simulation steps (configurable via speed slider)
2. Render the U/V grids to an ImageData via the selected colormap
3. Composite the offscreen canvas into the dream region on the main canvas
4. The main canvas continues rendering all other layers underneath

The RD engine uses Float32 arrays for the chemical grids and a 5-point stencil Laplacian. At resolution 200 with speed 8, this runs comfortably at 60fps in a browser.

---

## Future: Neural Cellular Automata (NCA)

The next evolution of Dream Mode will add **Neural Cellular Automata** — small neural networks that operate per-pixel, producing self-organizing, self-repairing textures that look alive.

### What NCA is

A Neural Cellular Automaton is a differentiable cellular automaton where each cell:

1. **Perceives** its neighborhood (3×3 Sobel filters to compute local gradients)
2. **Processes** the perception through a tiny neural network (typically 2-3 dense layers, ~8000 parameters total)
3. **Updates** its own state vector (typically 16 channels, of which 4 map to RGBA)

The network is trained via gradient descent: start from a seed state, run N steps, compare the resulting image to a target texture, and backpropagate through the entire simulation.

### Why NCA matters for this app

NCA produces qualitatively different weirdness than reaction-diffusion:

- **Self-repair**: Damage the pattern and it grows back. Erase a chunk and watch it regenerate.
- **Target textures**: Train an NCA to grow toward any image. Feed it a photo of bark, and it learns to generate bark-like textures that self-organize from a single seed pixel.
- **Persistence**: NCA patterns can maintain stable structures indefinitely, unlike RD which often reaches equilibrium.
- **Morphogenesis**: The growth process itself is visually fascinating — watching structure emerge from nothing.

### Integration plan

NCA will slot into Dream Mode alongside the existing RD engine. The user selects "NCA" as the dream engine, picks a pre-trained model (or trains one from a layer), and the simulation runs on the same region-select → evolve → freeze workflow.

### Implementation options

**Option A: TensorFlow.js in the webview (recommended for prototype)**

TensorFlow.js can run pre-trained NCA models directly in the browser/webview with WebGL acceleration. The model weights are small (~50KB per model) and inference is fast enough for real-time rendering at 128×128.

Requirements:
- `@tensorflow/tfjs` npm package
- Pre-trained weight files (`.json` + `.bin` shards)
- WebGL2-capable GPU (any modern GPU)

The NCA step function in TensorFlow.js:

```javascript
// Pseudocode for NCA inference step
function ncaStep(state) {
  // state: [1, H, W, 16] tensor (16-channel cell state)
  
  // 1. Perceive: apply Sobel filters to get local gradients
  const sobelX = tf.conv2d(state, SOBEL_X_KERNEL, 1, 'same');
  const sobelY = tf.conv2d(state, SOBEL_Y_KERNEL, 1, 'same');
  const perception = tf.concat([state, sobelX, sobelY], -1); // [1, H, W, 48]
  
  // 2. Process: two dense layers (implemented as 1x1 convolutions)
  let x = tf.conv2d(perception, weights.dense1, 1, 'same');
  x = tf.relu(x);
  x = tf.conv2d(x, weights.dense2, 1, 'same');  // → [1, H, W, 16]
  
  // 3. Stochastic update: randomly mask some cells (forces robustness)
  const mask = tf.randomUniform([1, H, W, 1]).greater(0.5);
  const update = x.mul(mask.cast('float32'));
  
  // 4. Apply: residual connection
  return state.add(update);
}
```

**Option B: Python sidecar process**

For training custom NCA models from user-provided textures, we'll need a Python process with PyTorch:

```
collage-ws/
├── nca-service/
│   ├── train.py          # Train NCA from target texture
│   ├── infer.py          # Run trained NCA, stream frames
│   ├── models/           # Saved model weights
│   │   ├── bark.pth
│   │   ├── moss.pth
│   │   └── custom/
│   └── requirements.txt  # torch, numpy
```

The Tauri backend spawns this as a child process and communicates via stdio JSON protocol:

```json
// Request: train a new NCA
{"cmd": "train", "target_image": "/path/to/texture.png", "steps": 5000, "name": "my_texture"}

// Request: run inference
{"cmd": "infer", "model": "bark", "width": 128, "height": 128, "steps": 200}

// Response: frame data (streamed)
{"frame": 42, "rgba": "<base64 encoded RGBA bytes>"}
```

**Option C: ComfyUI custom node**

A ComfyUI node that runs NCA inference, integrating with the existing workflow template system. This is the cleanest long-term solution but requires building a custom ComfyUI node package.

### Pre-trained model library

Ship the app with 10-15 pre-trained NCA models covering different texture families:

| Model | Visual character |
|---|---|
| Bark | Rough, cracked organic texture |
| Moss | Soft, spreading green growth |
| Coral | Branching calcium structures |
| Rust | Oxidation patterns, warm browns |
| Lichen | Slow-spreading circular colonies |
| Frost | Crystalline ice growth |
| Slime | Iridescent, flowing mold patterns |
| Scale | Reptilian overlapping scales |
| Woven | Self-organizing textile pattern |
| Lava | Cooling magma with glowing cracks |
| Neural | Brain-like folding convolutions |
| Mycelium | Fungal network branching |

Users could also train custom models from any layer in their collage (Option B), creating NCA that grow textures matching their existing artwork.

### NCA + RD interaction

The most interesting possibility: use RD output as the seed state for NCA, or vice versa. Run reaction-diffusion to create an interesting initial pattern, then switch to NCA and watch it morph into a learned texture. Or train an NCA on the output of a specific RD preset. The two systems operating in sequence produce patterns neither could alone.

### Resource requirements

| Component | CPU | GPU | RAM | Disk |
|---|---|---|---|---|
| TFJS inference (128×128) | Minimal | WebGL | ~50MB | ~50KB/model |
| TFJS inference (256×256) | Moderate | WebGL | ~100MB | ~50KB/model |
| PyTorch training | High | CUDA recommended | ~2GB | ~500MB (PyTorch) |
| Pre-trained models | — | — | — | ~5MB total |

---

## Architecture: Target Desktop App

```
┌──────────────────────────────────────┐
│            Tauri Window              │
│  ┌────────────────────────────────┐  │
│  │   Frontend (HTML/JS/CSS)       │  │
│  │   ┌──────────┐ ┌───────────┐  │  │
│  │   │  Canvas   │ │  Layer UI │  │  │
│  │   │  + Dream  │ │  Effects  │  │  │
│  │   │  + NCA    │ │  Tools    │  │  │
│  │   └────┬─────┘ └─────┬─────┘  │  │
│  └────────┼──────────────┼────────┘  │
│           │     IPC      │           │
│  ┌────────▼──────────────▼────────┐  │
│  │      Rust Backend              │  │
│  │  ┌──────────┐ ┌────────────┐   │  │
│  │  │ SQLite   │ │ ComfyUI    │   │  │
│  │  │ (state)  │ │ Client     │   │  │
│  │  └──────────┘ └─────┬──────┘   │  │
│  │  ┌──────────┐ ┌─────┴──────┐  │  │
│  │  │ File I/O │ │NCA Sidecar │  │  │
│  │  │ (images) │ │ (PyTorch)  │  │  │
│  │  └──────────┘ └────────────┘  │  │
│  └─────────────────────┬─────────┘  │
└────────────────────────┼────────────┘
                         │ HTTP/WS :8188
┌────────────────────────▼────────────┐
│     ComfyUI (Docker or native)      │
│     ├── SD / SDXL / Flux models     │
│     ├── ControlNet models           │
│     ├── LoRAs                       │
│     └── Custom nodes (NCA, Dream)   │
└─────────────────────────────────────┘
```

---

## Installation Plan

### Prerequisites

| Dependency | Version | Purpose |
|---|---|---|
| Rust | 1.75+ | Tauri backend |
| Node.js | 20+ | Frontend build tooling |
| ComfyUI | Latest | AI generation engine |
| Python | 3.10+ | ComfyUI runtime + NCA training |
| CUDA / ROCm | Matching GPU | GPU acceleration |

### Step 1: Install Tauri CLI

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install create-tauri-app --locked
cargo install tauri-cli --locked
```

### Step 2: Scaffold the project

```bash
cargo create-tauri-app collage-ws --template vanilla
cd collage-ws
cd src && npm init -y && npm install fabric
```

### Step 3: ComfyUI setup

```bash
mkdir -p ~/.collage-ws/comfyui-io/{input,output}

docker run -d --gpus all -p 8188:8188 \
  -v ~/.collage-ws/comfyui-io/input:/opt/ComfyUI/input \
  -v ~/.collage-ws/comfyui-io/output:/opt/ComfyUI/output \
  -v ~/comfyui-models:/opt/ComfyUI/models \
  --name comfyui ghcr.io/ai-dock/comfyui:latest
```

### Step 4: Configure

Create `~/.collage-ws/config.toml`:

```toml
[comfyui]
host = "127.0.0.1"
port = 8188
input_dir = "~/.collage-ws/comfyui-io/input"
output_dir = "~/.collage-ws/comfyui-io/output"

[canvas]
default_width = 1920
default_height = 1080

[storage]
db_path = "~/.collage-ws/collage.db"
image_dir = "~/.collage-ws/images"

[nca]
models_dir = "~/.collage-ws/nca-models"
python_path = "python3"
use_tfjs = true       # Use TensorFlow.js for inference
use_sidecar = false   # Enable Python sidecar for training
```

### Step 5: Build and run

```bash
cargo tauri dev        # Development
cargo tauri build      # Production
```

---

## Roadmap

### Phase 1 — Canvas Core ✓
- [x] HTML5 Canvas with layer compositing
- [x] Image import (drag-drop, paste, file browse)
- [x] Freehand lasso clipping
- [x] Layer panel (visibility, lock, reorder, duplicate, delete)
- [x] Per-layer opacity, scale, rotation, blend modes
- [x] Drawing tool
- [x] Pixel effects (8 types)
- [x] Autosave
- [x] PNG export

### Phase 2 — Dream Mode: Reaction-Diffusion ✓
- [x] Gray-Scott RD engine with Float32 grids
- [x] 8 pattern presets (mitosis, coral, spirals, labyrinth, leopard, worms, chaos, fingerprint)
- [x] 3 seed modes (random, layer-sampled, painted)
- [x] 5 colormaps (organic, heat, acid, bone, neon)
- [x] Live animation with configurable speed
- [x] Interactive seed injection (click to poke)
- [x] Freeze to layer
- [x] Resolution control
- [x] Pause/resume

### Phase 3 — Tauri Shell
- [ ] Migrate frontend to Tauri webview
- [ ] Rust backend with SQLite state persistence
- [ ] File-system based image storage (hashed blobs)
- [ ] Undo/redo stack (command pattern)
- [ ] Keyboard shortcuts
- [ ] Canvas resize / infinite canvas mode

### Phase 4 — Dream Mode: Neural Cellular Automata
- [ ] TensorFlow.js NCA inference in webview
- [ ] Ship 12+ pre-trained texture models
- [ ] NCA engine selection in Dream Mode panel
- [ ] Self-repair demo (erase region → watch regrowth)
- [ ] Python sidecar for training custom NCA from layer textures
- [ ] NCA ↔ RD chaining (use RD output as NCA seed and vice versa)
- [ ] Model browser with texture previews

### Phase 5 — ComfyUI Integration
- [ ] ComfyUI client in Rust (HTTP + WebSocket)
- [ ] Shared I/O directory with Docker bind mount
- [ ] Workflow template system with placeholder substitution
- [ ] ControlNet scribble: draw → generate → new layer
- [ ] ControlNet canny/depth: fragment → edge detect → generate
- [ ] img2img with denoise slider
- [ ] Inpainting via lasso mask
- [ ] Live generation preview (WebSocket progress frames)
- [ ] Model/LoRA selector
- [ ] Prompt bar with history

### Phase 6 — Deep Dream Integration
- [ ] Python sidecar or ComfyUI node for gradient ascent
- [ ] Layer selector (shallow = textures, deep = objects)
- [ ] Octave scaling controls
- [ ] Dream brush (paint to dream specific regions)
- [ ] Stream intermediate frames as live animation
- [ ] Combine with RD/NCA (dream → diffuse → dream)

### Phase 7 — Creative Tools
- [ ] Text fragments with font selection
- [ ] Shape primitives
- [ ] Texture generators (Perlin, Voronoi)
- [ ] Grid/snap system
- [ ] Alignment tools
- [ ] Color palette extraction
- [ ] Fragment auto-arrange

### Phase 8 — Gallery & Sharing
- [ ] Project gallery with thumbnails
- [ ] Daily prompt / constraint system
- [ ] Streak tracker
- [ ] Version history scrubber
- [ ] Multi-format export (PNG, SVG, PSD, TIFF)
- [ ] Bluesky integration

---

## Project Structure (Target)

```
collage-ws/
├── src-tauri/
│   ├── Cargo.toml
│   ├── src/
│   │   ├── main.rs
│   │   ├── comfyui/
│   │   │   ├── mod.rs
│   │   │   ├── workflow.rs
│   │   │   └── models.rs
│   │   ├── storage/
│   │   │   ├── mod.rs
│   │   │   └── images.rs
│   │   ├── nca/
│   │   │   ├── mod.rs           # NCA sidecar manager
│   │   │   └── models.rs        # Model inventory
│   │   └── commands.rs
│   └── tauri.conf.json
├── src/
│   ├── index.html
│   ├── main.js
│   ├── canvas/
│   │   ├── engine.js
│   │   ├── layers.js
│   │   ├── tools.js
│   │   └── effects.js
│   ├── dream/
│   │   ├── rd-engine.js         # Reaction-diffusion (current)
│   │   ├── nca-engine.js        # Neural cellular automata (TFJS)
│   │   ├── deep-dream.js        # Deep dream bridge
│   │   ├── presets.js           # RD presets + NCA model registry
│   │   └── colormaps.js         # Color mapping functions
│   ├── ui/
│   │   ├── toolbar.js
│   │   ├── layers-panel.js
│   │   ├── dream-panel.js       # Dream mode controls
│   │   ├── properties.js
│   │   └── comfyui-panel.js
│   ├── comfyui/
│   │   ├── bridge.js
│   │   └── preview.js
│   └── styles/
│       └── main.css
├── nca-service/                  # Python sidecar
│   ├── train.py
│   ├── infer.py
│   ├── models/
│   │   ├── bark.pth
│   │   ├── moss.pth
│   │   └── ...
│   └── requirements.txt
├── nca-models-tfjs/              # Pre-trained TFJS models
│   ├── bark/
│   │   ├── model.json
│   │   └── weights.bin
│   └── ...
├── workflows/
│   ├── controlnet_scribble.json
│   ├── inpaint_sdxl.json
│   └── ...
├── package.json
└── README.md
```

---

## Design Philosophy

**Additive, not destructive.** Every action adds to the collage. Effects create new state. The goal is to make it impossible to "ruin" a piece.

**Weird by default.** The effects are glitch art tools. The AI integration is about surprise. Reaction-diffusion grows living patterns from your images. NCA will learn to regrow textures. Deep Dream will hallucinate.

**Session continuity.** Open the app → your last collage is there. No project management, no file dialogs.

**Local-first.** Your images, your models, your GPU. Nothing leaves your machine.

**Generative layering.** The dream engines (RD, NCA, Deep Dream) all produce layers that compose with everything else — blend modes, clipping, effects. A dreamed layer can be clipped, glitched, and used as a seed for another dream. The creative loop tightens.

---

## Key References

### Reaction-Diffusion
- Pearson, J.E. "Complex Patterns in a Simple System" — the paper that mapped the Gray-Scott parameter space
- [Reaction-Diffusion Simulator](https://pmneila.github.io/jsexp/grayscott/) — interactive browser demo
- Karl Sims' original RD work

### Neural Cellular Automata
- Mordvintsev et al. "Growing Neural Cellular Automata" (Distill, 2020) — the foundational paper
- Mordvintsev et al. "Self-Organising Textures" (Distill, 2021) — texture generation with NCA
- [Google Research NCA Colab notebooks](https://colab.research.google.com/github/google-research/self-organising-systems)
- TensorFlow.js NCA demo: [https://distill.pub/2020/growing-ca/](https://distill.pub/2020/growing-ca/)

### Deep Dream
- Mordvintsev et al. "Inceptionism: Going Deeper into Neural Networks" (Google AI Blog, 2015)
- [DeepDream ComfyUI node](https://github.com/ComfyUI-DeepDream) — existing integration
