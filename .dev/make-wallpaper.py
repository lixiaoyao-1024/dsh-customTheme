"""Generate a seamless animated wallpaper (aurora drift) as an animated WebP.

The artwork is procedural: no third-party asset, no licence question, and it
loops exactly (every motion term completes a whole number of cycles).
"""
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

WIDTH, HEIGHT = 1024, 576
FRAMES = 60

out_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("assets/backgrounds/bg.webp")
preview_path = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(".dev/wallpapers/preview.png")

# Deep night palette: near-black indigo base, three coloured lights.
BASE = np.array([9, 11, 20], dtype=np.float32)
LIGHTS = [
    ((0.34, 0.38), (0.16, 0.30), np.array([38, 92, 190], dtype=np.float32)),
    ((0.66, 0.44), (0.14, 0.34), np.array([150, 46, 120], dtype=np.float32)),
    ((0.52, 0.70), (0.20, 0.26), np.array([24, 120, 128], dtype=np.float32)),
]

xs = np.linspace(0.0, 1.0, WIDTH, dtype=np.float32)[None, :]
ys = np.linspace(0.0, 1.0, HEIGHT, dtype=np.float32)[:, None]
# Vertical falloff keeps the top of the window calm.
vignette = 1.0 - 0.55 * ((ys - 0.45) ** 2 + (xs - 0.5) ** 2)


def field(phase: float) -> np.ndarray:
    canvas = np.zeros((HEIGHT, WIDTH, 3), dtype=np.float32)
    for index, ((cx, cy), (ax, ay), colour) in enumerate(LIGHTS):
        angle = 2.0 * math.pi * phase + index * (2.0 * math.pi / 3.0)
        px = cx + ax * 0.5 * math.sin(angle)
        py = cy + ay * 0.5 * math.cos(angle * 1.0)
        # Second, slower wobble keeps the loop from looking like a pendulum.
        px += ax * 0.18 * math.sin(angle * 2.0)
        py += ay * 0.16 * math.cos(angle * 2.0)
        radius = 0.30 + 0.05 * math.sin(angle)
        glow = np.exp(-(((xs - px) ** 2 + (ys - py) ** 2) / (2.0 * radius * radius)))
        canvas += glow[:, :, None] * colour[None, None, :] * 0.55
    return canvas


frames = []
rng = np.random.default_rng(7)
grain = rng.normal(0.0, 1.4, size=(HEIGHT, WIDTH, 1)).astype(np.float32)

for frame in range(FRAMES):
    phase = frame / FRAMES
    canvas = BASE[None, None, :] + field(phase)
    canvas = canvas * vignette[:, :, None]
    canvas = canvas + grain
    # Soft shoulder instead of a hard clip, so highlights roll off.
    canvas = np.where(canvas > 200.0, 200.0 + (canvas - 200.0) * 0.35, canvas)
    image = Image.fromarray(np.clip(canvas, 0, 255).astype(np.uint8), "RGB")
    frames.append(image)

preview_path.parent.mkdir(parents=True, exist_ok=True)
frames[0].save(preview_path)

out_path.parent.mkdir(parents=True, exist_ok=True)
frames[0].save(
    out_path,
    format="WEBP",
    save_all=True,
    append_images=frames[1:],
    duration=int(1000 / 12),
    loop=0,
    quality=68,
    method=4,
)

size = out_path.stat().st_size
print(f"wrote {out_path} ({size / 1024:.0f} KB, {FRAMES} frames, {WIDTH}x{HEIGHT})")
