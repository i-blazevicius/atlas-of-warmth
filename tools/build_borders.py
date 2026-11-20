"""
Builds data/borders.json: the land borders between countries, used to shade "inferred gaps" (an unlisted
country mostly enclosed by a type's listed areas, see inferredGaps in js/core.js).

For every country and each land neighbour it records
    [length in km, directions]
and, where the neighbour has region shapes (data/regions), how that stretch of border splits between the
neighbour's regions:
    [length in km, directions, {"IN-WB": [length, directions], "IN-AS": [...], ...}]
so a country listed in the sheet only through some of its regions counts only for the stretches of border
those regions actually touch. Grouped regions (FR-OCC, GB-SEE, LV-VID …) get the stretches of their parts.

"directions": which of 36 directions (10° each) the stretch lies in, seen from the centre of the country's
largest landmass (so islands far away don't pull it off; if that centre falls outside the land, a point inside
it), as one number of 36 binary digits (bit i = i×10° to i×10°+10°, clockwise from north, as seen on a flat map at that latitude).

Lengths are measured on the map's own 1:50m country shapes, so they are shorter than official figures
(coastline-paradox style), but consistent with each other, which is all the gap rule needs.

Run from the repository (needs Python 3 with shapely):  python3 tools/build_borders.py
Rerun after changing data/countries.geojson or data/regions/.
"""
import json, math, os, sys
from shapely.geometry import shape, LineString, Point
from shapely.ops import unary_union
from shapely.strtree import STRtree
from shapely.geometry import MultiPolygon
from shapely.validation import make_valid

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
DATA = os.path.join(ROOT, 'data')
OUT = os.path.join(DATA, 'borders.json')

TOL = 0.005         # degrees: how close a country's edge must run to a neighbour to count as a shared border
                    # (the country shapes share their border points, so this only needs to absorb rounding)
PIECE = 0.05        # degrees: shared borders are cut into pieces this long to split them between regions
REGION_TOL = 0.25   # degrees: a piece belongs to the neighbour's regions within this distance (else: none)
REGION_SLACK = 0.03 # degrees: regions this much further than the nearest one also get the piece (groups)
MIN_KM = 1          # stretches shorter than this are left out
REGION_FILE = {'PSE': 'PSX', 'SSD': 'SDS'}   # region files named differently from the country code


def km(a, b):
    """Great-circle distance between two lon/lat points, km."""
    (lon1, lat1), (lon2, lat2) = a, b
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(min(1, h)))


def bearing(a, b):
    """Direction from a to b as it looks on a flat map at a's latitude: degrees clockwise from north.
    (True compass bearings bend round the pole at high latitudes and make Canada look surrounded by the USA.)"""
    (lon1, lat1), (lon2, lat2) = a, b
    dx = ((lon2 - lon1 + 180) % 360 - 180) * math.cos(math.radians(lat1))
    return (math.degrees(math.atan2(dx, lat2 - lat1)) + 360) % 360


def lines(geom):
    if geom.is_empty:
        return []
    if geom.geom_type == 'LineString':
        return [geom]
    if hasattr(geom, 'geoms'):
        return [l for g in geom.geoms for l in lines(g)]
    return []


def pieces(geom):
    """Cut a (multi)line into short straight pieces: (start, end) pairs."""
    out = []
    for ln in lines(geom):
        cs = list(ln.coords)
        for a, b in zip(cs, cs[1:]):
            n = max(1, math.ceil(math.hypot(b[0] - a[0], b[1] - a[1]) / PIECE))
            for i in range(n):
                out.append(((a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n),
                            (a[0] + (b[0] - a[0]) * (i + 1) / n, a[1] + (b[1] - a[1]) * (i + 1) / n)))
    return out


def polygons(geom):
    """Only the area parts of a geometry (make_valid can add stray lines or points)."""
    if geom.geom_type in ('Polygon', 'MultiPolygon'):
        return geom
    return MultiPolygon([p for g in getattr(geom, 'geoms', []) for p in getattr(polygons(g), 'geoms', [polygons(g)])
                         if p.geom_type == 'Polygon'])


def load_countries():
    feats = json.load(open(os.path.join(DATA, 'countries.geojson')))['features']
    by = {}
    for f in feats:
        by.setdefault(f['properties']['iso'], []).append(polygons(make_valid(shape(f['geometry']))))
    return {iso: polygons(unary_union(gs)) for iso, gs in by.items()}


def load_regions(iso):
    path = os.path.join(DATA, 'regions', f"{REGION_FILE.get(iso, iso)}.geojson")
    if not os.path.exists(path):
        return []
    return [(f['properties']['code'], polygons(make_valid(shape(f['geometry']))))
            for f in json.load(open(path))['features'] if f.get('geometry')]


def main():
    countries = load_countries()
    isos = sorted(countries)
    tree = STRtree([countries[i] for i in isos])
    region_cache = {}
    out = {}
    for c in isos:
        geom = countries[c]
        main = max(getattr(geom, 'geoms', [geom]), key=lambda p: p.area)
        centre = main.centroid if main.contains(main.centroid) else main.representative_point()
        centre = centre.coords[0]
        edge = geom.boundary
        found = {}
        for j in tree.query(geom.buffer(TOL)):
            n = isos[j]
            if n == c:
                continue
            shared = edge.intersection(countries[n].buffer(TOL))
            parts = pieces(shared)
            if not parts:
                continue
            total, dirs, split = 0.0, 0, {}
            if n not in region_cache:
                rs = load_regions(n)
                region_cache[n] = (rs, STRtree([g for _, g in rs]) if rs else None)
            regions, rtree = region_cache[n]
            for a, b in parts:
                length = km(a, b)
                mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
                bit = 1 << int(bearing(centre, mid) // 10) % 36
                total += length
                dirs |= bit
                if rtree is None:
                    continue
                p = Point(mid)
                near = [(regions[k][1].distance(p), regions[k][0]) for k in rtree.query(p.buffer(REGION_TOL))]
                if not near:
                    continue
                d0 = min(d for d, _ in near)
                for d, code in near:
                    if d <= d0 + REGION_SLACK and d <= REGION_TOL:
                        s = split.setdefault(code, [0.0, 0])
                        s[0] += length
                        s[1] |= bit
            if total < MIN_KM:
                continue
            entry = [round(total), dirs]
            split = {r: [round(l), d] for r, (l, d) in sorted(split.items()) if l >= MIN_KM}
            if split:
                entry.append(split)
            found[n] = entry
        if found:
            out[c] = found
        print(f'{c}: {len(found)} neighbours', file=sys.stderr)
    with open(OUT, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    print(f'wrote {OUT}: {len(out)} countries, {os.path.getsize(OUT) // 1024} KB', file=sys.stderr)


if __name__ == '__main__':
    main()
