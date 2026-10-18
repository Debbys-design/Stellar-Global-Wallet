import request from "supertest";
import { createApp } from "../app";
import { DEFAULT_FEATURE_FLAGS } from "../services/featureFlags";

// Note: `config.ts` parses `process.env` once, at module-import time
// (`export const config = envSchema.parse(process.env)`), so a test can't
// mutate `process.env.FEATURE_FLAGS` after the fact and expect `config` to
// pick it up — `src/__tests__/featureFlags.test.ts` already covers the
// override-parsing logic directly (as a pure function of its string
// input), so this suite only needs to confirm the route itself is wired
// up and returns the (unset-override) defaults correctly.
describe("GET /api/v1/flags", () => {
  const app = createApp();

  it("returns the default flags, unauthenticated", async () => {
    const res = await request(app).get("/api/v1/flags").expect(200);

    expect(res.body.flags).toEqual(DEFAULT_FEATURE_FLAGS);
  });
});

describe("POST /api/v1/dev/fund", () => {
  const app = createApp();

  it("validates the account address at the edge", async () => {
    const res = await request(app)
      .post("/api/v1/dev/fund")
      .send({ account: "not-a-stellar-address" });

    // On mainnet the dev router is not mounted at all (404); on testnet the
    // request is rejected by validation (400). Either way it must not 500.
    expect([400, 404]).toContain(res.status);
    if (res.status === 400) {
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBeDefined();
    }
  });
});
