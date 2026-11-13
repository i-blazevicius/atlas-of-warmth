"""
Builds data/regions/<ISO3>.geojson from Natural Earth admin-1 (states/provinces), 1:10m.
Each feature: { code, name }. Codes are ISO 3166-2 (US-CA, IT-TN …), plus grouped regions:
  - Italian, French and Spanish regions from Natural Earth (IT-88 Sardinia, FR-OCC, ES-CL …)
  - the custom groups in GROUPS below.
Run (needs Python 3 and Node):  python3 tools/build_regions.py /path/to/ne_10m_admin_1_states_provinces.geojson
Download: https://github.com/nvkelso/natural-earth-vector/raw/master/geojson/ne_10m_admin_1_states_provinces.geojson
"""
import json, os, re, subprocess, sys, tempfile

SRC = sys.argv[1]
OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'regions')
SIMPLIFY = '6%'

# Extra groups: code -> (name, country ISO3, test on a Natural Earth feature's properties)
GROUPS = {
    'GB-NIR': ('Northern Ireland', 'GBR', lambda p: p['region'] == 'Northern Ireland'),
    'GB-WLS': ('Wales', 'GBR', lambda p: p['region'] in ('West Wales and the Valleys', 'East Wales')),
    'GB-SCT': ('Scotland', 'GBR', lambda p: p['region'] in ('Highlands and Islands', 'North Eastern', 'Eastern', 'South Western', 'West Central', 'South Western Scotland', 'North Eastern Scotland', 'Eastern Scotland')),
    'GB-SEE': ('South East England', 'GBR', lambda p: p['region'] in ('South East', 'London')),
    'LV-VID': ('Vidzeme', 'LVA', lambda p: p['region'] == 'Vidzeme'),
    'LV-KUR': ('Kurzeme', 'LVA', lambda p: p['region'] == 'Kurzeme'),
    'LV-ZEM': ('Zemgale', 'LVA', lambda p: p['region'] == 'Zemgale'),
    'LV-LAT': ('Latgale', 'LVA', lambda p: p['region'] == 'Latgale'),
}
NE_REGION_COUNTRIES = {'ITA', 'FRA', 'ESP'}   # where Natural Earth's region_cod is a proper ISO code

ms = os.path.join(os.path.dirname(__file__), 'node_modules', '.bin', 'mapshaper')
if not os.path.exists(ms):
    subprocess.run(['npm', 'i', '--prefix', os.path.dirname(__file__), 'mapshaper@0.6'], check=True)

tmp = tempfile.mkdtemp()
src = json.load(open(SRC))
for f in src['features']:
    p = f['properties']
    code = (p.get('region_cod') or '').strip().replace('.', '-')
    grp = []
    if p['adm0_a3'] in NE_REGION_COUNTRIES and re.fullmatch(r'[A-Z]{2}-[A-Z0-9]+', code):
        grp.append(code)
    for g, (_, iso3, test) in GROUPS.items():
        if p['adm0_a3'] == iso3 and test(p):
            grp.append(g)
    f['properties'] = {
        'code': p['iso_3166_2'], 'name': p.get('name_en') or p['name'], 'country': p['adm0_a3'],
        'region': p.get('region') or '', 'groups': ','.join(grp),
    }
slim = os.path.join(tmp, 'slim.json'); json.dump(src, open(slim, 'w'))

units = os.path.join(tmp, 'units.json')
subprocess.run([ms, slim, '-simplify', SIMPLIFY, 'weighted', 'keep-shapes', '-clean',
                '-o', 'format=geojson', 'precision=0.001', units], check=True)

features = json.load(open(units))['features']
# Grouped regions: one copy of the units per group, then dissolve by group code.
grouped = []
for f in features:
    for g in filter(None, f['properties']['groups'].split(',')):
        name = GROUPS[g][0] if g in GROUPS else f['properties']['region']
        grouped.append({'type': 'Feature', 'geometry': f['geometry'],
                        'properties': {'code': g, 'name': name, 'country': f['properties']['country']}})
gpath = os.path.join(tmp, 'groups.json'); dpath = os.path.join(tmp, 'groups_d.json')
json.dump({'type': 'FeatureCollection', 'features': grouped}, open(gpath, 'w'))
subprocess.run([ms, gpath, '-dissolve', 'code', 'copy-fields=name,country',
                '-o', 'format=geojson', 'precision=0.001', dpath], check=True)
groups = json.load(open(dpath))['features']

os.makedirs(OUT, exist_ok=True)
by_country, prefixes, names = {}, {}, {}
for f in features + groups:
    p = f['properties']
    code = (p['code'] or '').strip()
    if not code or '~' in code or code == '-99':
        continue
    c = p['country']
    by_country.setdefault(c, []).append({'type': 'Feature', 'properties': {'code': code, 'name': p['name']}, 'geometry': f['geometry']})
    prefixes.setdefault(code.split('-')[0], c)
    names[code] = p['name']
for c, feats in by_country.items():
    json.dump({'type': 'FeatureCollection', 'features': feats}, open(os.path.join(OUT, f'{c}.geojson'), 'w'), separators=(',', ':'))
json.dump({'prefixes': prefixes, 'names': names}, open(os.path.join(OUT, 'index.json'), 'w'), separators=(',', ':'), ensure_ascii=False)
print(len(by_country), 'countries,', len(names), 'codes')
