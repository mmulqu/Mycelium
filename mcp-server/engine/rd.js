import { COLORMAPS } from "./colormaps.js";

export const RD_PRESETS = {
  mitosis:     { name: "Mitosis",      f: 0.0367, k: 0.0649, Du: 0.21,  Dv: 0.105 },
  coral:       { name: "Coral",        f: 0.0545, k: 0.062,  Du: 0.16,  Dv: 0.08  },
  spirals:     { name: "Spirals",      f: 0.014,  k: 0.045,  Du: 0.21,  Dv: 0.105 },
  maze:        { name: "Labyrinth",    f: 0.029,  k: 0.057,  Du: 0.21,  Dv: 0.105 },
  spots:       { name: "Leopard",      f: 0.035,  k: 0.065,  Du: 0.16,  Dv: 0.08  },
  worms:       { name: "Worms",        f: 0.078,  k: 0.061,  Du: 0.16,  Dv: 0.08  },
  chaos:       { name: "Chaos",        f: 0.026,  k: 0.051,  Du: 0.21,  Dv: 0.105 },
  fingerprint: { name: "Fingerprint",  f: 0.055,  k: 0.062,  Du: 0.21,  Dv: 0.105 },
};

export class ReactionDiffusion {
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
    this.seedColors = null;
  }

  setParams(f, k, Du, Dv) {
    this.f = f; this.k = k; this.Du = Du; this.Dv = Dv;
  }

  setPreset(name) {
    const p = RD_PRESETS[name];
    if (p) this.setParams(p.f, p.k, p.Du, p.Dv);
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

  seedRandom(count = 15) {
    for (let i = 0; i < count; i++) {
      this.seed(
        Math.floor(Math.random() * this.w),
        Math.floor(Math.random() * this.h),
        3 + Math.floor(Math.random() * 5)
      );
    }
  }

  seedFromImageData(rgbaData, srcW, srcH) {
    const scaleX = srcW / this.w;
    const scaleY = srcH / this.h;
    this.seedColors = new Uint8Array(this.size * 3);
    let hasContent = false;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const sx = Math.floor(x * scaleX);
        const sy = Math.floor(y * scaleY);
        const srcIdx = (sy * srcW + sx) * 4;
        const idx = y * this.w + x;
        this.seedColors[idx * 3] = rgbaData[srcIdx];
        this.seedColors[idx * 3 + 1] = rgbaData[srcIdx + 1];
        this.seedColors[idx * 3 + 2] = rgbaData[srcIdx + 2];
        const alpha = rgbaData[srcIdx + 3];
        if (alpha === 0) continue;
        const lum = (rgbaData[srcIdx] + rgbaData[srcIdx + 1] + rgbaData[srcIdx + 2]) / 765;
        const invLum = 1 - lum;
        this.v[idx] = invLum * invLum * 0.9 + Math.random() * 0.1;
        this.u[idx] = 0.5 - this.v[idx] * 0.3;
        if (invLum > 0.1) hasContent = true;
      }
    }
    if (!hasContent) this.seedRandom(15);
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

  render(rgbaBuffer, colormap = "organic") {
    if (colormap === "image" && this.seedColors) {
      for (let i = 0; i < this.size; i++) {
        const vv = this.v[i];
        const pi = i * 4;
        const ci = i * 3;
        const intensity = Math.min(1, vv * 3);
        const boost = 0.6 + intensity * 0.4;
        rgbaBuffer[pi]     = Math.min(255, Math.floor(this.seedColors[ci]     * boost * intensity + (1 - intensity) * 10));
        rgbaBuffer[pi + 1] = Math.min(255, Math.floor(this.seedColors[ci + 1] * boost * intensity + (1 - intensity) * 8));
        rgbaBuffer[pi + 2] = Math.min(255, Math.floor(this.seedColors[ci + 2] * boost * intensity + (1 - intensity) * 15));
        rgbaBuffer[pi + 3] = 255;
      }
    } else {
      const mapFn = COLORMAPS[colormap] || COLORMAPS.organic;
      for (let i = 0; i < this.size; i++) {
        const [r, g, b] = mapFn(this.u[i], this.v[i]);
        const pi = i * 4;
        rgbaBuffer[pi] = r; rgbaBuffer[pi + 1] = g; rgbaBuffer[pi + 2] = b; rgbaBuffer[pi + 3] = 255;
      }
    }
  }

  renderWarp(rgbaBuffer, srcPixels, srcW, srcH, strength = 15) {
    const { w, h, v } = this;
    const scaleX = srcW / w;
    const scaleY = srcH / h;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const vv = v[idx];
        const vL = x > 0 ? v[idx - 1] : vv;
        const vR = x < w - 1 ? v[idx + 1] : vv;
        const vU = y > 0 ? v[idx - w] : vv;
        const vD = y < h - 1 ? v[idx + w] : vv;
        const gradX = (vR - vL) * strength;
        const gradY = (vD - vU) * strength;
        const mag = vv * strength * 0.5;
        const dx = gradX + Math.sin(vv * 12) * mag;
        const dy = gradY + Math.cos(vv * 12) * mag;
        const srcX = Math.max(0, Math.min(srcW - 1, Math.floor(x * scaleX + dx * scaleX)));
        const srcY = Math.max(0, Math.min(srcH - 1, Math.floor(y * scaleY + dy * scaleY)));
        const srcIdx = (srcY * srcW + srcX) * 4;
        const pi = idx * 4;
        rgbaBuffer[pi]     = srcPixels[srcIdx];
        rgbaBuffer[pi + 1] = srcPixels[srcIdx + 1];
        rgbaBuffer[pi + 2] = srcPixels[srcIdx + 2];
        rgbaBuffer[pi + 3] = 255;
      }
    }
  }
}
