// All effects operate on raw RGBA Uint8ClampedArray buffers

export function applyDither(data, w, h, intensity = 0.4) {
  for (let i = 0; i < data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 255 * intensity;
    data[i]     = Math.min(255, Math.max(0, data[i] + noise));
    data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + noise));
    data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + noise));
  }
}

export function applyPixelSort(data, w, h) {
  for (let row = 0; row < h; row++) {
    const pixels = [];
    for (let col = 0; col < w; col++) {
      const idx = (row * w + col) * 4;
      pixels.push([data[idx], data[idx+1], data[idx+2], data[idx+3]]);
    }
    pixels.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
    for (let col = 0; col < w; col++) {
      const idx = (row * w + col) * 4;
      data[idx] = pixels[col][0]; data[idx+1] = pixels[col][1]; data[idx+2] = pixels[col][2];
    }
  }
}

export function applyInvert(data, w, h) {
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255 - data[i]; data[i+1] = 255 - data[i+1]; data[i+2] = 255 - data[i+2];
  }
}

export function applyPosterize(data, w, h, levels = 4) {
  const step = 255 / (levels - 1);
  for (let i = 0; i < data.length; i += 4) {
    data[i]   = Math.round(data[i] / step) * step;
    data[i+1] = Math.round(data[i+1] / step) * step;
    data[i+2] = Math.round(data[i+2] / step) * step;
  }
}

export function applyChromatic(data, w, h, offset = 8) {
  const original = new Uint8ClampedArray(data);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const idx = (row * w + col) * 4;
      data[idx]     = original[(row * w + Math.min(w - 1, col + offset)) * 4];
      data[idx + 2] = original[(row * w + Math.max(0, col - offset)) * 4 + 2];
    }
  }
}

export function applyGlitch(data, w, h) {
  const sh = Math.floor(h / 20);
  for (let i = 0; i < 20; i++) {
    if (Math.random() > 0.5) {
      const shift = Math.floor((Math.random() - 0.5) * 40);
      for (let y = i * sh; y < Math.min(h, (i + 1) * sh); y++) {
        const rowStart = y * w * 4;
        const row = new Uint8ClampedArray(w * 4);
        for (let x = 0; x < w; x++) {
          const srcX = Math.max(0, Math.min(w - 1, x - shift));
          const di = x * 4, si = srcX * 4;
          row[di] = data[rowStart + si]; row[di+1] = data[rowStart + si+1];
          row[di+2] = data[rowStart + si+2]; row[di+3] = data[rowStart + si+3];
        }
        data.set(row, rowStart);
      }
    }
  }
}

export function applyThreshold(data, w, h, threshold = 128) {
  for (let i = 0; i < data.length; i += 4) {
    const avg = (data[i] + data[i+1] + data[i+2]) / 3;
    const v = avg > threshold ? 255 : 0;
    data[i] = data[i+1] = data[i+2] = v;
  }
}

export function applyHalftone(data, w, h, dotSize = 6) {
  const original = new Uint8ClampedArray(data);
  // Fill black
  for (let i = 0; i < data.length; i += 4) { data[i] = 0; data[i+1] = 0; data[i+2] = 0; data[i+3] = 255; }
  for (let y = 0; y < h; y += dotSize) {
    for (let x = 0; x < w; x += dotSize) {
      const si = (y * w + x) * 4;
      const brightness = (original[si] + original[si+1] + original[si+2]) / 3 / 255;
      const radius = brightness * dotSize / 2;
      const cx = x + dotSize / 2, cy = y + dotSize / 2;
      for (let dy = -Math.ceil(radius); dy <= Math.ceil(radius); dy++) {
        for (let dx = -Math.ceil(radius); dx <= Math.ceil(radius); dx++) {
          if (dx * dx + dy * dy <= radius * radius) {
            const px = Math.floor(cx + dx), py = Math.floor(cy + dy);
            if (px >= 0 && px < w && py >= 0 && py < h) {
              const di = (py * w + px) * 4;
              data[di] = original[si]; data[di+1] = original[si+1]; data[di+2] = original[si+2];
            }
          }
        }
      }
    }
  }
}

// ─── NEW EFFECTS ────────────────────────────────────────────────────────────

// Gaussian blur (3x3 kernel, multiple passes for larger radius)
export function applyBlur(data, w, h, passes = 2) {
  const kernel = [1/16, 2/16, 1/16, 2/16, 4/16, 2/16, 1/16, 2/16, 1/16];
  for (let p = 0; p < passes; p++) {
    const src = new Uint8ClampedArray(data);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let r = 0, g = 0, b = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const ki = (ky + 1) * 3 + (kx + 1);
            const si = ((y + ky) * w + (x + kx)) * 4;
            r += kernel[ki] * src[si];
            g += kernel[ki] * src[si + 1];
            b += kernel[ki] * src[si + 2];
          }
        }
        const idx = (y * w + x) * 4;
        data[idx] = r; data[idx + 1] = g; data[idx + 2] = b;
      }
    }
  }
}

// Sobel edge detection → white edges on black background (ControlNet Canny map)
export function applyEdge(data, w, h) {
  const src = new Uint8ClampedArray(data);
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = 0.299 * src[i * 4] + 0.587 * src[i * 4 + 1] + 0.114 * src[i * 4 + 2];
  }
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx =
        -gray[(y - 1) * w + (x - 1)] + gray[(y - 1) * w + (x + 1)]
        - 2 * gray[y * w + (x - 1)] + 2 * gray[y * w + (x + 1)]
        - gray[(y + 1) * w + (x - 1)] + gray[(y + 1) * w + (x + 1)];
      const gy =
        -gray[(y - 1) * w + (x - 1)] - 2 * gray[(y - 1) * w + x] - gray[(y - 1) * w + (x + 1)]
        + gray[(y + 1) * w + (x - 1)] + 2 * gray[(y + 1) * w + x] + gray[(y + 1) * w + (x + 1)];
      const mag = Math.min(255, Math.sqrt(gx * gx + gy * gy) * 2);
      const idx = (y * w + x) * 4;
      data[idx] = data[idx + 1] = data[idx + 2] = mag;
    }
  }
  // Clear border pixels
  for (let x = 0; x < w; x++) {
    data[x * 4] = data[x * 4 + 1] = data[x * 4 + 2] = 0;
    const bi = ((h - 1) * w + x) * 4;
    data[bi] = data[bi + 1] = data[bi + 2] = 0;
  }
  for (let y = 0; y < h; y++) {
    data[y * w * 4] = data[y * w * 4 + 1] = data[y * w * 4 + 2] = 0;
    const bi = (y * w + (w - 1)) * 4;
    data[bi] = data[bi + 1] = data[bi + 2] = 0;
  }
}

// Emboss / surface-normal approximation (ControlNet Normal map proxy)
export function applyEmboss(data, w, h) {
  const src = new Uint8ClampedArray(data);
  // Emboss kernel: top-left highlights, bottom-right shadows
  const kx = [-1, 0, 1, -2, 0, 2, -1, 0, 1]; // Sobel-X for R
  const ky = [-1, -2, -1, 0, 0, 0, 1, 2, 1];  // Sobel-Y for G
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let gx = 0, gy = 0, gray = 0;
      for (let i = 0; i < 9; i++) {
        const dx = (i % 3) - 1, dy = Math.floor(i / 3) - 1;
        const si = ((y + dy) * w + (x + dx)) * 4;
        const lum = 0.299 * src[si] + 0.587 * src[si + 1] + 0.114 * src[si + 2];
        gx += kx[i] * lum;
        gy += ky[i] * lum;
        gray += lum;
      }
      const idx = (y * w + x) * 4;
      // R = X gradient (128-centered), G = Y gradient (128-centered), B = flat normal Z
      data[idx]     = Math.max(0, Math.min(255, gx / 4 + 128));
      data[idx + 1] = Math.max(0, Math.min(255, gy / 4 + 128));
      data[idx + 2] = 200; // approximate Z normal (pointing outward)
    }
  }
}

// Luminance-based depth approximation: brighter = closer (heuristic)
export function applyDepth(data, w, h) {
  const src = new Uint8ClampedArray(data);
  // Step 1: grayscale luminance
  for (let i = 0; i < w * h; i++) {
    const lum = 0.299 * src[i * 4] + 0.587 * src[i * 4 + 1] + 0.114 * src[i * 4 + 2];
    const idx = i * 4;
    data[idx] = data[idx + 1] = data[idx + 2] = lum;
  }
  // Step 2: invert (dark = far, bright = close heuristic)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255 - data[i];
    data[i + 1] = 255 - data[i + 1];
    data[i + 2] = 255 - data[i + 2];
  }
  // Step 3: apply blur to smooth the depth estimate
  applyBlur(data, w, h, 3);
  // Step 4: add slight vignette (edges are typically farther)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x / w - 0.5) * 2, dy = (y / h - 0.5) * 2;
      const vignette = Math.max(0, 1 - (dx * dx + dy * dy) * 0.4);
      const idx = (y * w + x) * 4;
      data[idx]     = Math.round(data[idx] * vignette);
      data[idx + 1] = Math.round(data[idx + 1] * vignette);
      data[idx + 2] = Math.round(data[idx + 2] * vignette);
    }
  }
}

export const EFFECTS = {
  dither: applyDither,
  pixelsort: applyPixelSort,
  invert: applyInvert,
  posterize: applyPosterize,
  chromatic: applyChromatic,
  glitch: applyGlitch,
  threshold: applyThreshold,
  halftone: applyHalftone,
  blur: applyBlur,
  edge: applyEdge,
  emboss: applyEmboss,
  depth: applyDepth,
};
