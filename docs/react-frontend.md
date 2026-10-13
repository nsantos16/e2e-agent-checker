# React frontend

The local app uses React 19, TypeScript and Vite. The Effect backend continues to own verification, storage, subscription runtimes and MCP. The UI calls the existing same-origin HTTP APIs.

## Run and develop

```sh
npm install
npm run app       # builds missing/stale UI assets and serves everything on localhost:4100
npm run dev:ui    # optional second terminal: Vite with React Fast Refresh
npm run build    # standalone frontend build into dist/client
npm run check    # backend and browser TypeScript projects
npm test
```

Vite prints its development URL, normally `http://127.0.0.1:5173`. Its API and artifact proxy uses the configured backend port, including `E2E_APP_PORT`. Both the app and MCP-triggered app startup build the frontend when needed. Build tools are required for an initial build; a prebuilt `dist/client` can be served without rebuilding when no newer source files are present.

## Structure

- `src/app/client/main.tsx` mounts React. `App.tsx` composes the sidebar, workspace, run cards, composer and dialogs.
- `context.tsx` owns the workspace lifecycle and exposes a state/actions interface using React 19 context. Components do not manage subscriptions or know the storage implementation.
- `workspace.ts` owns immutable state snapshots, deduplicated API reads, parallel startup, submission and navigation. Cleanup aborts requests and removes timers. Late detail responses cannot replace a newer selection.
- `components/` contains separate workspace, run evidence, settings, environment form, model picker and network inspector components. Shared dialogs compose their content through children. Environment forms reset by editor identity, keeping pending edits stable during background refreshes.
- `useObservation.ts` polls only the selected run, aborts obsolete requests when selection or server filters change, and prevents overlapping polls. Network search, selection and frozen feed state stay local to the inspector.
- `styles.css` preserves the existing design and responsive layouts.
- `src/app/frontend.ts` builds stale assets at startup and serves only the generated JavaScript/CSS asset names. Hashed assets are immutable; the HTML entry is read fresh.

Run cards are keyed by job ID. Polling updates props instead of replacing markup, so video and browser preview elements retain their identity. Responses, case descriptions and evidence render as React text, including JSON highlighting; there is no HTML injection path or manual DOM reconciliation.

Existing preferences, case and environment formats, URLs and MCP tool schemas remain compatible. Backend types are imported with `import type`; provider runtimes and credential resolution do not enter the browser bundle.

The implementation follows `vercel-composition-patterns` and `vercel-react-best-practices`: state ownership in a provider, explicit feature components, children-based composition, parallel independent reads, shared polling, stable keys, scoped cleanup and derived values calculated during rendering.

## Verification

The browser scripts in `tests/` load the built React app in isolated frames with fixture APIs and preferences. They operate real controls and manually trigger polling; they do not depend on UI globals or internal render functions. The workspace suite covers desktop/mobile layouts, environment CRUD, model selection, network inspection, keyboard behavior and safe text rendering. The playback suite checks DOM identity across polling, evidence updates and new runs.

`workspace.test.ts` covers submission, catalog changes, late responses and cancellation on unmount. API integration tests verify bundled asset delivery, MIME types and missing/path-traversal responses. Browser fixtures make no model calls and do not modify the local catalog.
