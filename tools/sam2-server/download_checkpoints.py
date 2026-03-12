#!/usr/bin/env python3
"""
Download SAM2.1 model checkpoints from Meta.

Usage:
    python download_checkpoints.py [tiny|small|base_plus|large]
    python download_checkpoints.py small   # recommended for 8GB VRAM
"""

import sys
import urllib.request
from pathlib import Path

MODELS = {
    "tiny":      "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_tiny.pt",
    "small":     "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt",
    "base_plus": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_base_plus.pt",
    "large":     "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt",
}

SIZES = {"tiny": "38MB", "small": "46MB", "base_plus": "80MB", "large": "224MB"}

dest = Path(__file__).parent / "checkpoints"
dest.mkdir(exist_ok=True)

model = sys.argv[1] if len(sys.argv) > 1 else "small"

if model == "all":
    targets = list(MODELS)
elif model in MODELS:
    targets = [model]
else:
    print(f"Unknown model '{model}'. Choose from: {list(MODELS)} or 'all'")
    sys.exit(1)

for m in targets:
    url = MODELS[m]
    out = dest / url.split("/")[-1]

    if out.exists():
        print(f"  already exists: {out.name}")
        continue

    print(f"  downloading {m} ({SIZES[m]})...")

    def report(block, block_size, total):
        done = block * block_size
        pct = f"{done/total*100:.0f}%" if total > 0 else f"{done//1024}KB"
        print(f"\r  {pct}", end="", flush=True)

    urllib.request.urlretrieve(url, out, reporthook=report)
    print(f"\r  saved: {out}")

print("Done.")
