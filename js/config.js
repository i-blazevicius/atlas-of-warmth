// ─────────────────────────────────────────────────────────────
//  Atlas of Warmth — settings
//  Everything you are likely to want to change lives in this file.
//  Panel and control styling (fonts, sizes, panel colours) lives in css/style.css.
// ─────────────────────────────────────────────────────────────

export default {

  // Published-to-web CSV links from the "Warmth atlas" Google Sheet.
  // Google refreshes these a few minutes after you edit the sheet; then reload the page.
  data: {
    types: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSisp-A30FUq5SYzZc99_S1lDcQU7IEPai58C95VTVTsYEZvuOvC-r0hoLQwF9Y3aenVgKruYcGKvf3/pub?gid=1467989397&single=true&output=csv',
    cases: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSisp-A30FUq5SYzZc99_S1lDcQU7IEPai58C95VTVTsYEZvuOvC-r0hoLQwF9Y3aenVgKruYcGKvf3/pub?gid=207720304&single=true&output=csv',
    names: '',                         // published CSV of the Names tab (local names per type and place)
    countries: 'data/countries.geojson',
    labels: 'data/labels.json',        // a point inside every country and region, for placing name dots
    ocean: 'data/ocean.geojson',       // only drawn over the climate underlay, to keep coastlines crisp
    borders: 'data/borders.json',
    credits: 'data/credits.json',      // image credits, written by the upload page
    regions: 'data/regions/',          // region shapes per country (US-CA, IT-88 …), see tools/build_regions.py      // land-border lengths between neighbours, used for inferred gaps
  },

  // Column headers in the sheet. If you rename a column, change it here.
  // Matching ignores upper/lower case, and a header that merely starts with
  // the text below also counts (so "Core countries" finds "Core countries (ISO3, confirmed)").
  typeColumns: {
    id: 'Type ID',
    family: 'Family',
    name: 'Type name',
    search: 'Search phrase',
    translit: 'Transliterated name',
    native: 'Native script name',
    form: 'Form in brief',
    period: 'Period',
    lat: 'Centre latitude',
    lon: 'Centre longitude',
    core: 'Core countries',
    fringe: 'Fringe countries',
    cases: 'Linked cases',
    inferGaps: 'Infer gaps',  // write "no" to switch off inferred gap shading for a type
  },

  // Names tab: one row per local name of a type. Each row gets its own dot on the map
  // (at Latitude/Longitude if filled in; otherwise at the type's centre point if that lies in the
  // first "Shown in" area, else inside that area), and is used when listing a country's types.
  nameColumns: {
    type: 'Type ID',
    name: 'Name',
    native: 'Native script',
    language: 'Language',
    where: 'Shown in',
    lat: 'Latitude',
    lon: 'Longitude',
    note: 'Note',
  },

  // Only text in the "Linked cases" column that looks like a case ID is used (W001, W12 …); notes around it are ignored.
  caseIdPattern: '\\bW\\d+\\b',

  caseColumns: {
    id: 'ID',
    title: 'Case name',
    story: 'Story',          // a column with the story text; shown first, in full, if it exists
  },
  // Case columns never shown in the story panel (the rest are listed under the story).
  caseHiddenColumns: ['ID', 'Case name', 'Story', 'Type ID', 'Search phrase', 'Match basis', 'Latitude', 'Longitude', 'Entry in doc'],

  // Images live in /images, named after the type ID, e.g. images/T014.jpg
  images: {
    folder: 'images/',
    extensions: ['jpg', 'jpeg', 'png', 'webp'],
    showEmptySlot: true,     // show a blank frame when a type has no image yet
  },

  // Upload page (upload.html): where images are committed, and how they are shrunk first.
  github: { owner: 'i-blazevicius', repo: 'atlas-of-warmth', branch: 'main' },
  imageUpload: {
    commonsResults: 18,      // how many Wikimedia Commons results the picker shows per search
    maxSize: 1600,           // longest side in pixels (1080 is fine for the panel; 1600 leaves room to zoom later)
    quality: 0.82,           // JPG quality, 0–1
  },

  // Climate underlays (built by tools/build_climate.py from WorldClim 2.1).
  climate: {
    start: 'none',           // 'none', 'hdd' or 'continentality'
    opacity: 0.85,
    folder: 'data/climate/',
    layers: {
      hdd: { label: 'Heating', title: 'Heating degree days (base 18 °C, per year)', low: '0', high: '10 000+' },
      continentality: { label: 'Continental', title: 'Continentality (Conrad index)', low: 'maritime', high: 'continental' },
    },
    credit: 'Climate: WorldClim 2.1, monthly means 1970–2000 (Fick & Hijmans 2017).',
  },

  // How the map starts and behaves.
  view: {
    projection: 'globe',     // 'globe' or 'mercator' (flat)
    center: [40, 40],        // [longitude, latitude]
    zoom: 1.6,
    maxZoom: 9,
    flatLatitudes: [-60, 84],  // flat map: southern and northern limit (−60 hides Antarctica); also stops zooming out past one world width
    onClick: 'fit',          // 'fit' = zoom to the type's countries, 'stay' = keep the current view
    clusterRadius: 38,       // how close points must be (in pixels) to merge into a cluster
    clusterMaxZoom: 8,       // above this zoom, points never cluster
  },

  // Map colours. Any CSS colour works.
  theme: {
    space: '#0d0c0b',        // behind the globe (also set in style.css as --space)
    ocean: '#171513',
    land: '#24211d',
    border: '#6b6157',
    borderWidth: 0.6,
    graticule: '#2a2622',
    point: '#f4e9dc',        // dots (off-white reads on both climate palettes)
    pointStroke: '#0d0c0b',
    pointRadius: 6.5,       // dot size; clicks also register a few pixels around it
    selectedRing: '#f4e9dc',
    countryOutline: '#a39888',  // outline of a clicked country
    countryOutlineWidth: 2.4,
    core: '#b8aea2',
    coreOpacity: 0.45,
    fringe: '#d8cfc3',       // fringe countries get diagonal hatching in this colour
    fringeOpacity: 0.8,
    coreLine: '#d8cfc3',     // outline round the selected type's area
    areaOutline: 1.6,        // outline round the selected type's area (fringe gets a thinner dashed one)
    atmosphere: false,       // true = soft blue glow round the globe's edge
  },

  // Unlisted countries whose land border mostly touches a type's listed countries
  // (e.g. Latvia between Estonia and Lithuania) are shaded like "less prevalent / likely".
  inferGaps: {
    on: true,
    share: 0.65,             // at least 65% of the country's land border touches listed countries…
    maxGap: 150,             // …and listed borders surround it: no stretch wider than 150° (seen from its centre)
                             // without one. Stops edge countries like Greece being added for Balkan types.
  },

  // Some sheet codes differ from the border data's codes. Left: code in the sheet, right: codes to shade.
  isoAliases: {
    XKX: ['KOS'],            // Kosovo
    SOM: ['SOM', 'SOL'],     // Somalia incl. Somaliland
    CYP: ['CYP', 'CYN'],     // Cyprus incl. the north
  },
};
