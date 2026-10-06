# Photos

Original photos from my iPhone, published as a gallery at **https://tengdu.github.io/photos/**.

- `photos/` holds the **untouched originals**: HEIC/JPEG, plus a `.mov` with the same name for Live Photos.
- On every push, `.github/workflows/pages.yml` runs `scripts/build.mjs`. For each photo it generates **one** image, a 720px WebP preview, which is used in the grids and cards. It also reads the capture time, camera details and GPS, and looks up a place name offline. Then it bundles the site and deploys it to GitHub Pages.
- The **viewer always shows the original file**, loaded from `raw.githubusercontent.com`. JPEGs, and HEIC in Safari, are displayed directly. Chrome and Edge decode the original HEIC with the hardware HEVC decoder (WebCodecs, ~0.1–0.5 s). Other browsers fall back to libheif (WASM). Live Photos play the original `.mov`: they play once when opened, and again when you press and hold the photo, hover over **LIVE**, or press Space.
- Views: **Years**, **Months**, **Days** and **All Photos**. Identical files are shown once.

> The repo is public: anyone can download the originals, including the GPS location stored in them.

### Hide places near home (optional)

Add a repository secret **`PRIVACY_ZONES`** in Settings → Secrets and variables → Actions. Its value is one or more `latitude,longitude,radius_in_metres` entries separated by `;`, for example `47.61,-122.33,1000`. Photos taken inside these areas keep their city name, but their coordinates are left out of the website (the original files still contain GPS). The value stays private; the build log only prints how many zones are set.

## 1. Create a GitHub token (once)

GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → *Generate new token*

- Repository access: **Only select repositories** → `tengdu/photos`
- Permissions → Repository → **Contents: Read and write**
- Set an expiration date (renew it in the Shortcut when it expires)

## 2. Build the iPhone Shortcut (once)

Shortcuts app → **+** → name it **Upload to GitHub**. Tap **ⓘ** (Details) → turn on **Show in Share Sheet**. Set *Receive* to **Images** and **Media**. Set *If there's no input* to **Ask For → Photos**.

Add these actions in order (blue words are the variables you tap to insert):

| # | Action | Settings |
|---|---|---|
| 1 | **Text** | paste your token → then **Set Variable** `Token` |
| 2 | **Format Date** *(optional)* | Date: *Current Date*, Format: *Custom* `yyyy/MM` → **Set Variable** `Dir`. Sorts the repo into month folders; skip it to keep things simple |
| 3 | **Format Date** | Date: *Current Date*, Format: *Custom* `yyyyMMdd-HHmmss` → **Set Variable** `Stamp` |
| 4 | **Repeat with Each** | item in *Shortcut Input* |
| 5 | ↳ **Get Details of Files** | *File Extension* of *Repeat Item* → **Change Case** to *lowercase* → **Set Variable** `Ext` |
| 6 | ↳ **Get Name** | of *Repeat Item* → **Set Variable** `Name` |
| 7 | ↳ **Base64 Encode** | *Repeat Item*, tap the arrow → Line Breaks: **None** |
| 8 | ↳ **Get Contents of URL** | see below |
| 9 | **Show Notification** | `Uploaded — https://tengdu.github.io/photos/` (after *End Repeat*) |

Step 8, **Get Contents of URL**:

- URL: `https://api.github.com/repos/tengdu/photos/contents/photos/`**Stamp**`-`**Name**`.`**Ext**
  (or with month folders: `…/contents/photos/`**Dir**`/`**Stamp**`-`**Name**`.`**Ext**)
- Method: **PUT**
- Headers: `Authorization` = `Bearer `**Token**, `Accept` = `application/vnd.github+json`
- Request Body: **JSON**, with `message` (Text) = `Add `**Name** and `content` (Text) = **Base64 Encoded**

### Live Photo motion (step 7b, test once)

After step 8, still inside the loop, add **Encode Media** on *Repeat Item*. Then repeat steps 7 and 8 on its output, using `.mov` as the extension in the URL. The still and the `.mov` must have the same name (`<Stamp>-<Name>`) so the gallery pairs them.
If **Encode Media** shows an error for normal (non-Live) photos, move these actions into a separate shortcut, **Upload Live Photos**, that you only use for Live Photos.

### Troubleshooting

| Response | Meaning |
|---|---|
| `404 Not Found` | Method is still **GET**, or the URL is wrong (e.g. missing `repos/`, wrong repo name), or the token has no access to `tengdu/photos` |
| `422 path contains a malformed path component` | A variable in the URL is empty, so the path has `//`. Usually `Dir`: check that its Format Date really uses the custom format, or remove `Dir` from the URL |
| `422 … "sha" wasn't supplied` | A file with that exact name already exists |
| `401 Bad credentials` | Token is wrong or expired |

To see the URL the Shortcut actually builds, add a **Text** action containing the same URL, followed by **Quick Look**, just before **Get Contents of URL**. Also make sure the URL has no line breaks: GitHub accepts them silently and creates oddly named files.

## 3. Use it

Photos app → select photos → **Share**. To keep the full original, tap **Options** at the top of the share sheet and turn **Location** and **All Photos Data** on. Then pick **Upload to GitHub**.
Each photo becomes one commit. The gallery updates about 1–2 minutes after the last upload.

## Build locally

```sh
npm ci
node scripts/build.mjs          # HEIC previews use libheif's heif-dec, or sips on macOS
python3 -m http.server -d _site 8000
```

Set `RAW_BASE` to load originals from somewhere other than this repo, for example a local folder served at `http://localhost:8000/raw/`.

## Credits

Place names: [GeoNames](https://www.geonames.org/) cities15000 (CC BY 4.0), in `scripts/geo/`. Viewer: [PhotoSwipe](https://photoswipe.com/) (MIT). HEIC fallback decoder: [libheif-js](https://github.com/catdad-experiments/libheif-js) (LGPL-3.0). Placeholders: [ThumbHash](https://evanw.github.io/thumbhash/) (MIT). EXIF: [exifr](https://github.com/MikeKovarik/exifr) (MIT).
