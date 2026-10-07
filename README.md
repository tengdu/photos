# Photos

Original photos from my iPhone, published as a gallery at **https://tengdu.github.io/photos/**.

- `photos/` holds the **untouched originals**: HEIC/JPEG, plus a `.mov` with the same name for Live Photos.
- **Videos** are uploaded, untouched, to the [**media** release](https://github.com/tengdu/photos/releases/tag/media), because GitHub's API only puts files up to about 25–50 MB into the repo, while a release takes files up to 2 GB. For each video, `photos/` gets a tiny placeholder named after it, `<video file name>.release`, which is what triggers the build and what you delete. (A small `.mov`/`.mp4` put straight into `photos/` also works.)
- On every push, `.github/workflows/pages.yml` runs `scripts/build.mjs`. For each photo or video it generates **one** image, a 720px WebP preview, which is used in the grids and cards (for videos, ffmpeg decodes the first frame, tone-mapping HDR). It also reads the capture time, camera details and GPS, and looks up a place name offline. Then it bundles the site and deploys it to GitHub Pages.
- The **viewer always shows the original file**, loaded from `raw.githubusercontent.com`. JPEGs, and HEIC in Safari, are displayed directly. Chrome and Edge decode the original HEIC with the hardware HEVC decoder (WebCodecs, ~0.1–0.5 s). Other browsers fall back to libheif (WASM). Live Photos play the original `.mov`: they play once when opened, and again when you press and hold the photo, hover over **LIVE**, or press Space.
- **Videos** play the original file from the release, with the browser's own controls. They start when they come into view, with sound if the browser allows it before a tap (otherwise muted: tap the speaker button). iPhone videos (HEVC, also HDR) play in Safari, and in Chrome/Edge on Macs and on PCs with hardware HEVC; other browsers offer the download.
- Views: **Years**, **Months**, **Days**, **All Photos** (pinch, Ctrl+scroll or −/+ to change the grid size) and a **Map** of photos by place. Press **I** in the viewer for photo info. Identical files are shown once.
- On iPhone, Safari → Share → **Add to Home Screen** turns the site into an app. A service worker keeps previews, app files and recently viewed originals, so repeat visits open instantly and work offline.

> The repo is public: anyone can download the originals, including the GPS location stored in them.

### Delete photos and videos

Open the site once with **`?owner`** (https://tengdu.github.io/photos/?owner) on your iPhone, iPad or Mac; `?owner=off` turns it off again. Then, in All Photos or Days, tap **Select**, tap the photos and videos (or **Select All**), **Delete** → **Delete with Shortcut**. The site starts the **Delete from GitHub** shortcut below with the list of files (Live Photo videos and video placeholders included); it deletes them, and Shortcuts returns to the site, where they disappear at once. The site rebuilds once, about a minute after the last deletion; that build also deletes the videos whose placeholder is gone from the release. Deleted photos stay in the repository's Git history; deleted videos are gone for good.

### Delete from GitHub shortcut

Shortcuts app → **+** → name it exactly **Delete from GitHub**. The site gives it a list of file paths, one per line, as its input.

| # | Action | Settings |
|---|---|---|
| 1 | **Text** | paste your GitHub token (the same one as the upload shortcut) → **Set Variable** `Token` |
| 2 | **Split Text** | *Shortcut Input*, Separator: **New Lines** |
| 3 | **Repeat with Each** | item in *Split Text* |
| 4 | ↳ **Get Contents of URL** | URL `https://api.github.com/repos/tengdu/photos/contents/`**Repeat Item**, Method **GET**, Headers `Authorization` = `Bearer `**Token**, `Accept` = `application/vnd.github+json` |
| 5 | ↳ **Get Dictionary Value** | Get **Value** for key `sha` in *Contents of URL* |
| 6 | ↳ **Get Contents of URL** | the same URL, Method **DELETE**, the same Headers, Request Body **JSON**: `message` (Text) = `Delete `**Repeat Item**, `sha` (Text) = **Dictionary Value** |
| 7 | **End Repeat** | |

The first time it runs, iOS asks whether the shortcut may connect to api.github.com: choose **Always Allow**. If the shortcut runs but finds no files, open its **ⓘ** details, turn on **Show in Share Sheet** and set it to receive **Text**, so it accepts the list from the site.

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

### Videos (steps 10–12)

Videos go to the **media** release as they are: raw, without Base64, so they can be large. Inside the loop, the shortcut does that for videos and the usual upload for everything else:

```
Repeat with Each item in Shortcut Input
    Ext, Name                       ← steps 5 and 6, as before
    If  Ext  is  mov                ← step 10 (new)
        Get Contents of URL         ← step 11: the video, to the release
        Get Contents of URL         ← step 12: its placeholder, to photos/
    Otherwise
        Base64 Encode               ← step 7, moved here
        Get Contents of URL         ← step 8, moved here
        If … Live Photo … End If    ← the Live Photo part below, moved here
    End If
End Repeat
```

1. Add **If** right after step 6 (Set Variable `Name`). Input: **Ext**, condition **is**, value `mov`. For screen recordings and other `.mp4` videos too, tap **Add Condition**, choose **Any**, and add **Ext** **is** `mp4`.
2. Move steps 7, 8 and the Live Photo **If** block between **Otherwise** and **End If** (long-press an action and drag it; or tap **Select** to move several at once).
3. Between **If** and **Otherwise**, add two **Get Contents of URL** actions:

Step 11, the video:
- URL: `https://uploads.github.com/repos/tengdu/photos/releases/405441279/assets?name=`**Stamp**`-`**Name**`.`**Ext**
- Method: **POST**
- Headers: `Authorization` = `Bearer `**Token**, `Content-Type` = `application/octet-stream`
- Request Body: **File**, and pick **Repeat Item**

Step 12, its placeholder (this is what makes it appear on the site):
- URL: `https://api.github.com/repos/tengdu/photos/contents/photos/`**Stamp**`-`**Name**`.`**Ext**`.release`
- Method: **PUT**, Headers: the same as step 8
- Request Body: **JSON**, with `message` (Text) = `Add `**Name** and `content` (Text) = `dmlkZW8=` (any short Base64 text works; the build only needs the file name)

A big video takes a while to upload: keep the phone awake. If a large one fails from the Share menu, run the shortcut from the Shortcuts app instead (it opens the photo picker), which has more memory.

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
| `422 … "already_exists"` (step 11) | The release already has a video with that name |
| A video doesn't appear | Both step 11 and step 12 must succeed, and the placeholder's name must be the video's file name plus `.release`. A release file without a placeholder is deleted by a build an hour later |

To see the URL the Shortcut actually builds, add a **Text** action containing the same URL, followed by **Quick Look**, just before **Get Contents of URL**. Also make sure the URL has no line breaks: GitHub accepts them silently and creates oddly named files.

## 3. Use it

Photos app → select photos and videos → **Share**. To keep the full original, tap **Options** at the top of the share sheet and turn **Location** and **All Photos Data** on. Then pick **Upload to GitHub**.
Each photo becomes one commit (a video: one file in the release plus its placeholder's commit). Each upload cancels the build started by the one before it, and a build only starts its work after 20 seconds without a new upload, so a whole batch is built once and the gallery updates about a minute after the last upload.

## Build locally

```sh
npm ci
node scripts/build.mjs          # HEIC previews use libheif's heif-dec, or sips on macOS; videos need ffmpeg
python3 -m http.server -d _site 8000
```

Set `RAW_BASE` to load originals from somewhere other than this repo, for example a local folder served at `http://localhost:8000/raw/`.

## Credits

Place names: [GeoNames](https://www.geonames.org/) cities15000 (CC BY 4.0), in `scripts/geo/`. Viewer: [PhotoSwipe](https://photoswipe.com/) (MIT). HEIC fallback decoder: [libheif-js](https://github.com/catdad-experiments/libheif-js) (LGPL-3.0). Placeholders: [ThumbHash](https://evanw.github.io/thumbhash/) (MIT). EXIF: [exifr](https://github.com/MikeKovarik/exifr) (MIT). Video previews: [FFmpeg](https://ffmpeg.org/), at build time.
