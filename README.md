# Surplus Tracker

A standalone, phone-friendly web app for the furniture surplus workflow: log an item,
get its code and SharePoint captions instantly, pull in photos from Google Drive or
your camera, let AI guess the category and read handwritten dimensions, download
renamed photos, and track reservations with an aging clock.

It does **not** touch your SharePoint page directly (that needs IT-managed Microsoft
Graph API access you don't have). You still copy the caption and drag the renamed
photos into SharePoint yourself — everything up to that point is now one tool instead
of a scattered process.

Two things make this possible without a traditional backend server:
- **Data** lives in a Google Sheet you own, synced straight from your phone's browser
  using your own Google sign-in.
- **AI photo analysis** (category guessing, reading handwritten dimensions) goes
  through a small Google Cloud Function that holds your Gemini API key so it's never
  exposed in the app's code.

Setup now lives in one file (`config.js`) that ships with the deployed site, so once
you've filled it in, every device just opens the URL and signs in — no per-device
settings screen.

---

## Why not OneDrive / SharePoint / DeepSeek directly

- Your OneDrive and SharePoint are on CSULB's Microsoft tenant, which requires IT to
  register an Azure app and grant admin consent — not something available to you
  right now. So photo pickup uses **Google Drive** instead (your own personal
  account), which needs no organizational approval at all.
- DeepSeek's API doesn't currently accept image input (only their consumer chat app
  does) — Google's Gemini API does, cheaply, and reuses the same Google Cloud project
  you already set up for Sheets.

---

## 1. Create the Google Sheet

1. Go to [sheets.google.com](https://sheets.google.com) and create a new sheet.
2. Rename the first tab to exactly `Inventory`.
3. In row 1, paste these exact headers, one per column (A through L):

   ```
   ItemCode	Category	Description	Dimensions	DateAdded	Status	ReservedBy	ReservedContact	ReservedDate	Notes	Qty	Condition
   ```

4. Copy the Sheet ID out of the URL — the long string between `/d/` and `/edit`.
5. Share the sheet (File → Share) with anyone else who'll use the app, as Editor.

---

## 2. Create a Google Drive intake folder

1. In [drive.google.com](https://drive.google.com), create a folder — e.g. "Surplus Intake".
2. Point your phone's camera backup at this folder specifically (not your whole
   camera roll), so the app only ever shows relevant photos:
   - **Android**: open the Google Drive app → Settings → Backup → choose this folder
     for photo backup, or just manually move new shots into it from the Photos/Drive
     app when you're done shooting — either way, they'll be there by the time you're
     at your desk.
   - **iPhone**: the Google Drive app has an "Auto Backup" option in Settings that
     can target a specific folder the same way, or use Shortcuts to move new camera
     photos into that Drive folder automatically.
3. Copy the folder's ID out of its URL (the string after `/folders/`).

---

## 3. Create a Google OAuth Client ID

Same personal Google Cloud project you'd use for Sheets — this step just adds Drive
access to it.

1. [console.cloud.google.com](https://console.cloud.google.com) → your existing
   project (or create one).
2. **APIs & Services → Library** → enable **Google Sheets API** and **Google Drive API**.
3. **APIs & Services → OAuth consent screen** → under Scopes, add:
   - `.../auth/spreadsheets`
   - `.../auth/drive.readonly`
   Under Test users, add every Google account that'll use the app.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   - Type: Web application
   - Authorized JavaScript origins: your deployed URL, e.g.
     `https://yourusername.github.io`, plus `http://localhost:8080` for local testing.
5. Copy the **Client ID**.

---

## 4. Get a Gemini API key

1. [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → Create API key
   → pick the same Cloud project as above. The free tier comfortably covers this
   volume of use.
2. Keep this key handy for the next step — it goes in the Cloud Function, never in
   the app itself.

---

## 5. Deploy the vision proxy (Cloud Function)

This is the one piece that isn't purely static — a small function that holds your
Gemini key server-side. From the `cloud-function` folder:

```bash
gcloud functions deploy analyzeImage \
  --gen2 --runtime=nodejs20 --region=us-central1 \
  --trigger-http --allow-unauthenticated \
  --entry-point=analyzeImage \
  --set-env-vars=GEMINI_API_KEY=your-gemini-key,ALLOWED_ORIGIN=https://yourusername.github.io
```

No `gcloud` installed? You can paste `index.js` directly into the Cloud Console:
Cloud Functions → Create Function → same settings as above → Source: Inline editor.

After deploying, copy the function's URL (ends in `.cloudfunctions.net/analyzeImage`).

**Worth knowing:** this endpoint is reachable by anyone who finds the URL (a static
site can't hide it) — the `ALLOWED_ORIGIN` check stops other websites' browser code
from calling it, but not someone hitting it directly with curl. Given Gemini's free
tier and low request volume here, the realistic worst case is small, but you can set
a budget alert on the Cloud project for peace of mind.

---

## 6. Fill in config.js

Edit `config.js` with the four values you've collected, then commit/redeploy:

```js
window.APP_CONFIG = {
  clientId: '...',        // step 3
  sheetId: '...',         // step 1
  driveFolderId: '...',   // step 2
  visionProxyUrl: '...'   // step 5
};
```

---

## 7. Deploy the app itself (pick one — all free)

**GitHub Pages** (what you're already using):
1. Push this folder's contents (except `cloud-function/`) to a repo.
2. Settings → Pages → source: main branch, root.
3. Live at `https://yourusername.github.io/reponame/`.

**Netlify**: drag the folder onto [app.netlify.com/drop](https://app.netlify.com/drop).

**Cloudflare Pages**: Workers & Pages → Create → Pages → Upload assets.

Whichever you pick, make sure that exact URL is in both the OAuth origins (step 3)
and `ALLOWED_ORIGIN` (step 5).

---

## First run

1. Open the deployed URL. No Settings step needed — config.js already has everything.
2. Tap **Sign in**, approve access.
3. Tap **Sync with sheet** once to pull in anything already there.

Add it to your phone's home screen (Share → Add to Home Screen) so it opens like an app.

---

## Day-to-day workflow

**In the field:** measure and photograph as usual. If your phone's set up per step 2,
those photos are already in Drive by the time you sit down.

**At your desk:**
1. Open the app → **Intake** tab, pick the category (or skip and let AI guess it).
2. Tap **Load from Drive** to pull in the shots from the field, or use the camera
   input directly.
3. Optionally tap **✨ Guess category & description** — AI looks at the first photo
   and fills in category + a draft description (always double-check it).
4. If you photographed handwritten dimensions, tap **✨ Read dimensions from photo** —
   it reads the last attached photo and fills in the Dimensions field.
5. Fill in/adjust anything, tap **Save item & generate listing**.
6. Copy the caption, download the renamed photos, upload both to SharePoint as usual.

**Reservations, aging clock, email text:** unchanged from before — see the Inventory
and Reserved tabs.

---

## Notes & limits

- Only signed-in, test-user-approved Google accounts (with Editor access to the sheet)
  can read/write your data — the deployed site has no embedded secrets except the
  vision proxy's exposure noted in step 5.
- Multiple people can use this by each doing steps 3–4's sign-in on their own device
  and being added as a Sheet editor + OAuth test user — see the section on adding
  another account from earlier setup.
- SharePoint upload stays manual by design — see "Why not OneDrive / SharePoint /
  DeepSeek directly" above.
- AI suggestions are a starting point, not a source of truth — it's still your call
  on category, description, and dimensions before saving.
- Caption/email wording is easy to tweak in `app.js` (`buildStackedCaption` /
  `buildLineCaption` / `buildEmailText`) any time.
