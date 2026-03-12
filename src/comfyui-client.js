/**
 * ComfyUI bridge client for Mycelium.
 *
 * Handles image upload, workflow queuing, and result polling against a
 * locally-running ComfyUI instance (default http://127.0.0.1:8188).
 *
 * Workflow template format
 * ────────────────────────
 * Export your workflow from ComfyUI using "Save (API Format)" then place
 * the JSON in comfyui-workflows/.  Replace hard-coded values with these
 * placeholder strings inside any JSON string value:
 *
 *   "__INPUT_IMAGE__"     → filename of uploaded source image
 *   "__MASK__"            → filename of uploaded inpaint mask
 *   "__POSITIVE_PROMPT__" → positive text prompt
 *   "__NEGATIVE_PROMPT__" → negative text prompt
 *   "__DENOISE__"         → denoising strength  (number, 0.0–1.0)
 *   "__STEPS__"           → sampling steps      (number)
 *   "__CFG__"             → CFG scale           (number)
 *   "__SEED__"            → random seed         (number, -1 = random)
 *
 * Number placeholders must be quoted in the JSON ("__SEED__": valid JSON)
 * — fillTemplate() will unquote them when substituting real values.
 */

const DEFAULT_URL = "http://127.0.0.1:8188";

export class ComfyUIClient {
  constructor(baseUrl = DEFAULT_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.clientId = crypto.randomUUID();
  }

  // ── Connectivity ───────────────────────────────────────────────────────────

  /** Returns true if ComfyUI is reachable. */
  async ping(timeoutMs = 2000) {
    try {
      const r = await fetch(`${this.baseUrl}/system_stats`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return r.ok;
    } catch {
      return false;
    }
  }

  // ── Low-level API ──────────────────────────────────────────────────────────

  /**
   * Upload a base64 data-url as an image file into ComfyUI's input directory.
   * Returns the ComfyUI-assigned filename (may differ from the requested name).
   */
  async uploadImage(dataUrl, filename = "input.png") {
    const blob = await (await fetch(dataUrl)).blob();
    const form = new FormData();
    form.append("image", new File([blob], filename, { type: "image/png" }));
    form.append("overwrite", "true");

    const r = await fetch(`${this.baseUrl}/upload/image`, {
      method: "POST",
      body: form,
    });
    if (!r.ok) throw new Error(`ComfyUI upload failed: ${r.status}`);
    const data = await r.json();
    return data.name;
  }

  /**
   * Queue a workflow (API-format JSON object).
   * Returns the prompt_id for polling.
   */
  async queuePrompt(workflow) {
    const r = await fetch(`${this.baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: this.clientId }),
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`ComfyUI queue failed: ${r.status} — ${txt}`);
    }
    const data = await r.json();
    if (data.error) throw new Error(`Workflow error: ${JSON.stringify(data.error)}`);
    return data.prompt_id;
  }

  /**
   * Poll /history/{promptId} until generation completes.
   * Returns the first output image as a base64 data-url.
   */
  async pollResult(promptId, { timeoutMs = 180_000, intervalMs = 1_000 } = {}) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, intervalMs));

      let history;
      try {
        const r = await fetch(`${this.baseUrl}/history/${promptId}`);
        if (!r.ok) continue;
        history = await r.json();
      } catch {
        continue;
      }

      const entry = history[promptId];
      if (!entry) continue;

      if (entry.status?.status_str === "error") {
        const msgs = (entry.status?.messages ?? [])
          .map(m => (typeof m[1] === "string" ? m[1] : JSON.stringify(m[1])))
          .join("; ");
        throw new Error(`ComfyUI generation error: ${msgs}`);
      }

      // Scan all node outputs for images
      for (const nodeOutput of Object.values(entry.outputs ?? {})) {
        const imgs = nodeOutput.images;
        if (!imgs?.length) continue;

        const img = imgs[0];
        const imgUrl = `${this.baseUrl}/view?filename=${encodeURIComponent(img.filename)}`
          + `&subfolder=${encodeURIComponent(img.subfolder ?? "")}`
          + `&type=${img.type ?? "output"}`;

        const blob = await (await fetch(imgUrl)).blob();
        return await new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onload = () => res(reader.result);
          reader.onerror = rej;
          reader.readAsDataURL(blob);
        });
      }
    }

    throw new Error("ComfyUI: timed out waiting for result");
  }

  // ── Template engine ────────────────────────────────────────────────────────

  /**
   * Fill workflow template placeholders.
   * String params replace __KEY__ within existing JSON string values.
   * Number params replace "__KEY__" (the entire quoted string) with an unquoted number.
   */
  fillTemplate(template, params) {
    let json = JSON.stringify(template);

    for (const [key, val] of Object.entries(params)) {
      if (typeof val === "number") {
        // Replace quoted placeholder → bare JSON number: "__DENOISE__" → 0.75
        json = json.replaceAll(`"__${key}__"`, String(val));
      } else {
        // Replace placeholder inside an existing string value
        const escaped = String(val).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        json = json.replaceAll(`__${key}__`, escaped);
      }
    }

    return JSON.parse(json);
  }

  // ── High-level inpaint ────────────────────────────────────────────────────

  /**
   * Run an inpaint workflow end-to-end.
   *
   * @param {object}   opts
   * @param {string}   opts.imageDataUrl       Source image (base64 data-url)
   * @param {string}   opts.maskDataUrl        Inpaint mask (white=paint, black=keep)
   * @param {object}   opts.workflowTemplate   Parsed JSON workflow template
   * @param {string}   opts.positivePrompt
   * @param {string}   [opts.negativePrompt]
   * @param {number}   [opts.denoise=0.75]
   * @param {number}   [opts.steps=25]
   * @param {number}   [opts.cfg=7]
   * @param {function} [opts.onStatus]         Status callback (string)
   * @returns {Promise<string>}  Result image as base64 data-url
   */
  async runInpaint(opts) {
    const {
      imageDataUrl,
      maskDataUrl,
      workflowTemplate,
      positivePrompt,
      negativePrompt = "blurry, low quality, watermark, text, logo, cropped, deformed",
      denoise = 0.75,
      steps = 25,
      cfg = 7,
      onStatus = () => {},
    } = opts;

    onStatus("uploading...");
    const ts = Date.now();
    const [imgName, maskName] = await Promise.all([
      this.uploadImage(imageDataUrl, `mycelium_src_${ts}.png`),
      this.uploadImage(maskDataUrl,  `mycelium_msk_${ts}.png`),
    ]);

    onStatus("queuing workflow...");
    const workflow = this.fillTemplate(workflowTemplate, {
      INPUT_IMAGE:     imgName,
      MASK:            maskName,
      POSITIVE_PROMPT: positivePrompt,
      NEGATIVE_PROMPT: negativePrompt,
      DENOISE:         denoise,
      STEPS:           steps,
      CFG:             cfg,
      SEED:            Math.floor(Math.random() * 2 ** 31),
    });

    const promptId = await this.queuePrompt(workflow);

    onStatus("generating...");
    const result = await this.pollResult(promptId);
    onStatus("done");
    return result;
  }
}
