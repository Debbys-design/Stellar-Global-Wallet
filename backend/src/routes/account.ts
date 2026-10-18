import { Router } from "express";
import { body, param, query } from "express-validator";
import { assertValidRequest } from "../middleware/requestValidation";
import { StellarService } from "../services/stellar";
import { getUnifiedActivityFeed } from "../services/activityFeed";
import { isGAddress, publicKeyMessage } from "../utils/stellarAddress";
import { MuxedAccount } from "@stellar/stellar-sdk";

const BASE_RESERVE_XLM = 0.5;
const BASE_ACCOUNT_RESERVES = 2;

interface ReserveBreakdown {
  base: number;
  trustlines: number;
  offers: number;
  signers: number;
  data: number;
  sponsoring: number;
  sponsored: number;
  total: number;
  spendableXlm: number;
}

interface MultisigSigner {
  key: string;
  weight: number;
  type: string;
}

interface MultisigThresholds {
  low: number;
  med: number;
  high: number;
}

interface MultisigInfo {
  signers: MultisigSigner[];
  thresholds: MultisigThresholds;
  reachable: { low: boolean; med: boolean; high: boolean };
  canSign: { low: boolean; med: boolean; high: boolean };
}

function toNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

// #72 — normalise Horizon's signers/thresholds into a UI-ready shape and
// compute whether each threshold level can be reached by the current signers.
function computeMultisigInfo(account: any): MultisigInfo {
  const rawSigners = Array.isArray(account?.signers) ? account.signers : [];
  const signers: MultisigSigner[] = rawSigners.map((s: any) => ({
    key: typeof s?.key === "string" ? s.key : "",
    weight: toNumber(s?.weight),
    type: typeof s?.type === "string" ? s.type : "ed25519_public_key",
  }));

  const thresholds: MultisigThresholds = {
    low: toNumber(account?.thresholds?.low_threshold),
    med: toNumber(account?.thresholds?.med_threshold),
    high: toNumber(account?.thresholds?.high_threshold),
  };

  const totalWeight = signers.reduce((sum, s) => sum + s.weight, 0);
  const reachable = {
    low: totalWeight >= thresholds.low,
    med: totalWeight >= thresholds.med,
    high: totalWeight >= thresholds.high,
  };

  return {
    signers,
    thresholds,
    reachable,
    canSign: { ...reachable },
  };
}

function computeReserveBreakdown(account: any): ReserveBreakdown {
  const subentryCount = toNumber(account?.subentry_count);
  const numSponsoring = toNumber(account?.num_sponsoring);
  const numSponsored = toNumber(account?.num_sponsored);

  const trustlines = Array.isArray(account?.balances)
    ? account.balances.filter((b: any) => b?.asset_type !== "native").length
    : 0;
  const offers = Array.isArray(account?.offers) ? account.offers.length : 0;
  const signers = Array.isArray(account?.signers)
    ? Math.max(account.signers.length - 1, 0)
    : 0;
  const data = Array.isArray(account?.data) ? account.data.length : 0;

  const base = BASE_ACCOUNT_RESERVES * BASE_RESERVE_XLM;
  const trustlinesReserve = trustlines * BASE_RESERVE_XLM;
  const offersReserve = offers * BASE_RESERVE_XLM;
  const signersReserve = signers * BASE_RESERVE_XLM;
  const dataReserve = data * BASE_RESERVE_XLM;
  const sponsoringReserve = numSponsoring * BASE_RESERVE_XLM;
  const sponsoredReserve = numSponsored * BASE_RESERVE_XLM;

  const total =
    (BASE_ACCOUNT_RESERVES + subentryCount + numSponsoring - numSponsored) *
    BASE_RESERVE_XLM;

  const nativeBalance = Array.isArray(account?.balances)
    ? account.balances.find((b: any) => b?.asset_type === "native")
    : undefined;
  const nativeAmount = toNumber(nativeBalance?.balance);
  const sellingLiabilities = toNumber(nativeBalance?.selling_liabilities);
  const spendableXlm = Math.max(nativeAmount - sellingLiabilities - total, 0);

  return {
    base,
    trustlines: trustlinesReserve,
    offers: offersReserve,
    signers: signersReserve,
    data: dataReserve,
    sponsoring: sponsoringReserve,
    sponsored: sponsoredReserve,
    total,
    spendableXlm,
  };
}

// #71 — decode a muxed (M...) address into its base account and id. Returns
// null when the value is not a valid muxed address so callers can fall back
// to the raw value without throwing.
function decodeMuxedAddress(value: unknown): { baseAccount: string; id: string } | null {
  if (typeof value !== "string" || !value.startsWith("M")) {
    return null;
  }
  try {
    const muxed = MuxedAccount.fromAddress(value, "0");
    return {
      baseAccount: muxed.baseAccount().accountId(),
      id: muxed.id(),
    };
  } catch {
    return null;
  }
}

// #71 — attach decoded muxed info to a history item when its source account
// is a muxed address, leaving the original fields untouched.
function withDecodedMuxed(item: any): any {
  if (!item || typeof item !== "object") {
    return item;
  }
  const decoded = decodeMuxedAddress(item.source_account);
  if (!decoded) {
    return item;
  }
  return {
    ...item,
    muxed: {
      address: item.source_account,
      baseAccount: decoded.baseAccount,
      id: decoded.id,
    },
  };
}

export function createAccountRouter(stellar: StellarService): Router {
  const accountRouter = Router();

  accountRouter.get(
    "/:publicKey",
    param("publicKey").custom(isGAddress).withMessage(publicKeyMessage),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const account = await stellar.getAccount(req.params.publicKey);
        res.json(account);
      } catch (err) {
        next(err);
      }
    }
  );

  accountRouter.get(
    "/:publicKey/balances",
    param("publicKey").custom(isGAddress).withMessage(publicKeyMessage),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const balances = await stellar.getBalances(req.params.publicKey);
        res.json({ balances });
      } catch (err) {
        next(err);
      }
    }
  );

  // #72 — multisig signers, weights, thresholds and per-level reachability
  // in a UI-ready shape for the multisig screen.
  accountRouter.get(
    "/:publicKey/signers",
    param("publicKey").custom(isGAddress).withMessage(publicKeyMessage),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const account = await stellar.getAccount(req.params.publicKey);
        res.json(computeMultisigInfo(account));
      } catch (err) {
        next(err);
      }
    }
  );

  // #70 — reserve breakdown so clients can show spendable vs reserved.
  accountRouter.get(
    "/:publicKey/reserves",
    param("publicKey").custom(isGAddress).withMessage(publicKeyMessage),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const account = await stellar.getAccount(req.params.publicKey);
        const reserves = computeReserveBreakdown(account);
        const balances = Array.isArray(account?.balances)
          ? account.balances.map((b: any) => {
              const available = toNumber(b?.balance);
              const sellingLiabilities = toNumber(b?.selling_liabilities);
              return {
                ...b,
                spendable: Math.max(available - sellingLiabilities, 0).toString(),
              };
            })
          : [];
        res.json({ reserves, balances });
      } catch (err) {
        next(err);
      }
    }
  );

  // #71 — generate a muxed (M...) address for a base account and id so
  // exchanges/custodial services can tag deposits.
  accountRouter.post(
    "/:publicKey/muxed",
    param("publicKey").custom(isGAddress).withMessage(publicKeyMessage),
    body("id")
      .exists({ checkFalsy: false })
      .withMessage("id is required")
      .custom((value) => {
        const str = typeof value === "number" ? String(value) : value;
        if (typeof str !== "string" || !/^\d+$/.test(str)) {
          throw new Error("id must be a non-negative integer string");
        }
        if (BigInt(str) > BigInt("18446744073709551615")) {
          throw new Error("id must fit in an unsigned 64-bit integer");
        }
        return true;
      }),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const id = String(req.body.id);
        const muxed = new MuxedAccount(
          MuxedAccount.fromAddress(req.params.publicKey, id).baseAccount(),
          id
        );
        res.json({
          address: muxed.accountId(),
          baseAccount: req.params.publicKey,
          id,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  accountRouter.get(
    "/:publicKey/transactions",
    param("publicKey").custom(isGAddress).withMessage(publicKeyMessage),
    query("limit")
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage("limit must be an integer between 1 and 100")
      .toInt(),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const limit = (req.query.limit as number | undefined) ?? 20;
        const cursor = req.query.cursor as string | undefined;
        const result = await stellar.getTransactions(req.params.publicKey, { limit, cursor });
        res.json({ 
          transactions: result.transactions.map(withDecodedMuxed),
          next: result.next,
          hasMore: result.hasMore,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // #105 — activity feed with suspicious-payment flags (dust, memo_url,
  // unknown_asset). Separate from GET /:publicKey/transactions (which stays
  // on Horizon's transaction-level records) because flagging needs the
  // per-payment amount/asset Horizon only returns from /payments.
  accountRouter.get(
    "/:publicKey/payments",
    param("publicKey").custom(isGAddress).withMessage(publicKeyMessage),
    query("limit")
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage("limit must be an integer between 1 and 100")
      .toInt(),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        

/* … truncated 1276 chars — edit only what you need near the top … */
