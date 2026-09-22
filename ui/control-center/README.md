# AEH Control Center

This directory is a separately buildable Vite + TypeScript React application for
the Core Architecture v2 Home and Project Control Center views. It consumes the
versioned authenticated `/api/v1` projections exposed by the AEH Control Center
server and keeps the control token in memory only.

## Development

From this directory, install dependencies in the consuming environment and run:

```sh
npm install
npm run dev
```

Vite proxies `/api` and `/health` to `127.0.0.1:8787` during local development.
Set the proxy target to the port used by the local Control Center when needed.

## Production build

```sh
npm run build
npm run preview
```

The AEH Control Center server serves `dist` when it is packaged with AEH or
provided through `AEH_CONTROL_CENTER_UI_DIR`. If the bundle is absent, the
server returns an explicit build-unavailable response; it does not fall back to
an inline document.

The app uses React Query for the overview, Paseo gateway projection, and bounded
mutations. Normal Lead conversation uses `POST /api/v1/paseo/lead/messages`
with CSRF protection; `/api/v1/decisions` remains available for explicit
decision workflows but is not used for ordinary messages. The UI does not
expose Paseo credentials or a generic Paseo RPC surface.

TanStack Router owns the Home/Project mode search parameter (`?mode=home` or
`?mode=project`) so navigation is shareable without introducing a global store.
The backend serves one local static document and the authenticated versioned API;
Vite's history fallback handles the local route during development.

Dependencies are declared here but intentionally not installed by the parent
repository change. The backend, root package metadata, lockfiles, and source
outside `ui/control-center/**` are not part of this frontend slice.
