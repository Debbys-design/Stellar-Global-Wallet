# Contributing — frontend & mobile (issue #115)

This document is for contributors building the **web app** (`frontend/`)
or **mobile app** (`mobile/`). Neither exists yet — see the
[root README](README.md#%EF%B8%8F-architecture) — so this is written ahead
of the first frontend PR, to set expectations before one lands rather than
after.

If you're working on the backend API or Soroban contracts instead, this
isn't the doc you want: read
[`backend/CONTRIBUTING.md`](backend/CONTRIBUTING.md) or
[`contract/CONTRIBUTING.md`](contract/CONTRIBUTING.md).

## Repo layout

```
backend/    Node.js + Express + TypeScript REST API (built, testnet)
contract/   Rust + Soroban smart contracts (built, testnet)
frontend/   Next.js web app (planned — not started)
mobile/     React Native / Expo app (planned — not started)
```

`backend/` and `contract/` are independent packages with their own
`package.json`/`Cargo.toml`, CI workflow, and `CONTRIBUTING.md`. When
`frontend/`/`mobile/` are created, follow that same pattern: your own
dependency manifest, lockfile, and CI workflow scoped to path changes
under that directory (see [`.github/workflows/backend.yml`](.github/workflows/backend.yml)
for the pattern the new workflow should follow), rather than folding
frontend tooling into the backend's.

## Design is the source of truth for UI

The UI is specified in the
[Figma file template](https://claude.ai/artifact/HAEA9kUpEhSMCyjDwCBL6t#page-dcb81aee8d83)
linked from the root README. Build to that file — don't improvise layout,
copy, or flows that aren't in it. If something the design calls for isn't
possible with the current API (a field it doesn't expose, a flow it
doesn't support), that's a backend gap to open an issue for, not a reason
to deviate from the design silently.

## Talking to the backend API: SDK and mock server

**Neither exists yet.** There is no published client SDK package and no
mock server (e.g. Prism) wired up in this repo today — those are
themselves open frontend-prep work (a full OpenAPI 3.1 spec is tracked in
[#15](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/15); a
generated/hand-written SDK and a Prism mock server are natural follow-ups
once that spec exists). Until then:

- **Read the API directly from its docs**, not from guessing at routes:
  [`backend/README.md`](backend/README.md#api-reference) lists every
  route, [`backend/docs/error-examples.md`](backend/docs/error-examples.md)
  and [`backend/docs/openapi-errors.yaml`](backend/docs/openapi-errors.yaml)
  give you a real example body for every error status, and
  [`backend/docs/rate-limits.md`](backend/docs/rate-limits.md) covers
  request limits and backoff.
- **Run the real API against testnet locally** rather than waiting for a
  mock: `cd backend && cp .env.example .env && npm install && npm run dev`
  — the committed `.env.example` already points at a live testnet contract
  with a demo user, so read endpoints work with no setup beyond `npm run
  dev`. See [`backend/README.md`](backend/README.md#getting-started).
- **If you need a mock server before #15 lands**, say so in your issue —
  a hand-rolled fixture server scoped to the routes your feature needs is
  a reasonable stopgap PR, but say explicitly in that PR's description
  that it's a stopgap so it doesn't get treated as the permanent answer.
- Once an SDK package exists, this section (and
  [`backend/docs/rate-limits.md`](backend/docs/rate-limits.md)'s own "SDK"
  note) should be updated to link it instead of the API docs directly —
  don't let this doc silently go stale once that lands.

## Contract TypeScript bindings

TypeScript bindings for the Soroban contracts are generated with
`stellar contract bindings typescript` and published into the workspace
so the web and mobile apps can import typed clients instead of
hand-rolling contract calls. The generation is driven by
[`contract/scripts/bindings.sh`](contract/scripts/bindings.sh) and run in
CI by [`.github/workflows/contract-bindings.yml`](.github/workflows/contract-bindings.yml).

Both contracts are covered:

- `globe-wallet` — the wallet contract (see
  [#75](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/75)).
- `token-wrapper` — the token-wrapper contract (see
  [#76](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/76)).

To regenerate locally, run `contract/scripts/bindings.sh` from the repo
root; the generated packages land in the workspace alongside the
contracts. Don't hand-edit generated bindings — change the contract or
the script and regenerate. When a contract's public API changes, update
the script's contract list if a new contract is added, and note the
regenerated bindings in the PR description.

## PR flow

Same flow as the rest of the repo (see the
[root README](README.md#-how-you-can-help)):

1. Pick an open issue (or open one — use the
   [issue templates](.github/ISSUE_TEMPLATE/)) and get it assigned to you
   before starting, to avoid duplicate work.
2. Fork the repo and branch from `main`.
3. Keep each PR scoped to one issue/feature. A PR that mixes an unrelated
   drive-by fix with the feature it's actually about makes both harder to
   review — split it.
4. Add a CI workflow for `frontend/`/`mobile/` in the same PR that
   introduces the package (lint + type-check + test, scoped to that
   path), mirroring [`backend.yml`](.github/workflows/backend.yml).
5. Open the PR against `main` with a description that explains *why*, not
   just *what* — see [`backend/CONTRIBUTING.md`](backend/CONTRIBUTING.md#what-every-pr-must-include)
   for what "done" means on this project; the same bar applies here once
   frontend code exists (root-cause explanation, evidence it actually
   runs — a screen recording or before/after screenshots for UI work,
   tests where they make sense).

## Commit conventions

This repo uses [Conventional Commits](https://www.conventionalcommits.org/)
style subject lines, as seen throughout the existing history:

```
feat(wallet-ui): add send flow from Figma screen 4
fix(mobile): correct balance formatting for assets with 7 decimals
docs: link rate-limit guidance from frontend CONTRIBUTING
chore: scaffold frontend/ package
```

`type(scope): short, imperative summary` — common types are `feat`,
`fix`, `docs`, `chore`, `test`, `refactor`. Scope the commit to the
package/area it touches (`wallet-ui`, `mobile`, `globe-wallet`, etc.) the
same way existing `backend`/`contract` commits do.
