# Dalle's FUF — night logger (web)

A web version of the iOS night logger, installable on an iPhone home screen and usable offline.

- **Night:** AWAKE / BACK TO BED buttons that alternate, with a 0–10 pain list after AWAKE and a "What fixed it?" remedy list after BACK TO BED.
- **Summary:** wakes, total time awake, longest episode, pain min/avg/max, and a Copy button.
- **History:** nights with their metrics; tap a night to edit, add or delete events; CSV export of raw events or nightly summaries (same columns as the iOS app).
- **Settings:** the hour a night starts, accent colour, sync status, sign out.

## How the data works

- Sign-in: Firebase Authentication (email and password). New sign-ups are disabled; accounts are added in the Firebase console.
- Storage: Cloud Firestore, at `users/{uid}/events/{id}` and settings at `users/{uid}`.
- Offline: Firestore keeps a copy on the device. Every tap is saved locally first and syncs whenever there is a connection; edits made offline on several devices merge when they reconnect (the latest edit to the same field wins).
- Security: `firestore.rules` allows each signed-in person to read and write only their own documents. The values in `config.js` identify the Firebase project and are safe to publish.

## Files

| File | Purpose |
|---|---|
| `index.html`, `app.css`, `app.js` | Screens and behaviour |
| `model.js` | Night grouping, metrics and CSV, ported from the Swift code |
| `store.js` | Firebase (and a `?demo` browser-only mode for trying it out) |
| `firebase.js` | Firebase SDK v11.10.0 bundled locally so it works offline |
| `config.js` | Firebase project settings |
| `firestore.rules` | Security rules to paste into the Firebase console |
| `sw.js`, `manifest.json`, `icon-*.png` | Home-screen install and offline caching |

When changing files, bump `VERSION` in `sw.js`.
