# GlobeWallet — Backend

REST API for the GlobeWallet ecosystem, built with Node.js + Express + TypeScript.

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 LTS |
| Framework | Express 4 |
| Language | TypeScript (strict) |
| Stellar | @stellar/stellar-sdk (Horizon + Soroban RPC) |
| Validation | express-validator + Zod |
| Security | helmet, cors, express-rate-limit |
| Database | PostgreSQL (via pg) |
| Cache | Redis |

## Getting Started

```bash
cp .env.example .env   # fill in your values
npm install
npm run dev            # hot-reload dev server (tsx watch)
```

### Public testnet preview (#110)

Frontend contributors shouldn't need to run this backend at all. A
[`render.yaml`](../render.yaml) Blueprint at the repo root provisions a
testnet-configured instance (Horizon + Soroban RPC testnet, the demo
contract from `.env.example`, Postgres, Redis) that auto-deploys on every
push to `main`.

**TODO (see #110): deploy this Blueprint on Render and put the resulting
URL here.** Deploying is a one-time action — "New +" → "Blueprint" on
https://render.com/, pointing at this repo — that an account holder has to
take; this PR adds the config but can't click that button on anyone's
behalf. Once deployed, verify it with `./scripts/smoke-test.sh <url>`.

```
Preview API: <fill in after first deploy>
```

## API Reference

### Health

```
GET /health
```

### Account

```
GET  /api/v1/account/:publicKey              → account info
GET  /api/v1/account/:publicKey/balances     → { balances: { XLM: "...", ... } }
GET  /api/v1/account/:publicKey/transactions → paginated transaction list
GET  /api/v1/account/:publicKey/payments     → paginated activity feed with
                                                suspicious-payment `flags`
                                                (dust/memo_url/unknown_asset)
                                                — see docs/payment-flags.md
GET  /api/v1/account/:publicKey/activity     → unified activity feed combining
                                                classic transactions/payments and
                                                contract events with composite cursor
GET  /api/v1/account/:publicKey/thresholds   → multisig signers, weights and
                                                thresholds in a UI-ready shape
                                                (see below)
```

#### Multisig signers & thresholds (#72)

`GET /api/v1/account/:publicKey/thresholds` returns everything a multisig
screen needs to render signers and decide whether each operation level can
currently be signed:

```json
{
  "signers": [
    { "key": "G...", "weight": 1, "type": "ed25519_public_key" },
    { "key": "G...", "weight": 2, "type": "ed25519_public_key" }
  ],
  "thresholds": { "low": 1, "med": 2, "high": 3 },
  "reachable": { "low": true, "med": true, "high": false },
  "canSign": { "low": true, "med": true, "high": false }
}
```

- `signers[].type` is the Horizon signer type (`ed25519_public_key`,
  `sha256_hash`, `preauth_tx`, `ed25519_signed_payload`).
- `reachable[level]` is `true` when the sum of all signer weights meets the
  level's threshold — i.e. the account can ever satisfy that level.
- `canSign[level]` is the per-level helper: `true` when the caller's own
  signer weight (or the master key weight, if the caller is the account
  itself) is enough to meet the threshold on its own. Use `reachable` for
  "can this account ever sign" and `canSign` for "can this caller sign".

### Wallet

```
POST /api/v1/wallet/keypair  → generate a new keypair (public + secret)
POST /api/v1/wallet/send     → submit a payment transaction
```

Body for `/send`:
```json
{
  "sourceSecretKey": "S...",
  "destinationPublicKey": "G...",
  "amount": "10.0000000",
  "asset": "XLM",
  "memo": "optional"
}
```

Concurrent `/send` calls for the same source account are serialized
per-account (see [`docs/concurrency.md`](docs/concurrency.md)) — set
`LOCK_BACKEND=redis` before running more than one instance of this API,
or that serialization only holds within a single process.

### Contract (Soroban — `globe-wallet`)

```
GET  /api/v1/contract/wallet/:publicKey/assets  → { assets: [{ code, issuer }] }
GET  /api/v1/contract/admin                     → { admin, pendingAdmin }
GET  /api/v1/contract/upgrade                   → { pendingUpgrade }
POST /api/v1/contract/admin/propose             → { xdr } (unsigned XDR for propose_admin)
POST /api/v1/contract/admin/accept              → { xdr } (unsigned XDR for accept_admin)
POST /api/v1/contract/admin/cancel              → { xdr } (unsigned XDR for cancel_admin_transfer)
POST /api/v1/contract/wallet/spend              → { hash, ledger, successful }
```

`GET .../assets`, `GET .../admin`, and `GET .../upgrade` are public (read-only, simulated, no fee).
`POST .../spend` and `POST .../admin/*` require a Bearer token.
Requires `GLOBE_WALLET_CONTRACT_ID` — see `.env.example` and
[`docs/soroban-integration.md`](docs/soroban-integration.md) for the
design rationale and a real testnet run.

### Config & Transparency

```
GET /api/v1/config (and /config)  → { network, horizonUrl, sorobanRpcUrl, contracts: { globeWallet: { contractId, pendingUpgrade } } }
```

### Price

```
GET /api/v1/price/:asset  → placeholder only; always returns { price_usd: null,
                             source: "not_configured" } until a real oracle
                             (CoinGecko / Stellar DEX orderbook) is wired up
                             in src/routes/price.ts
```

## Docs for API integrators

- [`docs/rate-limits.md`](docs/rate-limits.md) — limits in effect, the
  `RateLimit-*` / `Retry-After` headers, and recommended client backoff.
- [`docs/error-examples.md`](docs/error-examples.md) /
  [`docs/openapi-errors.yaml`](docs/openapi-errors.yaml) — example response
  bodies for every error status (400–503), reusable from a mock server.
- [`docs/security-model.md`](docs/security-model.md) — secret key handling.
- [`docs/concurrency.md`](docs/concurrency.md) — per-account locking.
- [`docs/soroban-integration.md`](docs/soroban-integration.md) — Soroban RPC
  vs. Horizon.

## Project Structure

```
src/
  app.ts           # Express app factory
  index.ts         # Entry point
  config.ts        # Environment config validation (Zod)
  db.ts            # Postgres pool + audit table bootstrap
  routes/          # Route handlers
  middleware/       # Auth, error handling, rate limiting
  services/        # Stellar SDK, Soroban RPC, contract clients, locks
  utils/           # Helpers (JWT)
  types/           # Shared TypeScript types
  tests/             # Jest unit/integration tests
docs/              # Design docs (concurrency, security model, rate limits, error examples)
```

## Related Packages

- [`contract/`](../contract/) — Soroban smart contracts (in this monorepo)
- Web frontend and mobile app — not yet built; see the [root README](../README.md)
