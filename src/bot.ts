import { Connection, Keypair, LAMPORTS_PER_SOL, type PublicKey, SystemProgram, type TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { AddressLookupTableAccount } from "@solana/web3.js";
import { getConfig as getMarginfiConfig, type MarginfiAccountWrapper, MarginfiClient } from "@mrgnlabs/marginfi-client-v2";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { MAX_AUTO_REPAY_ATTEMPTS, LOOP_DELAY, JUPITER_SLIPPAGE_BPS, MIN_LAMPORTS_BALANCE, GOAL_HEALTH, DRIFT_SOL_COLLATERAL_WEIGHT, MARGINFI_FLASH_LOAN_TOKEN } from "./config/constants.js";
import { retryRPCWithBackoff, createPriorityFeeInstructions, createAtaIfNeeded, getTokenAccountBalance, getJupiterSwapQuote } from "./utils/helpers.js";
import { BigNumber } from "bignumber.js";
import { AppLogger } from "./utils/logger.js";
import config from "./config/config.js";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { QuartzClient, USDC_MINT, WSOL_MINT } from "@quartz-labs/sdk";
import type { QuartzUser } from "@quartz-labs/sdk";
import { Wallet } from "@coral-xyz/anchor";

export class AutoRepayBot extends AppLogger {
    private initPromise: Promise<void>;

    private connection: Connection;
    private wallet: Wallet | undefined;
    private walletUsdc: PublicKey | undefined;
    private walletWSol: PublicKey | undefined;

    private quartzClient: QuartzClient | undefined;
    private marginfiAccount: MarginfiAccountWrapper | undefined;
    private wSolBank: PublicKey | undefined;

    constructor() {
        super("Auto-Repay Bot");

        this.connection = new Connection(config.RPC_URL);
        this.initPromise = this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.initWallet();
        await this.initATAs();
        await this.initClients();
    }

    private async initWallet(): Promise<void> {
        if (!config.USE_AWS) {
            if (!config.WALLET_KEYPAIR) throw new Error("Wallet keypair is not set");
            this.wallet = new Wallet(Keypair.fromSecretKey(config.WALLET_KEYPAIR));
            return;
        }

        if (!config.AWS_REGION || !config.AWS_SECRET_NAME) throw new Error("AWS credentials are not set");

        const client = new SecretsManagerClient({ region: config.AWS_REGION });

        try {
            const response = await client.send(
                new GetSecretValueCommand({
                    SecretId: config.AWS_SECRET_NAME,
                    VersionStage: "AWSCURRENT",
                })
            );

            const secretString = response.SecretString;
            if (!secretString) throw new Error("Secret string is not set");

            const secret = JSON.parse(secretString);
            const secretArray = new Uint8Array(JSON.parse(secret.liquidatorSecret));

            this.wallet = new Wallet(Keypair.fromSecretKey(secretArray));
        } catch (error) {
            throw new Error(`Failed to get secret key from AWS: ${error}`);
        }
    }

    private async initATAs(): Promise<void> {
        if (!this.wallet) throw new Error("Wallet is not initialized");

        this.walletWSol = await getAssociatedTokenAddress(WSOL_MINT, this.wallet.publicKey);
        this.walletUsdc = await getAssociatedTokenAddress(USDC_MINT, this.wallet.publicKey);

        const oix_createUsdcATA = await createAtaIfNeeded(this.connection, this.walletUsdc, this.wallet.publicKey, USDC_MINT);
        if (oix_createUsdcATA.length === 0) return;

        const computeBudget = 200_000;
        const ix_priority = await createPriorityFeeInstructions(computeBudget);
        oix_createUsdcATA.unshift(...ix_priority);

        const latestBlockhash = await this.connection.getLatestBlockhash();
        const messageV0 = new TransactionMessage({
            payerKey: this.wallet.publicKey,
            recentBlockhash: latestBlockhash.blockhash,
            instructions: oix_createUsdcATA,
        }).compileToV0Message();
        const tx = new VersionedTransaction(messageV0);
        const signedTx = await this.wallet.signTransaction(tx);
        const signature = await this.connection.sendRawTransaction(signedTx.serialize());
        this.logger.info(`Created associated token accounts, signature: ${signature}`);
    }

    private async initClients(): Promise<void> {
        if (!this.wallet) throw new Error("Wallet is not initialized");

        // Quartz
        this.quartzClient = await QuartzClient.fetchClient(this.connection, this.wallet);

        // MarginFi
        const marginfiClient = await MarginfiClient.fetch(getMarginfiConfig(), this.wallet, this.connection);
        const wSolBank = marginfiClient.getBankByTokenSymbol(MARGINFI_FLASH_LOAN_TOKEN)?.address;
        if (!wSolBank) throw Error(`${MARGINFI_FLASH_LOAN_TOKEN} bank not found`);
        this.wSolBank = wSolBank;

        const marginfiAccounts = await marginfiClient.getMarginfiAccountsForAuthority(this.wallet.publicKey);
        if (marginfiAccounts.length === 0) {
            this.marginfiAccount = await marginfiClient.createMarginfiAccount();
        } else {
            this.marginfiAccount = marginfiAccounts[0];
        }
    }

    async start(): Promise<void> {
        await this.initPromise;
        if (!this.wallet || !this.quartzClient) throw new Error("Could not initialize correctly");
        this.logger.info(`Auto-Repay Bot initialized with address ${this.wallet.publicKey}`);
        
        setInterval(() => {
            this.logger.info(`Heartbeat | Bot address: ${this.wallet?.publicKey}`);
        }, 1000 * 60 * 60 * 24);

        while (true) {
            let owners: PublicKey[];
            let users: (QuartzUser | null)[];
            try {
                [owners, users] = await retryRPCWithBackoff(
                    async () => {
                        if (!this.quartzClient) throw new Error("Quartz client is not initialized");
                        const owners = await this.quartzClient.getAllQuartzAccountOwnerPubkeys();
                        const users = await this.quartzClient.getMultipleQuartzAccounts(owners);
                        return [owners, users];
                    },
                    3,
                    1_000,
                    this.logger
                );
            } catch (error) {
                this.logger.error(`[${this.wallet?.publicKey}] Error fetching users: ${error}`);
                continue;
            }
                
            for (let i = 0; i < owners.length; i++) {
                const user = users[i];
                try {
                    if (user === null) {
                        this.logger.warn(`[${this.wallet?.publicKey}] Failed to fetch Quartz user for ${owners[i].toBase58()}`);
                        continue;
                    }

                    if (user.getHealth() === 0) {
                        const repayAmount = user.getRepayAmountForTargetHealth(
                            GOAL_HEALTH, 
                            DRIFT_SOL_COLLATERAL_WEIGHT
                        );
                        this.attemptAutoRepay(user, repayAmount);
                    };
                } catch (error) {
                    this.logger.error(`[${this.wallet?.publicKey}] Error processing user: ${error}`);
                }
            }
            

            await new Promise(resolve => setTimeout(resolve, LOOP_DELAY));
        }
    }

    private async attemptAutoRepay(
        user: QuartzUser, 
        repayAmount: number
    ): Promise<void> {
        for (let retry = 0; retry < MAX_AUTO_REPAY_ATTEMPTS; retry++) {
            try {
                const signature = await this.executeAutoRepay(user, repayAmount);

                const latestBlockhash = await this.connection.getLatestBlockhash();
                await this.connection.confirmTransaction({ signature, ...latestBlockhash }, "confirmed");

                this.logger.info(`Executed auto-repay for ${user.pubkey.toBase58()}, signature: ${signature}`);
                return;
            } catch (error) {
                this.logger.warn(
                    `[${this.wallet?.publicKey}] Auto-repay transaction failed for ${user.pubkey.toBase58()}, retrying... Error: ${error}`
                );
            }
        }

        this.logger.error(`[${this.wallet?.publicKey}] Failed to execute auto-repay for ${user.pubkey.toBase58()}`);
    }

    private async executeAutoRepay (
        user: QuartzUser,
        repayAmount: number
    ): Promise<string> {
        if (!this.wallet || !this.walletWSol || !this.walletUsdc) throw new Error("AutoRepayBot is not initialized");

        // Fetch quote and balances
        const jupiterQuotePromise = getJupiterSwapQuote(WSOL_MINT, USDC_MINT, repayAmount, JUPITER_SLIPPAGE_BPS);
        const startingWSolBalancePromise = getTokenAccountBalance(this.connection, this.walletWSol);
        const startingLamportsBalancePromise = this.connection.getBalance(this.wallet.publicKey);

        const [
            startingLamportsBalance, 
            startingWSolBalance, 
            jupiterQuote
        ] = await Promise.all([startingLamportsBalancePromise, startingWSolBalancePromise, jupiterQuotePromise]);

        // Calculate balance amounts and wrap any wSOL needed
        const requiredSol = Math.round(
            Number(jupiterQuote.inAmount) * (1 + (JUPITER_SLIPPAGE_BPS / 10000))
        );
        const wrappableSol = Math.max(0, startingLamportsBalance - MIN_LAMPORTS_BALANCE);
        const lamportsToBorrow = Math.max(0, requiredSol - wrappableSol - startingWSolBalance);
        const lamportsToWrap = Math.max(0, requiredSol - lamportsToBorrow - startingWSolBalance);

        let oix_createWSolAta: TransactionInstruction[] = [];
        if (lamportsToBorrow <= 0) {
            oix_createWSolAta = await createAtaIfNeeded(this.connection, this.walletWSol, this.wallet.publicKey, WSOL_MINT);
        }

        const oix_wrapSol: TransactionInstruction[] = [];
        if (lamportsToWrap > 0) {
            oix_wrapSol.push(SystemProgram.transfer({
                fromPubkey: this.wallet.publicKey,
                toPubkey: this.walletWSol,
                lamports: lamportsToWrap
            }));
        }

        if (startingLamportsBalance < MIN_LAMPORTS_BALANCE) {
            this.logger.error(`[${this.wallet?.publicKey}] Low SOL balance, please add more funds`);
        }

        // Build instructions
        const startingBalance = startingWSolBalance + lamportsToWrap + lamportsToBorrow;
        const {ixs: ixs_autoRepay, lookupTables} = await user.makeCollateralRepayIxs(
            this.wallet.publicKey,
            this.walletUsdc,
            this.walletWSol,
            startingBalance,
            jupiterQuote
        )

        const tx = await this.buildAutoRepayTx(
            lamportsToBorrow,
            [...oix_createWSolAta, ...oix_wrapSol, ...ixs_autoRepay], 
            lookupTables
        );

        const signedTx = await this.wallet.signTransaction(tx);
        const signature = await this.connection.sendRawTransaction(signedTx.serialize());
        return signature;
    }

    private async buildAutoRepayTx(
        lamportsLoan: number,
        instructions: TransactionInstruction[],
        lookupTables: AddressLookupTableAccount[]
    ): Promise<VersionedTransaction> {
        if (!this.wallet || !this.walletWSol || !this.marginfiAccount || !this.wSolBank) {
            throw new Error("AutoRepayBot is not initialized");
        }

        if (lamportsLoan > 0) {
            const amountSolUi = new BigNumber(lamportsLoan).div(LAMPORTS_PER_SOL);
            const loop = await this.marginfiAccount.makeLoopTx(
                amountSolUi,
                amountSolUi,
                this.wSolBank,
                this.wSolBank,
                instructions,
                lookupTables,
                0.002,
                false
            );
            return loop.flashloanTx;
        }

        // If no loan required, build regular tx
        const computeBudget = 200_000;
        const ix_priority = await createPriorityFeeInstructions(computeBudget);
        instructions.unshift(...ix_priority);

        const latestBlockhash = await this.connection.getLatestBlockhash();
        const messageV0 = new TransactionMessage({
            payerKey: this.wallet.publicKey,
            recentBlockhash: latestBlockhash.blockhash,
            instructions: instructions,
        }).compileToV0Message();
        return new VersionedTransaction(messageV0);
    }
}
