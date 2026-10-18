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

// Stellar signer weights and thresholds are unsigned 32-bit integers.
const MAX_WEIGHT = 255;

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

interface SignerInput {
  key: string;
  weight: number;
}

interface SetOptionsInput {
  sourcePublicKey: string;
  addSigners?: SignerInput[];
  removeSigners?: string[];
  masterWeight?: number;
  lowThreshold?: number;
  mediumThreshold?: number;
  highThreshold?: number;
}

interface SetOptionsResult {
  xdr: string;
  networkPassphrase: string;
  warnings: string[];
  resultingSigners: { key: string; weight: number }[];
  resultingThresholds: { low: number; medium: number; high: number };
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

/**
 * Validate a signer weight / threshold: an integer in [0, 255].
 */
function isValidWeight(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_WEIGHT;
}

/**
 * Simulate the resulting signer set and thresholds for a `setOptions` change
 * and reject any change that would lock the account out.
 *
 * Lockout conditions:
 *  - the sum of all signer weights is below any of the resulting thresholds
 *    (no combination of signers can ever meet that threshold), or
 *  - the master weight is 0 and there are no other signers (nobody can sign).
 */
function simulateSetOptions(
  account: StellarSdk.AccountResponse,
  input: SetOptionsInput
): { signers: { key: string; weight: number }[]; thresholds: { low: number; medium: number; high: number }; warnings: string[] } {
  const warnings: string[] = [];

  // Build the resulting signer map keyed by signer key. The master key is
  // represented by the account's own public key with weight = master weight.
  const signerMap = new Map<string, number>();
  const masterKey = account.account_id;
  const masterSigner = account.signers?.find((s) => s.key === masterKey);
  signerMap.set(masterKey, masterSigner ? masterSigner.weight : 1);
  for (const s of account.signers ?? []) {
    if (s.key !== masterKey) {
      signerMap.set(s.key, s.weight);
    }
  }

  if (input.masterWeight !== undefined) {
    signerMap.set(masterKey, input.masterWeight);
  }

  for (const key of input.removeSigners ?? []) {
    if (key === masterKey) {
      // Removing the master key is expressed by setting master weight to 0.
      signerMap.set(masterKey, 0);
    } else {
      signerMap.delete(key);
    }
  }

  for (const signer of input.addSigners ?? []) {
    signerMap.set(signer.key, signer.weight);
  }

  const thresholds = {
    low: input.lowThreshold ?? account.thresholds.low_threshold,
    medium: input.mediumThreshold ?? account.thresholds.med_threshold,
    high: input.highThreshold ?? account.thresholds.high_threshold,
  };

  const signers = Array.from(signerMap.entries()).map(([key, weight]) => ({ key, weight }));
  const totalWeight = signers.reduce((sum, s) => sum + s.weight, 0);

  const masterWeight = signerMap.get(masterKey) ?? 0;
  const otherSigners = signers.filter((s) => s.key !== masterKey && s.weight > 0);
  if (masterWeight === 0 && otherSigners.length === 0) {
    throw new SetOptionsLockoutError(
      "SETOPTIONS_LOCKOUT",
      "Change would set master weight to 0 with no other signers, permanently locking the account"
    );
  }

  for (const [name, threshold] of Object.entries(thresholds)) {
    if (totalWeight < threshold) {
      throw new SetOptionsLockoutError(
        "SETOPTIONS_THRESHOLD_UNREACHABLE",
        `Sum of signer weights (${totalWeight}) is below the ${name} threshold (${threshold}); the account would be locked`
      );
    }
  }

  if (masterWeight === 0) {
    warnings.push("Master key weight is 0; the account can only be signed by other signers");
  }
  if (thresholds.low > thresholds.medium || thresholds.medium > thresholds.high) {
    warnings.push("Thresholds are not monotonically increasing (low <= medium <= high)");
  }

  return { signers, thresholds, warnings };
}

/**
 * Error raised when a `setOptions` change would lock the account. Carries a
 * stable error code so the shared error envelope can surface it.
 */
class SetOptionsLockoutError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SetOptionsLockoutError";
    this.code = code;
  }
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

  // Build an unsigned `setOptions` transaction for multisig management
  // (add/remove signers, master weight, thresholds). Returns the XDR for
  // client-side signing; never accepts a secret key. Rejects changes that
  // would lock the account out.
  walletRouter.post(
    "/set-options/build",
    body("sourcePublicKey")
      .isLength({ min: 56, max: 56 })
      .bail()
      .custom(isGAddress)
      .withMessage(publicKeyMessage),
    body("addSigners")
      .optional()
      .isArray({ max: 20 })
      .withMessage("addSigners must be an array of at most 20 signers"),
    body("addSigners.*.key")
      .if(body("addSigners").exists())
      .isLength({ min: 56, max: 56 })
      .bail()
      .custom(isGAddress)
      .withMessage(publicKeyMessage),
    body("addSigners.*.weight")
      .if(body("addSigners").exists())
      .custom(isValidWeight)
      .withMessage(`weight must be an integer between 0 and ${MAX_WEIGHT}`),
    body("removeSigners")
      .optional()
      .isArray({ max: 20 })
      .withMessage("removeSigners must be an array of at most 20 signer keys"),
    body("removeSigners.*")
      .if(body("removeSigners").exists())
      .isLength({ min: 56, max: 56 })
      .bail()
      .custom(isGAddress)
      .withMessage(publicKeyMessage),
    body("masterWeight")
      .optional()
      .custom(isValidWeight)
      .withMessage(`masterWeight must be an integer between 0 and ${MAX_WEIGHT}`),
    body("lowThreshold")
      .optional()
      .custom(isValidWeight)
      .withMessage(`lowThreshold must be an integer between 0 and ${MAX_WEIGHT}`),
    body("mediumThreshold")
      .optional()
      .custom(isValidWeight)
      .withMessage(`mediumThreshold must be an integer between 0 and ${MAX_WEIGHT}`),
    body("highThreshold")
      .optional()
      .custom(isValidWeight)
      .withMessage(`highThreshold must be an integer between 0 and ${MAX_WEIGHT}`),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const input: SetOptionsInput = {
          sourcePublicKey: req.body.sourcePublicKey,
          addSigners: req.body.addSigners,
          removeSigners: req.body.removeSigners,
          masterWeight: req.body.masterWeight,
          lowThreshold: req.body.lowThreshold,
          mediumThreshold: req.body.mediumThreshold,
          highThreshold: req.body.highThreshold,
        };

        const account = await stellar.server.loadAccount(input.sourcePublicKey);
        const simulation = simulateSetOptions(account, input);

        const builder = new StellarSdk.TransactionBuilder(account, {
          fee: StellarSdk.BASE_FEE,
          networkPassphrase: stellar.networkPassphrase,
        });

        const opts: StellarSdk.OperationOptions.SetOptions = {};
        if (input.masterWeight !== undefined) {
          opts.masterWeight = input.masterWeight;
        }
        if (input.lowThreshold !== undefined) {
          opts.lowThreshold = input.lowThreshold;
        }
        if (input.mediumThreshold !== undefined) {
          opts.mediumThreshold = input.mediumThreshold;
        }
        if (input.highThreshold !== undefined) {
          opts.highThreshold = input.highThreshold;
        }
        if (input.addSigners && input.addSigners.length > 0) {
          opts.signer = {
            ed25519PublicKey: input.addSigners[0].key,
            weight: input.addSigners[0].weight,
          };
        }

        builder.addOperation(StellarSdk.Operation.setOptions(opts));

        // Additional signers beyond the first are added as separate operations.
        for (const signer of (input.addSigners ?? []).slice(1)) {
          builder.addOperation(
            StellarSdk.Operation.setOptions({
              signer: { ed25519PublicKey: signer.key, weight: signer.weight },
            })
          );
        }

        // Removing a signer is expressed by setting its weight to 0.
        for (const key of input.removeSigners ?? []) {
          if (key === input.sourcePublicKey) {
            continue;
          }
          builder.addOperation(
            StellarSdk.Operation.setOptions({
              signer: { ed25519PublicKey: key, weight: 0 },
            })
          );
        }

        builder.setTimeout(180);
        const transaction = builder.build();

        const result: SetOptionsResult = {
          xdr: transaction.toXDR(),
          networkPassphrase: stellar.networkPassphrase,
          warnings: simulation.warnings,
          resultingSigners: simulation.signers,
          resultingThresholds: simulation.thresholds,
        };
        res.json(result);
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
    body("transactionXdr").is