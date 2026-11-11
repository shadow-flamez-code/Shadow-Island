import base64
import io
import subprocess
import sys

out = subprocess.run(
    ["node", "tools-eval.js", "(async () => { const d = await DI.api.captureScreen(); return d || ''; })()"],
    capture_output=True,
    text=True,
    timeout=90,
)
raw = out.stdout.strip().strip('"')
if not raw or "," not in raw:
    print("no image:", raw[:120], out.stderr[:200])
    sys.exit(0)
data = base64.b64decode(raw.split(",", 1)[1])
from PIL import Image

im = Image.open(io.BytesIO(data)).convert("L")
hist = im.histogram()
mean = sum(i * c for i, c in enumerate(hist)) / float(im.size[0] * im.size[1])
print("size", im.size, "mean", round(mean, 1))
im.save("capture-check.png")
