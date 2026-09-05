// The JSON behind "Use an example" on /custom.
//
// It lives here as well as in public/custom.js because a static asset cannot
// import from src/ — Cloudflare serves it directly, and there is no build step
// to share a constant through. The duplication is checked rather than trusted:
// `npm run check:docs` fails if the two ever say different things.
//
// The server needs it in order to recognise its own example when it comes back
// in as a paste. Someone clicking the button and then Create has not told us
// anything about what they wanted to mock, so the admin table leaves those out.
export const CUSTOM_EXAMPLE = `{
  "todos": [
    { "id": 1, "title": "Test the loading state", "done": false, "userId": 1 },
    { "id": 2, "title": "Test the error state",   "done": true,  "userId": 1 },
    { "id": 3, "title": "Test the retry logic",   "done": false, "userId": 2 }
  ],
  "users": [
    { "id": 1, "name": "Asha Menon",  "team": "Platform" },
    { "id": 2, "name": "Wei Chen",    "team": "Product" }
  ]
}`;
