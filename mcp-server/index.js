import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MyceliumCanvas } from "./engine/canvas.js";
import { RD_PRESETS } from "./engine/rd.js";
import { COLORMAPS } from "./engine/colormaps.js";
import { EFFECTS } from "./engine/effects.js";

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

// ── Effects ──

server.tool(
  "mycelium_effect_apply",
  "Apply a pixel effect to a layer. Available effects: dither, pixelsort, invert, posterize, chromatic, glitch, threshold, halftone",
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

// ── Start server ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
