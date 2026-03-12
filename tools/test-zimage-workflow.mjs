import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ComfyUIClient } from "../src/comfyui-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const workflowPath = path.join(projectRoot, "comfyui-workflows", "zimage_img2img_barebones.json");
const inputPath = process.argv[2] || path.join(projectRoot, "images", "amanita_mage_1.jpg");
const outputPath = path.join(projectRoot, "images", "test_zimage_img2img_output.png");
const comfyUrl = process.env.COMFYUI_URL || process.argv[3] || "http://127.0.0.1:8188";

function fileToDataUrl(filePath) {
  return readFile(filePath).then((buf) => {
    const ext = path.extname(filePath).toLowerCase();
    const mime =
      ext === ".png" ? "image/png" :
      ext === ".webp" ? "image/webp" :
      "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  });
}

async function main() {
  const workflowTemplate = JSON.parse(await readFile(workflowPath, "utf8"));
  const imageDataUrl = await fileToDataUrl(inputPath);
  const client = new ComfyUIClient(comfyUrl);

  if (!(await client.ping(2500))) {
    throw new Error(`ComfyUI is not reachable at ${comfyUrl}`);
  }

  const inputName = await client.uploadImage(imageDataUrl, path.basename(inputPath));
  const workflow = client.fillTemplate(workflowTemplate, {
    INPUT_IMAGE: inputName,
    POSITIVE_PROMPT: "inside an LLM, recursive corridors of light, token storm, memory cathedral, spectral computation, luminous abstractions",
    NEGATIVE_PROMPT: "blurry, low quality, watermark, text, logo, extra limbs, deformed",
    DENOISE: 0.55,
    STEPS: 8,
    CFG: 1,
    SEED: Math.floor(Math.random() * 2 ** 31),
  });

  const promptId = await client.queuePrompt(workflow);
  console.log(`Queued prompt ${promptId}`);
  const resultDataUrl = await client.pollResult(promptId, { timeoutMs: 180000, intervalMs: 1500 });
  const base64 = resultDataUrl.split(",", 2)[1];
  await writeFile(outputPath, Buffer.from(base64, "base64"));
  console.log(`Saved result to ${outputPath}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
