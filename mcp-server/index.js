import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile, execSync } from "child_process";
import { readdir, readFile, mkdir, writeFile } from "fs/promises";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { MyceliumCanvas } from "./engine/canvas.js";
import { RD_PRESETS } from "./engine/rd.js";
import { COLORMAPS } from "./engine/colormaps.js";
import { EFFECTS } from "./engine/effects.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const SAM2_URL = "http://127.0.0.1:7861";
const COMFYUI_URL = "http://127.0.0.1:8000";

const server = new McpServer({
  name: "mycelium",
  version: "0.1.0",
});

// Single canvas instance (persistent across calls)
let canvas = new MyceliumCanvas(1200, 800);

// ── Canvas tools ──

server.tool(
  "mycelium_canvas_new",
  "Create a new blank canvas, discarding any existing work",
  { width: z.number().min(100).max(4000).default(1200).describe("Canvas width in pixels"),
    height: z.number().min(100).max(4000).default(800).describe("Canvas height in pixels") },
  async ({ width, height }) => {
    canvas = new MyceliumCanvas(width, height);
    return { content: [{ type: "text", text: `New canvas created: ${width}x${height}` }] };
  }
);

server.tool(
  "mycelium_canvas_snapshot",
  "Take a snapshot of the current canvas state. Returns the image so you can see what the composition looks like.",
  {},
  async () => {
    const b64 = canvas.snapshotBase64();
    return { content: [
      { type: "image", data: b64, mimeType: "image/png" },
      { type: "text", text: `Canvas snapshot: ${canvas.width}x${canvas.height}, ${canvas.layers.length} layers` },
    ] };
  }
);

server.tool(
  "mycelium_canvas_export",
  "Export the canvas to a PNG file on disk",
  { file_path: z.string().describe("Absolute path to save the PNG file") },
  async ({ file_path }) => {
    await canvas.exportToFile(file_path);
    return { content: [{ type: "text", text: `Exported to ${file_path}` }] };
  }
);

// ── Layer tools ──

server.tool(
  "mycelium_layer_add_image",
  "Add an image as a new layer. Provide either a file path or base64-encoded image data.",
  { file_path: z.string().optional().describe("Absolute path to an image file"),
    base64: z.string().optional().describe("Base64-encoded image data (PNG/JPG)"),
    name: z.string().optional().describe("Layer name") },
  async ({ file_path, base64, name }) => {
    let result;
    if (file_path) {
      result = await canvas.addImageFromFile(file_path, name);
    } else if (base64) {
      result = await canvas.addImageFromBase64(base64, name);
    } else {
      return { content: [{ type: "text", text: "Error: provide file_path or base64" }] };
    }
    return { content: [{ type: "text", text: `Added layer "${result.name}" (${result.id}): ${result.width}x${result.height} at scale ${result.scale.toFixed(2)}` }] };
  }
);

server.tool(
  "mycelium_layer_list",
  "List all layers with their properties",
  {},
  async () => {
    const layers = canvas.listLayers();
    if (layers.length === 0) return { content: [{ type: "text", text: "No layers. Add an image first." }] };
    const desc = layers.map((l, i) =>
      `${i}: ${l.selected ? ">" : " "} [${l.id}] "${l.name}" ${l.visible ? "visible" : "hidden"} ` +
      `opacity:${l.opacity} blend:${l.blendMode} pos:(${l.x},${l.y}) ` +
      `scale:${l.scaleX.toFixed(2)} rot:${l.rotation}° ${l.width}x${l.height}px`
    ).join("\n");
    return { content: [{ type: "text", text: desc }] };
  }
);

server.tool(
  "mycelium_layer_update",
  "Update properties of a layer (opacity, position, scale, rotation, blend mode, visibility)",
  { layer_id: z.string().describe("Layer ID"),
    opacity: z.number().min(0).max(1).optional(),
    x: z.number().optional(), y: z.number().optional(),
    scaleX: z.number().min(0.01).max(10).optional(),
    scaleY: z.number().min(0.01).max(10).optional(),
    rotation: z.number().min(0).max(360).optional(),
    blend_mode: z.enum(["source-over","multiply","screen","overlay","darken","lighten",
      "color-dodge","color-burn","hard-light","soft-light","difference","exclusion"]).optional(),
    visible: z.boolean().optional() },
  async ({ layer_id, blend_mode, ...props }) => {
    if (blend_mode) props.blendMode = blend_mode;
    const ok = canvas.updateLayer(layer_id, props);
    if (!ok) return { content: [{ type: "text", text: `Layer ${layer_id} not found` }] };
    return { content: [{ type: "text", text: `Updated layer ${layer_id}` }] };
  }
);

server.tool(
  "mycelium_layer_delete",
  "Delete a layer",
  { layer_id: z.string().describe("Layer ID to delete") },
  async ({ layer_id }) => {
    const ok = canvas.deleteLayer(layer_id);
    return { content: [{ type: "text", text: ok ? `Deleted ${layer_id}` : `Layer not found` }] };
  }
);

server.tool(
  "mycelium_layer_duplicate",
  "Duplicate a layer",
  { layer_id: z.string().describe("Layer ID to duplicate") },
  async ({ layer_id }) => {
    const result = canvas.duplicateLayer(layer_id);
    if (!result) return { content: [{ type: "text", text: "Layer not found" }] };
    return { content: [{ type: "text", text: `Duplicated as "${result.name}" (${result.id})` }] };
  }
);

server.tool(
  "mycelium_layer_reorder",
  "Move a layer up or down in the stack",
  { layer_id: z.string(), direction: z.enum(["up", "down"]) },
  async ({ layer_id, direction }) => {
    const ok = canvas.reorderLayer(layer_id, direction);
    return { content: [{ type: "text", text: ok ? `Moved ${layer_id} ${direction}` : "Can't move further" }] };
  }
);

// ── Layer Transform Operations ──

server.tool(
  "mycelium_layer_flip",
  "Flip a layer horizontally or vertically",
  { layer_id: z.string().optional().describe("Layer ID (defaults to selected)"),
    axis: z.enum(["h", "v"]).describe("'h' for horizontal, 'v' for vertical") },
  async ({ layer_id, axis }) => {
    const ok = canvas.flipLayer(layer_id, axis);
    return { content: [{ type: "text", text: ok ? `Flipped ${axis === "h" ? "horizontal" : "vertical"}` : "Layer not found" }] };
  }
);

server.tool(
  "mycelium_layer_rotate90",
  "Rotate a layer 90 degrees clockwise or counter-clockwise",
  { layer_id: z.string().optional().describe("Layer ID (defaults to selected)"),
    direction: z.enum(["cw", "ccw"]).describe("'cw' for clockwise, 'ccw' for counter-clockwise") },
  async ({ layer_id, direction }) => {
    const ok = canvas.rotateLayer90(layer_id, direction);
    return { content: [{ type: "text", text: ok ? `Rotated 90° ${direction}` : "Layer not found" }] };
  }
);

server.tool(
  "mycelium_layer_resize",
  "Resize a layer's image data to specific pixel dimensions",
  { layer_id: z.string().optional().describe("Layer ID (defaults to selected)"),
    width: z.number().int().positive().describe("New width in pixels"),
    height: z.number().int().positive().describe("New height in pixels") },
  async ({ layer_id, width, height }) => {
    const ok = canvas.resizeLayer(layer_id, width, height);
    return { content: [{ type: "text", text: ok ? `Resized to ${width}×${height}` : "Layer not found" }] };
  }
);

server.tool(
  "mycelium_layer_crop",
  "Crop a layer's image to a rectangular region (in image-space pixel coordinates)",
  { layer_id: z.string().optional().describe("Layer ID (defaults to selected)"),
    x: z.number().int().describe("Left edge of crop rectangle"),
    y: z.number().int().describe("Top edge of crop rectangle"),
    width: z.number().int().positive().describe("Crop width in pixels"),
    height: z.number().int().positive().describe("Crop height in pixels") },
  async ({ layer_id, x, y, width, height }) => {
    const ok = canvas.cropLayer(layer_id, x, y, width, height);
    return { content: [{ type: "text", text: ok ? `Cropped to ${width}×${height} at (${x},${y})` : "Layer not found" }] };
  }
);

server.tool(
  "mycelium_layer_flatten",
  "Flatten all visible layers into a single layer",
  {},
  async () => {
    const result = canvas.flattenLayers();
    return { content: [{ type: "text", text: `Flattened to "${result.name}" (${result.id})` }] };
  }
);

// ── Effects ──

server.tool(
  "mycelium_effect_apply",
  "Apply a pixel effect to a layer. Available effects: " + Object.keys(EFFECTS).join(", "),
  { effect: z.enum(Object.keys(EFFECTS)).describe("Effect name"),
    layer_id: z.string().optional().describe("Layer ID (defaults to selected layer)") },
  async ({ effect, layer_id }) => {
    const ok = canvas.applyEffect(layer_id, effect);
    if (!ok) return { content: [{ type: "text", text: "Failed — no valid layer or unknown effect" }] };
    return { content: [{ type: "text", text: `Applied ${effect}` }] };
  }
);

// ── Dream Mode ──

server.tool(
  "mycelium_dream_start",
  "Start a reaction-diffusion dream simulation. Patterns grow organically from seeds. " +
  "Use 'warp' colormap to displace the source image pixels with the RD field. " +
  "Presets: " + Object.keys(RD_PRESETS).join(", ") + ". " +
  "Colormaps: " + [...Object.keys(COLORMAPS), "image", "warp"].join(", "),
  { preset: z.enum(Object.keys(RD_PRESETS)).default("coral"),
    seed_mode: z.enum(["random", "image"]).default("random").describe("'image' seeds from layer pixels (dark=strong)"),
    seed_layer_id: z.string().optional().describe("Specific layer to seed from (for image mode)"),
    colormap: z.enum([...Object.keys(COLORMAPS), "image", "warp"]).default("organic"),
    resolution: z.number().min(50).max(500).default(200),
    warp_strength: z.number().min(1).max(80).default(15).describe("Displacement strength for warp mode"),
    region_x: z.number().optional(), region_y: z.number().optional(),
    region_w: z.number().optional(), region_h: z.number().optional() },
  async ({ preset, seed_mode, seed_layer_id, colormap, resolution, warp_strength,
           region_x, region_y, region_w, region_h }) => {
    const region = (region_w && region_h)
      ? { x: region_x || 0, y: region_y || 0, w: region_w, h: region_h }
      : null;
    const result = canvas.dreamStart({
      preset, region, seedMode: seed_mode, seedLayerId: seed_layer_id,
      colormap, resolution, warpStrength: warp_strength,
    });
    return { content: [{ type: "text", text:
      `Dream started: ${result.preset} at ${result.width}x${result.height}, ` +
      `colormap=${result.colormap}, region=(${result.region.x},${result.region.y},${result.region.w},${result.region.h})` }] };
  }
);

server.tool(
  "mycelium_dream_step",
  "Advance the dream simulation by N steps and return a snapshot of the dream region. " +
  "More steps = more evolved patterns. Typical: 50-200 for incremental, 500+ for significant evolution.",
  { steps: z.number().min(1).max(5000).default(100).describe("Number of simulation steps to run") },
  async ({ steps }) => {
    const result = canvas.dreamStep(steps);
    if (!result) return { content: [{ type: "text", text: "No active dream. Start one first." }] };
    const b64 = canvas.dreamSnapshot();
    return { content: [
      { type: "image", data: b64, mimeType: "image/png" },
      { type: "text", text: `Dream at iteration ${result.iterations}` },
    ] };
  }
);

server.tool(
  "mycelium_dream_set_params",
  "Change dream parameters while running (colormap, warp strength)",
  { colormap: z.enum([...Object.keys(COLORMAPS), "image", "warp"]).optional(),
    warp_strength: z.number().min(1).max(80).optional() },
  async (params) => {
    const ok = canvas.dreamSetParams({ colormap: params.colormap, warpStrength: params.warp_strength });
    if (!ok) return { content: [{ type: "text", text: "No active dream" }] };
    return { content: [{ type: "text", text: "Dream params updated" }] };
  }
);

server.tool(
  "mycelium_dream_poke",
  "Inject a new seed point into the active dream at canvas coordinates",
  { x: z.number(), y: z.number() },
  async ({ x, y }) => {
    const ok = canvas.dreamPoke(x, y);
    return { content: [{ type: "text", text: ok ? `Poked at (${x}, ${y})` : "No active dream" }] };
  }
);

server.tool(
  "mycelium_dream_freeze",
  "Freeze the current dream state as a new layer. This captures the RD pattern and adds it to the layer stack.",
  { name: z.string().optional().describe("Name for the frozen layer") },
  async ({ name }) => {
    const result = canvas.dreamFreeze(name);
    if (!result) return { content: [{ type: "text", text: "No active dream to freeze" }] };
    return { content: [{ type: "text", text: `Frozen as "${result.name}" (${result.id}): ${result.width}x${result.height}` }] };
  }
);

server.tool(
  "mycelium_dream_stop",
  "Stop and discard the current dream without freezing",
  {},
  async () => { canvas.dreamStop(); return { content: [{ type: "text", text: "Dream stopped" }] }; }
);

// ── Composite workflow tool ──

server.tool(
  "mycelium_dream_evolve_and_snapshot",
  "Combined tool: run dream for N steps, freeze to layer, then take a full canvas snapshot. " +
  "Use this to see how a dream looks composited with all other layers.",
  { steps: z.number().min(1).max(5000).default(200),
    freeze: z.boolean().default(false).describe("If true, freeze to layer after stepping"),
    freeze_name: z.string().optional() },
  async ({ steps, freeze, freeze_name }) => {
    const stepResult = canvas.dreamStep(steps);
    if (!stepResult) return { content: [{ type: "text", text: "No active dream" }] };
    let frozenInfo = "";
    if (freeze) {
      const fr = canvas.dreamFreeze(freeze_name);
      if (fr) frozenInfo = ` Frozen as "${fr.name}".`;
    }
    const b64 = canvas.snapshotBase64();
    return { content: [
      { type: "image", data: b64, mimeType: "image/png" },
      { type: "text", text: `Iteration ${stepResult.iterations}.${frozenInfo} Full canvas snapshot.` },
    ] };
  }
);

// ── Layer select ──

server.tool(
  "mycelium_layer_select",
  "Select a layer as the active/current layer",
  { layer_id: z.string().describe("Layer ID to select") },
  async ({ layer_id }) => {
    const ok = canvas.selectLayer(layer_id);
    return { content: [{ type: "text", text: ok ? `Selected ${layer_id}` : "Layer not found" }] };
  }
);

// ── Image search ──

server.tool(
  "mycelium_image_search",
  "Search for images online and download them to disk. Sources: openverse (no API key), unsplash, pexels. " +
  "Returns file paths of downloaded images which can then be added as layers.",
  { query: z.string().describe("Search query"),
    count: z.number().min(1).max(10).default(3).describe("Number of images to download"),
    source: z.enum(["openverse", "unsplash", "pexels"]).default("openverse"),
    orientation: z.enum(["landscape", "portrait", "square"]).optional(),
    download_dir: z.string().optional().describe("Download directory (default: tools/image-search/downloads)") },
  async ({ query, count, source, orientation, download_dir }) => {
    const searchScript = join(PROJECT_ROOT, "tools", "image-search", "index.js");
    const args = [searchScript, query, "--count", String(count), "--source", source, "--format", "json"];
    if (orientation) args.push("--orientation", orientation);
    if (download_dir) args.push("--dir", download_dir);

    return new Promise((res) => {
      execFile("node", args, { maxBuffer: 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
        if (err) {
          return res({ content: [{ type: "text", text: `Search failed: ${err.message}\n${stderr}` }] });
        }
        try {
          const data = JSON.parse(stdout);
          const summary = data.results.map((r, i) =>
            `${i + 1}. ${r.filename} (${r.width}x${r.height}) — "${r.title}" by ${r.credit} [${r.license}]\n   ${r.path}`
          ).join("\n");
          return res({ content: [{ type: "text", text: `Downloaded ${data.results.length} images for "${query}":\n${summary}` }] });
        } catch {
          return res({ content: [{ type: "text", text: `Search output:\n${stdout}` }] });
        }
      });
    });
  }
);

// ── Style guides ──

server.tool(
  "mycelium_style_guide_list",
  "List available style guide JSON files",
  {},
  async () => {
    const dir = join(PROJECT_ROOT, "style-guides");
    try {
      const files = (await readdir(dir)).filter(f => f.endsWith(".json"));
      if (files.length === 0) return { content: [{ type: "text", text: "No style guides found" }] };
      return { content: [{ type: "text", text: `Style guides:\n${files.map(f => `  - ${f}`).join("\n")}` }] };
    } catch {
      return { content: [{ type: "text", text: "style-guides/ directory not found" }] };
    }
  }
);

server.tool(
  "mycelium_style_guide_load",
  "Load a style guide JSON and return its contents. Use this to understand the artistic direction for a session.",
  { filename: z.string().describe("Style guide filename (e.g. '2026-03-12-dore-goya-nordic-black.json')") },
  async ({ filename }) => {
    const filePath = join(PROJECT_ROOT, "style-guides", filename);
    try {
      const data = await readFile(filePath, "utf-8");
      return { content: [{ type: "text", text: data }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to load: ${err.message}` }] };
    }
  }
);

// ── ComfyUI inpainting ──

server.tool(
  "mycelium_comfyui_status",
  "Check if ComfyUI is running and reachable",
  {},
  async () => {
    try {
      const r = await fetch(`${COMFYUI_URL}/system_stats`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        const stats = await r.json();
        return { content: [{ type: "text", text: `ComfyUI is running.\n${JSON.stringify(stats, null, 2)}` }] };
      }
      return { content: [{ type: "text", text: `ComfyUI responded with status ${r.status}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ComfyUI not reachable at ${COMFYUI_URL}: ${err.message}` }] };
    }
  }
);

server.tool(
  "mycelium_comfyui_inpaint",
  "Run AI inpainting on a region of the canvas using ComfyUI. " +
  "Renders the current canvas region, creates a mask, sends to ComfyUI, and adds the result as a new layer. " +
  "Requires ComfyUI running locally. Workflows: sd15-inpaint (4GB VRAM), sdxl-inpaint-8g (8GB VRAM).",
  { prompt: z.string().describe("What to paint in the masked region"),
    negative_prompt: z.string().default("blurry, low quality, watermark, text, logo, cropped, deformed"),
    workflow: z.enum(["sd15-inpaint", "sdxl-inpaint-8g"]).default("sd15-inpaint"),
    region_x: z.number().describe("Region X coordinate on canvas"),
    region_y: z.number().describe("Region Y coordinate on canvas"),
    region_w: z.number().min(64).describe("Region width"),
    region_h: z.number().min(64).describe("Region height"),
    denoise: z.number().min(0).max(1).default(0.75).describe("Denoising strength (higher = more change)"),
    steps: z.number().min(1).max(50).default(25),
    cfg: z.number().min(1).max(20).default(7),
    layer_name: z.string().optional().describe("Name for the result layer") },
  async ({ prompt, negative_prompt, workflow, region_x, region_y, region_w, region_h, denoise, steps, cfg, layer_name }) => {
    const { createCanvas: makeCanvas } = await import("@napi-rs/canvas");

    // 1. Render the canvas region as the source image
    const fullCanvas = canvas.render();
    const regionCanvas = makeCanvas(Math.round(region_w), Math.round(region_h));
    const rctx = regionCanvas.getContext("2d");
    rctx.drawImage(fullCanvas, region_x, region_y, region_w, region_h, 0, 0, region_w, region_h);
    const srcB64 = regionCanvas.toBuffer("image/png").toString("base64");
    const srcDataUrl = `data:image/png;base64,${srcB64}`;

    // 2. Create a white mask (inpaint entire region)
    const maskCanvas = makeCanvas(Math.round(region_w), Math.round(region_h));
    const mctx = maskCanvas.getContext("2d");
    mctx.fillStyle = "white";
    mctx.fillRect(0, 0, region_w, region_h);
    const maskB64 = maskCanvas.toBuffer("image/png").toString("base64");
    const maskDataUrl = `data:image/png;base64,${maskB64}`;

    // 3. Load workflow template
    const workflowPath = join(PROJECT_ROOT, "comfyui-workflows",
      workflow === "sdxl-inpaint-8g" ? "sdxl-inpaint-8gb.json" : "sd15-inpaint.json");
    const workflowTemplate = JSON.parse(await readFile(workflowPath, "utf-8"));

    // 4. Upload images to ComfyUI
    try {
      const ts = Date.now();

      async function uploadImage(dataUrl, filename) {
        const raw = Buffer.from(dataUrl.split(",")[1], "base64");
        const boundary = "----mcpboundary" + ts;
        const crlf = "\r\n";
        const parts = [
          `--${boundary}${crlf}Content-Disposition: form-data; name="image"; filename="${filename}"${crlf}Content-Type: image/png${crlf}${crlf}`,
        ];
        const header = Buffer.from(parts[0]);
        const footer = Buffer.from(`${crlf}--${boundary}--${crlf}`);
        const body = Buffer.concat([header, raw, footer]);

        const r = await fetch(`${COMFYUI_URL}/upload/image`, {
          method: "POST",
          headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
          body,
        });
        if (!r.ok) throw new Error(`Upload failed: ${r.status}`);
        const data = await r.json();
        return data.name;
      }

      const [imgName, maskName] = await Promise.all([
        uploadImage(srcDataUrl, `mycelium_src_${ts}.png`),
        uploadImage(maskDataUrl, `mycelium_msk_${ts}.png`),
      ]);

      // 5. Fill template and queue
      let json = JSON.stringify(workflowTemplate);
      const subs = {
        INPUT_IMAGE: imgName, MASK: maskName,
        POSITIVE_PROMPT: prompt, NEGATIVE_PROMPT: negative_prompt,
      };
      for (const [key, val] of Object.entries(subs)) {
        const escaped = String(val).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        json = json.replaceAll(`__${key}__`, escaped);
      }
      for (const [key, val] of Object.entries({ DENOISE: denoise, STEPS: steps, CFG: cfg, SEED: Math.floor(Math.random() * 2 ** 31) })) {
        json = json.replaceAll(`"__${key}__"`, String(val));
      }
      const filledWorkflow = JSON.parse(json);

      const qr = await fetch(`${COMFYUI_URL}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: filledWorkflow }),
      });
      if (!qr.ok) throw new Error(`Queue failed: ${qr.status} — ${await qr.text()}`);
      const { prompt_id } = await qr.json();

      // 6. Poll for result
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000));
        const hr = await fetch(`${COMFYUI_URL}/history/${prompt_id}`);
        if (!hr.ok) continue;
        const history = await hr.json();
        const entry = history[prompt_id];
        if (!entry) continue;
        if (entry.status?.status_str === "error") {
          throw new Error("ComfyUI generation error");
        }
        for (const nodeOutput of Object.values(entry.outputs ?? {})) {
          const imgs = nodeOutput.images;
          if (!imgs?.length) continue;
          const img = imgs[0];
          const imgUrl = `${COMFYUI_URL}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder ?? "")}&type=${img.type ?? "output"}`;
          const imgResp = await fetch(imgUrl);
          const imgBuf = Buffer.from(await imgResp.arrayBuffer());
          const resultB64 = imgBuf.toString("base64");

          // 7. Add result as layer
          const result = await canvas.addImageFromBase64(resultB64, layer_name || `Inpaint: ${prompt.slice(0, 20)}`);
          canvas.updateLayer(result.id, { x: region_x, y: region_y, scaleX: region_w / result.width, scaleY: region_h / result.height });

          const snapshot = canvas.snapshotBase64();
          return { content: [
            { type: "image", data: snapshot, mimeType: "image/png" },
            { type: "text", text: `Inpainted "${prompt}" → layer "${result.name}" (${result.id})` },
          ] };
        }
      }
      return { content: [{ type: "text", text: "ComfyUI timed out waiting for result" }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ComfyUI inpaint failed: ${err.message}` }] };
    }
  }
);

// ── ComfyUI img2img ──

server.tool(
  "mycelium_comfyui_img2img",
  "Run AI image-to-image transformation on a layer using ComfyUI. " +
  "Takes an existing layer as input, applies a text prompt to transform it, and adds the result as a new layer. " +
  "Uses the ZImage Turbo model (GGUF) for fast generation. " +
  "Requires ComfyUI running locally with ZImage model loaded.",
  { prompt: z.string().describe("Text prompt describing the desired transformation"),
    negative_prompt: z.string().default("blurry, low quality, watermark, text, logo, cropped, deformed"),
    layer_id: z.string().optional().describe("Layer to use as source image (defaults to selected layer)"),
    denoise: z.number().min(0).max(1).default(0.5).describe("Denoising strength — lower preserves more of the original (0.3–0.5 for subtle, 0.7+ for heavy changes)"),
    steps: z.number().min(1).max(50).default(6).describe("Sampling steps (ZImage Turbo works well with 4–8 steps)"),
    cfg: z.number().min(0).max(20).default(1).describe("CFG scale (ZImage Turbo typically uses 1)"),
    layer_name: z.string().optional().describe("Name for the result layer") },
  async ({ prompt, negative_prompt, layer_id, denoise, steps, cfg, layer_name }) => {
    const { createCanvas: makeCanvas } = await import("@napi-rs/canvas");

    // Find source layer
    const lid = layer_id || canvas.selectedLayerId;
    const layer = canvas.layers.find(l => l.id === lid);
    if (!layer || !layer._img) return { content: [{ type: "text", text: "Layer not found or has no image" }] };

    // Render layer to PNG
    const w = layer._imgWidth, h = layer._imgHeight;
    const tc = makeCanvas(w, h);
    tc.getContext("2d").drawImage(layer._img, 0, 0);
    const srcB64 = tc.toBuffer("image/png").toString("base64");
    const srcDataUrl = `data:image/png;base64,${srcB64}`;

    // Load workflow template
    const workflowPath = join(PROJECT_ROOT, "comfyui-workflows", "zimage_img2img_barebones.json");

    try {
      const workflowTemplate = JSON.parse(await readFile(workflowPath, "utf-8"));
      const ts = Date.now();

      // Upload source image
      async function uploadImage(dataUrl, filename) {
        const raw = Buffer.from(dataUrl.split(",")[1], "base64");
        const boundary = "----mcpboundary" + ts;
        const crlf = "\r\n";
        const header = Buffer.from(
          `--${boundary}${crlf}Content-Disposition: form-data; name="image"; filename="${filename}"${crlf}Content-Type: image/png${crlf}${crlf}`
        );
        const footer = Buffer.from(`${crlf}--${boundary}--${crlf}`);
        const body = Buffer.concat([header, raw, footer]);

        const r = await fetch(`${COMFYUI_URL}/upload/image`, {
          method: "POST",
          headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
          body,
        });
        if (!r.ok) throw new Error(`Upload failed: ${r.status}`);
        const data = await r.json();
        return data.name;
      }

      const imgName = await uploadImage(srcDataUrl, `mycelium_img2img_${ts}.png`);

      // Fill template and queue
      let json = JSON.stringify(workflowTemplate);
      const stringSubs = { INPUT_IMAGE: imgName, POSITIVE_PROMPT: prompt, NEGATIVE_PROMPT: negative_prompt };
      for (const [key, val] of Object.entries(stringSubs)) {
        const escaped = String(val).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        json = json.replaceAll(`__${key}__`, escaped);
      }
      for (const [key, val] of Object.entries({ DENOISE: denoise, STEPS: steps, CFG: cfg, SEED: Math.floor(Math.random() * 2 ** 31) })) {
        json = json.replaceAll(`"__${key}__"`, String(val));
      }
      const filledWorkflow = JSON.parse(json);

      const qr = await fetch(`${COMFYUI_URL}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: filledWorkflow }),
      });
      if (!qr.ok) throw new Error(`Queue failed: ${qr.status} — ${await qr.text()}`);
      const { prompt_id } = await qr.json();

      // Poll for result
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000));
        const hr = await fetch(`${COMFYUI_URL}/history/${prompt_id}`);
        if (!hr.ok) continue;
        const history = await hr.json();
        const entry = history[prompt_id];
        if (!entry) continue;
        if (entry.status?.status_str === "error") {
          throw new Error("ComfyUI generation error");
        }
        for (const nodeOutput of Object.values(entry.outputs ?? {})) {
          const imgs = nodeOutput.images;
          if (!imgs?.length) continue;
          const img = imgs[0];
          const imgUrl = `${COMFYUI_URL}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder ?? "")}&type=${img.type ?? "output"}`;
          const imgResp = await fetch(imgUrl);
          const imgBuf = Buffer.from(await imgResp.arrayBuffer());
          const resultB64 = imgBuf.toString("base64");

          // Add result as new layer, positioned like the source
          const result = await canvas.addImageFromBase64(resultB64, layer_name || `${layer.name} (AI)`);
          canvas.updateLayer(result.id, {
            x: layer.x, y: layer.y,
            scaleX: (layer._imgWidth * layer.scaleX) / result.width,
            scaleY: (layer._imgHeight * layer.scaleY) / result.height,
            rotation: layer.rotation,
          });

          const snapshot = canvas.snapshotBase64();
          return { content: [
            { type: "image", data: snapshot, mimeType: "image/png" },
            { type: "text", text: `Img2img "${prompt}" on "${layer.name}" → layer "${result.name}" (${result.id})` },
          ] };
        }
      }
      return { content: [{ type: "text", text: "ComfyUI timed out waiting for result" }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ComfyUI img2img failed: ${err.message}` }] };
    }
  }
);

// ── ComfyUI TTS (Qwen3 voice clone) ──

server.tool(
  "mycelium_comfyui_tts",
  "Generate speech audio using Qwen3 TTS voice cloning via ComfyUI. " +
  "Provide a reference audio file + its transcript for voice cloning, then specify the target text to speak. " +
  "Returns the path to the generated audio file (FLAC). " +
  "Requires ComfyUI running with Qwen3 TTS nodes installed.",
  {
    target_text: z.string().describe("The text to speak in the cloned voice"),
    reference_audio: z.string().describe("Filename of reference audio already in ComfyUI input/ folder, OR absolute path to upload"),
    ref_text: z.string().describe("Transcript of the reference audio (what is said in it)"),
    language: z.enum(["English", "Chinese", "Japanese", "Korean", "French", "German", "Spanish", "Italian", "Portuguese", "Russian"]).default("English"),
    temperature: z.number().min(0.1).max(2.0).default(1.0).describe("Generation temperature (lower = more stable, higher = more expressive)"),
    repetition_penalty: z.number().min(1.0).max(2.0).default(1.05),
    max_tokens: z.number().min(512).max(4096).default(512).describe("Max new tokens for generation (min 512, ~42s at 12Hz)"),
    seed: z.number().optional().describe("Random seed (omit for random)"),
    output_prefix: z.string().default("mycelium_tts").describe("Filename prefix for the output audio"),
  },
  async ({ target_text, reference_audio, ref_text, language, temperature, repetition_penalty, max_tokens, seed, output_prefix }) => {
    try {
      const ts = Date.now();
      let audioFilename = reference_audio;

      // If it looks like an absolute path, upload the audio to ComfyUI
      if (reference_audio.includes("/") || reference_audio.includes("\\")) {
        const audioData = await readFile(reference_audio);
        const boundary = "----mcpboundary" + ts;
        const crlf = "\r\n";
        const ext = reference_audio.split(".").pop() || "wav";
        const uploadName = `mycelium_ref_${ts}.${ext}`;
        const header = Buffer.from(
          `--${boundary}${crlf}Content-Disposition: form-data; name="image"; filename="${uploadName}"${crlf}Content-Type: audio/${ext}${crlf}${crlf}`
        );
        const footer = Buffer.from(`${crlf}--${boundary}--${crlf}`);
        const body = Buffer.concat([header, audioData, footer]);

        const r = await fetch(`${COMFYUI_URL}/upload/image`, {
          method: "POST",
          headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
          body,
        });
        if (!r.ok) throw new Error(`Audio upload failed: ${r.status} ${await r.text()}`);
        const data = await r.json();
        audioFilename = data.name;
      }

      // Load and fill workflow template
      const workflowPath = join(PROJECT_ROOT, "comfyui-workflows", "qwen3_tts_barebones.json");
      const workflowTemplate = JSON.parse(await readFile(workflowPath, "utf-8"));

      let json = JSON.stringify(workflowTemplate);
      const stringSubs = {
        REFERENCE_AUDIO: audioFilename,
        REF_TEXT: ref_text,
        TARGET_TEXT: target_text,
        LANGUAGE: language,
        FILENAME_PREFIX: output_prefix,
      };
      for (const [key, val] of Object.entries(stringSubs)) {
        const escaped = String(val).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        json = json.replaceAll(`__${key}__`, escaped);
      }
      const numSubs = {
        SEED: seed ?? Math.floor(Math.random() * 2 ** 31),
        MAX_TOKENS: max_tokens,
        TEMPERATURE: temperature,
        REPETITION_PENALTY: repetition_penalty,
      };
      for (const [key, val] of Object.entries(numSubs)) {
        json = json.replaceAll(`"__${key}__"`, String(val));
      }
      const filledWorkflow = JSON.parse(json);

      // Queue workflow
      const qr = await fetch(`${COMFYUI_URL}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: filledWorkflow }),
      });
      if (!qr.ok) throw new Error(`Queue failed: ${qr.status} — ${await qr.text()}`);
      const { prompt_id } = await qr.json();

      // Poll for result — audio comes from SaveAudio node
      const deadline = Date.now() + 300_000; // 5 min timeout for TTS
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 3000));
        const hr = await fetch(`${COMFYUI_URL}/history/${prompt_id}`);
        if (!hr.ok) continue;
        const history = await hr.json();
        const entry = history[prompt_id];
        if (!entry) continue;
        if (entry.status?.status_str === "error") {
          throw new Error("ComfyUI TTS generation error");
        }

        // Look for audio outputs in any node
        for (const nodeOutput of Object.values(entry.outputs ?? {})) {
          const audios = nodeOutput.audio || nodeOutput.gifs; // ComfyUI audio can be under .audio or .gifs
          if (!audios?.length) continue;
          const audio = audios[0];
          const audioUrl = `${COMFYUI_URL}/view?filename=${encodeURIComponent(audio.filename)}&subfolder=${encodeURIComponent(audio.subfolder ?? "")}&type=${audio.type ?? "output"}`;
          const audioResp = await fetch(audioUrl);
          const audioBuf = Buffer.from(await audioResp.arrayBuffer());

          // Save locally
          const localDir = join(PROJECT_ROOT, "output");
          await mkdir(localDir, { recursive: true });
          const ext = audio.filename.split(".").pop() || "flac";
          const localPath = join(localDir, `${output_prefix}_${ts}.${ext}`);
          await writeFile(localPath, audioBuf);

          return { content: [
            { type: "text", text: `TTS generated: ${localPath}\nVoice: cloned from "${audioFilename}"\nText: "${target_text.slice(0, 80)}${target_text.length > 80 ? "..." : ""}"` },
          ] };
        }
      }
      return { content: [{ type: "text", text: "ComfyUI TTS timed out waiting for result" }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ComfyUI TTS failed: ${err.message}` }] };
    }
  }
);

// ── SAM2 segmentation ──

server.tool(
  "mycelium_sam2_status",
  "Check if the SAM2 segmentation server is running",
  {},
  async () => {
    try {
      const r = await fetch(`${SAM2_URL}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        const data = await r.json();
        return { content: [{ type: "text", text: `SAM2 server running on ${data.device}${data.gpu ? ` (${data.gpu})` : ""}` }] };
      }
      return { content: [{ type: "text", text: `SAM2 responded with status ${r.status}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `SAM2 not reachable at ${SAM2_URL}: ${err.message}` }] };
    }
  }
);

server.tool(
  "mycelium_sam2_segment",
  "Use SAM2 AI to segment an object from a layer by clicking a point. " +
  "Embeds the layer image, predicts a mask at the click point, and creates a new masked layer. " +
  "Requires SAM2 server running (python tools/sam2-server/server.py).",
  { layer_id: z.string().optional().describe("Layer to segment (defaults to selected)"),
    point_x: z.number().describe("X coordinate on the layer image (in layer pixel coords)"),
    point_y: z.number().describe("Y coordinate on the layer image (in layer pixel coords)"),
    foreground: z.boolean().default(true).describe("true=select object, false=exclude region"),
    layer_name: z.string().optional().describe("Name for the segmented layer") },
  async ({ layer_id, point_x, point_y, foreground, layer_name }) => {
    const { createCanvas: makeCanvas } = await import("@napi-rs/canvas");

    // Find layer
    const lid = layer_id || canvas.selectedLayerId;
    const layer = canvas.layers.find(l => l.id === lid);
    if (!layer || !layer._img) return { content: [{ type: "text", text: "Layer not found" }] };

    // Render layer to PNG
    const w = layer._imgWidth, h = layer._imgHeight;
    const tc = makeCanvas(w, h);
    tc.getContext("2d").drawImage(layer._img, 0, 0);
    const b64 = tc.toBuffer("image/png").toString("base64");
    const dataUrl = `data:image/png;base64,${b64}`;

    try {
      // Embed image
      const embedResp = await fetch(`${SAM2_URL}/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: dataUrl }),
      });
      if (!embedResp.ok) throw new Error(`Embed failed: ${embedResp.status}`);
      const { session_id } = await embedResp.json();

      // Predict mask
      const predResp = await fetch(`${SAM2_URL}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id, point_x, point_y, label: foreground ? 1 : 0 }),
      });
      if (!predResp.ok) throw new Error(`Predict failed: ${predResp.status}`);
      const { mask: maskDataUrl, score } = await predResp.json();

      // Clean up session
      fetch(`${SAM2_URL}/session/${session_id}`, { method: "DELETE" }).catch(() => {});

      // Apply mask: composite layer image with mask as alpha
      const { loadImage } = await import("@napi-rs/canvas");
      const maskBuf = Buffer.from(maskDataUrl.split(",")[1], "base64");
      const maskImg = await loadImage(maskBuf);

      const resultCanvas = makeCanvas(w, h);
      const rctx = resultCanvas.getContext("2d");
      rctx.drawImage(layer._img, 0, 0);
      // Use mask as alpha: where mask is white, keep pixels; where black, make transparent
      rctx.globalCompositeOperation = "destination-in";
      rctx.drawImage(maskImg, 0, 0, w, h);

      const resultB64 = resultCanvas.toBuffer("image/png").toString("base64");
      const result = await canvas.addImageFromBase64(resultB64, layer_name || `Segment: ${layer.name}`);
      canvas.updateLayer(result.id, { x: layer.x, y: layer.y, scaleX: layer.scaleX, scaleY: layer.scaleY, rotation: layer.rotation });

      const snapshot = canvas.snapshotBase64();
      return { content: [
        { type: "image", data: snapshot, mimeType: "image/png" },
        { type: "text", text: `Segmented from "${layer.name}" → "${result.name}" (${result.id}), score: ${score.toFixed(3)}` },
      ] };
    } catch (err) {
      return { content: [{ type: "text", text: `SAM2 segmentation failed: ${err.message}` }] };
    }
  }
);

server.tool(
  "mycelium_sam2_segment_multi",
  "Use SAM2 AI to segment an object using multiple foreground/background points. " +
  "Provide multiple clicks to refine the selection — foreground points (label=1) to include regions, " +
  "background points (label=0) to exclude regions. Embeds the layer image first, then predicts a mask. " +
  "Requires SAM2 server running (python tools/sam2-server/server.py).",
  { layer_id: z.string().optional().describe("Layer to segment (defaults to selected)"),
    points: z.array(z.object({
      x: z.number().describe("X coordinate on the layer image (layer pixel coords)"),
      y: z.number().describe("Y coordinate on the layer image (layer pixel coords)"),
      label: z.number().min(0).max(1).default(1).describe("1=foreground (include), 0=background (exclude)"),
    })).min(1).describe("Array of click points with foreground/background labels"),
    layer_name: z.string().optional().describe("Name for the segmented layer") },
  async ({ layer_id, points, layer_name }) => {
    const { createCanvas: makeCanvas, loadImage } = await import("@napi-rs/canvas");

    const lid = layer_id || canvas.selectedLayerId;
    const layer = canvas.layers.find(l => l.id === lid);
    if (!layer || !layer._img) return { content: [{ type: "text", text: "Layer not found" }] };

    const w = layer._imgWidth, h = layer._imgHeight;
    const tc = makeCanvas(w, h);
    tc.getContext("2d").drawImage(layer._img, 0, 0);
    const b64 = tc.toBuffer("image/png").toString("base64");
    const dataUrl = `data:image/png;base64,${b64}`;

    try {
      // Embed image
      const embedResp = await fetch(`${SAM2_URL}/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: dataUrl }),
      });
      if (!embedResp.ok) throw new Error(`Embed failed: ${embedResp.status}`);
      const { session_id } = await embedResp.json();

      // Predict mask with multiple points
      const predResp = await fetch(`${SAM2_URL}/predict_multi`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id, points }),
      });
      if (!predResp.ok) throw new Error(`Predict failed: ${predResp.status}`);
      const { mask: maskDataUrl, score } = await predResp.json();

      // Clean up session
      fetch(`${SAM2_URL}/session/${session_id}`, { method: "DELETE" }).catch(() => {});

      // Apply mask as alpha
      const maskBuf = Buffer.from(maskDataUrl.split(",")[1], "base64");
      const maskImg = await loadImage(maskBuf);
      const resultCanvas = makeCanvas(w, h);
      const rctx = resultCanvas.getContext("2d");
      rctx.drawImage(layer._img, 0, 0);
      rctx.globalCompositeOperation = "destination-in";
      rctx.drawImage(maskImg, 0, 0, w, h);

      const resultB64 = resultCanvas.toBuffer("image/png").toString("base64");
      const result = await canvas.addImageFromBase64(resultB64, layer_name || `Segment: ${layer.name}`);
      canvas.updateLayer(result.id, { x: layer.x, y: layer.y, scaleX: layer.scaleX, scaleY: layer.scaleY, rotation: layer.rotation });

      const snapshot = canvas.snapshotBase64();
      return { content: [
        { type: "image", data: snapshot, mimeType: "image/png" },
        { type: "text", text: `Multi-point segmented from "${layer.name}" → "${result.name}" (${result.id}), ` +
          `${points.length} points (${points.filter(p => p.label === 1).length} fg, ${points.filter(p => p.label === 0).length} bg), score: ${score.toFixed(3)}` },
      ] };
    } catch (err) {
      return { content: [{ type: "text", text: `SAM2 multi-point segmentation failed: ${err.message}` }] };
    }
  }
);

// ── Video / FFmpeg tools ──

server.tool(
  "mycelium_video_render_frames",
  "Render an animated sequence of canvas frames to disk by interpolating layer properties over time. " +
  "Provide keyframes for one or more layers — properties are linearly interpolated between them. " +
  "Returns the output directory containing numbered PNG frames. " +
  "Use this to create animations from the current canvas composition.",
  {
    frame_count: z.number().min(2).max(3000).default(60).describe("Total frames to render"),
    output_dir: z.string().optional().describe("Directory for frames (default: auto-generated in project output/)"),
    keyframes: z.array(z.object({
      layer_id: z.string().describe("Layer ID to animate"),
      frames: z.array(z.object({
        frame: z.number().min(0).describe("Frame number (0-based)"),
        x: z.number().optional(),
        y: z.number().optional(),
        scaleX: z.number().optional(),
        scaleY: z.number().optional(),
        rotation: z.number().optional(),
        opacity: z.number().min(0).max(1).optional(),
      })).min(1).describe("Keyframe data — properties at specific frames"),
    })).optional().describe("Layer animation keyframes. If omitted, renders static frames (useful with dream stepping)."),
    dream_steps_per_frame: z.number().min(0).max(500).default(0)
      .describe("If > 0, advance the dream simulation by this many steps between each frame"),
    effects_per_frame: z.array(z.object({
      layer_id: z.string(),
      effect: z.string(),
      apply_every: z.number().min(1).default(1).describe("Apply effect every N frames"),
    })).optional().describe("Effects to apply progressively during rendering"),
  },
  async ({ frame_count, output_dir, keyframes, dream_steps_per_frame, effects_per_frame }) => {
    const ts = Date.now();
    const framesDir = output_dir || join(PROJECT_ROOT, "output", `frames_${ts}`);
    await mkdir(framesDir, { recursive: true });

    // Snapshot original layer states so we can restore after
    const originals = new Map();
    for (const layer of canvas.layers) {
      originals.set(layer.id, { x: layer.x, y: layer.y, scaleX: layer.scaleX, scaleY: layer.scaleY, rotation: layer.rotation, opacity: layer.opacity });
    }

    function lerp(a, b, t) { return a + (b - a) * t; }

    function interpolateAtFrame(layerKeyframes, frame) {
      const sorted = layerKeyframes.sort((a, b) => a.frame - b.frame);
      if (frame <= sorted[0].frame) return sorted[0];
      if (frame >= sorted[sorted.length - 1].frame) return sorted[sorted.length - 1];
      let prev = sorted[0], next = sorted[1];
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].frame >= frame) { next = sorted[i]; prev = sorted[i - 1]; break; }
      }
      const t = (frame - prev.frame) / (next.frame - prev.frame);
      const result = {};
      for (const key of ["x", "y", "scaleX", "scaleY", "rotation", "opacity"]) {
        if (prev[key] !== undefined && next[key] !== undefined) result[key] = lerp(prev[key], next[key], t);
        else if (prev[key] !== undefined) result[key] = prev[key];
        else if (next[key] !== undefined) result[key] = next[key];
      }
      return result;
    }

    try {
      for (let f = 0; f < frame_count; f++) {
        // Apply keyframe interpolation
        if (keyframes) {
          for (const { layer_id, frames } of keyframes) {
            const props = interpolateAtFrame(frames, f);
            canvas.updateLayer(layer_id, props);
          }
        }

        // Step dream
        if (dream_steps_per_frame > 0) {
          canvas.dreamStep(dream_steps_per_frame);
        }

        // Apply effects
        if (effects_per_frame) {
          for (const { layer_id, effect, apply_every } of effects_per_frame) {
            if (f % apply_every === 0 && f > 0) {
              canvas.applyEffect(layer_id, effect);
            }
          }
        }

        // Render and save frame
        const buf = canvas.snapshot("png");
        const framePath = join(framesDir, `frame_${String(f).padStart(5, "0")}.png`);
        await writeFile(framePath, buf);
      }

      // Restore original layer states
      for (const [id, props] of originals) {
        canvas.updateLayer(id, props);
      }

      return { content: [{ type: "text", text: `Rendered ${frame_count} frames to ${framesDir}` }] };
    } catch (err) {
      // Restore on error too
      for (const [id, props] of originals) {
        canvas.updateLayer(id, props);
      }
      return { content: [{ type: "text", text: `Frame rendering failed at some point: ${err.message}` }] };
    }
  }
);

server.tool(
  "mycelium_video_encode",
  "Encode a directory of PNG frames into a video file using ffmpeg. " +
  "Frames must be named with zero-padded numbers (e.g. frame_00000.png). " +
  "Supports MP4 (H.264), WebM (VP9), and GIF output.",
  {
    frames_dir: z.string().describe("Directory containing numbered PNG frames"),
    output_path: z.string().describe("Output video file path (e.g. output/my_video.mp4)"),
    fps: z.number().min(1).max(120).default(24).describe("Frames per second"),
    format: z.enum(["mp4", "webm", "gif"]).default("mp4"),
    quality: z.enum(["draft", "normal", "high"]).default("normal")
      .describe("Encoding quality: draft=fast/large, normal=balanced, high=slow/small"),
    resolution: z.string().optional().describe("Output resolution e.g. '1920x1080' or '720x480'. Omit to use frame size."),
    loop: z.number().min(0).max(100).default(0).describe("For GIF: number of loops (0=infinite)"),
    audio_path: z.string().optional().describe("Optional audio file to mix in"),
  },
  async ({ frames_dir, output_path, fps, format, quality, resolution, loop, audio_path }) => {
    const absOutput = resolve(output_path);
    const absFrames = resolve(frames_dir);

    const qualityPresets = {
      mp4:  { draft: ["-crf", "28", "-preset", "ultrafast"], normal: ["-crf", "20", "-preset", "medium"], high: ["-crf", "14", "-preset", "slow"] },
      webm: { draft: ["-crf", "35", "-b:v", "0"], normal: ["-crf", "25", "-b:v", "0"], high: ["-crf", "15", "-b:v", "0"] },
      gif:  { draft: [], normal: [], high: [] },
    };

    let args = ["-y", "-framerate", String(fps), "-i", join(absFrames, "frame_%05d.png")];

    if (audio_path) {
      args.push("-i", resolve(audio_path), "-shortest");
    }

    if (resolution) {
      args.push("-vf", `scale=${resolution.replace("x", ":")}`);
    }

    if (format === "mp4") {
      args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", ...qualityPresets.mp4[quality]);
      if (audio_path) args.push("-c:a", "aac", "-b:a", "192k");
    } else if (format === "webm") {
      args.push("-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", ...qualityPresets.webm[quality]);
      if (audio_path) args.push("-c:a", "libopus");
    } else if (format === "gif") {
      // Two-pass GIF with palette for quality
      const paletteArgs = ["-y", "-framerate", String(fps), "-i", join(absFrames, "frame_%05d.png")];
      let filterBase = "";
      if (resolution) filterBase = `scale=${resolution.replace("x", ":")}:flags=lanczos,`;
      const palettePath = join(absFrames, "_palette.png");
      paletteArgs.push("-vf", `${filterBase}palettegen=stats_mode=diff`, palettePath);

      try {
        execSync(`ffmpeg ${paletteArgs.map(a => `"${a}"`).join(" ")}`, { timeout: 60000 });
      } catch (err) {
        return { content: [{ type: "text", text: `GIF palette generation failed: ${err.message}` }] };
      }

      args = ["-y", "-framerate", String(fps),
        "-i", join(absFrames, "frame_%05d.png"),
        "-i", palettePath,
        "-lavfi", `${filterBase}paletteuse=dither=bayer:bayer_scale=3`,
        "-loop", String(loop)];
    }

    args.push(absOutput);

    return new Promise((res) => {
      execFile("ffmpeg", args, { timeout: 300000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          return res({ content: [{ type: "text", text: `FFmpeg failed: ${err.message}\n${stderr?.slice(-500)}` }] });
        }
        return res({ content: [{ type: "text", text: `Video encoded: ${absOutput}\nFormat: ${format}, FPS: ${fps}, Quality: ${quality}` }] });
      });
    });
  }
);

server.tool(
  "mycelium_video_ffmpeg",
  "Run a custom ffmpeg command for advanced video operations. " +
  "Use this for anything the other video tools don't cover: concatenation, filters, speed changes, " +
  "text overlays, reverse, audio mixing, format conversion, etc. " +
  "The command runs from the project root directory.",
  {
    args: z.array(z.string()).describe("FFmpeg arguments as an array (do NOT include 'ffmpeg' itself). Example: [\"-i\", \"input.mp4\", \"-vf\", \"reverse\", \"output.mp4\"]"),
    timeout_ms: z.number().min(1000).max(600000).default(120000).describe("Timeout in milliseconds"),
  },
  async ({ args: ffmpegArgs, timeout_ms }) => {
    // Safety: always add -y for overwrite, prevent accidentally destructive commands
    const safeArgs = ["-y", ...ffmpegArgs.filter(a => a !== "-y")];

    return new Promise((res) => {
      execFile("ffmpeg", safeArgs, { timeout: timeout_ms, maxBuffer: 10 * 1024 * 1024, cwd: PROJECT_ROOT }, (err, stdout, stderr) => {
        if (err) {
          return res({ content: [{ type: "text", text: `FFmpeg failed: ${err.message}\n${stderr?.slice(-800)}` }] });
        }
        // Extract useful info from stderr (ffmpeg sends output info to stderr)
        const durationMatch = stderr?.match(/Duration:\s*(\S+)/);
        const sizeMatch = stderr?.match(/video:(\S+)/);
        const info = [
          durationMatch ? `Duration: ${durationMatch[1]}` : null,
          sizeMatch ? `Size: ${sizeMatch[1]}` : null,
        ].filter(Boolean).join(", ");
        return res({ content: [{ type: "text", text: `FFmpeg completed.${info ? ` ${info}` : ""}\n${stderr?.slice(-300)}` }] });
      });
    });
  }
);

// ── Start server ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
