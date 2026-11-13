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

Images are stored in colour and shown in greyscale on the page.
To apply one look to all images without editing them, change `--image-filter` in `css/style.css`
(e.g. `grayscale(1) contrast(1.1)`).

## Changing the look

| What | Where |
|---|---|
| Map colours, point size, shading, start view, cluster settings, column names | `js/config.js` |
| Fonts, panels, control panel, clusters, legend | `css/style.css` (variables at the top) |
| Control panel contents | `index.html` |

## Files

- `index.html` – the page
- `js/app.js` – map behaviour
- `js/config.js` – settings
- `css/style.css` – styling
- `data/countries.geojson` – country borders (Natural Earth 1:50m, public domain), with `iso` codes
- `data/borders.json` – land-border lengths and directions between neighbours (for inferred gaps)
- `data/regions/` – region shapes per country (Natural Earth admin-1, 1:10m, simplified), loaded only when needed;
  rebuild with `tools/build_regions.py`
- `lib/` – MapLibre GL JS 6.18 (BSD licence) and Papa Parse 5.5 (MIT), kept here so the page has no outside dependencies apart from the sheet and Google Fonts
