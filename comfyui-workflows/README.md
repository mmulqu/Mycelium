# ComfyUI Workflow Templates

Place ComfyUI workflow JSON files here.  Mycelium will pick them up automatically.

## Adding Your Own Workflow

1. In ComfyUI, build your workflow and click **Save (API Format)** to export `workflow_api.json`
2. Open the JSON and replace values you want Mycelium to control with placeholder strings:

   | Placeholder              | Type   | Description                      |
   |--------------------------|--------|----------------------------------|
   | `"__INPUT_IMAGE__"`      | string | Source image filename             |
   | `"__MASK__"`             | string | Inpaint mask filename             |
   | `"__POSITIVE_PROMPT__"`  | string | Positive text prompt              |
   | `"__NEGATIVE_PROMPT__"`  | string | Negative text prompt              |
   | `"__DENOISE__"`          | number | Denoising strength (0.0–1.0)      |
   | `"__STEPS__"`            | number | Sampling steps                    |
   | `"__CFG__"`              | number | CFG scale                         |
   | `"__SEED__"`             | number | Random seed                       |

   **Example:** Change `"text": "a dog"` → `"text": "__POSITIVE_PROMPT__"` in your CLIPTextEncode node.

   **Number fields** (seed, steps, cfg, denoise) must be quoted strings in the JSON template — Mycelium replaces them with bare numbers at runtime.

3. Save the file in this folder as `my-workflow.json`
4. Add it to `COMFY_WORKFLOWS` in `src/collage-app.jsx`:
   ```js
   import myWorkflow from '../comfyui-workflows/my-workflow.json';
   // in COMFY_WORKFLOWS:
   "my-workflow": { label: "My Workflow", template: myWorkflow },
   ```

## Included Templates

### `sd15-inpaint.json`
- **Model:** SD 1.5 inpainting (`v1-5-pruned-emaonly.safetensors`)
- **VRAM:** ~4GB — safe on any card
- **Steps:** 25, DPM++ 2M Karras
- **Best for:** Quick iterations, stylized outputs, fine-tuned models

### `sdxl-inpaint-8gb.json`
- **Model:** SDXL inpainting (`sd_xl_base_1.0_inpainting_0.1.safetensors`)
- **VRAM:** ~7-8GB — start ComfyUI with `--medvram`
- **Steps:** 25, DPM++ 2M SDE Karras
- **Best for:** Higher quality, photorealistic outputs

## ComfyUI Setup for 8GB VRAM

```bash
# Start ComfyUI with memory optimizations:
python main.py --medvram --preview-method auto

# For very tight VRAM (also running SAM2):
python main.py --lowvram
```

The SAM2 server (`tools/sam2-server/server.py`) uses ~900MB VRAM on its own,
leaving ~7GB for ComfyUI with `--medvram`.
