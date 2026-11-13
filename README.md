# Atlas of Warmth

Interactive map of hearth types from the *Warmth atlas* Google Sheet.
Live at **https://i-blazevicius.github.io/atlas-of-warmth/**

## Updating the data

Edit the Google Sheet (Types and Cases tabs), wait a few minutes for Google to refresh the
published CSV, then reload the map. Nothing in this repository needs to change.

- A type appears on the map if it has a **Type ID** and numeric **Centre latitude / longitude**.
- **Core / Fringe countries**: ISO3 codes separated by commas (`RUS, BLR`). Core is shaded solid, fringe hatched.
- **Linked cases**: case IDs separated by commas (`W001, W004`). Each must exist in the Cases tab's `ID` column.
- **Stories**: add a column called `Story` to the Cases tab and its text shows in the story panel.
  Other filled-in Cases columns are listed below it (except those listed in `caseHiddenColumns` in `js/config.js`).
- Link straight to a type by adding its ID to the address: `…/atlas-of-warmth/#T014`.

## Images

Put images in the `images/` folder, named after the type ID: `T014.jpg` (also `.jpeg`, `.png`, `.webp`).
Keep them around 1200–1600 px on the long side so the page stays fast.
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
- `lib/` – MapLibre GL JS 6.18 (BSD licence) and Papa Parse 5.5 (MIT), kept here so the page has no outside dependencies apart from the sheet and Google Fonts
