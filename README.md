# Atlas of Warmth

Interactive map of hearth types from the *Warmth atlas* Google Sheet.
Live at **https://i-blazevicius.github.io/atlas-of-warmth/**

## Updating the data

Edit the Google Sheet (Types and Cases tabs), wait a few minutes for Google to refresh the
published CSV, then reload the map. Nothing in this repository needs to change.

- A type appears on the map if it has a **Type ID** and numeric **Centre latitude / longitude**.
- **Core / Fringe countries**: ISO3 codes separated by commas (`RUS, BLR`). Core ("widely used") is shaded solid,
  fringe ("less prevalent / likely") hatched.
- **Region codes** can be mixed in with country codes: `ITA, US-CA, IT-88`. They are ISO 3166-2 codes
  (states, provinces, counties) and contain a hyphen. List a region *instead of* its country, otherwise the whole
  country is shaded. Also available: Italian, French and Spanish regions (`IT-88` Sardinia, `FR-OCC`, `ES-CL`) and
  a few custom groups: `GB-NIR` Northern Ireland, `GB-WLS` Wales, `GB-SCT` Scotland, `GB-SEE` South East England,
  `LV-VID` / `LV-KUR` / `LV-ZEM` / `LV-LAT` (Latvian regions). Unknown codes are listed in the browser console.
  Look codes up in `data/regions/index.json`, or on Wikipedia ("ISO 3166-2:IT").
- **Names tab**: one row per local name of a type (Type ID, Name, Native script, Language, Shown in, Latitude,
  Longitude, Note). Each row gets its own dot, all opening the same card. The dot sits at Latitude/Longitude if
  filled in; otherwise at the type's centre point if that lies in the first "Shown in" area; otherwise inside that
  area. Clicking a country lists each type under its local name there; the card's heading follows the dot or list
  you came from, and the names row on the card switches between them. Types without Names rows work as before.
- **Infer gaps** (Types tab): write `no` to stop a type's inferred gap shading.
- **Stand-out types** (`standout` in `js/config.js`, now T000): never merged into clusters, drawn as a black dot.
- Row order in the sheet doesn't matter; types are matched by ID.
- **Clicking a country** lists every type found in it, including types listed only by one of its regions.
- **Inferred gaps**: an unlisted country whose land border mostly (60%+) touches a type's listed countries is hatched too
  (e.g. Latvia between Estonia and Lithuania). Change or switch off under `inferGaps` in `js/config.js`.
- **Linked cases**: only text that looks like a case ID (`W001`) is used; notes around it are ignored.
- **Stories**: add a column called `Story` to the Cases tab and its text shows in the story panel.
  Other filled-in Cases columns are listed below it (except those listed in `caseHiddenColumns` in `js/config.js`).
- Link straight to a type by adding its ID to the address: `…/atlas-of-warmth/#T014`.

## Images

Use the upload page: **https://i-blazevicius.github.io/atlas-of-warmth/upload.html**

- Drop an image on a type's row (or click the row to pick a file), or drop many files on the dashed box:
  each is matched by the type ID at the start of its file name (`T014 stove.png` → T014).
- Images are shrunk to 1600 px on the long side and saved as JPG (`imageUpload` in `js/config.js`).
- With a GitHub token (instructions on the page) they are saved straight into `images/` and replace any older
  version; the map shows them a minute or two later. Without a token they are downloaded, already renamed,
  for uploading by hand (github.com → images → Add file → Upload files).

- **find on Commons** (on each row) searches Wikimedia Commons with the type's search phrase, native name and
  transliteration. Click a result to save it: the image is shrunk and renamed, and its author, licence and
  source link go into `data/credits.json`. Other words can be searched in the box.
- For an image found elsewhere, type its credit in the row's credit field, then drop the image on the row
  (or click the thumbnail). "Save credit only" changes the credit of an image already there.
- Credits show as a small linked line under the image on the map. Removing an image removes its credit.

Images are stored in colour and shown in greyscale on the page.
To apply one look to all images without editing them, change `--image-filter` in `css/style.css`
(e.g. `grayscale(1) contrast(1.1)`).

## Climate underlays

Switch them in the control panel. Both are built by `tools/build_climate.py` from WorldClim 2.1
(10-minute monthly average temperatures, 1970–2000 means, CC BY 4.0 – credit shown on the map):

- **Heating** – heating degree days per year, base 18 °C: how much heating a year's weather asks for.
  From the 12 monthly mean temperatures with Hitchin's formula (allows for day-to-day swings).
  Dark = cold, pale = little or no heating needed.
- **Continental** – Conrad's continentality index (0 maritime → 100 extremely continental), from the
  summer–winter range corrected for latitude.

## Changing the look

| What | Where |
|---|---|
| Map colours, point size, shading, start view, cluster settings, column names | `js/config.js` |
| Fonts, panels, control panel, clusters, legend | `css/style.css` (variables at the top) |
| Control panel contents | `index.html` |

## Experiments (off by default)

Two trial features, switched in `js/config.js` or just for one visit through the address bar:

| Feature | config.js | Try it with |
|---|---|---|
| Floating cards: up to 5 open at once, each hanging off its dot; the oldest closes when a 6th opens, and a card closes when its dot leaves the screen. Click a card to bring it to the front. | `cards: 'float'` (`maxCards: 5`) | `?cards=float` |
| Equal Earth on the flat map (the globe stays as it is). | `flatProjection: 'equalEarth'` | `?flat=equalearth` |

Both together: `…/atlas-of-warmth/?cards=float&flat=equalearth`. To go back, set the values to `'panel'` and `'mercator'` (the defaults). The branch `before-experiments` keeps the site as it was before either was added.

Equal Earth uses its own climate images (`data/climate/*-ee.webp`), made by `tools/build_climate.py` alongside the normal ones.

## Files

- `index.html` – the page
- `js/app.js` – map behaviour
- `js/config.js` – settings
- `css/style.css` – styling
- `data/countries.geojson` – country borders (Natural Earth 1:50m, public domain), with `iso` codes
- `data/borders.json` – land-border lengths and directions between neighbours (for inferred gaps)
- `data/credits.json` – image credits (written by the upload page)
- `data/climate/` – climate underlay images and legend; `data/ocean.geojson` – sea drawn over them for crisp coasts
- `data/regions/` – region shapes per country (Natural Earth admin-1, 1:10m, simplified), loaded only when needed;
  rebuild with `tools/build_regions.py`
- `lib/` – MapLibre GL JS 6.18 (BSD licence) and Papa Parse 5.5 (MIT), kept here so the page has no outside dependencies apart from the sheet and Google Fonts
