import { Connection, Keypair, type PublicKey, SystemProgram, type TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { AddressLookupTableAccount } from "@solana/web3.js";
import { getConfig as getMarginfiConfig, type MarginfiAccountWrapper, MarginfiClient } from "@mrgnlabs/marginfi-client-v2";
import { createSyncNativeInstruction, getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { MAX_AUTO_REPAY_ATTEMPTS, LOOP_DELAY, JUPITER_SLIPPAGE_BPS, MIN_LAMPORTS_BALANCE, GOAL_HEALTH } from "./config/constants.js";
import { retryRPCWithBackoff, getTokenAccountBalance, getJupiterSwapQuote, getPrices, getSortedPositions, fetchExactInParams, fetchExactOutParams, getComputeUnitPriceIx, getComputerUnitLimitIx } from "./utils/helpers.js";
import config from "./config/config.js";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { MarketIndex, getTokenProgram, QuartzClient, type QuartzUser, TOKENS, makeCreateAtaIxIfNeeded, WSOL_MINT, baseUnitToDecimal, type BN } from "@quartz-labs/sdk";
import { NodeWallet } from "@mrgnlabs/mrgn-common";
import type { SwapMode } from "@jup-ag/api";
import type { Position } from "./types/Position.interface.js";
import { AppLogger } from "@quartz-labs/logger";

export class AutoRepayBot extends AppLogger {
    private initPromise: Promise<void>;

    private connection: Connection;
    private wallet: Keypair | undefined;
    private splWallets = {} as Record<MarketIndex, PublicKey>;

    private quartzClient: QuartzClient | undefined;
    private marginfiClient: MarginfiClient | undefined;
    private marginfiAccount: MarginfiAccountWrapper | undefined;

    constructor() {
        super({
            name: "Auto-Repay Bot",
            dailyErrorCacheTimeMs: 1000 * 60 * 60 // 1 hour
        });

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
            this.wallet = Keypair.fromSecretKey(config.WALLET_KEYPAIR);
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

            this.wallet = Keypair.fromSecretKey(secretArray);
        } catch (error) {
            throw new Error(`Failed to get secret key from AWS: ${error}`);
        }
    }

    private async initATAs(): Promise<void> {
        if (!this.wallet) throw new Error("Wallet is not initialized");

        const oix_createATAs = [];
        for (const [marketIndex, token] of Object.entries(TOKENS)) {
            const tokenProgram = await getTokenProgram(this.connection, token.mint);
            const ata = await getAssociatedTokenAddress(token.mint, this.wallet.publicKey, false, tokenProgram);

            const oix_createAta = await makeCreateAtaIxIfNeeded(this.connection, ata, this.wallet.publicKey, token.mint, tokenProgram);
            if (oix_createAta.length > 0) oix_createATAs.push(...oix_createAta);

            this.splWallets[Number(marketIndex) as MarketIndex] = ata;
        }
        if (oix_createATAs.length === 0) return;

        const blockhash = (await this.connection.getLatestBlockhash()).blockhash;
        const ix_computeLimit = await getComputerUnitLimitIx(
            this.connection, 
            oix_createATAs, 
            this.wallet.publicKey, 
            blockhash
        );
        const ix_computePrice = await getComputeUnitPriceIx();
        oix_createATAs.unshift(ix_computeLimit, ix_computePrice);

        const latestBlockhash = await this.connection.getLatestBlockhash();
        const messageV0 = new TransactionMessage({
            payerKey: this.wallet.publicKey,
            recentBlockhash: latestBlockhash.blockhash,
            instructions: oix_createATAs,
        }).compileToV0Message();
        const transaction = new VersionedTransaction(messageV0);

        transaction.sign([this.wallet]);
        const signature = await this.connection.sendRawTransaction(transaction.serialize());
        await this.connection.confirmTransaction({ signature, ...latestBlockhash }, "confirmed");
        this.logger.info(`Created associated token accounts, signature: ${signature}`);
    }

    private async initClients(): Promise<void> {
        if (!this.wallet) throw new Error("Wallet is not initialized");

        this.quartzClient = await QuartzClient.fetchClient(this.connection);

        this.marginfiClient = await MarginfiClient.fetch(getMarginfiConfig(), new NodeWallet(this.wallet), this.connection);
        const marginfiAccounts = await this.marginfiClient.getMarginfiAccountsForAuthority(this.wallet.publicKey);
        if (marginfiAccounts.length === 0) {
            this.marginfiAccount = await this.marginfiClient.createMarginfiAccount();
        } else {
            this.marginfiAccount = marginfiAccounts[0];
        }
    }

    async start(): Promise<void> {
        await this.initPromise;
        if (!this.wallet || !this.quartzClient) throw new Error("Could not initialize correctly");
        this.logger.info(`Auto-Repay Bot initialized with address ${this.wallet.publicKey}`);

        // const user = await this.quartzClient.getQuartzAccount(this.wallet.publicKey);
        // const balances = await user.getMultipleTokenBalances([...MarketIndex]);
        // const prices = await getPrices();
        // const {
        //     collateralPositions,
        //     loanPositions
        // } = await getSortedPositions(balances, prices);

        // const { 
        //     swapAmountBaseUnits, 
        //     marketIndexLoan,
        //     marketIndexCollateral,
        //     swapMode
        // } = await this.fetchAutoRepayParams(
        //     user,
        //     loanPositions,
        //     collateralPositions,
        //     prices,
        //     balances
        // );

        // this.attemptAutoRepay(user, swapAmountBaseUnits, marketIndexLoan, marketIndexCollateral, swapMode);

        // return;

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
                    if (user === null || user === undefined) {
                        // this.logger.warn(`[${this.wallet?.publicKey}] Failed to fetch Quartz user for ${owners[i]?.toBase58()}`);
                        continue;
                    }

                    if (user.getHealth() === 0) {
                        const balances = await user.getMultipleTokenBalances([...MarketIndex]);
                        const prices = await getPrices();
                        const {
                            collateralPositions,
                            loanPositions
                        } = await getSortedPositions(balances, prices);

                        if (loanPositions.length === 0) {
                            throw new Error("No loan positions found");
                        }
                        if (loanPositions[0]?.value ?? 0 < 0.01) {
                            continue; // Ignore cases where largest loan's value is less than $0.01
                        }

                        const { 
                            swapAmountBaseUnits, 
                            marketIndexLoan,
                            marketIndexCollateral,
                            swapMode
                        } = await this.fetchAutoRepayParams(
                            user,
                            loanPositions,
                            collateralPositions,
                            prices,
                            balances
                        );

                        this.attemptAutoRepay(user, swapAmountBaseUnits, marketIndexLoan, marketIndexCollateral, swapMode);
                    };
                } catch (error) {
                    this.logger.error(`[${this.wallet?.publicKey}] Error processing user: ${error}`);
                }
            }
            
            await new Promise(resolve => setTimeout(resolve, LOOP_DELAY));
        }
    }

    private async fetchAutoRepayParams(
        user: QuartzUser,
        loanPositions: Position[],
        collateralPositions: Position[],
        prices: Record<MarketIndex, number>,
        balances: Record<MarketIndex, BN>
    ): Promise<{
        swapAmountBaseUnits: number,
        marketIndexLoan: MarketIndex,
        marketIndexCollateral: MarketIndex,
        swapMode: SwapMode
    }> {
        // Try each token pair for a Jupiter quote, from largest to smallest values
        for (const loanPosition of loanPositions) {
            for (const collateralPosition of collateralPositions) {
                if (loanPosition.marketIndex === collateralPosition.marketIndex) {
                    continue;
                }

                const marketIndexLoan = loanPosition.marketIndex;
                const marketIndexCollateral = collateralPosition.marketIndex;

                const loanRepayValue = user.getRepayAmountForTargetHealth(
                    GOAL_HEALTH, 
                    TOKENS[marketIndexCollateral].driftCollateralWeight.toNumber()
                );

                console.log(user.getHealth(), GOAL_HEALTH, TOKENS[marketIndexCollateral].driftCollateralWeight.toNumber(), loanRepayValue);

                try {
                    return await fetchExactOutParams(
                        marketIndexCollateral, 
                        marketIndexLoan,
                        loanRepayValue, 
                        prices[marketIndexLoan], 
                        prices[marketIndexCollateral],
                        balances[marketIndexCollateral].toNumber()
                    );
                } catch {
                    try {
                        return await fetchExactInParams(
                            marketIndexCollateral, 
                            marketIndexLoan,
                            loanRepayValue, 
                            prices[marketIndexCollateral], 
                            balances[marketIndexCollateral].toNumber()
                        );
                    } catch { } // Ignore error until no routes are found
                }
            }
        }

        throw new Error("No valid Jupiter quote found");
    }

    private async attemptAutoRepay(
        user: QuartzUser, 
        swapAmount: number,
        marketIndexLoan: MarketIndex,
        marketIndexCollateral: MarketIndex,
        swapMode: SwapMode
    ): Promise<void> {
        let lastError: Error | null = null;
        for (let retry = 0; retry < MAX_AUTO_REPAY_ATTEMPTS; retry++) {
            try {
                const signature = await this.executeAutoRepay(
                    user, 
                    swapAmount, 
                    marketIndexLoan, 
                    marketIndexCollateral,
                    swapMode
                );

                const latestBlockhash = await this.connection.getLatestBlockhash();
                await this.connection.confirmTransaction({ signature, ...latestBlockhash }, "confirmed");

                this.logger.info(`Executed auto-repay for ${user.pubkey.toBase58()}, signature: ${signature}`);
                return;
            } catch (error) {
                lastError = error as Error;
                this.logger.warn(
                    `[${this.wallet?.publicKey}] Auto-repay transaction failed for ${user.pubkey.toBase58()}, retrying...`
                );
                
                const delay = 2_000 * (retry + 1);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        console.log(lastError);

        try {
            const refreshedUser = await this.quartzClient?.getQuartzAccount(user.pubkey);
            const refreshedHealth = refreshedUser?.getHealth();
            if (refreshedHealth === undefined || refreshedHealth === 0) throw lastError;
        } catch (error) {
            this.logger.error(`[${this.wallet?.publicKey}] Failed to execute auto-repay for ${user.pubkey.toBase58()}. Error: ${error}`);
        }
    }

    private async executeAutoRepay (
        user: QuartzUser,
        swapAmount: number,
        marketIndexLoan: MarketIndex,
        marketIndexCollateral: MarketIndex,
        swapMode: SwapMode
    ): Promise<string> {
        if (!this.wallet || !this.splWallets[marketIndexLoan] || !this.splWallets[marketIndexCollateral]) {
            throw new Error("AutoRepayBot is not initialized");
        }

        // Fetch quote and balances
        const jupiterQuotePromise = getJupiterSwapQuote(
            swapMode,
            TOKENS[marketIndexCollateral].mint, 
            TOKENS[marketIndexLoan].mint, 
            swapAmount, 
            JUPITER_SLIPPAGE_BPS
        );
        const startingCollateralBalancePromise = getTokenAccountBalance(this.connection, this.splWallets[marketIndexCollateral]);
        const startingLamportsBalancePromise = this.connection.getBalance(this.wallet.publicKey);

        const [
            startingLamportsBalance, 
            startingCollateralBalance, 
            jupiterQuote
        ] = await Promise.all([startingLamportsBalancePromise, startingCollateralBalancePromise, jupiterQuotePromise]);

        // Calculate balance amounts
        const requiredCollateralForRepay = Math.ceil(
            Number(jupiterQuote.inAmount) * (1 + (JUPITER_SLIPPAGE_BPS / 10000))
        );
        const amountExtraCollateralRequired = Math.max(0, requiredCollateralForRepay - startingCollateralBalance);

        // Wrap any SOL if needed
        let lamportsToWrap = 0;
        let oix_createWSolAta: TransactionInstruction[] = [];
        const oix_wrapSol: TransactionInstruction[] = [];
        if (TOKENS[marketIndexLoan].mint === WSOL_MINT) {
            oix_createWSolAta = await makeCreateAtaIxIfNeeded(
                this.connection, 
                this.splWallets[marketIndexLoan], 
                this.wallet.publicKey, 
                TOKENS[marketIndexLoan].mint, 
                TOKEN_PROGRAM_ID
            );
        } else if (TOKENS[marketIndexCollateral].mint === WSOL_MINT) {
            const wrappableLamports = Math.max(0, startingLamportsBalance - MIN_LAMPORTS_BALANCE);
            lamportsToWrap = Math.min(amountExtraCollateralRequired, wrappableLamports);

            oix_createWSolAta = await makeCreateAtaIxIfNeeded(
                this.connection, 
                this.splWallets[marketIndexCollateral], 
                this.wallet.publicKey, 
                TOKENS[marketIndexCollateral].mint, 
                TOKEN_PROGRAM_ID
            );
        }

        if (oix_createWSolAta.length > 0 && lamportsToWrap > 0) {
            oix_wrapSol.push(
                SystemProgram.transfer({
                    fromPubkey: this.wallet.publicKey,
                    toPubkey: this.splWallets[marketIndexCollateral],
                    lamports: lamportsToWrap
                }),
                createSyncNativeInstruction(this.splWallets[marketIndexCollateral])
            );
        }

        // Warning to keep gas funds balance
        if (startingLamportsBalance < MIN_LAMPORTS_BALANCE) {
            this.logger.error(`[${this.wallet?.publicKey}] Low SOL balance, please add more funds`);
        }

        // Build instructions
        const collateralToBorrow = Math.max(0, amountExtraCollateralRequired - lamportsToWrap);
        const {ixs: ixs_autoRepay, lookupTables} = await user.makeCollateralRepayIxs(
            this.wallet.publicKey,
            marketIndexLoan,
            marketIndexCollateral,
            jupiterQuote
        )

        const instructions = [...oix_createWSolAta, ...oix_wrapSol, ...ixs_autoRepay];
        const transaction = await this.buildAutoRepayTx(
            collateralToBorrow,
            marketIndexCollateral,
            instructions, 
            lookupTables
        );

        transaction.sign([this.wallet]);
        const signature = await this.connection.sendRawTransaction(transaction.serialize());
        return signature;
    }

    private async buildAutoRepayTx(
        collateralToBorrow: number,
        marketIndexCollateral: MarketIndex,
        instructions: TransactionInstruction[],
        lookupTables: AddressLookupTableAccount[]
    ): Promise<VersionedTransaction> {
        if (!this.wallet || !this.marginfiAccount || !this.marginfiClient) {
            throw new Error("AutoRepayBot is not initialized");
        }

        if (collateralToBorrow > 0) {
            const amountCollateralDecimal = baseUnitToDecimal(collateralToBorrow, marketIndexCollateral);
            const collateralBank = await this.marginfiClient.getBankByMint(TOKENS[marketIndexCollateral].mint);
            if (!collateralBank) throw new Error("Collateral bank for flash loan not found");

            const ix_computePrice = await getComputeUnitPriceIx();
            const { instructions: ix_borrow } = await this.marginfiAccount.makeBorrowIx(amountCollateralDecimal, collateralBank.address, {
                createAtas: false,
                wrapAndUnwrapSol: false
            });
            const { instructions: ix_deposit } = await this.marginfiAccount.makeDepositIx(amountCollateralDecimal, collateralBank.address, {
                wrapAndUnwrapSol: false
            });

            const flashloanTx = await this.marginfiAccount.buildFlashLoanTx({
                ixs: [
                    ix_computePrice, 
                    ...ix_borrow, 
                    ...instructions, 
                    ...ix_deposit
                ],
                addressLookupTableAccounts: lookupTables
            });

            return flashloanTx;
        }

        // If no loan required, build regular tx
        const blockhash = (await this.connection.getLatestBlockhash()).blockhash;
        const ix_computeLimit = await getComputerUnitLimitIx(
            this.connection, 
            instructions, 
            this.wallet.publicKey, 
            blockhash,
            lookupTables 
        );
        const ix_computePrice = await getComputeUnitPriceIx();
        instructions.unshift(ix_computeLimit, ix_computePrice);

        const latestBlockhash = await this.connection.getLatestBlockhash();
        const messageV0 = new TransactionMessage({
            payerKey: this.wallet.publicKey,
            recentBlockhash: latestBlockhash.blockhash,
            instructions: instructions
        }).compileToV0Message(lookupTables);
        return new VersionedTransaction(messageV0);
    }
}
