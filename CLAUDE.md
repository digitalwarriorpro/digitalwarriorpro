# digitalwarriorpro

Node.js + TypeScript project with three entry points sharing one core library:

- `src/index.ts` — library exports (pure functions, no I/O)
- `src/server.ts` — Express web server, imports from `src/index.ts`
- `bin/cli.js` — CLI wrapper, imports the built library from `dist/index.js`

## Commands

- `npm run dev` — start the server with hot reload (tsx)
- `npm run build` — compile to `dist/` (required before `bin/cli.js` or `npm start` will work)
- `npm test` — run Vitest once; `npm run test:watch` for watch mode
- `npm run lint`, `npm run typecheck`, `npm run format:check` — same checks CI runs

## Conventions

- Strict TypeScript (`strict: true` in `tsconfig.json`); avoid `any`.
- ESM only (`"type": "module"`) — use `.js` extensions in relative imports (NodeNext resolution).
- New library logic goes in `src/`, exported from `src/index.ts` if it should be reusable by
  both the server and the CLI.
- Tests live in `tests/`, mirroring `src/` filenames (`index.ts` → `index.test.ts`).
- CI (`.github/workflows/ci.yml`) must pass: lint, typecheck, format check, test, build.
