# /// script
# requires-python = ">=3.13"
# dependencies = ["numpy", "scipy"]
# ///
"""Fit per-ink-pair, per-channel strengths on the 1x1 checkerboards (kernel shape from fit_bw.py) and predict the 2x2 ones.

    R=1 uv run scripts/mixing/fit_pairs.py reference/mixing-<panel>-reset.json <lambda> <nn-extra> model.json
"""
import json, sys, itertools
import numpy as np
from scipy.optimize import least_squares, brentq
d = json.load(open(sys.argv[1]))['patterns']
lam, c1 = float(sys.argv[2]), float(sys.argv[3])   # kernel shape from the black/white fit
inks = ['black', 'white', 'yellow', 'red', 'blue', 'green']
X = {i: np.mean([v['xyz_d65'] for k, v in d.items() if k.startswith('solid ' + i)], axis=0) for i in inks}
T = 32
R = float(__import__('os').environ.get('R', 12)); RI = int(__import__('math').ceil(R))
yy, xx = np.mgrid[0:T, 0:T]
offs = [(dx, dy) for dx in range(-RI, RI + 1) for dy in range(-RI, RI + 1) if (dx or dy) and dx * dx + dy * dy <= R * R]
dist = np.array([np.hypot(dx, dy) for dx, dy in offs]); w = np.exp(-dist / lam) + c1 * (dist == 1)
def S_of(m):  # per-pixel weighted count of differing neighbours (2-ink patterns)
    return sum(wi * (m != np.roll(np.roll(m, dy, 0), dx, 1)) for wi, (dx, dy) in zip(w, offs))
M = {1: (xx + yy) % 2 == 0, 2: (xx // 2 + yy // 2) % 2 == 0}
SS = {s: S_of(m) for s, m in M.items()}
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
from colorlib import lab, de00  # noqa: E402
def model(a, b, beta, s):  # beta: per-channel strength (symmetric for the pair)
    m, Sm = M[s], SS[s]
    out = np.zeros(3)
    for ch in range(3):
        v = np.where(m, X[a][ch], X[b][ch]) * np.exp(-beta[ch] * Sm)
        out[ch] = v.mean()
    return out
print(f'{"pair":14} {"beta X/Y/Z":>22} | 2x2 predicted (held out): ΔE00 linear → model')
res = []
BETA = {}
for a, b in itertools.combinations(inks, 2):
    beta = np.zeros(3)
    for ch in range(3):  # fit each channel exactly on checker1
        target = d[f'checker1 {a}/{b}']['xyz_d65'][ch]
        f = lambda bt: model(a, b, [bt] * 3, 1)[ch] - target
        beta[ch] = brentq(f, -0.3, 0.6)
    BETA[f'{a}/{b}'] = beta.tolist()
    meas2 = np.array(d[f'checker2 {a}/{b}']['xyz_d65'])
    lin2 = 0.5 * X[a] + 0.5 * X[b]
    e_lin, e_mod = de00(lab(meas2), lab(lin2)), de00(lab(meas2), lab(model(a, b, beta, 2)))
    res.append((e_lin, e_mod))
    print(f'{a + "/" + b:14} {beta[0]:7.3f}{beta[1]:7.3f}{beta[2]:7.3f}   | {e_lin:5.2f} → {e_mod:5.2f}')
json.dump({'lam': lam, 'c1': c1, 'inks': inks, 'solids_xyz': {i: X[i].tolist() for i in inks}, 'beta': BETA}, open(sys.argv[4], 'w'), indent=1)
r = np.array(res); print(f'mean ΔE00 on 2x2 (held out): linear {r[:, 0].mean():.2f} → model {r[:, 1].mean():.2f}; max {r[:, 0].max():.2f} → {r[:, 1].max():.2f}')
