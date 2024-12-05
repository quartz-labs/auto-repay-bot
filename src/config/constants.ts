import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

export const MIN_LAMPORTS_BALANCE = 0.1 * LAMPORTS_PER_SOL;
export const LOOP_DELAY = 30_000;
export const MAX_AUTO_REPAY_ATTEMPTS = 3;

export const GOAL_HEALTH = 0.2;
export const JUPITER_SLIPPAGE_BPS = 50;
export const DRIFT_SOL_COLLATERAL_WEIGHT = 0.9;
export const MARGINFI_FLASH_LOAN_TOKEN = "SOL";

export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

