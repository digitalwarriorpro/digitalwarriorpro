# digitalwarriorpro

## Requirements

- Node.js 22+ (see `.nvmrc`)
- npm

## Setup

```bash
npm install
```

## Scripts

| Command                           | Purpose                                    |
| --------------------------------- | ------------------------------------------ |
| `npm run dev`                     | Run the server with hot reload             |
| `npm run build`                   | Compile TypeScript to `dist/`              |
| `npm start`                       | Run the compiled server                    |
| `npm test`                        | Run the test suite once                    |
| `npm run test:watch`              | Run tests in watch mode                    |
| `npm run lint` / `lint:fix`       | Lint (and auto-fix) the codebase           |
| `npm run format` / `format:check` | Format (or check formatting) with Prettier |
| `npm run typecheck`               | Type-check without emitting files          |

## Project layout

- `src/index.ts` — library entry point (exported functions)
- `src/server.ts` — Express web server entry point
- `bin/cli.js` — CLI entry point (`npx digitalwarriorpro <name>`)
- `tests/` — Vitest test suites

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs lint, typecheck, format check,
tests, and build on every push and pull request.
