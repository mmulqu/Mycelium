import { useState, useEffect, useRef, useCallback } from "react";
import { ComfyUIClient } from './comfyui-client.js';
import sd15Inpaint from '../comfyui-workflows/sd15-inpaint.json';
import sdxlInpaint from '../comfyui-workflows/sdxl-inpaint-8gb.json';
import zimageImg2Img from '../comfyui-workflows/zimage_img2img_barebones.json';

const SAM2_URL = "http://127.0.0.1:7861";

const COMFY_WORKFLOWS = {
  "sd15-inpaint":    { label: "SD 1.5 Inpaint (4GB)",  template: sd15Inpaint, mode: "inpaint" },
  "sdxl-inpaint-8g": { label: "SDXL Inpaint (8GB)",    template: sdxlInpaint, mode: "inpaint" },
  "zimage-img2img":  { label: "ZImage Img2Img",        template: zimageImg2Img, mode: "img2img" },
};

// ═══════════════════════════════════════════════════════════════
// TOOLS & CONSTANTS
// ═══════════════════════════════════════════════════════════════

const TOOLS = {
  SELECT: "select",
  LASSO: "lasso",
  DRAW: "draw",
  PAN: "pan",
  DREAM: "dream",
  WAND: "wand",       // Magic Wand flood-fill selection
  SEGMENT: "segment", // SAM2 AI object segmentation
  REGION: "region",   // Polygonal region for ComfyUI inpainting
};

const BLEND_MODES = [
  "source-over", "multiply", "screen", "overlay", "darken",
  "lighten", "color-dodge", "color-burn", "hard-light",
  "soft-light", "difference", "exclusion",
];

// Gray-Scott reaction-diffusion presets
const RD_PRESETS = {
  mitosis: { name: "Mitosis", f: 0.0367, k: 0.0649, Du: 0.21, Dv: 0.105, desc: "Cell-like splitting blobs" },
  coral: { name: "Coral", f: 0.0545, k: 0.062, Du: 0.16, Dv: 0.08, desc: "Branching coral growth" },
  spirals: { name: "Spirals", f: 0.014, k: 0.045, Du: 0.21, Dv: 0.105, desc: "Rotating spiral waves" },
  maze: { name: "Labyrinth", f: 0.029, k: 0.057, Du: 0.21, Dv: 0.105, desc: "Turing stripe maze" },
  spots: { name: "Leopard", f: 0.035, k: 0.065, Du: 0.16, Dv: 0.08, desc: "Isolated spot patterns" },
  worms: { name: "Worms", f: 0.078, k: 0.061, Du: 0.16, Dv: 0.08, desc: "Writhing worm tendrils" },
  chaos: { name: "Chaos", f: 0.026, k: 0.051, Du: 0.21, Dv: 0.105, desc: "Turbulent instability" },
  fingerprint: { name: "Fingerprint", f: 0.055, k: 0.062, Du: 0.21, Dv: 0.105, desc: "Dense parallel ridges" },
};

// Color maps for rendering RD state
const RD_COLORMAPS = {
  organic: (u, v) => {
    const r = Math.floor(Math.min(255, (1 - u) * 40 + v * 300));
    const g = Math.floor(Math.min(255, (1 - u) * 60 + v * 120));
    const b = Math.floor(Math.min(255, (1 - u) * 80 + v * 180));
    return [r, g, b];
  },
  heat: (u, v) => {
    const t = v * 4;
    const r = Math.floor(Math.min(255, t * 255));
    const g = Math.floor(Math.min(255, Math.max(0, (t - 0.4) * 400)));
    const b = Math.floor(Math.min(255, Math.max(0, (t - 0.7) * 600)));
    return [r, g, b];
  },
  acid: (u, v) => {
    const r = Math.floor(Math.min(255, v * 150 + (1 - u) * 30));
    const g = Math.floor(Math.min(255, v * 400));
    const b = Math.floor(Math.min(255, (1 - u) * 100 + v * 200));
    return [r, g, b];
  },
  bone: (u, v) => {
    const l = Math.floor(Math.min(255, (1 - v * 3) * 240));
    return [l, l, Math.floor(Math.min(255, l + 15))];
  },
  neon: (u, v) => {
    const t = v * 5;
    const r = Math.floor(Math.min(255, Math.sin(t * 2) * 127 + 128));
    const g = Math.floor(Math.min(255, Math.sin(t * 3 + 2) * 127 + 128));
    const b = Math.floor(Math.min(255, Math.sin(t * 5 + 4) * 127 + 128));
    return [r, g, b];
  },
};

// ═══════════════════════════════════════════════════════════════
// INPAINT HELPERS  (polygon region + mask generation)
// ═══════════════════════════════════════════════════════════════

/** Bounding box of an array of {x,y} canvas points. */
function polyBounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Bounding box of a SAM boolean mask in canvas coordinates.
 * Returns null if mask is empty.
 */
function samMaskBounds(mask, maskW, maskH, layerX, layerY, scaleX, scaleY) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < maskH; y++) {
    for (let x = 0; x < maskW; x++) {
      if (!mask[y * maskW + x]) continue;
      const cx = layerX + x * scaleX, cy = layerY + y * scaleY;
      if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
    }
  }
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Crop a layer's imageData to a rect (image-space coords).
 * Returns a Promise<dataUrl>.
 */
function cropLayerImage(layer, cropX, cropY, cropW, cropH) {
  return new Promise(resolve => {
    const img = new Image();
    img.src = layer.imageData;
    img.onload = () => {
      const tc = document.createElement("canvas");
      tc.width = cropW; tc.height = cropH;
      tc.getContext("2d").drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
      resolve(tc.toDataURL("image/png"));
    };
  });
}

function loadImageDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Build a white-on-black mask PNG (same size as the crop) from polygon points.
 * All coordinates are canvas-space; function converts to cropped image-space.
 */
function polygonMaskDataUrl(points, layerX, layerY, scaleX, scaleY, cropX, cropY, cropW, cropH) {
  const mc = document.createElement("canvas");
  mc.width = cropW; mc.height = cropH;
  const ctx = mc.getContext("2d");
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, cropW, cropH);
  // Canvas → layer image → cropped image coords
  const local = points.map(p => ({
    x: (p.x - layerX) / scaleX - cropX,
    y: (p.y - layerY) / scaleY - cropY,
  }));
  ctx.fillStyle = "white";
  ctx.beginPath();
  ctx.moveTo(local[0].x, local[0].y);
  for (let i = 1; i < local.length; i++) ctx.lineTo(local[i].x, local[i].y);
  ctx.closePath();
  ctx.fill();
  return mc.toDataURL("image/png");
}

/**
 * Build a white-on-black mask PNG from a SAM boolean mask, cropped to a rect.
 */
function samMaskCroppedDataUrl(samMask, maskW, cropX, cropY, cropW, cropH) {
  const mc = document.createElement("canvas");
  mc.width = cropW; mc.height = cropH;
  const ctx = mc.getContext("2d");
  const id = ctx.createImageData(cropW, cropH);
  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const srcIdx = (y + cropY) * maskW + (x + cropX);
      const v = samMask[srcIdx] ? 255 : 0;
      const dst = (y * cropW + x) * 4;
      id.data[dst] = id.data[dst + 1] = id.data[dst + 2] = v;
      id.data[dst + 3] = 255;
    }
  }
  ctx.putImageData(id, 0, 0);
  return mc.toDataURL("image/png");
}

// ═══════════════════════════════════════════════════════════════
// REACTION-DIFFUSION ENGINE (Gray-Scott model)
// ═══════════════════════════════════════════════════════════════

class ReactionDiffusion {
  constructor(width, height) {
    this.w = width;
    this.h = height;
    this.size = width * height;
    this.u = new Float32Array(this.size).fill(1.0);
    this.v = new Float32Array(this.size).fill(0.0);
    this.uNext = new Float32Array(this.size);
    this.vNext = new Float32Array(this.size);
    this.f = 0.0545;
    this.k = 0.062;
    this.Du = 0.16;
    this.Dv = 0.08;
    this.dt = 1.0;
    this.iterations = 0;
    // Stored seed image colors (RGB per pixel) for image colormap
    this.seedColors = null;
  }

  setParams(f, k, Du, Dv) {
    this.f = f; this.k = k; this.Du = Du; this.Dv = Dv;
  }

  seed(cx, cy, radius) {
    for (let y = Math.max(0, cy - radius); y < Math.min(this.h, cy + radius); y++) {
      for (let x = Math.max(0, cx - radius); x < Math.min(this.w, cx + radius); x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy < radius * radius) {
          const idx = y * this.w + x;
          this.v[idx] = 1.0;
          this.u[idx] = 0.5;
          this.v[idx] += (Math.random() - 0.5) * 0.1;
        }
      }
    }
  }

  seedFromImage(imageData, w, h) {
    const scaleX = w / this.w;
    const scaleY = h / this.h;
    this.seedColors = new Uint8Array(this.size * 3);
    let hasContent = false;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const sx = Math.floor(x * scaleX);
        const sy = Math.floor(y * scaleY);
        const srcIdx = (sy * w + sx) * 4;
        const idx = y * this.w + x;
        // Store original colors
        this.seedColors[idx * 3] = imageData[srcIdx];
        this.seedColors[idx * 3 + 1] = imageData[srcIdx + 1];
        this.seedColors[idx * 3 + 2] = imageData[srcIdx + 2];
        const alpha = imageData[srcIdx + 3];
        if (alpha === 0) continue;
        const lum = (imageData[srcIdx] + imageData[srcIdx + 1] + imageData[srcIdx + 2]) / 765;
        const invLum = 1 - lum;
        // Stronger seeding: high V in dark areas to reliably trigger growth
        this.v[idx] = invLum * invLum * 0.9 + Math.random() * 0.1;
        this.u[idx] = 0.5 - this.v[idx] * 0.3;
        if (invLum > 0.1) hasContent = true;
      }
    }
    // Fallback: if image was mostly white/transparent, add random seeds
    if (!hasContent) this.seedRandom(15);
  }

  seedRandom(count = 20) {
    for (let i = 0; i < count; i++) {
      this.seed(
        Math.floor(Math.random() * this.w),
        Math.floor(Math.random() * this.h),
        3 + Math.floor(Math.random() * 5)
      );
    }
  }

  step() {
    const { w, h, u, v, uNext, vNext, f, k, Du, Dv, dt } = this;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        const lapU = u[idx - 1] + u[idx + 1] + u[idx - w] + u[idx + w] - 4 * u[idx];
        const lapV = v[idx - 1] + v[idx + 1] + v[idx - w] + v[idx + w] - 4 * v[idx];
        const uvv = u[idx] * v[idx] * v[idx];
        uNext[idx] = u[idx] + (Du * lapU - uvv + f * (1 - u[idx])) * dt;
        vNext[idx] = v[idx] + (Dv * lapV + uvv - (f + k) * v[idx]) * dt;
        uNext[idx] = Math.max(0, Math.min(1, uNext[idx]));
        vNext[idx] = Math.max(0, Math.min(1, vNext[idx]));
      }
    }
    this.u.set(uNext);
    this.v.set(vNext);
    this.iterations++;
  }

  stepN(n) { for (let i = 0; i < n; i++) this.step(); }

  render(imageData, colormap = "organic") {
    const data = imageData.data;
    if (colormap === "image" && this.seedColors) {
      for (let i = 0; i < this.size; i++) {
        const vv = this.v[i];
        const pi = i * 4;
        const ci = i * 3;
        // V intensity modulates the seed color brightness
        // Low V = dark background, high V = vivid seed color
        const intensity = Math.min(1, vv * 3);
        const boost = 0.6 + intensity * 0.4;
        data[pi]     = Math.min(255, Math.floor(this.seedColors[ci]     * boost * intensity + (1 - intensity) * 10));
        data[pi + 1] = Math.min(255, Math.floor(this.seedColors[ci + 1] * boost * intensity + (1 - intensity) * 8));
        data[pi + 2] = Math.min(255, Math.floor(this.seedColors[ci + 2] * boost * intensity + (1 - intensity) * 15));
        data[pi + 3] = 255;
      }
    } else {
      const mapFn = RD_COLORMAPS[colormap] || RD_COLORMAPS.organic;
      for (let i = 0; i < this.size; i++) {
        const [r, g, b] = mapFn(this.u[i], this.v[i]);
        const pi = i * 4;
        data[pi] = r; data[pi + 1] = g; data[pi + 2] = b; data[pi + 3] = 255;
      }
    }
  }

  // Warp render: use RD field to displace source image pixels
  renderWarp(imageData, srcPixels, srcW, srcH, strength = 15) {
    const data = imageData.data;
    const { w, h, v, u } = this;
    const scaleX = srcW / w;
    const scaleY = srcH / h;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const vv = v[idx];
        // Compute local V gradient for displacement direction
        const vL = x > 0 ? v[idx - 1] : vv;
        const vR = x < w - 1 ? v[idx + 1] : vv;
        const vU = y > 0 ? v[idx - w] : vv;
        const vD = y < h - 1 ? v[idx + w] : vv;
        const gradX = (vR - vL) * strength;
        const gradY = (vD - vU) * strength;
        // Also add some swirl based on V magnitude
        const mag = vv * strength * 0.5;
        const dx = gradX + Math.sin(vv * 12) * mag;
        const dy = gradY + Math.cos(vv * 12) * mag;
        // Sample source image at displaced position
        const srcX = Math.floor(x * scaleX + dx * scaleX);
        const srcY = Math.floor(y * scaleY + dy * scaleY);
        const clampX = Math.max(0, Math.min(srcW - 1, srcX));
        const clampY = Math.max(0, Math.min(srcH - 1, srcY));
        const srcIdx = (clampY * srcW + clampX) * 4;
        const pi = idx * 4;
        data[pi]     = srcPixels[srcIdx];
        data[pi + 1] = srcPixels[srcIdx + 1];
        data[pi + 2] = srcPixels[srcIdx + 2];
        data[pi + 3] = 255;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// PIXEL EFFECTS
// ═══════════════════════════════════════════════════════════════

const applyDither = (ctx, x, y, w, h, intensity = 0.3) => {
  const imageData = ctx.getImageData(x, y, w, h);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 255 * intensity;
    data[i] = Math.min(255, Math.max(0, data[i] + noise));
    data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + noise));
    data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + noise));
  }
  ctx.putImageData(imageData, x, y);
};

const applyPixelSort = (ctx, x, y, w, h) => {
  const imageData = ctx.getImageData(x, y, w, h);
  const data = imageData.data;
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
  ctx.putImageData(imageData, x, y);
};

const applyInvert = (ctx, x, y, w, h) => {
  const imageData = ctx.getImageData(x, y, w, h);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) { data[i] = 255 - data[i]; data[i+1] = 255 - data[i+1]; data[i+2] = 255 - data[i+2]; }
  ctx.putImageData(imageData, x, y);
};

const applyPosterize = (ctx, x, y, w, h, levels = 4) => {
  const imageData = ctx.getImageData(x, y, w, h);
  const data = imageData.data;
  const step = 255 / (levels - 1);
  for (let i = 0; i < data.length; i += 4) { data[i] = Math.round(data[i]/step)*step; data[i+1] = Math.round(data[i+1]/step)*step; data[i+2] = Math.round(data[i+2]/step)*step; }
  ctx.putImageData(imageData, x, y);
};

const applyChromatic = (ctx, x, y, w, h, offset = 5) => {
  const imageData = ctx.getImageData(x, y, w, h);
  const original = new Uint8ClampedArray(imageData.data);
  const data = imageData.data;
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const idx = (row * w + col) * 4;
      data[idx] = original[(row * w + Math.min(w-1, col+offset)) * 4];
      data[idx+2] = original[(row * w + Math.max(0, col-offset)) * 4 + 2];
    }
  }
  ctx.putImageData(imageData, x, y);
};

// Gaussian blur (box approximation, 3×3 kernel, multiple passes)
const applyBlur = (ctx, x, y, w, h, passes = 3) => {
  const kernel = [1/16, 2/16, 1/16, 2/16, 4/16, 2/16, 1/16, 2/16, 1/16];
  for (let p = 0; p < passes; p++) {
    const imageData = ctx.getImageData(x, y, w, h);
    const src = new Uint8ClampedArray(imageData.data);
    const data = imageData.data;
    for (let iy = 1; iy < h - 1; iy++) {
      for (let ix = 1; ix < w - 1; ix++) {
        let r = 0, g = 0, b = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const ki = (ky + 1) * 3 + (kx + 1);
            const si = ((iy + ky) * w + (ix + kx)) * 4;
            r += kernel[ki] * src[si]; g += kernel[ki] * src[si+1]; b += kernel[ki] * src[si+2];
          }
        }
        const idx = (iy * w + ix) * 4;
        data[idx] = r; data[idx+1] = g; data[idx+2] = b;
      }
    }
    ctx.putImageData(imageData, x, y);
  }
};

// Sobel edge detection → white edges on black (ControlNet Canny conditioning map)
const applyEdge = (ctx, x, y, w, h) => {
  const imageData = ctx.getImageData(x, y, w, h);
  const src = new Uint8ClampedArray(imageData.data);
  const data = imageData.data;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = 0.299*src[i*4] + 0.587*src[i*4+1] + 0.114*src[i*4+2];
  for (let iy = 1; iy < h - 1; iy++) {
    for (let ix = 1; ix < w - 1; ix++) {
      const gx = -gray[(iy-1)*w+(ix-1)] + gray[(iy-1)*w+(ix+1)]
               - 2*gray[iy*w+(ix-1)] + 2*gray[iy*w+(ix+1)]
               - gray[(iy+1)*w+(ix-1)] + gray[(iy+1)*w+(ix+1)];
      const gy = -gray[(iy-1)*w+(ix-1)] - 2*gray[(iy-1)*w+ix] - gray[(iy-1)*w+(ix+1)]
               + gray[(iy+1)*w+(ix-1)] + 2*gray[(iy+1)*w+ix] + gray[(iy+1)*w+(ix+1)];
      const mag = Math.min(255, Math.sqrt(gx*gx + gy*gy) * 2);
      const idx = (iy * w + ix) * 4;
      data[idx] = data[idx+1] = data[idx+2] = mag;
    }
  }
  ctx.putImageData(imageData, x, y);
};

// RGB surface-normal / emboss effect (ControlNet Normal map proxy)
const applyEmboss = (ctx, x, y, w, h) => {
  const imageData = ctx.getImageData(x, y, w, h);
  const src = new Uint8ClampedArray(imageData.data);
  const data = imageData.data;
  const kx = [-1,0,1,-2,0,2,-1,0,1]; // Sobel X
  const ky = [-1,-2,-1,0,0,0,1,2,1]; // Sobel Y
  for (let iy = 1; iy < h - 1; iy++) {
    for (let ix = 1; ix < w - 1; ix++) {
      let gx = 0, gy = 0;
      for (let i = 0; i < 9; i++) {
        const dx = (i%3)-1, dy = Math.floor(i/3)-1;
        const si = ((iy+dy)*w+(ix+dx))*4;
        const lum = 0.299*src[si] + 0.587*src[si+1] + 0.114*src[si+2];
        gx += kx[i]*lum; gy += ky[i]*lum;
      }
      const idx = (iy*w+ix)*4;
      data[idx]   = Math.max(0, Math.min(255, gx/4 + 128)); // R = X normal
      data[idx+1] = Math.max(0, Math.min(255, gy/4 + 128)); // G = Y normal
      data[idx+2] = 200; // B = Z normal (mostly pointing out)
    }
  }
  ctx.putImageData(imageData, x, y);
};

// Luminance depth approximation: bright = close, dark = far (depth map heuristic)
const applyDepth = (ctx, x, y, w, h) => {
  const imageData = ctx.getImageData(x, y, w, h);
  const data = imageData.data;
  for (let i = 0; i < w*h; i++) {
    const lum = 0.299*data[i*4] + 0.587*data[i*4+1] + 0.114*data[i*4+2];
    data[i*4] = data[i*4+1] = data[i*4+2] = 255 - lum; // invert: dark=far
  }
  ctx.putImageData(imageData, x, y);
  // Blur for smooth depth field
  applyBlur(ctx, x, y, w, h, 4);
  // Vignette: edges farther
  const d2 = ctx.getImageData(x, y, w, h);
  for (let iy = 0; iy < h; iy++) {
    for (let ix = 0; ix < w; ix++) {
      const dx = (ix/w-0.5)*2, dy = (iy/h-0.5)*2;
      const v = Math.max(0, 1 - (dx*dx+dy*dy)*0.4);
      const idx = (iy*w+ix)*4;
      d2.data[idx] = Math.round(d2.data[idx]*v);
      d2.data[idx+1] = Math.round(d2.data[idx+1]*v);
      d2.data[idx+2] = Math.round(d2.data[idx+2]*v);
    }
  }
  ctx.putImageData(d2, x, y);
};

// ─── MAGIC WAND UTILITIES ────────────────────────────────────────────────────

// BFS flood-fill from (seedX, seedY) on RGBA pixel buffer, returns Uint8Array mask
function floodFill(pixels, w, h, seedX, seedY, tolerance) {
  const mask = new Uint8Array(w * h);
  const si = (seedY * w + seedX) * 4;
  const sr = pixels[si], sg = pixels[si+1], sb = pixels[si+2];
  const queue = [seedY * w + seedX];
  mask[seedY * w + seedX] = 1;
  while (queue.length) {
    const idx = queue.shift();
    const px = idx % w, py = Math.floor(idx / w);
    for (const [nx, ny] of [[px-1,py],[px+1,py],[px,py-1],[px,py+1]]) {
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const ni = ny * w + nx;
      if (mask[ni]) continue;
      const pi = ni * 4;
      const dr = pixels[pi]-sr, dg = pixels[pi+1]-sg, db = pixels[pi+2]-sb;
      if (Math.sqrt(dr*dr+dg*dg+db*db) <= tolerance) { mask[ni] = 1; queue.push(ni); }
    }
  }
  return mask;
}

// Trace the outer boundary of a boolean mask as a clockwise polygon (simplified)
function traceSelectionBoundary(mask, w, h, step = 5) {
  const points = [];
  // Find bounding box
  let minX=w, minY=h, maxX=0, maxY=0;
  for (let y=0; y<h; y++) for (let x=0; x<w; x++) {
    if (mask[y*w+x]) { minX=Math.min(minX,x); minY=Math.min(minY,y); maxX=Math.max(maxX,x); maxY=Math.max(maxY,y); }
  }
  // Top edge: leftmost filled pixel per column
  for (let x=minX; x<=maxX; x+=step) {
    for (let y=minY; y<=maxY; y++) { if (mask[y*w+x]) { points.push({x,y}); break; } }
  }
  // Right edge: topmost filled pixel per row (right side)
  for (let y=minY; y<=maxY; y+=step) {
    for (let x=maxX; x>=minX; x--) { if (mask[y*w+x]) { points.push({x,y}); break; } }
  }
  // Bottom edge: rightmost column, reversed
  for (let x=maxX; x>=minX; x-=step) {
    for (let y=maxY; y>=minY; y--) { if (mask[y*w+x]) { points.push({x,y}); break; } }
  }
  // Left edge: bottom to top
  for (let y=maxY; y>=minY; y-=step) {
    for (let x=minX; x<=maxX; x++) { if (mask[y*w+x]) { points.push({x,y}); break; } }
  }
  return points;
}

// ═══════════════════════════════════════════════════════════════
// STORAGE
// ═══════════════════════════════════════════════════════════════

const saveState = async (layers, canvasSize, drawingPaths) => {
  try {
    const state = { canvasSize, drawingPaths, layers: layers.map(l => ({
      id: l.id, name: l.name, visible: l.visible, locked: l.locked, opacity: l.opacity,
      blendMode: l.blendMode, x: l.x, y: l.y, scaleX: l.scaleX, scaleY: l.scaleY,
      rotation: l.rotation, imageData: l.imageData, clipPath: l.clipPath,
    })), savedAt: new Date().toISOString() };
    await window.storage.set("collage:current", JSON.stringify(state));
    return true;
  } catch (e) { console.error("Save failed:", e); return false; }
};

const loadState = async () => {
  try { const r = await window.storage.get("collage:current"); return r ? JSON.parse(r.value) : null; } catch { return null; }
};

let idCounter = Date.now();
const uid = () => `layer_${idCounter++}`;

// ═══════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════

export default function CollageWorkspace() {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const fileInputRef = useRef(null);
  const rdCanvasRef = useRef(null);
  const rdRef = useRef(null);
  const animFrameRef = useRef(null);
  const dreamSrcPixelsRef = useRef(null); // source image data for warp mode
  const dreamSrcSizeRef = useRef(null);   // { w, h } of source image

  // ─── UNDO/REDO ───
  const historyRef = useRef([]);
  const historyIndexRef = useRef(-1);
  const skipHistoryRef = useRef(false);
  const MAX_HISTORY = 50;

  const [layers, setLayers] = useState([]);
  const [selectedLayerId, setSelectedLayerId] = useState(null);
  const [tool, setTool] = useState(TOOLS.SELECT);
  const [brushSize, setBrushSize] = useState(3);
  const [brushColor, setBrushColor] = useState("#ff3366");
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState(null);
  const [lassoPoints, setLassoPoints] = useState([]);
  const [isLassoing, setIsLassoing] = useState(false);
const [saveStatus, setSaveStatus] = useState("");
  const [drawingPaths, setDrawingPaths] = useState([]);
  const [currentPath, setCurrentPath] = useState(null);
  const [canvasSize] = useState({ width: 1200, height: 800 });
  const [showWelcome, setShowWelcome] = useState(true);
  const [loaded, setLoaded] = useState(false);

  // Dream mode
  const [dreamActive, setDreamActive] = useState(false);
  const [dreamRunning, setDreamRunning] = useState(false);
  const [dreamPreset, setDreamPreset] = useState("coral");
  const [dreamColormap, setDreamColormap] = useState("organic");
  const [dreamSpeed, setDreamSpeed] = useState(8);
  const [dreamSeedMode, setDreamSeedMode] = useState("random");
  const [dreamIterations, setDreamIterations] = useState(0);
  const [dreamRegion, setDreamRegion] = useState(null);
  const [dreamPaintPoints, setDreamPaintPoints] = useState([]);
  const [isDreamPainting, setIsDreamPainting] = useState(false);
  const [dreamRes, setDreamRes] = useState(200);
  const [dreamSeedLayerId, setDreamSeedLayerId] = useState(null);
  const [dreamWarpStrength, setDreamWarpStrength] = useState(15);

  // Magic Wand
  const [wandTolerance, setWandTolerance] = useState(30);
  const [wandSelection, setWandSelection] = useState(null); // { mask, imgW, imgH, layerId }
  const wandMaskCanvasRef = useRef(null); // offscreen canvas for wand overlay

  // SAM2 / SAM Segment
  const [samStatus, setSamStatus] = useState("idle"); // idle | loading | embedding | ready | segmenting | error
  const [samMask, setSamMask] = useState(null); // Uint8Array boolean mask
  const [samMaskDims, setSamMaskDims] = useState(null); // { w, h, layerId }
  const [sam2Available, setSam2Available] = useState(false); // SAM2 CUDA server running
  const samModelRef = useRef(null);         // browser SAM fallback model
  const samProcessorRef = useRef(null);     // browser SAM fallback processor
  const samEmbeddingRef = useRef(null);     // browser SAM cached embedding
  const samEmbedLayerIdRef = useRef(null);  // browser SAM: which layer was embedded
  const sam2SessionRef = useRef(null);      // SAM2 server: { sessionId, layerId }
  const samMaskCanvasRef = useRef(null);    // offscreen canvas for SAM mask overlay

  // Polygon Region tool (for ComfyUI inpainting)
  const [regionPoints, setRegionPoints] = useState([]);    // [{x,y}] canvas coords
  const [regionClosed, setRegionClosed] = useState(false);
  const [regionMousePos, setRegionMousePos] = useState(null); // live cursor while drawing
  const lastRegionClickRef = useRef(0); // ms timestamp of last click (double-click detect)
  const clearRegion = useCallback(() => {
    setRegionPoints([]); setRegionClosed(false); setRegionMousePos(null);
    lastRegionClickRef.current = 0;
  }, []);

  // ComfyUI inpaint panel
  const [comfyUrl, setComfyUrl] = useState("/api/comfyui");
  const [comfyWorkflow, setComfyWorkflow] = useState("sd15-inpaint");
  const [comfyPrompt, setComfyPrompt] = useState("");
  const [comfyNegPrompt, setComfyNegPrompt] = useState("blurry, low quality, watermark");
  const [comfyDenoise, setComfyDenoise] = useState(0.75);
  const [comfySteps, setComfySteps] = useState(8);
  const [comfyInputSource, setComfyInputSource] = useState("selected-layer");
  const [comfyUploadImage, setComfyUploadImage] = useState(null);   // { name, dataUrl }
  const [comfyStatus, setComfyStatus] = useState("idle"); // idle | running | done | error:...
  const [comfyResult, setComfyResult] = useState(null);           // base64 result image
  const [comfyResultBounds, setComfyResultBounds] = useState(null); // {x,y,scaleX,scaleY,rotation,name}

  // Load state
  useEffect(() => {
    (async () => {
      const state = await loadState();
      if (state?.layers?.length > 0) {
        setLayers(state.layers);
        setSelectedLayerId(state.layers[0].id);
        if (state.drawingPaths) setDrawingPaths(state.drawingPaths);
        setShowWelcome(false);
      }
      setLoaded(true);
    })();
  }, []);

  // Autosave
  useEffect(() => {
    if (!loaded || layers.length === 0) return;
    const timer = setTimeout(async () => {
      const ok = await saveState(layers, canvasSize, drawingPaths);
      if (ok) { setSaveStatus("saved"); setTimeout(() => setSaveStatus(""), 2000); }
    }, 3000);
    return () => clearTimeout(timer);
  }, [layers, loaded, canvasSize, drawingPaths]);

  // ─── HISTORY (undo/redo) ───
  const pushHistory = useCallback((snapshotLayers, snapshotPaths) => {
    const history = historyRef.current;
    const idx = historyIndexRef.current;
    // Truncate any forward history
    history.length = idx + 1;
    history.push({ layers: JSON.parse(JSON.stringify(snapshotLayers)), drawingPaths: JSON.parse(JSON.stringify(snapshotPaths)) });
    if (history.length > MAX_HISTORY) history.shift();
    historyIndexRef.current = history.length - 1;
  }, []);

  // Track changes — push history whenever layers or drawingPaths change meaningfully
  const prevLayersRef = useRef(null);
  const prevPathsRef = useRef(null);
  useEffect(() => {
    if (!loaded) return;
    if (skipHistoryRef.current) { skipHistoryRef.current = false; return; }
    // Skip intermediate drag states
    if (isDragging || isLassoing || currentPath) return;
    const layersJson = JSON.stringify(layers);
    const pathsJson = JSON.stringify(drawingPaths);
    if (layersJson === prevLayersRef.current && pathsJson === prevPathsRef.current) return;
    prevLayersRef.current = layersJson;
    prevPathsRef.current = pathsJson;
    pushHistory(layers, drawingPaths);
  }, [layers, drawingPaths, loaded, isDragging, isLassoing, currentPath, pushHistory]);

  const undo = useCallback(() => {
    const history = historyRef.current;
    const idx = historyIndexRef.current;
    if (idx <= 0) return;
    historyIndexRef.current = idx - 1;
    const snapshot = history[idx - 1];
    skipHistoryRef.current = true;
    setLayers(JSON.parse(JSON.stringify(snapshot.layers)));
    setDrawingPaths(JSON.parse(JSON.stringify(snapshot.drawingPaths)));
  }, []);

  const redo = useCallback(() => {
    const history = historyRef.current;
    const idx = historyIndexRef.current;
    if (idx >= history.length - 1) return;
    historyIndexRef.current = idx + 1;
    const snapshot = history[idx + 1];
    skipHistoryRef.current = true;
    setLayers(JSON.parse(JSON.stringify(snapshot.layers)));
    setDrawingPaths(JSON.parse(JSON.stringify(snapshot.drawingPaths)));
  }, []);

  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Sidebar tab state: "tools" | "ai" | "fx" | "file" | null (collapsed)
  const [sideTab, setSideTab] = useState("tools");
  const toggleTab = (tab) => setSideTab(prev => prev === tab ? null : tab);
  useEffect(() => {
    setCanUndo(historyIndexRef.current > 0);
    setCanRedo(historyIndexRef.current < historyRef.current.length - 1);
  }, [layers, drawingPaths]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && e.shiftKey) { e.preventDefault(); redo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); redo(); }
      if (e.key === 'Escape') {
        if (regionPoints.length > 0) clearRegion();
      }
      if (e.key === 'Enter' && tool === TOOLS.REGION && !regionClosed && regionPoints.length >= 3) {
        setRegionClosed(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo, regionPoints, clearRegion, tool, regionClosed]);

  // Auto-open the AI tab when switching to AI-powered tools
  useEffect(() => {
    if (tool === TOOLS.SEGMENT || tool === TOOLS.REGION || tool === TOOLS.WAND) {
      setSideTab("ai");
    }
  }, [tool]);

  // ─── SAM2 server health check ───
  // Runs whenever the user switches to SEGMENT tool
  useEffect(() => {
    if (tool !== TOOLS.SEGMENT && tool !== TOOLS.REGION) return;
    (async () => {
      try {
        const r = await fetch(`${SAM2_URL}/health`, { signal: AbortSignal.timeout(1200) });
        if (!r.ok) { setSam2Available(false); return; }
        const data = await r.json();
        setSam2Available(data.ok === true);
      } catch {
        setSam2Available(false);
      }
    })();
  }, [tool]);

  // ─── RENDER ───
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const sz = 16;
    for (let y = 0; y < canvas.height; y += sz) {
      for (let x = 0; x < canvas.width; x += sz) {
        ctx.fillStyle = ((x / sz + y / sz) % 2 === 0) ? "#1a1a2e" : "#16162a";
        ctx.fillRect(x, y, sz, sz);
      }
    }

    const sortedLayers = [...layers].reverse();
    for (const layer of sortedLayers) {
      if (!layer.visible || !layer.imageData) continue;
      ctx.save();
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = layer.blendMode || "source-over";
      const img = new Image(); img.src = layer.imageData;
      ctx.translate(layer.x + (img.width * layer.scaleX) / 2, layer.y + (img.height * layer.scaleY) / 2);
      ctx.rotate((layer.rotation * Math.PI) / 180);
      ctx.translate(-(img.width * layer.scaleX) / 2, -(img.height * layer.scaleY) / 2);
      if (layer.clipPath?.length > 2) {
        ctx.beginPath();
        ctx.moveTo(layer.clipPath[0].x - layer.x, layer.clipPath[0].y - layer.y);
        for (let i = 1; i < layer.clipPath.length; i++) ctx.lineTo(layer.clipPath[i].x - layer.x, layer.clipPath[i].y - layer.y);
        ctx.closePath(); ctx.clip();
      }
      ctx.drawImage(img, 0, 0, img.width * layer.scaleX, img.height * layer.scaleY);
      ctx.restore();
    }

    for (const path of drawingPaths) {
      if (path.points.length < 2) continue;
      ctx.save(); ctx.strokeStyle = path.color; ctx.lineWidth = path.size; ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.beginPath(); ctx.moveTo(path.points[0].x, path.points[0].y);
      for (let i = 1; i < path.points.length; i++) ctx.lineTo(path.points[i].x, path.points[i].y);
      ctx.stroke(); ctx.restore();
    }

    // Selection box
    const selected = layers.find(l => l.id === selectedLayerId);
    if (selected?.imageData && tool === TOOLS.SELECT) {
      ctx.save(); ctx.strokeStyle = "#ff3366"; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
      const img = new Image(); img.src = selected.imageData;
      ctx.strokeRect(selected.x - 2, selected.y - 2, img.width * selected.scaleX + 4, img.height * selected.scaleY + 4);
      ctx.setLineDash([]); ctx.fillStyle = "#ff3366";
      [[selected.x, selected.y], [selected.x + img.width * selected.scaleX, selected.y],
       [selected.x, selected.y + img.height * selected.scaleY],
       [selected.x + img.width * selected.scaleX, selected.y + img.height * selected.scaleY]
      ].forEach(([cx, cy]) => ctx.fillRect(cx - 4, cy - 4, 8, 8));
      ctx.restore();
    }

    // Lasso
    if (isLassoing && lassoPoints.length > 1) {
      ctx.save(); ctx.strokeStyle = "#00ff88"; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
      for (let i = 1; i < lassoPoints.length; i++) ctx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
      ctx.stroke(); ctx.restore();
    }

    // Dream overlay
    if (tool === TOOLS.DREAM && dreamRegion) {
      if (dreamActive && rdCanvasRef.current) {
        ctx.save(); ctx.globalAlpha = 0.92;
        ctx.drawImage(rdCanvasRef.current, dreamRegion.x, dreamRegion.y, dreamRegion.w, dreamRegion.h);
        const pulse = Math.sin(Date.now() / 300) * 0.3 + 0.7;
        ctx.globalAlpha = pulse; ctx.strokeStyle = "#00ff88"; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
        ctx.strokeRect(dreamRegion.x, dreamRegion.y, dreamRegion.w, dreamRegion.h);
        ctx.restore();
      } else if (!dreamActive) {
        ctx.save(); ctx.strokeStyle = "#00ff8888"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
        ctx.strokeRect(dreamRegion.x, dreamRegion.y, dreamRegion.w, dreamRegion.h);
        ctx.restore();
      }
    }

    // Paint seed points
    if (tool === TOOLS.DREAM && !dreamActive && dreamPaintPoints.length > 0) {
      ctx.save(); ctx.fillStyle = "#00ff8866";
      for (const pt of dreamPaintPoints) { ctx.beginPath(); ctx.arc(pt.x, pt.y, 6, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    }

    // Magic Wand selection overlay
    if (tool === TOOLS.WAND && wandSelection) {
      const layer = layers.find(l => l.id === wandSelection.layerId);
      if (layer) {
        const { mask, imgW, imgH } = wandSelection;
        // Build overlay canvas if needed
        if (!wandMaskCanvasRef.current ||
            wandMaskCanvasRef.current.width !== imgW ||
            wandMaskCanvasRef.current.height !== imgH) {
          wandMaskCanvasRef.current = document.createElement("canvas");
          wandMaskCanvasRef.current.width = imgW;
          wandMaskCanvasRef.current.height = imgH;
        }
        const mc = wandMaskCanvasRef.current;
        const mCtx = mc.getContext("2d");
        const mData = mCtx.createImageData(imgW, imgH);
        for (let i = 0; i < mask.length; i++) {
          if (mask[i]) { mData.data[i*4]=100; mData.data[i*4+1]=220; mData.data[i*4+2]=255; mData.data[i*4+3]=120; }
        }
        mCtx.putImageData(mData, 0, 0);
        ctx.save();
        ctx.globalAlpha = 0.7;
        ctx.drawImage(mc, layer.x, layer.y, imgW * layer.scaleX, imgH * layer.scaleY);
        ctx.restore();
      }
    }

    // SAM mask overlay
    if (tool === TOOLS.SEGMENT && samMask && samMaskDims) {
      const layer = layers.find(l => l.id === samMaskDims.layerId);
      if (layer) {
        const { w: mw, h: mh } = samMaskDims;
        if (!samMaskCanvasRef.current ||
            samMaskCanvasRef.current.width !== mw ||
            samMaskCanvasRef.current.height !== mh) {
          samMaskCanvasRef.current = document.createElement("canvas");
          samMaskCanvasRef.current.width = mw;
          samMaskCanvasRef.current.height = mh;
        }
        const mc = samMaskCanvasRef.current;
        const mCtx = mc.getContext("2d");
        const mData = mCtx.createImageData(mw, mh);
        for (let i = 0; i < samMask.length; i++) {
          if (samMask[i]) { mData.data[i*4]=255; mData.data[i*4+1]=80; mData.data[i*4+2]=180; mData.data[i*4+3]=130; }
        }
        mCtx.putImageData(mData, 0, 0);
        ctx.save();
        ctx.globalAlpha = 0.75;
        ctx.drawImage(mc, layer.x, layer.y, mw * layer.scaleX, mh * layer.scaleY);
        ctx.restore();
      }
    }
    // Region polygon overlay
    if (tool === TOOLS.REGION && regionPoints.length > 0) {
      ctx.save();
      ctx.strokeStyle = "#f97316"; // orange
      ctx.fillStyle = "rgba(249,115,22,0.12)";
      ctx.lineWidth = 2;
      ctx.setLineDash(regionClosed ? [] : [5, 4]);
      ctx.beginPath();
      ctx.moveTo(regionPoints[0].x, regionPoints[0].y);
      for (let i = 1; i < regionPoints.length; i++) ctx.lineTo(regionPoints[i].x, regionPoints[i].y);
      if (regionClosed) {
        ctx.closePath();
        ctx.fill();
      } else if (regionMousePos) {
        ctx.lineTo(regionMousePos.x, regionMousePos.y);
      }
      ctx.stroke();
      // Vertex dots
      ctx.setLineDash([]);
      ctx.fillStyle = "#f97316";
      for (let i = 0; i < regionPoints.length; i++) {
        const isFirst = i === 0;
        ctx.beginPath();
        ctx.arc(regionPoints[i].x, regionPoints[i].y, isFirst ? 6 : 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }, [layers, selectedLayerId, tool, drawingPaths, isLassoing, lassoPoints, dreamActive, dreamRegion, dreamPaintPoints, wandSelection, samMask, samMaskDims, regionPoints, regionClosed, regionMousePos]);

  useEffect(() => {
    const loads = layers.filter(l => l.imageData).map(l =>
      new Promise(res => { const img = new Image(); img.onload = res; img.onerror = res; img.src = l.imageData; })
    );
    Promise.all(loads).then(render);
  }, [render, layers]);
  useEffect(() => { render(); }, [render]);

  // ─── DREAM ANIMATION LOOP ───
  useEffect(() => {
    if (!dreamRunning || !rdRef.current || !rdCanvasRef.current) return;
    let running = true;
    const rd = rdRef.current;
    const rdCanvas = rdCanvasRef.current;
    const rdCtx = rdCanvas.getContext("2d");
    const animate = () => {
      if (!running) return;
      rd.stepN(dreamSpeed);
      const imageData = rdCtx.createImageData(rd.w, rd.h);
      if (dreamColormap === "warp" && dreamSrcPixelsRef.current) {
        rd.renderWarp(imageData, dreamSrcPixelsRef.current, dreamSrcSizeRef.current.w, dreamSrcSizeRef.current.h, dreamWarpStrength);
      } else {
        rd.render(imageData, dreamColormap);
      }
      rdCtx.putImageData(imageData, 0, 0);
      setDreamIterations(rd.iterations);
      render();
      animFrameRef.current = requestAnimationFrame(animate);
    };
    animFrameRef.current = requestAnimationFrame(animate);
    return () => { running = false; if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current); };
  }, [dreamRunning, dreamSpeed, dreamColormap, dreamWarpStrength, render]);

  // ─── DREAM CONTROLS ───
  const finishInit = (rd, rdW, rdH) => {
    rdRef.current = rd;
    const offscreen = document.createElement("canvas");
    offscreen.width = rdW; offscreen.height = rdH;
    rdCanvasRef.current = offscreen;
    setDreamActive(true); setDreamRunning(true); setDreamIterations(0);
  };

  const initDream = () => {
    if (!dreamRegion || dreamRegion.w < 10) return;
    const preset = RD_PRESETS[dreamPreset];
    const aspect = dreamRegion.w / dreamRegion.h;
    const rdW = dreamRes;
    const rdH = Math.max(10, Math.round(dreamRes / aspect));
    const rd = new ReactionDiffusion(rdW, rdH);
    rd.setParams(preset.f, preset.k, preset.Du, preset.Dv);

    if (dreamSeedMode === "image") {
      const seedLayer = dreamSeedLayerId ? layers.find(l => l.id === dreamSeedLayerId) : null;
      const seedLayers = seedLayer ? [seedLayer] : [...layers].reverse().filter(l => l.visible && l.imageData);
      if (seedLayers.length > 0) {
        const loadPromises = seedLayers.map(l => new Promise(res => {
          const im = new Image(); im.onload = () => res({ layer: l, img: im }); im.onerror = () => res(null); im.src = l.imageData;
        }));
        Promise.all(loadPromises).then(results => {
          const tc = document.createElement("canvas"); tc.width = Math.round(dreamRegion.w); tc.height = Math.round(dreamRegion.h);
          const tctx = tc.getContext("2d");
          for (const r of results) {
            if (!r) continue;
            const { layer, img } = r;
            tctx.save();
            tctx.globalAlpha = layer.opacity;
            tctx.globalCompositeOperation = layer.blendMode || "source-over";
            // Translate so dream region origin is 0,0
            tctx.translate(-dreamRegion.x, -dreamRegion.y);
            tctx.translate(layer.x + (img.width * layer.scaleX) / 2, layer.y + (img.height * layer.scaleY) / 2);
            tctx.rotate((layer.rotation * Math.PI) / 180);
            tctx.translate(-(img.width * layer.scaleX) / 2, -(img.height * layer.scaleY) / 2);
            if (layer.clipPath?.length > 2) {
              tctx.beginPath();
              tctx.moveTo(layer.clipPath[0].x - layer.x, layer.clipPath[0].y - layer.y);
              for (let i = 1; i < layer.clipPath.length; i++) tctx.lineTo(layer.clipPath[i].x - layer.x, layer.clipPath[i].y - layer.y);
              tctx.closePath(); tctx.clip();
            }
            tctx.drawImage(img, 0, 0, img.width * layer.scaleX, img.height * layer.scaleY);
            tctx.restore();
          }
          const pd = tctx.getImageData(0, 0, tc.width, tc.height);
          // Store source pixels for warp mode
          dreamSrcPixelsRef.current = new Uint8ClampedArray(pd.data);
          dreamSrcSizeRef.current = { w: tc.width, h: tc.height };
          rd.seedFromImage(pd.data, tc.width, tc.height);
          finishInit(rd, rdW, rdH);
        });
        return;
      }
    }
    if (dreamSeedMode === "paint" && dreamPaintPoints.length > 0) {
      for (const pt of dreamPaintPoints) {
        const rx = Math.floor(((pt.x - dreamRegion.x) / dreamRegion.w) * rdW);
        const ry = Math.floor(((pt.y - dreamRegion.y) / dreamRegion.h) * rdH);
        rd.seed(rx, ry, 4);
      }
    } else { rd.seedRandom(15); }
    finishInit(rd, rdW, rdH);
  };

  const pauseDream = () => setDreamRunning(false);
  const resumeDream = () => { if (dreamActive) setDreamRunning(true); };

  const freezeDream = () => {
    if (!rdCanvasRef.current || !dreamRegion) return;
    setDreamRunning(false);
    const oc = document.createElement("canvas");
    oc.width = Math.round(dreamRegion.w); oc.height = Math.round(dreamRegion.h);
    const octx = oc.getContext("2d"); octx.imageSmoothingEnabled = true;
    octx.drawImage(rdCanvasRef.current, 0, 0, oc.width, oc.height);
    const newLayer = {
      id: uid(), name: `Dream:${RD_PRESETS[dreamPreset].name}`, visible: true, locked: false,
      opacity: 1, blendMode: "source-over", x: dreamRegion.x, y: dreamRegion.y,
      scaleX: 1, scaleY: 1, rotation: 0, imageData: oc.toDataURL(), clipPath: null,
    };
    setLayers(prev => [newLayer, ...prev]);
    setSelectedLayerId(newLayer.id);
    resetDream();
  };

  const resetDream = () => {
    setDreamRunning(false); setDreamActive(false); setDreamIterations(0);
    rdRef.current = null; rdCanvasRef.current = null; setDreamPaintPoints([]);
    dreamSrcPixelsRef.current = null; dreamSrcSizeRef.current = null;
  };

  const pokeDream = (cx, cy) => {
    if (!rdRef.current || !dreamRegion) return;
    const rd = rdRef.current;
    rd.seed(Math.floor(((cx - dreamRegion.x) / dreamRegion.w) * rd.w),
            Math.floor(((cy - dreamRegion.y) / dreamRegion.h) * rd.h), 5 + Math.floor(Math.random() * 5));
  };

  // ─── MOUSE ───
  const getCanvasPos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / zoom - panOffset.x, y: (e.clientY - rect.top) / zoom - panOffset.y };
  };

  const addImageLayer = useCallback((dataUrl, name = "Untitled") => {
    const img = new Image();
    img.onload = () => {
      let scale = 1;
      if (img.width > canvasSize.width * 0.8) scale = (canvasSize.width * 0.6) / img.width;
      if (img.height * scale > canvasSize.height * 0.8) scale = (canvasSize.height * 0.6) / img.height;
      const nl = {
        id: uid(), name: name.substring(0, 24), visible: true, locked: false, opacity: 1, blendMode: "source-over",
        x: canvasSize.width / 2 - (img.width * scale) / 2, y: canvasSize.height / 2 - (img.height * scale) / 2,
        scaleX: scale, scaleY: scale, rotation: 0, imageData: dataUrl, clipPath: null,
      };
      setLayers(prev => [nl, ...prev]); setSelectedLayerId(nl.id); setShowWelcome(false);
    };
    img.src = dataUrl;
  }, [canvasSize]);

  const handleFiles = (files) => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const reader = new FileReader();
      reader.onload = (e) => addImageLayer(e.target.result, file.name);
      reader.readAsDataURL(file);
    }
  };

  useEffect(() => {
    const handler = (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          const reader = new FileReader();
          reader.onload = (ev) => addImageLayer(ev.target.result, "Pasted");
          reader.readAsDataURL(file);
        }
      }
    };
    window.addEventListener("paste", handler);
    return () => window.removeEventListener("paste", handler);
  }, [addImageLayer]);

  const handleMouseDown = (e) => {
    if (e.button === 1 || (e.button === 0 && tool === TOOLS.PAN)) {
      setIsDragging(true); setDragStart({ x: e.clientX - panOffset.x * zoom, y: e.clientY - panOffset.y * zoom }); return;
    }
    const pos = getCanvasPos(e);

    if (tool === TOOLS.DREAM) {
      if (dreamActive && dreamRegion && pos.x >= dreamRegion.x && pos.x <= dreamRegion.x + dreamRegion.w &&
          pos.y >= dreamRegion.y && pos.y <= dreamRegion.y + dreamRegion.h) {
        pokeDream(pos.x, pos.y); return;
      }
      if (!dreamActive) {
        if (dreamSeedMode === "paint") { setIsDreamPainting(true); setDreamPaintPoints(prev => [...prev, pos]); return; }
        setIsDragging(true); setDragStart(pos); setDreamRegion({ x: pos.x, y: pos.y, w: 1, h: 1 }); return;
      }
      return;
    }
    if (tool === TOOLS.LASSO) { setIsLassoing(true); setLassoPoints([pos]); return; }
    if (tool === TOOLS.DRAW) { setCurrentPath({ points: [pos], color: brushColor, size: brushSize }); return; }
    if (tool === TOOLS.WAND) { doWandSelect(pos.x, pos.y); return; }
    if (tool === TOOLS.SEGMENT) { doSAMClick(pos.x, pos.y); return; }
    if (tool === TOOLS.REGION && !regionClosed) {
      const now = Date.now();
      // Double-click within 300ms → close polygon
      if (now - lastRegionClickRef.current < 300 && regionPoints.length >= 3) {
        setRegionClosed(true); return;
      }
      lastRegionClickRef.current = now;
      // Click near first point → close polygon
      if (regionPoints.length >= 3) {
        const first = regionPoints[0];
        if (Math.hypot(pos.x - first.x, pos.y - first.y) < 14 / zoom) {
          setRegionClosed(true); return;
        }
      }
      setRegionPoints(prev => [...prev, pos]);
      return;
    }
    if (tool === TOOLS.SELECT) {
      for (const layer of layers) {
        if (!layer.visible || layer.locked || !layer.imageData) continue;
        const img = new Image(); img.src = layer.imageData;
        const w = img.width * layer.scaleX, h = img.height * layer.scaleY;
        if (pos.x >= layer.x && pos.x <= layer.x + w && pos.y >= layer.y && pos.y <= layer.y + h) {
          setSelectedLayerId(layer.id); setIsDragging(true); setDragStart({ x: pos.x - layer.x, y: pos.y - layer.y }); return;
        }
      }
    }
  };

  const handleMouseMove = (e) => {
    if (tool === TOOLS.PAN && isDragging && dragStart) {
      setPanOffset({ x: (e.clientX - dragStart.x) / zoom, y: (e.clientY - dragStart.y) / zoom }); return;
    }
    const pos = getCanvasPos(e);
    if (tool === TOOLS.DREAM && !dreamActive && isDragging && dragStart) {
      setDreamRegion({ x: Math.min(dragStart.x, pos.x), y: Math.min(dragStart.y, pos.y), w: Math.abs(pos.x - dragStart.x), h: Math.abs(pos.y - dragStart.y) });
      render(); return;
    }
    if (tool === TOOLS.DREAM && isDreamPainting) { setDreamPaintPoints(prev => [...prev, pos]); return; }
    if (tool === TOOLS.LASSO && isLassoing) { setLassoPoints(prev => [...prev, pos]); return; }
    if (tool === TOOLS.DRAW && currentPath) { setCurrentPath(prev => ({ ...prev, points: [...prev.points, pos] })); return; }
    if (tool === TOOLS.REGION && !regionClosed) { setRegionMousePos(pos); return; }
    if (tool === TOOLS.SELECT && isDragging && selectedLayerId && dragStart) {
      setLayers(prev => prev.map(l => l.id !== selectedLayerId || l.locked ? l : { ...l, x: pos.x - dragStart.x, y: pos.y - dragStart.y }));
    }
  };

  const handleMouseUp = () => {
    if (tool === TOOLS.DREAM && isDreamPainting) {
      setIsDreamPainting(false);
      if (dreamPaintPoints.length > 2 && (!dreamRegion || dreamRegion.w < 10)) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const pt of dreamPaintPoints) { minX = Math.min(minX, pt.x); minY = Math.min(minY, pt.y); maxX = Math.max(maxX, pt.x); maxY = Math.max(maxY, pt.y); }
        setDreamRegion({ x: minX - 40, y: minY - 40, w: maxX - minX + 80, h: maxY - minY + 80 });
      }
    }
    if (tool === TOOLS.DREAM && isDragging && !dreamActive) { setIsDragging(false); setDragStart(null); return; }
    if (tool === TOOLS.LASSO && isLassoing && lassoPoints.length > 4 && selectedLayerId) {
      setLayers(prev => prev.map(l => l.id !== selectedLayerId ? l : { ...l, clipPath: lassoPoints }));
      setIsLassoing(false); setLassoPoints([]); return;
    }
    if (tool === TOOLS.DRAW && currentPath?.points.length > 1) { setDrawingPaths(prev => [...prev, currentPath]); setCurrentPath(null); }
    setIsDragging(false); setDragStart(null); setIsLassoing(false);
  };

  const handleWheel = (e) => { e.preventDefault(); setZoom(prev => Math.max(0.1, Math.min(5, prev * (e.deltaY > 0 ? 0.9 : 1.1)))); };

  // ─── LAYER OPS ───
  const updateLayer = (id, u) => setLayers(prev => prev.map(l => l.id === id ? { ...l, ...u } : l));
  const deleteLayer = (id) => { setLayers(prev => prev.filter(l => l.id !== id)); if (selectedLayerId === id) setSelectedLayerId(null); };
  const moveLayer = (id, dir) => {
    setLayers(prev => { const i = prev.findIndex(l => l.id === id); if (i < 0) return prev; const t = dir === "up" ? i-1 : i+1; if (t < 0 || t >= prev.length) return prev; const n = [...prev]; [n[i],n[t]]=[n[t],n[i]]; return n; });
  };
  const duplicateLayer = (id) => {
    const l = layers.find(l => l.id === id); if (!l) return;
    const nl = { ...l, id: uid(), name: l.name + " copy", x: l.x + 20, y: l.y + 20 };
    setLayers(prev => [nl, ...prev]); setSelectedLayerId(nl.id);
  };

  // ─── EFFECTS ───
  const applyEffect = (fx) => {
    const layer = layers.find(l => l.id === selectedLayerId);
    if (!layer?.imageData) return;
    const img = new Image();
    img.onload = () => {
      const tc = document.createElement("canvas"); tc.width = img.width; tc.height = img.height;
      const tCtx = tc.getContext("2d"); tCtx.drawImage(img, 0, 0);
      switch (fx) {
        case "dither": applyDither(tCtx, 0, 0, img.width, img.height, 0.4); break;
        case "pixelsort": applyPixelSort(tCtx, 0, 0, img.width, img.height); break;
        case "invert": applyInvert(tCtx, 0, 0, img.width, img.height); break;
        case "posterize": applyPosterize(tCtx, 0, 0, img.width, img.height, 4); break;
        case "chromatic": applyChromatic(tCtx, 0, 0, img.width, img.height, 8); break;
        case "glitch": { const sh = Math.floor(img.height/20); for (let i=0;i<20;i++) { if (Math.random()>0.5) { const s=Math.floor((Math.random()-0.5)*40); tCtx.putImageData(tCtx.getImageData(0,i*sh,img.width,sh),s,i*sh); } } break; }
        case "threshold": { const d=tCtx.getImageData(0,0,img.width,img.height); const p=d.data; for(let i=0;i<p.length;i+=4){const a=(p[i]+p[i+1]+p[i+2])/3;const v=a>128?255:0;p[i]=p[i+1]=p[i+2]=v;} tCtx.putImageData(d,0,0); break; }
        case "halftone": { const d2=tCtx.getImageData(0,0,img.width,img.height); tCtx.fillStyle="#000"; tCtx.fillRect(0,0,img.width,img.height); const dot=6;
          for(let y=0;y<img.height;y+=dot) for(let x=0;x<img.width;x+=dot) { const i=(y*img.width+x)*4; const b=(d2.data[i]+d2.data[i+1]+d2.data[i+2])/3/255;
            tCtx.fillStyle=`rgb(${d2.data[i]},${d2.data[i+1]},${d2.data[i+2]})`; tCtx.beginPath(); tCtx.arc(x+dot/2,y+dot/2,b*dot/2,0,Math.PI*2); tCtx.fill(); } break; }
        case "blur": applyBlur(tCtx, 0, 0, img.width, img.height, 3); break;
        case "edge": applyEdge(tCtx, 0, 0, img.width, img.height); break;
        case "emboss": applyEmboss(tCtx, 0, 0, img.width, img.height); break;
        case "depth": applyDepth(tCtx, 0, 0, img.width, img.height); break;
      }
      updateLayer(selectedLayerId, { imageData: tc.toDataURL() });
    };
    img.src = layer.imageData;
  };

  const clearClip = () => { if (selectedLayerId) updateLayer(selectedLayerId, { clipPath: null }); };
  const exportCanvas = () => { const c = canvasRef.current; const a = document.createElement("a"); a.download = `collage_${Date.now()}.png`; a.href = c.toDataURL("image/png"); a.click(); };
  const clearAll = async () => { setLayers([]); setDrawingPaths([]); setSelectedLayerId(null); setShowWelcome(true); resetDream(); try { await window.storage.delete("collage:current"); } catch {} };

  // ─── MAGIC WAND ───────────────────────────────────────────────────────────
  const doWandSelect = useCallback((canvasX, canvasY) => {
    const layer = layers.find(l => l.id === selectedLayerId);
    if (!layer?.imageData) return;
    const img = new Image();
    img.onload = () => {
      const lx = Math.floor((canvasX - layer.x) / layer.scaleX);
      const ly = Math.floor((canvasY - layer.y) / layer.scaleY);
      if (lx < 0 || lx >= img.width || ly < 0 || ly >= img.height) return;
      const tc = document.createElement("canvas");
      tc.width = img.width; tc.height = img.height;
      const tCtx = tc.getContext("2d"); tCtx.drawImage(img, 0, 0);
      const pixels = tCtx.getImageData(0, 0, img.width, img.height).data;
      const mask = floodFill(pixels, img.width, img.height, lx, ly, wandTolerance);
      setWandSelection({ mask, imgW: img.width, imgH: img.height, layerId: layer.id });
    };
    img.src = layer.imageData;
  }, [layers, selectedLayerId, wandTolerance]);

  const wandExtract = useCallback(() => {
    if (!wandSelection) return;
    const layer = layers.find(l => l.id === wandSelection.layerId);
    if (!layer?.imageData) return;
    const img = new Image();
    img.onload = () => {
      const tc = document.createElement("canvas");
      tc.width = img.width; tc.height = img.height;
      const tCtx = tc.getContext("2d"); tCtx.drawImage(img, 0, 0);
      const imgData = tCtx.getImageData(0, 0, img.width, img.height);
      for (let i = 0; i < wandSelection.mask.length; i++) {
        if (!wandSelection.mask[i]) imgData.data[i*4+3] = 0;
      }
      tCtx.putImageData(imgData, 0, 0);
      const nl = { id: uid(), name: layer.name + " (wand)", visible: true, opacity: 1, blendMode: "source-over",
        x: layer.x, y: layer.y, scaleX: layer.scaleX, scaleY: layer.scaleY, rotation: layer.rotation,
        imageData: tc.toDataURL(), clipPath: null, locked: false };
      setLayers(prev => [nl, ...prev]); setSelectedLayerId(nl.id); setWandSelection(null);
    };
    img.src = layer.imageData;
  }, [wandSelection, layers]);

  const wandClip = useCallback(() => {
    if (!wandSelection) return;
    const { mask, imgW, imgH, layerId } = wandSelection;
    const layer = layers.find(l => l.id === layerId);
    if (!layer) return;
    const pts = traceSelectionBoundary(mask, imgW, imgH, 4);
    if (pts.length > 3) {
      const scaled = pts.map(p => ({ x: layer.x + p.x * layer.scaleX, y: layer.y + p.y * layer.scaleY }));
      updateLayer(layerId, { clipPath: scaled });
    }
    setWandSelection(null);
  }, [wandSelection, layers, updateLayer]);

  // ─── SAM2 / SAM SEGMENT ───────────────────────────────────────────────────
  /**
   * Prepare for segmentation.
   * Prefers the local SAM2 CUDA server; falls back to browser SAM (@xenova/transformers).
   */
  const loadSAM = useCallback(async () => {
    if (sam2Available) { setSamStatus("ready"); return true; }
    // Browser SAM fallback
    if (samModelRef.current) return true;
    setSamStatus("loading");
    try {
      const { SamModel, AutoProcessor } = await import('@xenova/transformers');
      samModelRef.current = await SamModel.from_pretrained('Xenova/sam-vit-base');
      samProcessorRef.current = await AutoProcessor.from_pretrained('Xenova/sam-vit-base');
      setSamStatus("ready");
      return true;
    } catch (e) {
      console.error("SAM load failed:", e);
      setSamStatus("error");
      return false;
    }
  }, [sam2Available]);

  const samEmbedLayer = useCallback(async (layer) => {
    // ── SAM2 server ──────────────────────────────────────────────────────────
    if (sam2Available) {
      if (sam2SessionRef.current?.layerId === layer.id) return true;
      setSamStatus("embedding");
      try {
        const r = await fetch(`${SAM2_URL}/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: layer.imageData }),
        });
        if (!r.ok) throw new Error(`SAM2 /embed ${r.status}`);
        const { session_id } = await r.json();
        sam2SessionRef.current = { sessionId: session_id, layerId: layer.id };
        setSamStatus("ready");
        return true;
      } catch (e) {
        console.error("SAM2 embed failed:", e);
        setSamStatus("error");
        return false;
      }
    }
    // ── Browser SAM fallback ─────────────────────────────────────────────────
    if (!samModelRef.current || !samProcessorRef.current) return false;
    if (samEmbedLayerIdRef.current === layer.id && samEmbeddingRef.current) return true;
    setSamStatus("embedding");
    try {
      const { RawImage } = await import('@xenova/transformers');
      const image = await RawImage.fromURL(layer.imageData);
      const inputs = await samProcessorRef.current(image);
      const { image_embeddings } = await samModelRef.current.get_image_embeddings(inputs);
      samEmbeddingRef.current = { inputs, image_embeddings };
      samEmbedLayerIdRef.current = layer.id;
      setSamStatus("ready");
      return true;
    } catch (e) {
      console.error("SAM embed failed:", e);
      setSamStatus("error");
      return false;
    }
  }, [sam2Available]);

  const doSAMClick = useCallback(async (canvasX, canvasY) => {
    const layer = layers.find(l => l.id === selectedLayerId);
    if (!layer?.imageData) return;
    const ok = await loadSAM();
    if (!ok) return;
    const embedded = await samEmbedLayer(layer);
    if (!embedded) return;
    setSamStatus("segmenting");

    const img = new Image(); img.src = layer.imageData;
    await new Promise(r => { img.onload = r; img.onerror = r; });
    const imgW = img.width, imgH = img.height;
    const lx = Math.max(0, Math.min(imgW - 1, (canvasX - layer.x) / layer.scaleX));
    const ly = Math.max(0, Math.min(imgH - 1, (canvasY - layer.y) / layer.scaleY));

    // ── SAM2 server path ─────────────────────────────────────────────────────
    if (sam2Available) {
      try {
        const r = await fetch(`${SAM2_URL}/predict`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: sam2SessionRef.current.sessionId,
            point_x: lx,
            point_y: ly,
            label: 1,
          }),
        });
        if (!r.ok) throw new Error(`SAM2 /predict ${r.status}`);
        const { mask: maskDataUrl, width, height } = await r.json();
        // Decode white-on-black PNG → flat Uint8Array
        const maskImg = new Image(); maskImg.src = maskDataUrl;
        await new Promise(res => { maskImg.onload = res; });
        const mc = document.createElement("canvas");
        mc.width = width; mc.height = height;
        const mCtx = mc.getContext("2d"); mCtx.drawImage(maskImg, 0, 0);
        const px = mCtx.getImageData(0, 0, width, height).data;
        const flat = new Uint8Array(width * height);
        for (let i = 0; i < flat.length; i++) flat[i] = px[i * 4] > 127 ? 1 : 0;
        setSamMask(flat);
        setSamMaskDims({ w: width, h: height, layerId: layer.id });
        setSamStatus("ready");
      } catch (e) {
        console.error("SAM2 predict failed:", e);
        setSamStatus("error");
      }
      return;
    }

    // ── Browser SAM fallback ─────────────────────────────────────────────────
    try {
      const { inputs, image_embeddings } = samEmbeddingRef.current;
      const [rh, rw] = inputs.reshaped_input_sizes[0];
      const maskInputs = {
        ...inputs, image_embeddings,
        input_points: [[[lx / imgW * rw, ly / imgH * rh]]],
        input_labels: [[1]],
      };
      const { pred_masks } = await samModelRef.current(maskInputs);
      const masks = await samProcessorRef.current.post_process_masks(
        pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes
      );
      const rawMask = masks[0][0];
      const flat = new Uint8Array(imgW * imgH);
      const maskH = rawMask.dims[0], maskW = rawMask.dims[1];
      const maskData = rawMask.data;
      for (let y = 0; y < imgH; y++) {
        for (let x = 0; x < imgW; x++) {
          const my = Math.floor(y * maskH / imgH), mx = Math.floor(x * maskW / imgW);
          flat[y * imgW + x] = maskData[my * maskW + mx] ? 1 : 0;
        }
      }
      setSamMask(flat); setSamMaskDims({ w: imgW, h: imgH, layerId: layer.id });
      setSamStatus("ready");
    } catch (e) {
      console.error("SAM segment failed:", e);
      setSamStatus("error");
    }
  }, [layers, selectedLayerId, loadSAM, samEmbedLayer, sam2Available]);

  const samExtract = useCallback(() => {
    if (!samMask || !samMaskDims) return;
    const layer = layers.find(l => l.id === samMaskDims.layerId);
    if (!layer?.imageData) return;
    const img = new Image();
    img.onload = () => {
      const tc = document.createElement("canvas");
      tc.width = img.width; tc.height = img.height;
      const tCtx = tc.getContext("2d"); tCtx.drawImage(img, 0, 0);
      const imgData = tCtx.getImageData(0, 0, img.width, img.height);
      for (let i = 0; i < samMask.length; i++) {
        if (!samMask[i]) imgData.data[i*4+3] = 0;
      }
      tCtx.putImageData(imgData, 0, 0);
      const nl = { id: uid(), name: layer.name + " (SAM)", visible: true, opacity: 1, blendMode: "source-over",
        x: layer.x, y: layer.y, scaleX: layer.scaleX, scaleY: layer.scaleY, rotation: layer.rotation,
        imageData: tc.toDataURL(), clipPath: null, locked: false };
      setLayers(prev => [nl, ...prev]); setSelectedLayerId(nl.id);
      setSamMask(null); setSamMaskDims(null);
    };
    img.src = layer.imageData;
  }, [samMask, samMaskDims, layers]);

  const samClip = useCallback(() => {
    if (!samMask || !samMaskDims) return;
    const { w, h, layerId } = samMaskDims;
    const layer = layers.find(l => l.id === layerId);
    if (!layer) return;
    const pts = traceSelectionBoundary(samMask, w, h, 4);
    if (pts.length > 3) {
      const scaled = pts.map(p => ({ x: layer.x + p.x * layer.scaleX, y: layer.y + p.y * layer.scaleY }));
      updateLayer(layerId, { clipPath: scaled });
    }
    setSamMask(null); setSamMaskDims(null);
  }, [samMask, samMaskDims, layers, updateLayer]);

  // ─── COMFYUI INPAINT ──────────────────────────────────────────────────────
  /**
   * Crop the selected layer (or SAM mask's layer) to the active region
   * (polygon or SAM mask), build a matching mask, send both to ComfyUI,
   * and store the result ready to be accepted as a new layer.
   */
  const handleComfyUpload = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setComfyUploadImage({ name: file.name, dataUrl });
    } catch (err) {
      console.error("Comfy upload source failed:", err);
      setComfyStatus("error: failed to load upload");
    }
    e.target.value = "";
  }, []);

  const runComfyGenerate = useCallback(async () => {
    const PAD = 32; // px padding around the region in image-space

    setComfyStatus("running");
    try {
      const client = new ComfyUIClient(comfyUrl);
      const workflowDef = COMFY_WORKFLOWS[comfyWorkflow];
      const workflowTemplate = workflowDef?.template;
      if (!workflowTemplate) throw new Error("Unknown workflow");

      if (workflowDef.mode === "img2img") {
        let imageDataUrl, resultName, placement;

        if (comfyInputSource === "selected-layer") {
          const srcLayer = layers.find(l => l.id === selectedLayerId);
          if (!srcLayer?.imageData) throw new Error("Select an image layer first");
          imageDataUrl = srcLayer.imageData;
          const srcImg = await loadImageDataUrl(srcLayer.imageData);
          resultName = `${srcLayer.name} (AI)`;
          placement = { type: "layer", layer: srcLayer, displayW: srcImg.width * srcLayer.scaleX, displayH: srcImg.height * srcLayer.scaleY };
        } else {
          if (!comfyUploadImage?.dataUrl) throw new Error("Choose an upload image first");
          imageDataUrl = comfyUploadImage.dataUrl;
          resultName = `${comfyUploadImage.name.replace(/\.[^.]+$/, "")} (AI)`;
          placement = { type: "upload" };
        }

        setComfyStatus("uploading...");
        const inputName = await client.uploadImage(imageDataUrl, "img2img_input.png");
        setComfyStatus("queuing workflow...");
        const workflow = client.fillTemplate(workflowTemplate, {
          INPUT_IMAGE: inputName,
          POSITIVE_PROMPT: comfyPrompt,
          NEGATIVE_PROMPT: comfyNegPrompt,
          DENOISE: comfyDenoise,
          STEPS: comfySteps,
          CFG: 1,
          SEED: Math.floor(Math.random() * 2 ** 31),
        });
        const promptId = await client.queuePrompt(workflow);
        setComfyStatus("generating...");
        const resultDataUrl = await client.pollResult(promptId);
        const resultImg = await loadImageDataUrl(resultDataUrl);

        if (placement.type === "layer") {
          const srcLayer = placement.layer;
          setComfyResultBounds({
            x: srcLayer.x,
            y: srcLayer.y,
            scaleX: placement.displayW / resultImg.width,
            scaleY: placement.displayH / resultImg.height,
            rotation: srcLayer.rotation,
            name: resultName,
          });
        } else {
          let scale = 1;
          if (resultImg.width > canvasSize.width * 0.8) scale = (canvasSize.width * 0.6) / resultImg.width;
          if (resultImg.height * scale > canvasSize.height * 0.8) scale = (canvasSize.height * 0.6) / resultImg.height;
          setComfyResultBounds({
            x: Math.round(canvasSize.width / 2 - (resultImg.width * scale) / 2),
            y: Math.round(canvasSize.height / 2 - (resultImg.height * scale) / 2),
            scaleX: scale,
            scaleY: scale,
            rotation: 0,
            name: resultName,
          });
        }

        setComfyResult(resultDataUrl);
        setComfyStatus("done");
        return;
      }

      let srcLayer = layers.find(l => l.id === selectedLayerId);
      if (!srcLayer?.imageData) throw new Error("Select an image layer first");
      const img = await loadImageDataUrl(srcLayer.imageData);

      let cropX, cropY, cropW, cropH, imageDataUrl, maskDataUrl, placementX, placementY;

      if (regionClosed && regionPoints.length >= 3) {
        // ── Polygon region path ───────────────────────────────────────────
        const b = polyBounds(regionPoints);
        cropX = Math.max(0, Math.floor((b.minX - srcLayer.x) / srcLayer.scaleX) - PAD);
        cropY = Math.max(0, Math.floor((b.minY - srcLayer.y) / srcLayer.scaleY) - PAD);
        const x1 = Math.min(img.width,  Math.ceil((b.maxX - srcLayer.x) / srcLayer.scaleX) + PAD);
        const y1 = Math.min(img.height, Math.ceil((b.maxY - srcLayer.y) / srcLayer.scaleY) + PAD);
        cropW = x1 - cropX; cropH = y1 - cropY;
        imageDataUrl = await cropLayerImage(srcLayer, cropX, cropY, cropW, cropH);
        maskDataUrl  = polygonMaskDataUrl(
          regionPoints, srcLayer.x, srcLayer.y, srcLayer.scaleX, srcLayer.scaleY,
          cropX, cropY, cropW, cropH
        );
        placementX = srcLayer.x + cropX * srcLayer.scaleX;
        placementY = srcLayer.y + cropY * srcLayer.scaleY;

      } else if (samMask && samMaskDims) {
        // ── SAM mask path ─────────────────────────────────────────────────
        srcLayer = layers.find(l => l.id === samMaskDims.layerId) || srcLayer;
        const samImg = await new Promise(res => {
          const i = new Image(); i.onload = () => res(i); i.src = srcLayer.imageData;
        });
        const b = samMaskBounds(samMask, samMaskDims.w, samMaskDims.h,
          srcLayer.x, srcLayer.y, srcLayer.scaleX, srcLayer.scaleY);
        if (!b) { setComfyStatus("idle"); return; }
        cropX = Math.max(0, Math.floor((b.minX - srcLayer.x) / srcLayer.scaleX) - PAD);
        cropY = Math.max(0, Math.floor((b.minY - srcLayer.y) / srcLayer.scaleY) - PAD);
        const x1 = Math.min(samImg.width,  Math.ceil((b.maxX - srcLayer.x) / srcLayer.scaleX) + PAD);
        const y1 = Math.min(samImg.height, Math.ceil((b.maxY - srcLayer.y) / srcLayer.scaleY) + PAD);
        cropW = x1 - cropX; cropH = y1 - cropY;
        imageDataUrl = await cropLayerImage(srcLayer, cropX, cropY, cropW, cropH);
        maskDataUrl  = samMaskCroppedDataUrl(samMask, samMaskDims.w, cropX, cropY, cropW, cropH);
        placementX = srcLayer.x + cropX * srcLayer.scaleX;
        placementY = srcLayer.y + cropY * srcLayer.scaleY;

      } else {
        setComfyStatus("idle");
        return;
      }

      const resultDataUrl = await client.runInpaint({
        imageDataUrl,
        maskDataUrl,
        workflowTemplate,
        positivePrompt:  comfyPrompt,
        negativePrompt:  comfyNegPrompt,
        denoise:  comfyDenoise,
        steps:    comfySteps,
        cfg:      7,
        onStatus: setComfyStatus,
      });

      setComfyResult(resultDataUrl);
      setComfyResultBounds({
        x: placementX, y: placementY, scaleX: srcLayer.scaleX, scaleY: srcLayer.scaleY,
        rotation: 0, name: "AI Inpaint",
      });
      setComfyStatus("done");
    } catch (e) {
      console.error("ComfyUI inpaint failed:", e);
      setComfyStatus("error: " + e.message);
    }
  }, [layers, selectedLayerId, regionClosed, regionPoints, samMask, samMaskDims,
      comfyUrl, comfyWorkflow, comfyPrompt, comfyNegPrompt, comfyDenoise, comfySteps, comfyInputSource, comfyUploadImage, canvasSize]);

  const acceptComfyResult = useCallback(() => {
    if (!comfyResult || !comfyResultBounds) return;
    const nl = {
      id: uid(), name: comfyResultBounds.name || "AI Result", visible: true, locked: false, opacity: 1,
      blendMode: "source-over", x: comfyResultBounds.x, y: comfyResultBounds.y,
      scaleX: comfyResultBounds.scaleX, scaleY: comfyResultBounds.scaleY,
      rotation: comfyResultBounds.rotation ?? 0, imageData: comfyResult, clipPath: null,
    };
    setLayers(prev => [nl, ...prev]);
    setSelectedLayerId(nl.id);
    setComfyResult(null); setComfyResultBounds(null); setComfyStatus("idle");
    clearRegion();
  }, [comfyResult, comfyResultBounds, clearRegion]);

  // Export edge/depth/normal map of selected layer as PNG (ControlNet conditioning)
  const exportControlMap = useCallback((mapType) => {
    const layer = layers.find(l => l.id === selectedLayerId);
    if (!layer?.imageData) return;
    const img = new Image();
    img.onload = () => {
      const tc = document.createElement("canvas");
      tc.width = img.width; tc.height = img.height;
      const tCtx = tc.getContext("2d"); tCtx.drawImage(img, 0, 0);
      if (mapType === "edge") applyEdge(tCtx, 0, 0, img.width, img.height);
      else if (mapType === "normal") applyEmboss(tCtx, 0, 0, img.width, img.height);
      else if (mapType === "depth") applyDepth(tCtx, 0, 0, img.width, img.height);
      const a = document.createElement("a");
      a.download = `${mapType}_map_${Date.now()}.png`;
      a.href = tc.toDataURL("image/png"); a.click();
    };
    img.src = layer.imageData;
  }, [layers, selectedLayerId]);

  // ─── STYLES ───
  const toolBtn = (t) => `px-3 py-2 text-xs font-bold tracking-wider uppercase transition-all duration-150 border ${
    tool === t ? (t === TOOLS.DREAM ? "bg-emerald-500 border-emerald-400 text-white shadow-lg shadow-emerald-500/30" : "bg-pink-500 border-pink-400 text-white shadow-lg shadow-pink-500/30")
    : "bg-transparent border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"}`;
  const fxBtn = "px-3 py-1.5 text-xs font-mono bg-zinc-800 border border-zinc-700 text-zinc-300 hover:bg-pink-500/20 hover:border-pink-500/50 hover:text-pink-300 transition-all";
  const dreamBtn = (on) => `px-3 py-1.5 text-xs font-mono border transition-all ${on ? "bg-emerald-500/20 border-emerald-500/50 text-emerald-300" : "bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-emerald-500/50 hover:text-emerald-300"}`;
  const comfyWorkflowDef = COMFY_WORKFLOWS[comfyWorkflow];
  const comfyIsImg2Img = comfyWorkflowDef?.mode === "img2img";
  const comfySelectedLayer = layers.find(l => l.id === selectedLayerId);
  const comfyCanGenerate = comfyIsImg2Img
    ? (comfyInputSource === "selected-layer" ? !!comfySelectedLayer?.imageData : !!comfyUploadImage?.dataUrl)
    : (regionClosed || !!samMask);

  return (
    <div className="flex h-screen w-full bg-zinc-950 text-zinc-200 overflow-hidden" style={{ fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}>
      {/* ICON STRIP */}
      <div className="w-10 flex-shrink-0 border-r border-zinc-800 flex flex-col items-center py-2 gap-0.5 bg-zinc-950">
        <div className="mb-2 pb-2 border-b border-zinc-800 w-full text-center">
          <span className="text-pink-400 text-xs font-black">C</span>
        </div>
        {[
          ["tools", "⊞", "Tools"],
          ["ai",    "◈", "AI — Wand, Segment, Region, ComfyUI"],
          ["fx",    "✦", "Effects & ControlNet"],
          ["file",  "⊟", "Import & Export"],
        ].map(([tab, icon, tip]) => (
          <button key={tab} title={tip} onClick={() => toggleTab(tab)}
            className={`w-8 h-8 text-sm flex items-center justify-center border transition-all ${
              sideTab === tab
                ? "bg-pink-500/20 border-pink-500/50 text-pink-300"
                : "border-transparent text-zinc-600 hover:text-zinc-300 hover:border-zinc-700"
            }`}>
            {icon}
          </button>
        ))}
        <div className="flex-1" />
        <button onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)"
          className={`w-8 h-8 text-xs flex items-center justify-center border transition-all ${
            canUndo ? "border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500" : "border-transparent text-zinc-800 cursor-not-allowed"
          }`}>↩</button>
        <button onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)"
          className={`w-8 h-8 text-xs flex items-center justify-center border transition-all mb-1 ${
            canRedo ? "border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500" : "border-transparent text-zinc-800 cursor-not-allowed"
          }`}>↪</button>
        {saveStatus && <div className="w-2 h-2 rounded-full bg-emerald-500 mb-1" title="Autosaved" />}
      </div>

      {/* CONTEXT PANEL */}
      {sideTab && (
      <div className="w-52 flex-shrink-0 border-r border-zinc-800 flex flex-col bg-zinc-950 overflow-y-auto">
        <div className="px-3 py-2 border-b border-zinc-800 flex items-center justify-between flex-shrink-0">
          <span className="text-xs text-zinc-500 uppercase tracking-widest">
            {{ tools: "Tools", ai: "AI", fx: "Effects", file: "Files" }[sideTab]}
          </span>
          <button onClick={() => setSideTab(null)} className="text-zinc-700 hover:text-zinc-400 text-xs leading-none">✕</button>
        </div>

        {/* ── TOOLS TAB ── */}
        {sideTab === "tools" && (<>
          <div className="p-2 border-b border-zinc-800 space-y-1">
            <div className="grid grid-cols-2 gap-1">
              <button className={toolBtn(TOOLS.SELECT)} onClick={() => setTool(TOOLS.SELECT)}>Select</button>
              <button className={toolBtn(TOOLS.PAN)} onClick={() => setTool(TOOLS.PAN)}>Pan</button>
              <button className={toolBtn(TOOLS.LASSO)} onClick={() => setTool(TOOLS.LASSO)}>Lasso</button>
              <button className={toolBtn(TOOLS.DRAW)} onClick={() => setTool(TOOLS.DRAW)}>Draw</button>
            </div>
            <button className={toolBtn(TOOLS.DREAM) + " w-full"} onClick={() => setTool(TOOLS.DREAM)}>◎ Dream</button>
          </div>
          {tool === TOOLS.DRAW && (
            <div className="p-3 border-b border-zinc-800 space-y-2">
              <p className="text-xs text-zinc-600 uppercase tracking-widest">Brush</p>
              <div className="flex items-center gap-2">
                <input type="color" value={brushColor} onChange={e => setBrushColor(e.target.value)} className="w-8 h-8 border-0 bg-transparent cursor-pointer" />
                <input type="range" min="1" max="30" value={brushSize} onChange={e => setBrushSize(+e.target.value)} className="flex-1 accent-pink-500" />
                <span className="text-xs text-zinc-500 w-6">{brushSize}</span>
              </div>
            </div>
          )}
          {tool === TOOLS.LASSO && (
            <div className="p-3 border-b border-zinc-800">
              <p className="text-xs text-zinc-500 leading-relaxed">Draw around a region to clip the selected layer.</p>
              {layers.find(l => l.id === selectedLayerId)?.clipPath && (
                <button onClick={clearClip} className="mt-2 text-xs text-pink-400 hover:text-pink-300 underline">Remove clip</button>
              )}
            </div>
          )}

          {/* Dream controls */}
          {tool === TOOLS.DREAM && (
            <div className="p-3 border-b border-zinc-800 space-y-3">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <p className="text-xs text-emerald-400 uppercase tracking-widest font-bold">Dream Mode</p>
              </div>
              {!dreamActive ? (<>
                <div>
                  <p className="text-xs text-zinc-500 mb-1">Pattern</p>
                  <div className="grid grid-cols-2 gap-1">
                    {Object.entries(RD_PRESETS).map(([k, p]) => (
                      <button key={k} onClick={() => setDreamPreset(k)} className={dreamBtn(dreamPreset === k)} title={p.desc}>{p.name}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-xs text-zinc-500 mb-1">Seed from</p>
                  <div className="grid grid-cols-3 gap-1">
                    {[["image","Layer"],["random","Random"],["paint","Paint"]].map(([k,l]) => (
                      <button key={k} onClick={() => setDreamSeedMode(k)} className={dreamBtn(dreamSeedMode === k)}>{l}</button>
                    ))}
                  </div>
                  {dreamSeedMode === "image" && (
                    <div className="mt-1">
                      <select value={dreamSeedLayerId || ""} onChange={e => setDreamSeedLayerId(e.target.value || null)}
                        className="w-full bg-zinc-800 border border-zinc-700 text-xs text-zinc-300 px-2 py-1.5 rounded-none">
                        <option value="">All visible layers</option>
                        {layers.filter(l => l.imageData).map(l => (
                          <option key={l.id} value={l.id}>{l.name}</option>
                        ))}
                      </select>
                      <p className="text-xs text-zinc-600 mt-1">Dark pixels seed stronger growth</p>
                    </div>
                  )}
                  {dreamSeedMode === "random" && <p className="text-xs text-zinc-600 mt-1">Scatter random seeds</p>}
                  {dreamSeedMode === "paint" && <p className="text-xs text-zinc-600 mt-1">Click to place seeds</p>}
                </div>
                <div>
                  <p className="text-xs text-zinc-500 mb-1">Colormap</p>
                  <div className="grid grid-cols-3 gap-1">
                    {[...Object.keys(RD_COLORMAPS), "image", "warp"].map(cm => (
                      <button key={cm} onClick={() => setDreamColormap(cm)} className={dreamBtn(dreamColormap === cm)}>{cm}</button>
                    ))}
                  </div>
                  {(dreamColormap === "image" || dreamColormap === "warp") && dreamSeedMode !== "image" && (
                    <p className="text-xs text-amber-500 mt-1">Set seed to "Layer" for {dreamColormap} mode</p>
                  )}
                  {dreamColormap === "warp" && (
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-zinc-500 w-10">warp</span>
                      <input type="range" min="2" max="50" value={dreamWarpStrength} onChange={e => setDreamWarpStrength(+e.target.value)} className="flex-1 accent-emerald-500" />
                      <span className="text-xs text-zinc-500 w-6">{dreamWarpStrength}</span>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-500 w-8">res</span>
                  <input type="range" min="64" max="400" step="16" value={dreamRes} onChange={e => setDreamRes(+e.target.value)} className="flex-1 accent-emerald-500" />
                  <span className="text-xs text-zinc-500 w-8">{dreamRes}</span>
                </div>
                <p className="text-xs text-zinc-600">{dreamSeedMode === "paint" ? "Place seeds then drag a region." : "Drag on canvas to select a region."}</p>
                <button onClick={initDream} disabled={!dreamRegion || dreamRegion.w < 10}
                  className={`w-full py-2 text-xs font-bold uppercase tracking-wider border transition-all ${
                    dreamRegion && dreamRegion.w >= 10 ? "bg-emerald-500/20 border-emerald-500 text-emerald-300 hover:bg-emerald-500/30" : "border-zinc-700 text-zinc-600 cursor-not-allowed"}`}>
                  ▶ Start Dreaming
                </button>
                {dreamPaintPoints.length > 0 && (
                  <button onClick={() => setDreamPaintPoints([])} className="w-full text-xs text-zinc-600 hover:text-zinc-400">Clear seeds</button>
                )}
              </>) : (<>
                <div className="bg-zinc-900 border border-emerald-900/50 p-2 space-y-1">
                  <div className="flex justify-between"><span className="text-xs text-zinc-500">Pattern</span><span className="text-xs text-emerald-400">{RD_PRESETS[dreamPreset].name}</span></div>
                  <div className="flex justify-between"><span className="text-xs text-zinc-500">Iters</span><span className="text-xs text-emerald-400 font-mono">{dreamIterations}</span></div>
                  <div className="flex justify-between"><span className="text-xs text-zinc-500">Status</span>
                    <span className={`text-xs ${dreamRunning ? "text-emerald-400" : "text-amber-400"}`}>{dreamRunning ? "● evolving" : "◆ paused"}</span></div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-500 w-12">speed</span>
                  <input type="range" min="1" max="30" value={dreamSpeed} onChange={e => setDreamSpeed(+e.target.value)} className="flex-1 accent-emerald-500" />
                  <span className="text-xs text-zinc-500 w-6">{dreamSpeed}</span>
                </div>
                <div>
                  <p className="text-xs text-zinc-500 mb-1">Colormap</p>
                  <div className="grid grid-cols-3 gap-1">
                    {[...Object.keys(RD_COLORMAPS),
                      ...(rdRef.current?.seedColors ? ["image"] : []),
                      ...(dreamSrcPixelsRef.current ? ["warp"] : [])
                    ].map(cm => (
                      <button key={cm} onClick={() => setDreamColormap(cm)} className={dreamBtn(dreamColormap === cm)}>{cm}</button>
                    ))}
                  </div>
                  {dreamColormap === "warp" && (
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-zinc-500 w-10">warp</span>
                      <input type="range" min="2" max="50" value={dreamWarpStrength} onChange={e => setDreamWarpStrength(+e.target.value)} className="flex-1 accent-emerald-500" />
                      <span className="text-xs text-zinc-500 w-6">{dreamWarpStrength}</span>
                    </div>
                  )}
                </div>
                <p className="text-xs text-zinc-600">Click inside dream to inject seeds</p>
                <div className="grid grid-cols-2 gap-1">
                  <button onClick={dreamRunning ? pauseDream : resumeDream}
                    className="py-2 text-xs border border-zinc-700 text-zinc-300 hover:border-emerald-500/50 hover:text-emerald-300 transition-all">
                    {dreamRunning ? "⏸ Pause" : "▶ Resume"}</button>
                  <button onClick={freezeDream}
                    className="py-2 text-xs bg-emerald-500/20 border border-emerald-500 text-emerald-300 hover:bg-emerald-500/30 transition-all font-bold">
                    ❄ Freeze</button>
                </div>
                <button onClick={resetDream} className="w-full py-1.5 text-xs border border-zinc-800 text-zinc-600 hover:text-red-400 hover:border-red-800 transition-all">Reset</button>
              </>)}
            </div>
          )}
        </>)}

        {/* ── AI TAB ── */}
        {sideTab === "ai" && (<>
          <div className="p-2 border-b border-zinc-800 space-y-1">
            <button className={toolBtn(TOOLS.WAND) + " w-full"} onClick={() => setTool(TOOLS.WAND)}>⬡ Wand</button>
            <button className={toolBtn(TOOLS.SEGMENT) + " w-full"} onClick={() => { setTool(TOOLS.SEGMENT); loadSAM(); }}>◈ Segment</button>
            <button className={toolBtn(TOOLS.REGION) + " w-full"} onClick={() => { setTool(TOOLS.REGION); clearRegion(); }}>⬟ Region AI</button>
          </div>

          {/* Wand options */}
          {tool === TOOLS.WAND && (
            <div className="p-3 border-b border-zinc-800 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-500 w-14">tolerance</span>
                <input type="range" min="1" max="120" value={wandTolerance} onChange={e => setWandTolerance(+e.target.value)} className="flex-1 accent-pink-500" />
                <span className="text-xs text-zinc-500 w-8">{wandTolerance}</span>
              </div>
              <p className="text-xs text-zinc-600">{selectedLayerId ? "Click to flood-fill select." : "Select a layer first."}</p>
              {wandSelection && (
                <div className="space-y-1">
                  <p className="text-xs text-pink-400 font-mono">Selection active</p>
                  <div className="grid grid-cols-2 gap-1">
                    <button onClick={wandExtract} className="py-1.5 text-xs bg-pink-500/20 border border-pink-500/50 text-pink-300 hover:bg-pink-500/30 transition-all">Extract</button>
                    <button onClick={wandClip} className="py-1.5 text-xs bg-zinc-800 border border-zinc-700 text-zinc-300 hover:border-pink-500/50 hover:text-pink-300 transition-all">Clip</button>
                  </div>
                  <button onClick={() => setWandSelection(null)} className="w-full py-1 text-xs text-zinc-600 hover:text-zinc-400">Clear</button>
                </div>
              )}
            </div>
          )}

          {/* SAM2 options */}
          {tool === TOOLS.SEGMENT && (
            <div className="p-3 border-b border-zinc-800 space-y-2">
              <div className="flex items-center justify-between">
                <span className={`text-xs font-mono ${sam2Available ? "text-green-400" : "text-zinc-500"}`}>
                  {sam2Available ? "● SAM2 CUDA" : "○ SAM browser"}
                </span>
                <span className={`text-xs font-mono ${samStatus === "ready" ? "text-purple-400" : samStatus === "error" ? "text-red-400" : "text-amber-400"}`}>
                  {samStatus === "idle" ? "not loaded" : samStatus === "loading" ? "loading..." :
                   samStatus === "embedding" ? "encoding..." : samStatus === "segmenting" ? "working..." :
                   samStatus === "error" ? "error" : "● ready"}
                </span>
              </div>
              {samStatus === "idle" && !sam2Available && (
                <button onClick={loadSAM} className="w-full py-1.5 text-xs border border-purple-500/40 text-purple-400 hover:bg-purple-500/10 transition-all">Load SAM (~100MB)</button>
              )}
              {samStatus === "error" && (
                <button onClick={() => { setSamStatus("idle"); samModelRef.current = null; sam2SessionRef.current = null; }} className="w-full py-1.5 text-xs border border-red-700 text-red-400 hover:bg-red-900/20">Reset &amp; retry</button>
              )}
              {(samStatus === "loading" || samStatus === "embedding" || samStatus === "segmenting") && (
                <div className="py-1.5 text-xs text-center text-amber-400 border border-amber-800/50 animate-pulse">
                  {samStatus === "loading" ? "Downloading..." : samStatus === "embedding" ? "Encoding…" : "Segmenting…"}
                </div>
              )}
              {samStatus === "ready" && !samMask && (
                <p className="text-xs text-zinc-600">{selectedLayerId ? "Click image to segment." : "Select a layer first."}</p>
              )}
              {samMask && samMaskDims && (
                <div className="space-y-1">
                  <p className="text-xs text-purple-400 font-mono">Mask ready</p>
                  <div className="grid grid-cols-2 gap-1">
                    <button onClick={samExtract} className="py-1.5 text-xs bg-purple-500/20 border border-purple-500/50 text-purple-300 hover:bg-purple-500/30 transition-all">Extract</button>
                    <button onClick={samClip} className="py-1.5 text-xs bg-zinc-800 border border-zinc-700 text-zinc-300 hover:border-purple-500/50 hover:text-purple-300 transition-all">Clip</button>
                  </div>
                  <button onClick={() => setTool(TOOLS.REGION)}
                    className="w-full py-1.5 text-xs bg-orange-500/15 border border-orange-500/40 text-orange-300 hover:bg-orange-500/25 transition-all">
                    ⬟ Send mask to AI
                  </button>
                  <button onClick={() => { setSamMask(null); setSamMaskDims(null); }} className="w-full py-1 text-xs text-zinc-600 hover:text-zinc-400">Clear</button>
                </div>
              )}
            </div>
          )}

          {/* Region options */}
          {tool === TOOLS.REGION && (
            <div className="p-3 border-b border-zinc-800 space-y-2">
              {!regionClosed && regionPoints.length === 0 && (
                <p className="text-xs text-zinc-500 leading-relaxed">
                  Click to add vertices. Click start dot or <kbd className="text-zinc-400 bg-zinc-800 px-1">↵</kbd> to close. <kbd className="text-zinc-400 bg-zinc-800 px-1">Esc</kbd> cancel.
                </p>
              )}
              {!regionClosed && regionPoints.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs text-zinc-500">{regionPoints.length} pts — {regionPoints.length >= 3 ? "close or keep adding" : "need ≥3"}</p>
                  <button onClick={clearRegion} className="w-full py-1 text-xs text-zinc-600 hover:text-red-400">Clear</button>
                </div>
              )}
              {regionClosed && (
                <div className="space-y-1">
                  <p className="text-xs text-orange-400 font-mono">Region closed ✓</p>
                  <button onClick={clearRegion} className="w-full py-1 text-xs text-zinc-600 hover:text-zinc-400">Redraw</button>
                </div>
              )}
            </div>
          )}

          {/* ComfyUI Generate — shown when any region/mask source is ready */}
          <div className="p-3 space-y-3">
            <p className="text-xs text-zinc-500 uppercase tracking-widest font-bold">ComfyUI Generate</p>
            <div>
              <p className="text-xs text-zinc-600 mb-1">Server</p>
              <input type="text" value={comfyUrl} onChange={e => setComfyUrl(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-700 text-xs text-zinc-300 px-2 py-1 font-mono" />
            </div>
            <div>
              <p className="text-xs text-zinc-600 mb-1">Workflow</p>
              <select value={comfyWorkflow} onChange={e => setComfyWorkflow(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 text-xs text-zinc-300 px-2 py-1.5 rounded-none">
                {Object.entries(COMFY_WORKFLOWS).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
            </div>
            {comfyIsImg2Img && (
              <div className="space-y-2">
                <div>
                  <p className="text-xs text-zinc-600 mb-1">Input source</p>
                  <div className="grid grid-cols-2 gap-1">
                    <button onClick={() => setComfyInputSource("selected-layer")}
                      className={`py-1.5 text-xs border transition-all ${comfyInputSource === "selected-layer" ? "bg-orange-500/20 border-orange-500 text-orange-300" : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"}`}>
                      Selected layer
                    </button>
                    <button onClick={() => setComfyInputSource("upload")}
                      className={`py-1.5 text-xs border transition-all ${comfyInputSource === "upload" ? "bg-orange-500/20 border-orange-500 text-orange-300" : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"}`}>
                      Upload image
                    </button>
                  </div>
                </div>
                {comfyInputSource === "selected-layer" ? (
                  <p className="text-xs text-zinc-500">
                    {comfySelectedLayer?.imageData ? `Using layer: ${comfySelectedLayer.name}` : "Select an image layer to use as img2img input."}
                  </p>
                ) : (
                  <div className="space-y-1">
                    <input type="file" accept="image/*" onChange={handleComfyUpload}
                      className="w-full bg-zinc-900 border border-zinc-700 text-xs text-zinc-400 px-2 py-1 file:mr-2 file:border-0 file:bg-orange-500/20 file:px-2 file:py-1 file:text-orange-300" />
                    <p className="text-xs text-zinc-500">
                      {comfyUploadImage?.name ? `Using upload: ${comfyUploadImage.name}` : "Choose an image file to generate from."}
                    </p>
                  </div>
                )}
              </div>
            )}
            {!comfyIsImg2Img && (
              <p className="text-xs text-zinc-500">
                {regionClosed ? "Using polygon region from canvas." : samMask ? "Using SAM mask from selected layer." : "Draw a region or create a SAM mask first."}
              </p>
            )}
            <div>
              <p className="text-xs text-zinc-600 mb-1">Prompt</p>
              <textarea value={comfyPrompt} onChange={e => setComfyPrompt(e.target.value)}
                placeholder="describe what to generate…" rows={3}
                className="w-full bg-zinc-900 border border-zinc-700 text-xs text-zinc-200 px-2 py-1.5 resize-none placeholder-zinc-700" />
            </div>
            <div>
              <p className="text-xs text-zinc-600 mb-1">Negative</p>
              <input type="text" value={comfyNegPrompt} onChange={e => setComfyNegPrompt(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-700 text-xs text-zinc-400 px-2 py-1" />
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-600 w-12">denoise</span>
                <input type="range" min="0.1" max="1.0" step="0.05" value={comfyDenoise} onChange={e => setComfyDenoise(+e.target.value)} className="flex-1 accent-orange-500" />
                <span className="text-xs text-zinc-500 w-8">{comfyDenoise.toFixed(2)}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-600 w-12">steps</span>
                <input type="range" min="8" max="50" step="1" value={comfySteps} onChange={e => setComfySteps(+e.target.value)} className="flex-1 accent-orange-500" />
                <span className="text-xs text-zinc-500 w-8">{comfySteps}</span>
              </div>
            </div>
            {comfyStatus === "idle" && (
              <button onClick={runComfyGenerate} disabled={!comfyCanGenerate}
                className={`w-full py-2 text-xs font-bold uppercase tracking-wider border transition-all ${
                  comfyCanGenerate ? "bg-orange-500/20 border-orange-500 text-orange-300 hover:bg-orange-500/30" : "border-zinc-700 text-zinc-600 cursor-not-allowed"}`}>
                ▶ Generate
              </button>
            )}
            {comfyStatus !== "idle" && comfyStatus !== "done" && !comfyStatus.startsWith("error") && (
              <div className="py-2 text-xs text-center text-amber-400 border border-amber-800/50 animate-pulse font-mono">{comfyStatus}</div>
            )}
            {comfyStatus.startsWith("error") && (
              <div className="space-y-1">
                <p className="text-xs text-red-400 break-words">{comfyStatus}</p>
                <button onClick={() => setComfyStatus("idle")} className="w-full py-1.5 text-xs border border-red-700 text-red-400 hover:bg-red-900/20">Dismiss</button>
              </div>
            )}
            {comfyStatus === "done" && comfyResult && (
              <div className="space-y-2">
                <p className="text-xs text-orange-400 font-mono">Done ✓</p>
                <img src={comfyResult} alt="AI result" className="w-full border border-orange-500/30" />
                <div className="grid grid-cols-2 gap-1">
                  <button onClick={acceptComfyResult}
                    className="py-1.5 text-xs bg-orange-500/20 border border-orange-500 text-orange-300 hover:bg-orange-500/30 font-bold transition-all">✓ Accept</button>
                  <button onClick={() => { setComfyResult(null); setComfyResultBounds(null); setComfyStatus("idle"); }}
                    className="py-1.5 text-xs border border-zinc-700 text-zinc-400 hover:text-red-400 hover:border-red-700 transition-all">✕ Discard</button>
                </div>
                <button onClick={runComfyGenerate} className="w-full py-1 text-xs border border-orange-500/40 text-orange-400 hover:bg-orange-500/10">↺ Regenerate</button>
              </div>
            )}
          </div>
        </>)}

        {/* ── FX TAB ── */}
        {sideTab === "fx" && (
          <div className="p-3 space-y-4">
            <div>
              <p className="text-xs text-zinc-600 uppercase tracking-widest mb-2">Effects</p>
              <div className="grid grid-cols-2 gap-1">
                {["dither","pixelsort","invert","posterize","chromatic","glitch","threshold","halftone"].map(f => (
                  <button key={f} onClick={() => applyEffect(f)} disabled={!selectedLayerId}
                    className={fxBtn + (selectedLayerId ? "" : " opacity-30 cursor-not-allowed")}>{f}</button>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs text-zinc-700 uppercase tracking-widest mb-1">ControlNet Maps</p>
              <div className="grid grid-cols-2 gap-1">
                {["blur","edge","emboss","depth"].map(f => (
                  <button key={f} onClick={() => applyEffect(f)} disabled={!selectedLayerId}
                    className={fxBtn + " text-cyan-400/80 hover:text-cyan-300 hover:border-cyan-500/50" + (selectedLayerId ? "" : " opacity-30 cursor-not-allowed")}>{f}</button>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs text-zinc-700 uppercase tracking-widest mb-1">Export Map</p>
              <div className="grid grid-cols-3 gap-1">
                {[["edge","Canny"],["emboss","Normal"],["depth","Depth"]].map(([t,l]) => (
                  <button key={t} onClick={() => exportControlMap(t)} disabled={!selectedLayerId}
                    className={"px-2 py-1.5 text-xs font-mono bg-zinc-800 border border-cyan-900 text-cyan-600 hover:bg-cyan-500/10 hover:border-cyan-500/50 hover:text-cyan-300 transition-all" + (selectedLayerId ? "" : " opacity-30 cursor-not-allowed")}>↓{l}</button>
                ))}
              </div>
            </div>
            {!selectedLayerId && <p className="text-xs text-zinc-700">Select a layer to apply effects.</p>}
          </div>
        )}

        {/* ── FILE TAB ── */}
        {sideTab === "file" && (
          <div className="p-3 space-y-4">
            <div className="space-y-1">
              <p className="text-xs text-zinc-600 uppercase tracking-widest">Import</p>
              <button onClick={() => fileInputRef.current?.click()} className="w-full py-2 text-xs border border-dashed border-zinc-700 text-zinc-400 hover:border-pink-500 hover:text-pink-400 transition-all">Browse files…</button>
              <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={e => { handleFiles(e.target.files); e.target.value = ""; }} />
              <p className="text-xs text-zinc-700 text-center">or drop / paste anywhere</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-zinc-600 uppercase tracking-widest">Export</p>
              <button onClick={exportCanvas} className="w-full py-2 text-xs bg-pink-500/20 border border-pink-500/40 text-pink-300 hover:bg-pink-500/30 transition-all">↓ Export PNG</button>
            </div>
            <div className="pt-2 border-t border-zinc-800 space-y-1">
              <button onClick={clearAll} className="w-full py-1.5 text-xs border border-zinc-800 text-zinc-600 hover:text-red-400 hover:border-red-800 transition-all">Clear all</button>
              {saveStatus && <p className="text-center text-xs text-emerald-500 animate-pulse">✓ autosaved</p>}
            </div>
          </div>
        )}

      </div>
      )}

      {/* CANVAS */}
      <div ref={containerRef} className="flex-1 overflow-hidden relative bg-zinc-900"
        onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
        onDrop={e => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); }}
        style={{ cursor: tool === TOOLS.PAN ? "grab" : tool === TOOLS.DREAM ? (dreamActive ? "cell" : "crosshair") : (tool === TOOLS.LASSO || tool === TOOLS.DRAW || tool === TOOLS.WAND || tool === TOOLS.SEGMENT || tool === TOOLS.REGION) ? "crosshair" : "default" }}>
        <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
          <button onClick={() => setZoom(z => Math.max(0.1, z * 0.8))} className="w-7 h-7 text-xs bg-zinc-800/80 border border-zinc-700 text-zinc-400 hover:text-white">−</button>
          <span className="text-xs text-zinc-500 font-mono w-12 text-center">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom(z => Math.min(5, z * 1.2))} className="w-7 h-7 text-xs bg-zinc-800/80 border border-zinc-700 text-zinc-400 hover:text-white">+</button>
          <button onClick={() => { setZoom(1); setPanOffset({x:0,y:0}); }} className="px-2 h-7 text-xs bg-zinc-800/80 border border-zinc-700 text-zinc-500 hover:text-white">fit</button>
        </div>
        {tool === TOOLS.DREAM && dreamActive && (
          <div className="absolute top-3 left-3 z-10 flex items-center gap-2 bg-zinc-900/90 border border-emerald-800 px-3 py-1.5">
            <div className={`w-2 h-2 rounded-full ${dreamRunning ? "bg-emerald-400 animate-pulse" : "bg-amber-400"}`} />
            <span className="text-xs text-emerald-400 font-mono">DREAMING — iter {dreamIterations}</span>
          </div>
        )}
        {showWelcome && layers.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none">
            <div className="text-center"><div className="text-6xl mb-4 opacity-20">✂️</div>
              <p className="text-zinc-500 text-sm mb-1">Drop images here to begin</p>
              <p className="text-zinc-700 text-xs">or paste from clipboard</p></div>
          </div>
        )}
        <div style={{ transform: `scale(${zoom}) translate(${panOffset.x}px, ${panOffset.y}px)`, transformOrigin: "0 0", width: canvasSize.width, height: canvasSize.height, position: "absolute", top: 40, left: 40 }}>
          <canvas ref={canvasRef} width={canvasSize.width} height={canvasSize.height} className="shadow-2xl shadow-black/50"
            onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp} onWheel={handleWheel} />
        </div>
      </div>

      {/* RIGHT — LAYERS */}
      <div className="w-60 flex-shrink-0 border-l border-zinc-800 flex flex-col bg-zinc-950">
        <div className="p-3 border-b border-zinc-800 flex items-center justify-between">
          <p className="text-xs text-zinc-600 uppercase tracking-widest">Layers</p>
          <span className="text-xs text-zinc-700">{layers.length}</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {layers.map(layer => (
            <div key={layer.id} onClick={() => setSelectedLayerId(layer.id)}
              className={`p-2 border-b border-zinc-800/50 cursor-pointer transition-all ${layer.id === selectedLayerId ? "bg-pink-500/10 border-l-2 border-l-pink-500" : "hover:bg-zinc-800/30"}`}>
              <div className="flex items-center gap-2">
                <button onClick={e => { e.stopPropagation(); updateLayer(layer.id, { visible: !layer.visible }); }}
                  className={`text-xs ${layer.visible ? "text-emerald-400" : "text-zinc-700"}`}>{layer.visible ? "●" : "○"}</button>
                <span className="text-xs flex-1 truncate">
                  {layer.name.startsWith("Dream") && <span className="text-emerald-500 mr-1">◎</span>}{layer.name}
                </span>
                <div className="flex gap-1">
                  <button onClick={e => { e.stopPropagation(); moveLayer(layer.id, "up"); }} className="text-xs text-zinc-600 hover:text-zinc-300 px-1">↑</button>
                  <button onClick={e => { e.stopPropagation(); moveLayer(layer.id, "down"); }} className="text-xs text-zinc-600 hover:text-zinc-300 px-1">↓</button>
                </div>
              </div>
              {layer.id === selectedLayerId && (
                <div className="mt-2 space-y-2">
                  <div className="flex items-center gap-2"><span className="text-xs text-zinc-600 w-10">α</span>
                    <input type="range" min="0" max="1" step="0.05" value={layer.opacity} onChange={e => updateLayer(layer.id, { opacity: +e.target.value })} className="flex-1 accent-pink-500" />
                    <span className="text-xs text-zinc-500 w-8">{Math.round(layer.opacity * 100)}</span></div>
                  <div className="flex items-center gap-2"><span className="text-xs text-zinc-600 w-10">⤧</span>
                    <input type="range" min="0.05" max="3" step="0.05" value={layer.scaleX} onChange={e => { const s=+e.target.value; updateLayer(layer.id, { scaleX:s, scaleY:s }); }} className="flex-1 accent-pink-500" />
                    <span className="text-xs text-zinc-500 w-8">{Math.round(layer.scaleX * 100)}%</span></div>
                  <div className="flex items-center gap-2"><span className="text-xs text-zinc-600 w-10">↻</span>
                    <input type="range" min="0" max="360" step="1" value={layer.rotation} onChange={e => updateLayer(layer.id, { rotation: +e.target.value })} className="flex-1 accent-pink-500" />
                    <span className="text-xs text-zinc-500 w-8">{layer.rotation}°</span></div>
                  <div className="flex items-center gap-2"><span className="text-xs text-zinc-600 w-10">mix</span>
                    <select value={layer.blendMode} onChange={e => updateLayer(layer.id, { blendMode: e.target.value })}
                      className="flex-1 bg-zinc-800 border border-zinc-700 text-xs text-zinc-300 px-1 py-1 rounded-none">
                      {BLEND_MODES.map(m => <option key={m} value={m}>{m}</option>)}</select></div>
                  <div className="flex gap-1 pt-1">
                    <button onClick={e => { e.stopPropagation(); duplicateLayer(layer.id); }} className="flex-1 py-1 text-xs border border-zinc-700 text-zinc-500 hover:text-zinc-200 hover:border-zinc-500">dup</button>
                    <button onClick={e => { e.stopPropagation(); updateLayer(layer.id, { locked: !layer.locked }); }}
                      className={`flex-1 py-1 text-xs border ${layer.locked ? "border-amber-600 text-amber-500" : "border-zinc-700 text-zinc-500 hover:text-zinc-200"}`}>
                      {layer.locked ? "locked" : "lock"}</button>
                    <button onClick={e => { e.stopPropagation(); deleteLayer(layer.id); }}
                      className="flex-1 py-1 text-xs border border-zinc-700 text-zinc-500 hover:text-red-400 hover:border-red-700">del</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
        {drawingPaths.length > 0 && (
          <div className="p-3 border-t border-zinc-800">
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-600">{drawingPaths.length} strokes</span>
              <button onClick={() => setDrawingPaths([])} className="text-xs text-zinc-600 hover:text-red-400">clear</button>
            </div>
          </div>
        )}
        <div className="p-2 border-t border-zinc-800 text-xs text-zinc-700 flex justify-between">
          <span>{canvasSize.width}×{canvasSize.height}</span><span>v0.2.0</span>
        </div>
      </div>
    </div>
  );
}
