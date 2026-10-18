import { Router, Request, Response, NextFunction } from "express";
import { body, param } from "express-validator";
import { jwtAuth } from "../middleware/jwtAuth";
import { assertValidRequest } from "../middleware/requestValidation";
import { logKeypairIssuance } from "../services/auditLog";
import { StellarService } from "../services/stellar";
import { isGAddress, publicKeyMessage, destinationMessage } from "../utils/stellarAddress";
import { validatePathAssets } from "../validation/stellarAsset";
import { isValidMemoText, memoTextMessage } from "@globe-wallet/sdk";
import * as StellarSdk from "@stellar/stellar-sdk";
import { getCachedResult, cacheResult } from "../services/idempotency";

const BASE_RESERVE_XLM = 0.5;

// Muxed account IDs are unsigned 64-bit integers.
const MAX_MUXED_ID = (1n << 64n) - 1n;

interface ReserveBreakdown {
  base: string;
  trustlines: string;
  offers: string;
  signers: string;
  data: string;
  sponsoring: string;
  sponsored: string;
  total: string;
  spendableXlm: string;
}

interface AssetSpendable {
  asset: string;
  balance: string;
  sellingLiabilities: string;
  spendable: string;
}

function formatAmount(value: number): string {
  // Stellar amounts are 7-decimal precision; trim trailing zeros for readability.
  return value.toFixed(7).replace(/\.?0+$/, "");
}

function computeReserveBreakdown(account: StellarSdk.AccountResponse): ReserveBreakdown {
  const subentryCount = account.subentry_count ?? 0;
  const numSponsoring = account.num_sponsoring ?? 0;
  const numSponsored = account.num_sponsored ?? 0;

  const trustlines = account.balances.filter((b) => b.asset_type !== "native").length;
  const offers = account.offers?.length ?? 0;
  const signers = Math.max((account.signers?.length ?? 1) - 1, 0);
  const data = Object.keys(account.data ?? {}).length;

  // Subentries are trustlines + offers + signers + data. Sponsoring adds a
  // reserve per sponsored entry; being sponsored removes one.
  const base = BASE_RESERVE_XLM * 2;
  const trustlinesReserve = BASE_RESERVE_XLM * trustlines;
  const offersReserve = BASE_RESERVE_XLM * offers;
  const signersReserve = BASE_RESERVE_XLM * signers;
  const dataReserve = BASE_RESERVE_XLM * data;
  const sponsoringReserve = BASE_RESERVE_XLM * numSponsoring;
  const sponsoredReserve = BASE_RESERVE_XLM * numSponsored;

  const total =
    (2 + subentryCount + numSponsoring - numSponsored) * BASE_RESERVE_XLM;

  const native = account.balances.find((b) => b.asset_type === "native");
  const nativeBalance = native ? parseFloat(native.balance) : 0;
  const nativeSelling = native ? parseFloat(native.selling_liabilities ?? "0") : 0;
  const spendableXlm = Math.max(nativeBalance - total - nativeSelling, 0);

  return {
    base: formatAmount(base),
    trustlines: formatAmount(trustlinesReserve),
    offers: formatAmount(offersReserve),
    signers: formatAmount(signersReserve),
    data: formatAmount(dataReserve),
    sponsoring: formatAmount(sponsoringReserve),
    sponsored: formatAmount(sponsoredReserve),
    total: formatAmount(total),
    spendableXlm: formatAmount(spendableXlm),
  };
}

function computeAssetSpendable(account: StellarSdk.AccountResponse): AssetSpendable[] {
  return account.balances.map((b) => {
    const asset =
      b.asset_type === "native"
        ? "XLM"
        : `${b.asset_code}:${b.asset_issuer}`;
    const balance = parseFloat(b.balance);
    const sellingLiabilities = parseFloat(b.selling_liabilities ?? "0");
    const spendable = Math.max(balance - sellingLiabilities, 0);
    return {
      asset,
      balance: formatAmount(balance),
      sellingLiabilities: formatAmount(sellingLiabilities),
      spendable: formatAmount(spendable),
    };
  });
}

/**
 * Validate a muxed account ID: a non-negative integer within the uint64 range.
 * Accepts a number or a decimal string (strings avoid JS precision loss for
 * IDs above Number.MAX_SAFE_INTEGER).
 */
function isValidMuxedId(value: unknown): boolean {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && BigInt(value) <= MAX_MUXED_ID;
  }
  if (typeof value === "string") {
    if (!/^\d+$/.test(value)) {
      return false;
    }
    return BigInt(value) <= MAX_MUXED_ID;
  }
  return false;
}

async function handleIdempotentRequest(
  req: Request,
  res: Response,
  next: NextFunction,
  secretKey: string | undefined,
  execute: () => Promise<{ hash: string; successful: boolean }>
) {
  try {
    assertValidRequest(req);
    const idempotencyKey = req.body.idempotencyKey;
    let sourcePublicKey: string | undefined;

    if (idempotencyKey && secretKey) {
      const keypair = StellarSdk.Keypair.fromSecret(secretKey);
      sourcePublicKey = keypair.publicKey();
      const cached = await getCachedResult(sourcePublicKey, idempotencyKey);
      if (cached) {
        res.json({ hash: cached.hash, successful: cached.successful });
        return;
      }
    }

    const result = await execute();

    if (idempotencyKey && sourcePublicKey) {
      await cacheResult(sourcePublicKey, idempotencyKey, result.hash, result.successful);
    }

    res.json({ hash: result.hash, successful: result.successful });
  } catch (err) {
    next(err);
  }
}

export function createWalletRouter(stellar: StellarService): Router {
  const walletRouter = Router();

  walletRouter.use(jwtAuth);

  walletRouter.get(
    "/accounts/:publicKey/reserves",
    param("publicKey")
      .isLength({ min: 56, max: 56 })
      .bail()
      .custom(isGAddress)
      .withMessage(publicKeyMessage),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const account = await stellar.server.loadAccount(req.params.publicKey);
        const reserves = computeReserveBreakdown(account);
        const assets = computeAssetSpendable(account);
        res.json({ reserves, assets });
      } catch (err) {
        next(err);
      }
    }
  );

  // Generate a muxed (M-address) receive address for a base account. Exchanges
  // and custodial services use muxed accounts to tag deposits to a sub-account.
  walletRouter.post(
    "/:publicKey/muxed",
    param("publicKey")
      .isLength({ min: 56, max: 56 })
      .bail()
      .custom(isGAddress)
      .withMessage(publicKeyMessage),
    body("id")
      .exists({ checkNull: true })
      .bail()
      .custom(isValidMuxedId)
      .withMessage("id must be a non-negative integer within the uint64 range"),
    (req, res, next) => {
      try {
        assertValidRequest(req);
        const publicKey = req.params.publicKey;
        const id = BigInt(req.body.id);
        const muxed = new StellarSdk.MuxedAccount(
          StellarSdk.Keypair.fromPublicKey(publicKey),
          id
        );
        res.json({
          publicKey,
          id: id.toString(),
          muxedAccount: muxed.accountId(),
        });
      } catch (err) {
        next(err);
      }
    }
  );

  walletRouter.post(
    "/send",
    body("sourceSecretKey").isLength({ min: 56, max: 56 }),
    body("destinationPublicKey")
      .isLength({ min: 56, max: 56 })
      .bail()
      .custom(isGAddress)
      .withMessage(destinationMessage),
    body("amount").isDecimal({ decimal_digits: "0,7" }),
    body("asset").optional().isString(),
    // Stellar's MEMO_TEXT limit is 28 *bytes* once UTF-8 encoded, not 28
    // characters — `isLength({ max: 28 })` (the previous check here) counts
    // characters, so it wrongly accepted e.g. a 20-character memo full of
    // emoji/CJK text that's well over 28 bytes and would be rejected
    // on-chain. See packages/sdk/src/validate/memo.ts (#103).
    body("memo").optional().isString().custom(isValidMemoText).withMessage(memoTextMessage),
    body("idempotencyKey").optional().isString().isLength({ max: 255 }),
    (req, res, next) =>
      handleIdempotentRequest(req, res, next, req.body.sourceSecretKey, () => stellar.sendPayment(req.body))
  );

  walletRouter.post(
    "/fee-bump",
    body("transactionXdr").isString().notEmpty(),
    body("feeSecretKey").isLength({ min: 56, max: 56 }),
    body("fee").optional().isDecimal({ decimal_digits: "0,7" }),
    body("idempotencyKey").optional().isString().isLength({ max: 255 }),
    (req, res, next) =>
      handleIdempotentRequest(req, res, next, req.body.feeSecretKey, () => stellar.feeBumpTransaction(req.body))
  );

  walletRouter.post(
    "/path-payment-strict-send",
    body("sourceSecretKey").isLength({ min: 56, max: 56 }),
    body("destinationPublicKey")
      .isLength({ min: 56, max: 56 })
      .bail()
      .custom(isGAddress)
      .withMessage(destinationMessage),
    body("sendAmount").isDecimal({ decimal_digits: "0,7" }),
    body("destAsset").isString(),
    body("destMin").isDecimal({ decimal_digits: "0,7" }),
    body("path").optional().custom((path: unknown) => {
      if (!Array.isArray(path)) {
        throw new Error("Path must be an array");
      }
      validatePathAssets(path);
      return true;
    }),
    // Stellar's MEMO_TEXT limit is 28 *bytes* once UTF-8 encoded, not 28
    // characters — `isLength({ max: 28 })` (the previous check here) counts
    // characters, so it wrongly accepted e.g. a 20-character memo full of
    // emoji/CJK text that's well over 28 bytes and would be rejected
    // on-chain. See packages/sdk/src/validate/memo.ts (#103).
    body("memo").optional().isString().custom(isValidMemoText).withMessage(memoTextMessage),
    body("idempotencyKey").optional().isString().isLength({ max: 255 }),
    (req, res, next) =>
      handleIdempotentRequest(req, res, next, req.body.sourceSecretKey, () => stellar.pathPaymentStrictSend(req.body))
  );

  return walletRouter;
}
