#!/usr/bin/env python3
"""
SAM2 local inference server for Mycelium.
Runs SAM2 with CUDA on your NVIDIA GPU.

Setup:
    pip install -e git+https://github.com/facebookresearch/sam2.git#egg=sam2
    pip install -r requirements.txt
    python download_checkpoints.py small
    python server.py [--port 7861] [--model small]

VRAM usage (alongside ComfyUI on 8GB):
    tiny:      ~500MB  (fast, good enough)
    small:     ~900MB  (recommended)
    base_plus: ~1.4GB
    large:     ~2.5GB
"""

import argparse
import base64
import io
import uuid
import numpy as np
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image
import uvicorn
import torch

app = FastAPI(title="Mycelium SAM2 Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Model configs ─────────────────────────────────────────────────────────────
MODEL_CONFIGS = {
    "tiny":      ("sam2.1_hiera_tiny.yaml",      "sam2.1_hiera_tiny.pt"),
    "small":     ("sam2.1_hiera_small.yaml",     "sam2.1_hiera_small.pt"),
    "base_plus": ("sam2.1_hiera_base_plus.yaml", "sam2.1_hiera_base_plus.pt"),
    "large":     ("sam2.1_hiera_large.yaml",     "sam2.1_hiera_large.pt"),
}

# In-memory sessions: { session_id: { image_np, w, h, features, orig_hw } }
sessions: dict = {}
predictor = None
device = None


def load_model(model_size: str = "small"):
    global predictor, device

    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor

    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cpu":
        print("WARNING: CUDA not available — running on CPU (slow)")

    cfg, ckpt = MODEL_CONFIGS[model_size]
    ckpt_path = Path(__file__).parent / "checkpoints" / ckpt

    if not ckpt_path.exists():
        raise FileNotFoundError(
            f"Checkpoint not found: {ckpt_path}\n"
            "Run:  python download_checkpoints.py small"
        )

    model = build_sam2(cfg, str(ckpt_path), device=device)
    predictor = SAM2ImagePredictor(model)
    print(f"SAM2 ({model_size}) loaded on {device}")
    if torch.cuda.is_available():
        print(f"GPU: {torch.cuda.get_device_name(0)}, "
              f"VRAM: {torch.cuda.get_device_properties(0).total_memory // 1024**2} MB")


# ── Helpers ───────────────────────────────────────────────────────────────────

def decode_image(data_url: str) -> Image.Image:
    """Accept data:image/...;base64,... or raw base64."""
    if "," in data_url:
        data_url = data_url.split(",", 1)[1]
    raw = base64.b64decode(data_url)
    return Image.open(io.BytesIO(raw)).convert("RGB")


def mask_to_png_b64(mask: np.ndarray) -> str:
    """Convert boolean/uint8 2D mask → white-on-black PNG base64 data-url."""
    out_img = Image.fromarray((mask.astype(np.uint8) * 255), mode="L")
    buf = io.BytesIO()
    out_img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "ok": True,
        "device": str(device),
        "model_loaded": predictor is not None,
        "cuda": torch.cuda.is_available(),
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "vram_mb": (
            torch.cuda.get_device_properties(0).total_memory // 1024**2
            if torch.cuda.is_available() else None
        ),
    }


class EmbedRequest(BaseModel):
    image: str  # base64 data-url


@app.post("/embed")
def embed(body: EmbedRequest):
    """
    Encode an image with SAM2 and cache its embeddings.
    Returns a session_id — pass it to /predict for click-based segmentation.
    Embeddings are cached in VRAM; call /session/{id} DELETE to free them.
    """
    if predictor is None:
        raise HTTPException(503, "Model not loaded")

    image = decode_image(body.image)
    img_arr = np.array(image)

    with torch.inference_mode():
        predictor.set_image(img_arr)
        # Snapshot the internal embedding tensors so multiple predict
        # calls can reuse the same embedding without re-encoding.
        cached_features = predictor._features
        cached_orig_hw = predictor._orig_hw

    session_id = str(uuid.uuid4())
    sessions[session_id] = {
        "image": img_arr,
        "w": image.width,
        "h": image.height,
        "features": cached_features,
        "orig_hw": cached_orig_hw,
    }

    return {"session_id": session_id, "width": image.width, "height": image.height}


class PredictRequest(BaseModel):
    session_id: str
    point_x: float
    point_y: float
    label: int = 1   # 1 = foreground click, 0 = background click


@app.post("/predict")
def predict(body: PredictRequest):
    """
    Run mask prediction from a single point click.
    Returns the best mask as a white-on-black PNG base64 data-url.
    """
    if predictor is None:
        raise HTTPException(503, "Model not loaded")

    sess = sessions.get(body.session_id)
    if sess is None:
        raise HTTPException(404, "Session not found — call /embed first")

    with torch.inference_mode():
        # Restore the cached image embedding (no re-encoding needed)
        predictor._features = sess["features"]
        predictor._orig_hw = sess["orig_hw"]
        predictor._is_image_set = True

        point = np.array([[body.point_x, body.point_y]], dtype=np.float32)
        label = np.array([body.label], dtype=np.int32)

        masks, scores, _ = predictor.predict(
            point_coords=point,
            point_labels=label,
            multimask_output=True,  # get 3 candidates, pick best
        )

    best = int(np.argmax(scores))
    mask = masks[best]  # shape (H, W), bool

    return {
        "mask": mask_to_png_b64(mask),
        "score": float(scores[best]),
        "width": sess["w"],
        "height": sess["h"],
    }


class MultiPointRequest(BaseModel):
    session_id: str
    points: list   # [{"x": float, "y": float, "label": int}]


@app.post("/predict_multi")
def predict_multi(body: MultiPointRequest):
    """
    Predict mask from multiple foreground/background clicks.
    Useful for refining a selection with additional positive/negative points.
    """
    if predictor is None:
        raise HTTPException(503, "Model not loaded")

    sess = sessions.get(body.session_id)
    if sess is None:
        raise HTTPException(404, "Session not found")

    coords = np.array([[p["x"], p["y"]] for p in body.points], dtype=np.float32)
    labels = np.array([p.get("label", 1) for p in body.points], dtype=np.int32)

    with torch.inference_mode():
        predictor._features = sess["features"]
        predictor._orig_hw = sess["orig_hw"]
        predictor._is_image_set = True

        masks, scores, _ = predictor.predict(
            point_coords=coords,
            point_labels=labels,
            multimask_output=False,
        )

    mask = masks[0]
    return {
        "mask": mask_to_png_b64(mask),
        "score": float(scores[0]),
        "width": sess["w"],
        "height": sess["h"],
    }


@app.delete("/session/{session_id}")
def delete_session(session_id: str):
    """Free a cached session to release VRAM."""
    sessions.pop(session_id, None)
    return {"ok": True}


@app.get("/sessions")
def list_sessions():
    return {"count": len(sessions), "ids": list(sessions.keys())}


# ── Entry ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Mycelium SAM2 server")
    parser.add_argument("--port", type=int, default=7861)
    parser.add_argument(
        "--model",
        choices=list(MODEL_CONFIGS),
        default="small",
        help="SAM2 model size. 'small' recommended for 8GB VRAM alongside ComfyUI.",
    )
    args = parser.parse_args()

    load_model(args.model)
    print(f"\nSAM2 server ready at http://0.0.0.0:{args.port}")
    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="warning")
