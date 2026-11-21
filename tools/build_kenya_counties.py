"""
Replaces Kenya's region shapes (Natural Earth still has the 8 provinces, codes KE-700 etc., abolished in 2013)
with the 47 counties, ISO 3166-2 codes KE-01 to KE-47, from geoBoundaries (CC BY 4.0, https://www.geoboundaries.org).

Updates data/regions/KEN.geojson, data/regions/index.json (names) and data/labels.json (a point inside each county).
Afterwards run  python3 tools/build_borders.py  to refresh data/borders.json.
Do not rerun tools/build_regions.py without rerunning this afterwards: it would bring the provinces back.

Run (needs Python 3 with shapely, and Node for mapshaper):
    python3 tools/build_kenya_counties.py /path/to/geoBoundaries-KEN-ADM1_simplified.geojson
Download: https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/main/releaseData/gbOpen/KEN/ADM1/geoBoundaries-KEN-ADM1_simplified.geojson
"""
import json, os, subprocess, sys, tempfile
from shapely.geometry import shape
from shapely.ops import polylabel

SRC = sys.argv[1]
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', 'data')
SIMPLIFY = '6%'          # same as build_regions.py

ms = os.path.join(HERE, 'node_modules', '.bin', 'mapshaper')
if not os.path.exists(ms):
    subprocess.run(['npm', 'i', '--prefix', HERE, 'mapshaper@0.6'], check=True)

src = json.load(open(SRC))
for f in src['features']:
    p = f['properties']
    f['properties'] = {'code': p['shapeISO'], 'name': p['shapeName']}
tmp = tempfile.mkdtemp()
slim, out = os.path.join(tmp, 'in.json'), os.path.join(tmp, 'out.json')
json.dump(src, open(slim, 'w'))
subprocess.run([ms, slim, '-simplify', SIMPLIFY, 'weighted', 'keep-shapes', '-clean',
                '-o', 'format=geojson', 'precision=0.001', out], check=True)
feats = json.load(open(out))['features']
assert len(feats) == 47 and all(f['properties']['code'].startswith('KE-') for f in feats)
json.dump({'type': 'FeatureCollection', 'features': [
    {'type': 'Feature', 'properties': {'code': f['properties']['code'], 'name': f['properties']['name']}, 'geometry': f['geometry']}
    for f in feats]}, open(os.path.join(DATA, 'regions', 'KEN.geojson'), 'w'), separators=(',', ':'))

ipath = os.path.join(DATA, 'regions', 'index.json')
ix = json.load(open(ipath))
ix['names'] = {k: v for k, v in ix['names'].items() if not k.startswith('KE-')}
for f in feats:
    ix['names'][f['properties']['code']] = f['properties']['name']
json.dump(ix, open(ipath, 'w'), separators=(',', ':'), ensure_ascii=False)

lpath = os.path.join(DATA, 'labels.json')
lab = json.load(open(lpath))
lab = {k: v for k, v in lab.items() if not k.startswith('KE-')}
for f in feats:
    g = shape(f['geometry'])
    big = max(g.geoms, key=lambda x: x.area) if g.geom_type == 'MultiPolygon' else g
    pt = polylabel(big, tolerance=0.001)
    lab[f['properties']['code']] = [round(pt.x, 2), round(pt.y, 2)]
json.dump(lab, open(lpath, 'w'), separators=(',', ':'))
print('Kenya: 47 counties written')
