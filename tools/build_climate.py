"""
Builds the climate underlays in data/climate/ from WorldClim 2.1 bioclimatic variables (10 arc-minutes).
  python3 tools/build_climate.py /path/to/wc2.1_10m_bio
Needs: pip install tifffile imagecodecs numpy pillow
Source: Fick, S.E. & Hijmans, R.J. (2017) WorldClim 2. https://www.worldclim.org  (CC BY 4.0), means 1970–2000.

Heating degree days (base 18 °C) are ESTIMATED: each cell's year is modelled as a sine curve through its
annual mean (BIO1) with an amplitude from the warmest- and coldest-quarter means (BIO10, BIO11); HDD is the sum
over 365 days of max(0, 18 − T). Day-to-day swings are ignored, so mild-winter places come out a little low.
Continentality is Conrad's index: K = 1.7·A / sin(latitude + 10°) − 14, A = annual range of monthly means.
0 ≈ fully maritime, 100 ≈ extremely continental.
"""
import os, sys, json
import numpy as np, tifffile
from PIL import Image

SRC = sys.argv[1]
OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'climate')
BASE = 18.0
WIDTH = 2048            # output width; height follows (Web Mercator, ±85.05°)
MAX_LAT = 85.0511287798

def band(n):
    a = tifffile.imread(os.path.join(SRC, f'wc2.1_10m_bio_{n}.tif')).astype('float64')
    a[a < -1e30] = np.nan
    return a

mean, warm, cold = band(1), band(10), band(11)
# A quarter-mean of a sine curve is ~0.9003 of its peak (sin(π/4)/(π/4)).
amp = (warm - cold) / 2 / 0.9003
days = np.cos(2 * np.pi * (np.arange(365) + 0.5) / 365)
hdd = np.zeros_like(mean)
for c in np.array_split(days, 13):  # in chunks to keep memory low
    t = mean[..., None] + amp[..., None] * c
    hdd += np.clip(BASE - t, 0, None).sum(-1)
hdd[np.isnan(mean)] = np.nan

h, w = mean.shape
lat = 90 - (np.arange(h) + 0.5) * 180 / h
annual_range = 2 * amp
k = 1.7 * annual_range / np.sin(np.radians(np.abs(lat)[:, None] + 10)) - 14
k[np.isnan(mean)] = np.nan

def spread(grid, steps=4):
    """Extend values a few cells out to sea, so the crisp ocean layer drawn on top hides the blocky coast."""
    g = grid.copy()
    for _ in range(steps):
        nan = np.isnan(g)
        if not nan.any(): break
        acc = np.zeros_like(g); cnt = np.zeros_like(g)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            sh = np.roll(np.roll(g, dy, 0), dx, 1)
            ok = ~np.isnan(sh)
            acc[ok] += sh[ok]; cnt[ok] += 1
        fill = nan & (cnt > 0)
        g[fill] = acc[fill] / cnt[fill]
    return g

def to_mercator(grid):
    """Resample a lat/lon grid (90..-90) to Web Mercator rows."""
    height = WIDTH
    y = (np.arange(height) + 0.5) / height            # 0 top .. 1 bottom
    merc = np.pi * (1 - 2 * y)
    lats = np.degrees(np.arctan(np.sinh(merc)))
    rows = np.clip(((90 - lats) / 180 * h).astype(int), 0, h - 1)
    cols = np.clip(((np.arange(WIDTH) + 0.5) / WIDTH * w).astype(int), 0, w - 1)
    return grid[rows][:, cols]

def ramp(stops, values, vmin, vmax):
    """stops: list of (0..1, '#rrggbb'). Returns RGBA uint8, NaN transparent."""
    pos = np.array([s[0] for s in stops])
    cols = np.array([[int(s[1][i:i + 2], 16) for i in (1, 3, 5)] for s in stops], float)
    x = np.clip((values - vmin) / (vmax - vmin), 0, 1)
    rgb = np.stack([np.interp(x, pos, cols[:, i]) for i in range(3)], -1)
    alpha = np.where(np.isnan(values), 0, 255)[..., None]
    rgb = np.nan_to_num(rgb)
    return np.concatenate([rgb, alpha], -1).astype('uint8')

# Ironbow: white-hot … black-cold. For HDD, many degree days = cold = dark.
IRONBOW = [(0, '#ffffe6'), (0.12, '#ffe066'), (0.28, '#fca12a'), (0.45, '#e8532a'), (0.62, '#b0205a'),
           (0.78, '#5c1270'), (0.9, '#22104a'), (1, '#05030f')]
CONTINENTAL = [(0, '#2f7f8f'), (0.25, '#7fb7b2'), (0.5, '#e6dcc0'), (0.75, '#d08a4c'), (1, '#8a3b1e')]

LAYERS = {
    'hdd': (hdd, IRONBOW, 0, 10000),
    'continentality': (k, CONTINENTAL, 0, 100),
}
os.makedirs(OUT, exist_ok=True)
meta = {}
for name, (grid, stops, vmin, vmax) in LAYERS.items():
    img = Image.fromarray(ramp(stops, to_mercator(spread(grid)), vmin, vmax), 'RGBA')
    img.save(os.path.join(OUT, f'{name}.webp'), 'WEBP', quality=85, method=6)
    meta[name] = {'min': vmin, 'max': vmax, 'stops': stops}
json.dump(meta, open(os.path.join(OUT, 'legend.json'), 'w'))

def at(grid, la, lo):
    return grid[int((90 - la) / 180 * h), int((lo + 180) / 360 * w)]
for place, la, lo in [('Vilnius', 54.7, 25.3), ('London', 51.5, -0.1), ('Yakutsk', 62.0, 129.7),
                      ('Lisbon', 38.7, -9.1), ('Moscow', 55.75, 37.6), ('Reykjavik', 64.1, -21.9), ('Delhi', 28.6, 77.2)]:
    print(f'{place:10s} HDD {at(hdd, la, lo):6.0f}   continentality {at(k, la, lo):5.1f}')
