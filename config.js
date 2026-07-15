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
  clientId: 'YOUR_CLIENT_ID.apps.googleusercontent.com',
  sheetId: 'YOUR_SHEET_ID',
  driveFolderId: 'YOUR_DRIVE_FOLDER_ID',
  visionProxyUrl: 'https://REGION-PROJECT.cloudfunctions.net/analyzeImage'
};
