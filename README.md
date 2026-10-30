# Patamu Aquifer Studio

An interactive 3D watershed and aquifer exploration experience for rural regions across India.

## Deployment

The live application is hosted on Railway:

- https://patamu-web-production.up.railway.app

## Source layout

- `railway/function.ts` — deployed Bun Railway Function that serves the frontend and its assets.
- `assets/manifest.json` — SHA-256 asset manifest embedded in the deployed function.
- `assets/` — intended location for the static frontend and region data assets.

## Asset storage

The deployed function currently serves static assets from Railway Object Storage. The source and manifest are included here, but the underlying binary/static asset objects have not yet been mirrored into this repository. To make this repository independently deployable, copy the objects from the configured Railway bucket into the corresponding paths under `assets/`, then follow the deployment setup for the Railway Function.

No Railway credentials or deployment tokens are stored in this repository.
