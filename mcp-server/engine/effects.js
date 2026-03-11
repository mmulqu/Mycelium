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

export const EFFECTS = {
  dither: applyDither,
  pixelsort: applyPixelSort,
  invert: applyInvert,
  posterize: applyPosterize,
  chromatic: applyChromatic,
  glitch: applyGlitch,
  threshold: applyThreshold,
  halftone: applyHalftone,
};
