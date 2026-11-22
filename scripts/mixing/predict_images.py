# /// script
# requires-python = ">=3.13"
# dependencies = ["numpy", "pillow"]
# ///
"""Compare measured images (e.g. DBS output, measured with measure-mixing.py --images) with their target, the linear-mix
prediction and the fitted model's prediction.

    R=1 uv run scripts/mixing/predict_images.py reference/mixing-<panel>-dbs.json model.json <dir with PNG + JSON per image>
"""
import json, sys
from pathlib import Path
import numpy as np
from PIL import Image
sys.path.insert(0, str(Path(__file__).parent))
from colorlib import lab, de00  # noqa: E402
meas = json.load(open(sys.argv[1]))['patterns']
model = json.load(open(sys.argv[2]))
flat = Path(sys.argv[3])
inks = model['inks']
NOM = {'black': (0, 0, 0), 'white': (255, 255, 255), 'yellow': (255, 255, 0), 'red': (255, 0, 0), 'blue': (0, 0, 255), 'green': (0, 255, 0)}
# this session's solids, else the model's
X = np.array([meas[f'solid {i}']['xyz_d65'] if f'solid {i}' in meas else model['solids_xyz'][i] for i in inks])
B = np.zeros((6, 6, 3))
for k, v in model['beta'].items():
    a, b = k.split('/'); B[inks.index(a), inks.index(b)] = B[inks.index(b), inks.index(a)] = v
lam, c1 = model['lam'], model['c1']
R = float(__import__('os').environ.get('R', 12)); RI = int(__import__('math').ceil(R))
offs = [(dx, dy) for dx in range(-RI, RI + 1) for dy in range(-RI, RI + 1) if (dx or dy) and dx * dx + dy * dy <= R * R]
def lin2srgb(c): c = np.clip(c, 0, 1); return np.where(c <= 0.0031308, 12.92 * c, 1.055 * c ** (1 / 2.4) - 0.055)
def srgb2xyz(rgb):
    c = np.asarray(rgb, float) / 255; l = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    M = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]])
    return M @ l
print(f'{"colour":11} {"measured L* a* b*":>20} | ΔE00 to measured: {"target":>7} {"linear":>7} {"model":>7}')
rows = []
for png in sorted(flat.glob('*.png')):
    key = f'image {png.stem}'
    if key not in meas: continue
    info = json.load(open(png.with_suffix('.json')))
    a = np.asarray(Image.open(png).convert('RGB'))
    H, W, _ = a.shape; crop = a[H // 2 - 200:H // 2 + 200, W // 2 - 200:W // 2 + 200]
    idx = np.zeros(crop.shape[:2], int)
    for i, n in enumerate(inks): idx[np.all(crop == NOM[n], axis=2)] = i
    lin = X[idx].reshape(-1, 3).mean(axis=0)
    S = np.zeros(idx.shape + (3,))
    for dx, dy in offs:
        d = np.hypot(dx, dy); wgt = np.exp(-d / lam) + c1 * (d == 1)
        S += wgt * B[idx, np.roll(np.roll(idx, dy, 0), dx, 1)]
    S = S[RI:-RI, RI:-RI]; core = idx[RI:-RI, RI:-RI]
    mod = (X[core] * np.exp(-S)).reshape(-1, 3).mean(axis=0)
    tgt = srgb2xyz(info['target'])
    m = np.array(meas[key]['xyz_d65'])
    L = lab(m); r = (de00(L, lab(tgt)), de00(L, lab(lin)), de00(L, lab(mod)))
    rows.append(r)
    print(f'{png.stem:11} {L[0]:6.1f} {L[1]:6.1f} {L[2]:6.1f} | {"":17} {r[0]:7.2f} {r[1]:7.2f} {r[2]:7.2f}   (target L* {lab(tgt)[0]:5.1f}, linear {lab(lin)[0]:5.1f}, model {lab(mod)[0]:5.1f})')
if rows:
    r = np.array(rows); print(f'{"mean":11} {"":20} | {"":17} {r[:, 0].mean():7.2f} {r[:, 1].mean():7.2f} {r[:, 2].mean():7.2f}')
