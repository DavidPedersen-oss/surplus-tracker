# Surplus Tracker

A standalone, phone-friendly web app for the furniture surplus workflow: log an item,
get its code and SharePoint captions instantly, download renamed photos, and track
reservations with an aging clock — all outside of Claude, hosted on a free static site.

It does **not** touch your SharePoint page directly (that requires IT-managed API
access you don't have). You still copy the caption and drag the renamed photos into
SharePoint yourself — but everything up to that point is now one tool instead of
a scattered process.

Data lives in a Google Sheet you own. The app talks to it directly from your phone's
browser using your own Google sign-in — no backend server, no exposed passwords or keys.

---

## 1. Create the Google Sheet

1. Go to [sheets.google.com](https://sheets.google.com) and create a new sheet.
2. Rename the first tab to exactly `Inventory`.
3. In row 1, paste these exact headers, one per column (A through L):

   ```
   ItemCode	Category	Description	Dimensions	DateAdded	Status	ReservedBy	ReservedContact	ReservedDate	Notes	Qty	Condition
   ```

   (If you already have an existing sheet from before, just add `Qty` in K1 and
   `Condition` in L1 — existing rows are unaffected.)

4. Copy the Sheet ID out of the URL — it's the long string between `/d/` and `/edit`:
   `https://docs.google.com/spreadsheets/d/`**`THIS_PART_IS_THE_ID`**`/edit`

Keep this tab handy — you'll paste the ID into the app's Settings screen.

---

## 2. Create a Google OAuth Client ID (one-time, ~5 minutes)

This lets *you* sign in from the app to read/write *your own* sheet. It does not
involve CSULB's IT or Azure AD at all — it's tied to your personal Google account.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a new project (any name, e.g. "Surplus Tracker").
2. In the search bar, find **Google Sheets API** and click **Enable**. Then search for
   **Google Drive API** and click **Enable** on that too — this is what lets the app
   save your intake photos straight to a folder in your own Google Drive.
3. Go to **APIs & Services → OAuth consent screen**. Choose **External**, fill in an
   app name and your email, and save (you can leave it in "Testing" mode — add your
   own Google account under **Test users**).
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
   - Application type: **Web application**
   - Under **Authorized JavaScript origins**, add the URL(s) you'll host this on, e.g.:
     - `http://localhost:8080` (for local testing)
     - `https://yourname.github.io` (if using GitHub Pages)
     - `https://your-site-name.netlify.app` (if using Netlify)
5. Click Create, then copy the **Client ID** (ends in `.apps.googleusercontent.com`).

---

## 3. Deploy the app (pick one — all free)

**Netlify (easiest):**
1. Go to [app.netlify.com/drop](https://app.netlify.com/drop)
2. Drag this whole `surplus-tracker` folder onto the page.
3. You'll get a live URL immediately (e.g. `random-name.netlify.app`). You can rename
   it in Site settings.
4. Go back to step 2.4 above and add this URL to your OAuth client's authorized origins.

**GitHub Pages:**
1. Create a new GitHub repo, upload the contents of this folder.
2. Go to Settings → Pages → set source to the main branch, root folder.
3. Your app will be live at `https://yourusername.github.io/reponame/`.
4. Add that URL to your OAuth client's authorized origins.

**Cloudflare Pages:**
1. Go to the Cloudflare dashboard → Workers & Pages → Create → Pages → Upload assets.
2. Upload this folder's contents.
3. Add the resulting `*.pages.dev` URL to your OAuth client's authorized origins.

---

## 4. First run

1. Open your deployed URL on your phone.
2. Tap **Settings**, paste in your Client ID and Sheet ID, tap **Save settings**.
3. Tap **Sign in** in the top bar and approve access to Google Sheets **and** Google Drive
   (you'll see both listed on the consent screen — that's expected).
4. Tap **Sync with sheet** on the Inventory tab once to pull in anything already there.

You're set. Bookmark it or add it to your phone's home screen (Share → Add to Home Screen)
so it opens like an app.

---

## How the day-to-day workflow works

**In the field:** measure and photograph as usual.

**At your desk (or right in the field on your phone):**
1. Open the app → **Intake** tab.
2. Pick the category — it shows you the next code automatically.
3. Fill in description, dimensions, qty, condition, notes, and attach the photos —
   on a phone, tapping the Photos field opens your camera or photo library directly.
4. Tap **Save item & generate listing**. This saves the item to your sheet, hands you
   a ready-to-copy caption, and — if you're signed in — automatically uploads the
   photos to a **"Surplus Tracker Photos"** folder in your Google Drive, renamed to
   `CODE_1.jpg`, `CODE_2.jpg`, etc. If you're not signed in (or want a local copy too),
   use **Download renamed photos** to get the same files as a zip instead.
5. Paste the caption and grab the photos from Drive (or the zip) to upload into
   SharePoint exactly like before.

**When someone reserves an item:**
1. Go to **Inventory**, find the item, tap **Reserve**.
2. Enter their name and contact info. This timestamps the reservation and flips the
   item's status.
3. A confirmation email is generated for you to copy into a new message — subject
   line included. Paste, review, send from your own email client.

**Watching the clock:** the **Reserved** tab lists every open reservation with a badge
showing days since reservation — green under 2 weeks, amber 2–4 weeks, red past a month —
so stale reservations are obvious at a glance.

**If you're offline or not signed in:** changes still save on your phone and sync
automatically next time you're signed in and connected — nothing is lost, but sync
promptly so the sheet (your source of truth across devices) stays current.

---

## Notes & limits

- Only you (via your Google sign-in) can write to the sheet — the deployed site itself
  has no embedded secrets, so it's safe to host somewhere technically public.
- If you ever want a second device (e.g. a desk computer) to see the same data, just
  open the same deployed URL there and sign in with the same Google account.
- SharePoint upload and status changes on the public listing page stay manual by
  design — automating that would require CSULB IT to register an Azure app, which
  isn't on the table right now. Nothing here assumes that access.
- Captions are a starting template — tweak the wording in `app.js`
  (`buildCaption` / `buildEmailText`) any time to match your exact preferred phrasing.
- Photos upload to Drive using the `drive.file` scope, which only lets the app see
  files *it* creates — not your whole Drive. The folder is a normal folder in your
  "My Drive," so you can open, rename, or move it like any other.
