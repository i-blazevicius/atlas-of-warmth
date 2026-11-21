# Atlas of Warmth

Interactive map of hearth types from the *Warmth atlas* Google Sheet.
Live at **https://i-blazevicius.github.io/atlas-of-warmth/**

## Updating the data

Edit the Google Sheet (Types, Names and Cases tabs), wait a few minutes for Google to refresh the
published CSV, then reload the map. Nothing in this repository needs to change.

- Columns are found by their **header text**, never by their letter, so columns can be moved or added
  freely. Don't rename or duplicate the headers the map uses (listed in `js/config.js` → `typeColumns`,
  `nameColumns`, `caseColumns`). If one can't be found, the map says so under the hearth count.
- A hearth appears on the map if it has a **Type ID** and numeric **Centre latitude / longitude**.
- **Core / Fringe countries**: ISO3 codes separated by commas (`RUS, BLR`). Core ("widely used") is shaded solid,
  fringe ("less prevalent / likely") hatched.
- **Region codes** can be mixed in with country codes: `ITA, US-CA, IT-88`. They are ISO 3166-2 codes
  (states, provinces, counties) and contain a hyphen. List a region *instead of* its country, otherwise the whole
  country is shaded. Also available: Italian, French and Spanish regions (`IT-88` Sardinia, `FR-OCC`, `ES-CL`) and
  a few custom groups: `GB-NIR` Northern Ireland, `GB-WLS` Wales, `GB-SCT` Scotland, `GB-SEE` South East England,
  `LV-VID` / `LV-KUR` / `LV-ZEM` / `LV-LAT` (Latvian regions). Codes the map doesn't know are listed under the
  hearth count. Look codes up in `data/regions/index.json`, or on Wikipedia ("ISO 3166-2:IT").
- Places too small for the map's country shapes (Tokelau, `TKL`) are skipped quietly: see `isoAliases` in `js/config.js`.
- **Names tab**: one row per local name of a type (Type ID, Name, Native script, Language, Shown in, Latitude,
  Longitude, Note). Each row gets its own dot, all opening the same card. The dot sits at Latitude/Longitude if
  filled in; otherwise at the type's centre point if that lies in the first "Shown in" area; otherwise inside that
  area. Clicking a country lists each hearth under its local name there; the card's heading follows the dot or list
  you came from, and the names row on the card switches between them. Types without Names rows work as before.
- **Infer gaps** (Types tab): write `no` to stop a type's inferred gap shading.
- **Stand-out types** (`standout` in `js/config.js`, now T000): never merged into clusters, drawn as a black dot.
- Row order in the sheet doesn't matter; types are matched by ID.
- **Clicking a country** lists the hearths found in it that the filters let through (with a note of how many
  more the filters hide), including hearths listed only by one of its regions.
- **Inferred gaps**: an unlisted country whose land border mostly (65%+) touches a type's listed areas, and
  which they surround (no stretch wider than 150° without one), is hatched too (e.g. Latvia between Estonia and
  Lithuania). A country listed only through some of its regions counts only for the stretches of border those
  regions touch: Jammu and Kashmir does not make Bangladesh a gap, because it doesn't border it. Change or switch
  off under `inferGaps` in `js/config.js`.
- **Linked cases** (Types tab) is the only link between a hearth and its stories: only text that looks like a
  case ID (`W001`) is used; notes around it are ignored.
- **Stories** (Cases tab): the story panel shows Case name, Place · Period, Story and Author. Other filled-in
  Cases columns are listed below it, except those in `caseHiddenColumns` in `js/config.js`.
- **Addresses**: every step has its own address, so Back and Forward move between them and any of them can be
  bookmarked or shared: `…/atlas-of-warmth/#T014` (a hearth's card), `#T014/W001` (with one of its stories
  open), `#LTU` (a country's list).

## When something goes wrong

If the map, print page or upload page cannot start, a box in the middle of the page gives a code and says
what happened:

| Code | Meaning | What to do |
|---|---|---|
| E1 | `js/config.js` can't be read: a comma, bracket or quote is missing or extra | On GitHub, open the file's History and correct or undo the last change |
| E2 | A sheet tab couldn't be reached, or Google answered with an error | Check the internet connection, then the links in `js/config.js` → `data` |
| E3 | A sheet tab came back as a web page instead of data: the sheet is no longer published | Google Sheets → File → Share → Publish to web |
| E4 | The Types tab has no `Type ID` column, or no row with an ID and coordinates | Check the header row of the Types tab |
| E5 | A file of the site itself (the country shapes) is missing | Check that `data/countries.geojson` is in the repository |
| E6 | Anything else: an error in the code | If it started after an edit on GitHub, undo that edit |

Smaller problems don't stop the map. They are listed under the hearth count (and in the print page's bar): a
renamed column, a hearth without coordinates, an unknown area code, a story ID missing from the Cases tab, a
name given to a type ID that doesn't exist.

## Images

Use the upload page (**…/atlas-of-warmth/upload.html**). The map only knows about images saved through it,
because it also records each image's size in `data/images.json`. An image added to `images/` by hand on
GitHub won't show until that file lists it too.

- Drop an image on a type's row (or click the thumbnail to pick a file), or drop many files on the dashed box:
  each is matched by the type ID at the start of its file name (`T014 stove.png` → T014).
- Images are shrunk to 1600 px on the long side and saved as JPG (`imageUpload` in `js/config.js`).
- With a GitHub token (instructions on the page) they are saved straight into `images/` and replace any older
  version; the map shows them a minute or two later. Without a token they are downloaded, already renamed. If the
  token has expired or been revoked, the page says so and asks for a new one.
- **find on Commons** (on each row) searches Wikimedia Commons with the type's search phrase, native name,
  transliteration and its names in other languages. Click a result to save it: the image is shrunk and renamed,
  and its author, licence and source link go into `data/credits.json`. Other words can be searched in the box.
- For an image found elsewhere (the Google buttons open a search in a new tab), paste its link or the image
  itself into the *Paste here* field, and type its credit and source in the fields below.
- **edit credit** changes the credit of an image already there; **remove** takes the image and its credit away.
- Each change is saved as **one commit**: an image together with its entry in `data/images.json` and its credit
  (and the removal of any older version), a removal, or a credit edit. The line at the top says whether
  everything is saved; anything that failed can be retried from there.
- **Disconnect** (in the connection box, or in the top line once everything is saved) forgets the token in this
  browser; paste it again next time. The style panel uses the same token.
- The search box and *Only types without an image* only hide rows, so open searches and typed credits stay.

Images are stored in colour and shown in greyscale on the page.
To apply one look to all images without editing them, change `--image-filter` in `css/style.css`
(e.g. `grayscale(1) contrast(1.1)`).

## Climate underlays

Switch them in the control panel. Both are built by `tools/build_climate.py` from WorldClim 2.1
(10-minute monthly average temperatures, 1970–2000 means; credit shown on the map). WorldClim's licence allows
academic and other non-commercial use, and asks for permission before the data itself is redistributed or used
commercially.

- **Heating** – heating degree days per year, base 18 °C: how much heating a year's weather asks for.
  From the 12 monthly mean temperatures with Hitchin's formula (allows for day-to-day swings).
  Dark = cold, pale = little or no heating needed.
- **Continental** – Conrad's continentality index (0 maritime → 100 extremely continental), from the
  summer–winter range corrected for latitude.

## Changing the look

**Style panel.** With `stylePanel: true` in `js/config.js`, a *Style* panel sits under the map controls:

- **Versions:** click one to switch fonts and colours. *Make default* sets what visitors see.
- **Accent, More colours, Fonts:** any change makes an *Unsaved changes* entry, so the saved versions stay untouched. *Save* (with a name) adds it to the list; *Discard* goes back.
- **Add a font:** type a Google font's name or paste its fonts.google.com link. For your own font file, put it in the `fonts/` folder of the repository, then type its file name.
- Everything is stored in `data/styles.json`. Each version holds every setting, so switching never leaves anything from the previous one behind (a setting a version leaves out goes back to the built-in value). Saving writes to the repository with the GitHub token from the upload page; without a token, it is kept in this browser only.
- When you are done, set `stylePanel: false`: the panel disappears and everyone gets the default version.

| What | Where |
|---|---|
| Image file names and sizes (kept by the upload page, so the card leaves the right space before an image loads) | `data/images.json` |
| Filters ticked at the start (`onlyImages`, `onlyStories`) | `js/config.js` → `view` |
| Built-in map colours, point size, shading, start view, cluster settings, column names | `js/config.js` |
| Fonts and colours | the style panel (above) / `data/styles.json` |
| Panel layout, clusters, legend | `css/style.css` (variables at the top are the built-in values) |
| Control panel contents | `index.html` |

## Printing the cards

**https://i-blazevicius.github.io/atlas-of-warmth/print.html** lays every hearth card out for printing: picture, names, a small locator map of the type's area, form, period, stories and ID. The cards are packed into columns of nearly equal length on the smallest paper (A4 to A0) that holds them all, or on several A0 sheets if needed. Use the bar at the top to pick the style version, order, paper, card width and filters, then **Print / save as PDF**: text, borders and maps come out as vectors. The starting settings are in `js/config.js` → `print`.

The map and the print page share the code that reads the sheet and draws a card (`js/core.js`), so the printed cards always match the map.

## Experiment (off by default)

**Equal Earth on the flat map** (the globe stays as it is): `flatProjection: 'equalEarth'` in `js/config.js`,
or for one visit `…/atlas-of-warmth/?flat=equalearth`. It uses its own climate images
(`data/climate/*-ee.webp`), made by `tools/build_climate.py` alongside the normal ones. The branch
`before-experiments` keeps the site as it was before the experiments were added.

## Files

- `index.html` – the map; `print.html` – the print page; `upload.html` – the image page
- `js/head.js` – shared start of every page: fonts, the last-used style, stylesheets, the error box
- `js/app.js` – map behaviour; `js/print.js` – print layout; `js/upload.js` – image page
- `js/core.js` – shared by all three: reading the sheet, placing dots, working out areas, drawing a card
- `js/styles.js` – style versions and the style panel
- `js/config.js` – settings
- `css/style.css` – styling (`css/print.css`, `css/upload.css` for the other pages)
- `data/countries.geojson` – country borders (Natural Earth 1:50m, public domain), with `iso` codes
- `data/labels.json` – a point inside every country and region, for placing name dots
- `data/borders.json` – land-border lengths and directions between neighbours, split by the neighbour's regions
  (for inferred gaps); rebuild with `python3 tools/build_borders.py` after changing the country or region shapes
- `data/styles.json` – style versions and fonts (written by the style panel)
- `data/images.json` – image file names and sizes; `data/credits.json` – image credits (both written by the upload page)
- `data/climate/` – climate underlay images and legend; `data/ocean.geojson` – sea drawn over them for crisp coasts
- `data/regions/` – region shapes per country (Natural Earth admin-1, 1:10m, simplified), loaded only when needed;
  rebuild with `tools/build_regions.py`. Kenya is the exception: its 47 counties (`KE-01` to `KE-47`) come from
  geoBoundaries (CC BY 4.0, geoboundaries.org; Natural Earth still has the old provinces); after rerunning
  `build_regions.py`, rerun `tools/build_kenya_counties.py` and then `tools/build_borders.py`
- `images/` – one picture per type, named by its ID; `fonts/` – your own font files
- `favicon.svg`, `favicon-32.png` – the tab icon
- `tools/` – scripts that build the climate images, region shapes and border file (not part of the site)
- `lib/` – MapLibre GL JS 6.18 (BSD licence) and Papa Parse 5.5 (MIT), kept here so the page has no outside dependencies apart from the sheet and Google Fonts
