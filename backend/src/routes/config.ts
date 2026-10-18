import { Router } from "express";
import { config } from "../config";
import { GlobeWalletContract } from "../services/contracts/globeWallet";
import { AppError } from "../errors/appError";

const FRIENDBOT_URL = "https://friendbot.stellar.org";
const STELLAR_ACCOUNT_REGEX = /^G[A-Z2-7]{55}$/;

/**
 * Returns runtime environment configuration and contract state (#81).
 * Exposes network parameters, Horizon/RPC URLs, and pending upgrade timelock state.
 *
 * On testnet only, also mounts `POST /dev/fund` (#69) which funds a new
 * account via Friendbot for one-click onboarding. The route is absent on
 * any non-testnet network so it returns 404 there.
 */
export function createConfigRouter(globeWallet?: GlobeWalletContract): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      let pendingUpgrade = null;
      if (globeWallet && config.GLOBE_WALLET_CONTRACT_ID) {
        try {
          pendingUpgrade = await globeWallet.getPendingUpgrade();
        } catch {
          pendingUpgrade = null;
        }
      }

      res.json({
        network: config.STELLAR_NETWORK,
        horizonUrl: config.HORIZON_URL,
        sorobanRpcUrl: config.SOROBAN_RPC_URL,
        contracts: {
          globeWallet: {
            contractId: config.GLOBE_WALLET_CONTRACT_ID || null,
            pendingUpgrade,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  });

  if (config.STELLAR_NETWORK === "testnet") {
    router.post("/dev/fund", async (req, res, next) => {
      try {
        const account = req.body?.account;
        if (typeof account !== "string" || !STELLAR_ACCOUNT_REGEX.test(account)) {
          throw new AppError(
            "INVALID_ACCOUNT",
            400,
            "A valid Stellar account address is required",
          );
        }

        const response = await fetch(
          `${FRIENDBOT_URL}?addr=${encodeURIComponent(account)}`,
        );

        if (response.ok) {
          res.json({ account, funded: true, alreadyFunded: false });
          return;
        }

        const body = await response.text();
        if (/already|funded|op_already_exists|createAccountAlreadyExist/i.test(body)) {
          res.json({ account, funded: true, alreadyFunded: true });
          return;
        }

        throw new AppError(
          "FRIENDBOT_FAILED",
          502,
          "Friendbot could not fund the account",
        );
      } catch (err) {
        next(err);
      }
    });
  }

  return router;
}
