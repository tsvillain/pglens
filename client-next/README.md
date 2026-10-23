# client-next

The pglens web UI: React 18 + TypeScript, built with Vite and served by the
pglens server at `/`.

```bash
npm install
npm run dev        # Vite on :5173, proxies /api to a running pglens on :54321
npm run build      # outputs dist/, which the server serves
npm test           # Vitest unit tests
npm run typecheck
```

Source lives in `src/`: `pages/` (routed screens), `components/`, `lib/`
(API client and pure helpers), and `store/` (Zustand state).
