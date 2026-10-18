import { Router } from "express";
import { param, query } from "express-validator";
import { assertValidRequest } from "../middleware/requestValidation";
import { StellarService } from "../services/stellar";
import { getUnifiedActivityFeed } from "../services/activityFeed";
import { isGAddress, publicKeyMessage } from "../utils/stellarAddress";

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

function toNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
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
          transactions: result.transactions,
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
        const limit = (req.query.limit as number | undefined) ?? 20;
        const cursor = req.query.cursor as string | undefined;
        const result = await stellar.getPaymentHistory(req.params.publicKey, { limit, cursor });
        res.json({
          payments: result.payments,
          next: result.next,
          hasMore: result.hasMore,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // #79 — activity feed combining classic payments and Soroban contract events
  accountRouter.get(
    "/:publicKey/activity",
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
        const result = await getUnifiedActivityFeed({
          publicKey: req.params.publicKey,
          limit,
          cursor,
          stellar,
        });
        res.json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  return accountRouter;
}
