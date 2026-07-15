/**
 * Google Cloud Function (2nd gen, HTTP trigger).
 * Keeps the Gemini API key server-side; the static app only ever calls
 * this URL, never the Gemini API directly.
 *
 * Deploy (from this folder):
 *   gcloud functions deploy analyzeImage \
 *     --gen2 --runtime=nodejs20 --region=us-central1 \
 *     --trigger-http --allow-unauthenticated \
 *     --entry-point=analyzeImage \
 *     --set-env-vars=GEMINI_API_KEY=your-key-here,ALLOWED_ORIGIN=https://yourname.github.io
 *
 * Env vars:
 *   GEMINI_API_KEY  - from https://aistudio.google.com/apikey (free tier is fine for this volume)
 *   ALLOWED_ORIGIN  - your deployed site's origin, e.g. https://yourname.github.io
 *                     (restricts which sites' browser JS can call this function)
 */

const MODEL = 'gemini-3.5-flash';

const PROMPTS = {
  category: `You are helping classify surplus furniture for a university surplus program.
Categories: B = Bookshelf or cabinet, T = Table or desk, C = Chair, M = Miscellaneous (anything else).
Look at the photo and respond with ONLY minified JSON, no markdown, no commentary:
{"category":"B|T|C|M","description":"a short 6-12 word plain description of the item"}`,

  dimensions: `This photo shows handwritten or printed measurements for a piece of furniture
(length/width/height, usually in inches). Read the numbers and units exactly as written.
Respond with ONLY minified JSON, no markdown, no commentary:
{"dimensions":"formatted like 36\\"L x 24\\"W x 30\\"H using the numbers you read, or an empty string if you can't read it confidently"}`
};

exports.analyzeImage = async (req, res) => {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.set('Access-Control-Allow-Origin', allowedOrigin);
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }

  const { image, mimeType, mode } = req.body || {};
  if (!image || !PROMPTS[mode]) {
    res.status(400).json({ error: 'Expected { image: base64, mimeType, mode: "category"|"dimensions" }' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server missing GEMINI_API_KEY' });
    return;
  }

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: PROMPTS[mode] },
              { inline_data: { mime_type: mimeType || 'image/jpeg', data: image } }
            ]
          }],
          generationConfig: { responseMimeType: 'application/json' }
        })
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini error', geminiRes.status, errText);
      res.status(502).json({ error: 'Gemini request failed' });
      return;
    }

    const data = await geminiRes.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = {}; }

    res.status(200).json(parsed);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Unexpected server error' });
  }
};
