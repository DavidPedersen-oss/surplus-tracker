/* ---------------------------------------------------------------
   App-wide config. These values are safe to commit/publish:
   - clientId is a public OAuth identifier by design (Google's own
     docs put these in client-side apps)
   - sheetId / driveFolderId are only useful to someone who already
     has Editor access to your Sheet/Drive, which you control via
     normal Google sharing — not via this file
   - visionProxyUrl points at your Cloud Function; the real secret
     (your Gemini API key) lives server-side, never here

   Fill these in once, commit, redeploy — every device then works
   with zero setup screen.
--------------------------------------------------------------- */
window.APP_CONFIG = {
  clientId: '265547647267-k08fv21h3sdsfe7kuoseoafabsd48h9p.apps.googleusercontent.com',
  sheetId: '1QVY9-GvqFR3RR4JN49vyXbEMMh4IgXUm8pRjfl7o_Jo',
  driveFolderId: '', // leave blank — the app creates/manages its own "Surplus Tracker Photos" folder in your Drive
  visionProxyUrl: ''
};
