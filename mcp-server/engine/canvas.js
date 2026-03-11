import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readFile } from "fs/promises";
import { EFFECTS } from "./effects.js";
import { ReactionDiffusion, RD_PRESETS } from "./rd.js";

let idCounter = Date.now();
const uid = () => `layer_${idCounter++}`;

export class MyceliumCanvas {
  constructor(width = 1200, height = 800) {
    this.width = width;
    this.height = height;
    this.layers = [];
    this.selectedLayerId = null;
    this.dream = null; // active RD state
  }

  // ── Layer management ──

  async addImageFromFile(filePath, name) {
    const imgData = await readFile(filePath);
    const img = await loadImage(imgData);
    let scale = 1;
    if (img.width > this.width * 0.8) scale = (this.width * 0.6) / img.width;
    if (img.height * scale > this.height * 0.8) scale = (this.height * 0.6) / img.height;
    const layer = {
      id: uid(),
      name: (name || filePath.split(/[/\\]/).pop()).substring(0, 24),
      visible: true, locked: false, opacity: 1, blendMode: "source-over",
      x: Math.round(this.width / 2 - (img.width * scale) / 2),
      y: Math.round(this.height / 2 - (img.height * scale) / 2),
      scaleX: scale, scaleY: scale, rotation: 0, clipPath: null,
      _img: img, _imgWidth: img.width, _imgHeight: img.height,
    };
    this.layers.unshift(layer);
    this.selectedLayerId = layer.id;
    return { id: layer.id, name: layer.name, width: img.width, height: img.height, scale };
  }

  async addImageFromBase64(base64, name = "Imported") {
    const buf = Buffer.from(base64, "base64");
    const img = await loadImage(buf);
    let scale = 1;
    if (img.width > this.width * 0.8) scale = (this.width * 0.6) / img.width;
    if (img.height * scale > this.height * 0.8) scale = (this.height * 0.6) / img.height;
    const layer = {
      id: uid(),
      name: name.substring(0, 24),
      visible: true, locked: false, opacity: 1, blendMode: "source-over",
      x: Math.round(this.width / 2 - (img.width * scale) / 2),
      y: Math.round(this.height / 2 - (img.height * scale) / 2),
      scaleX: scale, scaleY: scale, rotation: 0, clipPath: null,
      _img: img, _imgWidth: img.width, _imgHeight: img.height,
    };
    this.layers.unshift(layer);
    this.selectedLayerId = layer.id;
    return { id: layer.id, name: layer.name, width: img.width, height: img.height, scale };
  }

  listLayers() {
    return this.layers.map(l => ({
      id: l.id, name: l.name, visible: l.visible, locked: l.locked,
      opacity: l.opacity, blendMode: l.blendMode, x: l.x, y: l.y,
      scaleX: l.scaleX, scaleY: l.scaleY, rotation: l.rotation,
      width: l._imgWidth, height: l._imgHeight,
      selected: l.id === this.selectedLayerId,
    }));
  }

  selectLayer(id) {
    const l = this.layers.find(l => l.id === id);
    if (l) { this.selectedLayerId = id; return true; }
    return false;
  }

  updateLayer(id, props) {
    const l = this.layers.find(l => l.id === id);
    if (!l) return false;
    const allowed = ["visible", "locked", "opacity", "blendMode", "x", "y", "scaleX", "scaleY", "rotation"];
    for (const k of allowed) { if (props[k] !== undefined) l[k] = props[k]; }
    return true;
  }

  deleteLayer(id) {
    const idx = this.layers.findIndex(l => l.id === id);
    if (idx < 0) return false;
    this.layers.splice(idx, 1);
    if (this.selectedLayerId === id) this.selectedLayerId = this.layers[0]?.id || null;
    return true;
  }

  duplicateLayer(id) {
    const l = this.layers.find(l => l.id === id);
    if (!l) return null;
    const nl = { ...l, id: uid(), name: l.name + " copy", x: l.x + 20, y: l.y + 20 };
    this.layers.unshift(nl);
    this.selectedLayerId = nl.id;
    return { id: nl.id, name: nl.name };
  }

  reorderLayer(id, direction) {
    const i = this.layers.findIndex(l => l.id === id);
    if (i < 0) return false;
    const t = direction === "up" ? i - 1 : i + 1;
    if (t < 0 || t >= this.layers.length) return false;
    [this.layers[i], this.layers[t]] = [this.layers[t], this.layers[i]];
    return true;
  }

  // ── Effects ──

  applyEffect(layerId, effectName) {
    const l = this.layers.find(l => l.id === (layerId || this.selectedLayerId));
    if (!l || !l._img) return false;
    const fn = EFFECTS[effectName];
    if (!fn) return false;
    const w = l._imgWidth, h = l._imgHeight;
    const tc = createCanvas(w, h);
    const tctx = tc.getContext("2d");
    tctx.drawImage(l._img, 0, 0);
    const imgData = tctx.getImageData(0, 0, w, h);
    fn(imgData.data, w, h);
    tctx.putImageData(imgData, 0, 0);
    l._img = tc;
    return true;
  }

  // ── Render / Snapshot ──

  render() {
    const canvas = createCanvas(this.width, this.height);
    const ctx = canvas.getContext("2d");

    // Checkerboard background
    const sz = 16;
    for (let y = 0; y < this.height; y += sz) {
      for (let x = 0; x < this.width; x += sz) {
        ctx.fillStyle = ((x / sz + y / sz) % 2 === 0) ? "#1a1a2e" : "#16162a";
        ctx.fillRect(x, y, sz, sz);
      }
    }

    // Layers (bottom to top)
    const sorted = [...this.layers].reverse();
    for (const layer of sorted) {
      if (!layer.visible || !layer._img) continue;
      ctx.save();
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = layer.blendMode || "source-over";
      const w = layer._imgWidth * layer.scaleX;
      const h = layer._imgHeight * layer.scaleY;
      ctx.translate(layer.x + w / 2, layer.y + h / 2);
      ctx.rotate((layer.rotation * Math.PI) / 180);
      ctx.translate(-w / 2, -h / 2);
      ctx.drawImage(layer._img, 0, 0, w, h);
      ctx.restore();
    }

    // Dream overlay
    if (this.dream?.canvas) {
      const dr = this.dream.region;
      ctx.save();
      ctx.globalAlpha = 0.92;
      ctx.drawImage(this.dream.canvas, dr.x, dr.y, dr.w, dr.h);
      ctx.restore();
    }

    return canvas;
  }

  snapshot(format = "png") {
    const canvas = this.render();
    return canvas.toBuffer(`image/${format}`);
  }

  snapshotBase64(format = "png") {
    return this.snapshot(format).toString("base64");
  }

  // ── Dream Mode ──

  dreamStart({ preset = "coral", region, seedMode = "random", seedLayerId, colormap = "organic", resolution = 200, warpStrength = 15 }) {
    if (!region || region.w < 10 || region.h < 10) {
      // Default to full canvas
      region = { x: 0, y: 0, w: this.width, h: this.height };
    }
    const p = RD_PRESETS[preset] || RD_PRESETS.coral;
    const aspect = region.w / region.h;
    const rdW = resolution;
    const rdH = Math.max(10, Math.round(resolution / aspect));
    const rd = new ReactionDiffusion(rdW, rdH);
    rd.setParams(p.f, p.k, p.Du, p.Dv);

    let srcPixels = null;
    let srcW = 0, srcH = 0;

    if (seedMode === "image" || colormap === "warp") {
      // Render visible layers into the dream region
      const tc = createCanvas(Math.round(region.w), Math.round(region.h));
      const tctx = tc.getContext("2d");
      const layerToSeed = seedLayerId ? this.layers.find(l => l.id === seedLayerId) : null;
      const seedLayers = layerToSeed ? [layerToSeed] : [...this.layers].reverse().filter(l => l.visible && l._img);
      for (const layer of seedLayers) {
        tctx.save();
        tctx.globalAlpha = layer.opacity;
        tctx.globalCompositeOperation = layer.blendMode || "source-over";
        tctx.translate(-region.x, -region.y);
        const w = layer._imgWidth * layer.scaleX;
        const h = layer._imgHeight * layer.scaleY;
        tctx.translate(layer.x + w / 2, layer.y + h / 2);
        tctx.rotate((layer.rotation * Math.PI) / 180);
        tctx.translate(-w / 2, -h / 2);
        tctx.drawImage(layer._img, 0, 0, w, h);
        tctx.restore();
      }
      const imgData = tctx.getImageData(0, 0, tc.width, tc.height);
      srcPixels = new Uint8ClampedArray(imgData.data);
      srcW = tc.width;
      srcH = tc.height;
      if (seedMode === "image") {
        rd.seedFromImageData(imgData.data, tc.width, tc.height);
      }
    }

    if (seedMode === "random" || (seedMode === "image" && !srcPixels)) {
      rd.seedRandom(15);
    }

    const dreamCanvas = createCanvas(rdW, rdH);
    this.dream = {
      rd, region, colormap, warpStrength, preset,
      canvas: dreamCanvas, srcPixels, srcW, srcH,
    };
    return { width: rdW, height: rdH, preset, colormap, region };
  }

  dreamStep(steps = 50) {
    if (!this.dream) return null;
    const { rd, canvas, colormap, srcPixels, srcW, srcH, warpStrength } = this.dream;
    rd.stepN(steps);

    const ctx = canvas.getContext("2d");
    const imgData = ctx.createImageData(rd.w, rd.h);
    if (colormap === "warp" && srcPixels) {
      rd.renderWarp(imgData.data, srcPixels, srcW, srcH, warpStrength);
    } else {
      rd.render(imgData.data, colormap);
    }
    ctx.putImageData(imgData, 0, 0);

    return { iterations: rd.iterations };
  }

  dreamSnapshot() {
    if (!this.dream) return null;
    return this.dream.canvas.toBuffer("image/png").toString("base64");
  }

  dreamSetParams({ colormap, warpStrength, speed }) {
    if (!this.dream) return false;
    if (colormap !== undefined) this.dream.colormap = colormap;
    if (warpStrength !== undefined) this.dream.warpStrength = warpStrength;
    return true;
  }

  dreamPoke(x, y) {
    if (!this.dream) return false;
    const { rd, region } = this.dream;
    const rx = Math.floor(((x - region.x) / region.w) * rd.w);
    const ry = Math.floor(((y - region.y) / region.h) * rd.h);
    rd.seed(rx, ry, 5 + Math.floor(Math.random() * 5));
    return true;
  }

  dreamFreeze(name) {
    if (!this.dream) return null;
    const { canvas, region, preset } = this.dream;
    const oc = createCanvas(Math.round(region.w), Math.round(region.h));
    const octx = oc.getContext("2d");
    octx.drawImage(canvas, 0, 0, oc.width, oc.height);
    const layer = {
      id: uid(),
      name: name || `Dream:${RD_PRESETS[preset]?.name || preset}`,
      visible: true, locked: false, opacity: 1, blendMode: "source-over",
      x: region.x, y: region.y, scaleX: 1, scaleY: 1, rotation: 0, clipPath: null,
      _img: oc, _imgWidth: oc.width, _imgHeight: oc.height,
    };
    this.layers.unshift(layer);
    this.selectedLayerId = layer.id;
    this.dream = null;
    return { id: layer.id, name: layer.name, width: oc.width, height: oc.height };
  }

  dreamStop() {
    this.dream = null;
  }

  async exportToFile(filePath) {
    const { writeFile } = await import("fs/promises");
    const buf = this.snapshot("png");
    await writeFile(filePath, buf);
    return filePath;
  }
}
