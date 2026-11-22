# /// script
# requires-python = ">=3.13"
# dependencies = ["numpy", "scipy"]
# ///
"""Fit the black/white neighbour-attenuation model on the checkerboard series; test it on lines and coverage.

    R=1 uv run scripts/mixing/fit_bw.py reference/mixing-<panel>-reset.json   # R: kernel radius in px (1 = 4 neighbours)
"""
import json, sys
import numpy as np
from scipy.optimize import least_squares
d = json.load(open(sys.argv[1]))['patterns']
Ys = {ink: np.mean([v['xyz_d65'][1] for k, v in d.items() if k.startswith('solid ' + ink)]) for ink in ('black', 'white')}
T = 64
yy, xx = np.mgrid[0:T, 0:T]
masks = {  # True = black
    'checker1': (xx + yy) % 2 == 0, 'checker2': (xx // 2 + yy // 2) % 2 == 0, 'checker4': (xx // 4 + yy // 4) % 2 == 0,
    'checker8': (xx // 8 + yy // 8) % 2 == 0, 'checker16': (xx // 16 + yy // 16) % 2 == 0,
    'lines-h': yy % 2 == 0, 'lines-v': xx % 2 == 0,
    'coverage 25%': (xx % 2 == 0) & (yy % 2 == 0), 'coverage 75%': ~((xx % 2 == 0) & (yy % 2 == 0)),
}
name = {k: (f'{k} black/white' if not k.startswith('coverage') else f'{k} black/white') for k in masks}
meas = {k: d[name[k]]['xyz_d65'][1] for k in masks}
R = float(__import__('os').environ.get('R', 20)); RI = int(__import__('math').ceil(R))
offs = [(dx, dy) for dx in range(-RI, RI + 1) for dy in range(-RI, RI + 1) if (dx or dy) and dx * dx + dy * dy <= R * R]
dist = np.array([np.hypot(dx, dy) for dx, dy in offs])
# per pattern: for each offset, per-pixel indicator "neighbour differs"
radii = np.unique(np.round(dist, 6))
ridx = np.searchsorted(radii, np.round(dist, 6))
classes = {}
for k, m in masks.items():
    C = np.zeros((len(radii), T, T))
    for (dx, dy), ri in zip(offs, ridx):
        C[ri] += m != np.roll(np.roll(m, dy, 0), dx, 1)
    feats = np.concatenate([C.reshape(len(radii), -1).T, m.reshape(-1, 1)], axis=1)
    u, cnt = np.unique(feats, axis=0, return_counts=True)
    classes[k] = (u[:, :-1], u[:, -1].astype(bool), cnt / cnt.sum())
def predict(p, k):
    bw, bb, lam, c1 = p
    w = np.exp(-radii / lam) + c1 * (radii == 1)
    Cu, isb, frac = classes[k]
    S = Cu @ w
    Y = np.where(isb, Ys['black'] * np.exp(-bb * S), Ys['white'] * np.exp(-bw * S))
    return float((Y * frac).sum())
fit_set = ['checker1', 'checker2', 'checker4', 'checker8', 'checker16']
def resid(p, keys): return [np.log(predict(p, k) / meas[k]) for k in keys]
best = None
for lam0 in (1, 3, 8):
    for c0 in (0, 2):
        r = least_squares(resid, [0.1, 0.0, lam0, c0], args=(fit_set,), bounds=([0, -2, 0.2, 0], [5, 5, 30, 50]))
        if best is None or r.cost < best.cost: best = r
p = best.x
print(f'Y black {Ys["black"]:.4f} white {Ys["white"]:.4f}')
print(f'fit on checkers: beta_white {p[0]:.4f} beta_black {p[1]:.4f} lambda {p[2]:.2f} px nn-extra {p[3]:.3f}  (cost {best.cost:.2e})')
print(f'{"pattern":14} {"linear":>8} {"model":>8} {"measured":>9}   model/meas')
for k in masks:
    lin = masks[k].mean() * Ys['black'] + (1 - masks[k].mean()) * Ys['white']
    pr = predict(p, k)
    print(f'{k:14} {lin:8.4f} {pr:8.4f} {meas[k]:9.4f}   {pr / meas[k]:.3f}{"   (held out)" if k not in fit_set else ""}')
