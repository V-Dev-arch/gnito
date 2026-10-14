# Contributing to Gnito

Thanks for your interest. Gnito is a local-first, open-source AI
workspace — contributions that respect that philosophy are welcome.

## Ways to contribute

- Bug reports and feature requests: open an issue with reproduction steps.
- Code: open a PR with a clear description and passing tests.
- Docs: improvements to `docs/` are always valued.
- Plugins: see `docs/plugin-sdk.md`.

## Development setup

```bash
git clone <your-fork>
cd gnito
npm install
npm run dev           # dev server (vite + tsx watch)
npm run typecheck     # tsc for both client and server
npm run test          # vitest
npm run build         # production build
```

## Code style

- TypeScript strict mode.
- No `any` where avoidable.
- Every route validates input with zod.
- No secrets in logs, errors, or client bundles.
- All UI controls must be functional or clearly disabled with a reason.
- Test new features with vitest.

## Commit messages

Use conventional commits:

```
feat(chat): add retry button on failed assistant messages
fix(backup): reject corrupted archives with 400 not 500
docs: expand threat model
```

## Licensing

By contributing, you agree your work is licensed under the project's
MIT license (see `LICENSE`).
