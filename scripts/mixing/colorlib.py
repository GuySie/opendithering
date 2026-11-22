"""CIELAB (D65) and CIEDE2000 helpers shared by the mixing-model scripts."""
import numpy as np
D65 = np.array([0.95047, 1.0, 1.08883])
def lab(x):
    f = lambda t: np.where(t > 0.008856, np.cbrt(t), 7.787 * t + 16 / 116)
    fx, fy, fz = f(x / D65); return np.array([116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)])
def de00(a, b):  # CIEDE2000
    L1, a1, b1 = a; L2, a2, b2 = b
    C1, C2 = np.hypot(a1, b1), np.hypot(a2, b2); Cb = (C1 + C2) / 2; G = 0.5 * (1 - np.sqrt(Cb**7 / (Cb**7 + 25**7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2; C1p, C2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1p, h2p = np.degrees(np.arctan2(b1, a1p)) % 360, np.degrees(np.arctan2(b2, a2p)) % 360
    dLp, dCp = L2 - L1, C2p - C1p
    dhp = h2p - h1p; dhp = dhp - 360 if dhp > 180 else dhp + 360 if dhp < -180 else dhp
    dHp = 2 * np.sqrt(C1p * C2p) * np.sin(np.radians(dhp / 2))
    Lbp, Cbp = (L1 + L2) / 2, (C1p + C2p) / 2
    hbp = (h1p + h2p) / 2 if abs(h1p - h2p) <= 180 else (h1p + h2p + 360) / 2
    Tt = 1 - 0.17 * np.cos(np.radians(hbp - 30)) + 0.24 * np.cos(np.radians(2 * hbp)) + 0.32 * np.cos(np.radians(3 * hbp + 6)) - 0.20 * np.cos(np.radians(4 * hbp - 63))
    dth = 30 * np.exp(-((hbp - 275) / 25)**2); RC = 2 * np.sqrt(Cbp**7 / (Cbp**7 + 25**7))
    SL = 1 + 0.015 * (Lbp - 50)**2 / np.sqrt(20 + (Lbp - 50)**2); SC = 1 + 0.045 * Cbp; SH = 1 + 0.015 * Cbp * Tt
    return float(np.sqrt((dLp / SL)**2 + (dCp / SC)**2 + (dHp / SH)**2 + (-np.sin(np.radians(2 * dth)) * RC) * (dCp / SC) * (dHp / SH)))
