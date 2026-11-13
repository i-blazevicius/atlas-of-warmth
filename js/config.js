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
    countries: 'data/countries.geojson',
  },

  // Column headers in the sheet. If you rename a column, change it here.
  // Matching ignores upper/lower case, and a header that merely starts with
  // the text below also counts (so "Core countries" finds "Core countries (ISO3, confirmed)").
  typeColumns: {
    id: 'Type ID',
    family: 'Family',
    name: 'Type name',
    translit: 'Transliterated name',
    native: 'Native script name',
    form: 'Form in brief',
    period: 'Period',
    lat: 'Centre latitude',
    lon: 'Centre longitude',
    core: 'Core countries',
    fringe: 'Fringe countries',
    cases: 'Linked cases',
  },

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

  // How the map starts and behaves.
  view: {
    projection: 'globe',     // 'globe' or 'mercator' (flat)
    center: [40, 40],        // [longitude, latitude]
    zoom: 1.6,
    maxZoom: 9,
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
    point: '#e8662a',
    pointStroke: '#0d0c0b',
    pointRadius: 6.5,       // dot size; clicks also register a few pixels around it
    selectedRing: '#f4e9dc',
    core: '#e8662a',
    coreOpacity: 0.55,
    fringe: '#e8662a',       // fringe countries get diagonal hatching in this colour
    fringeOpacity: 0.7,
    atmosphere: false,       // true = soft blue glow round the globe's edge
  },

  // Some sheet codes differ from the border data's codes. Left: code in the sheet, right: codes to shade.
  isoAliases: {
    XKX: ['KOS'],            // Kosovo
    SOM: ['SOM', 'SOL'],     // Somalia incl. Somaliland
    CYP: ['CYP', 'CYN'],     // Cyprus incl. the north
  },
};
