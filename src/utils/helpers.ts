import { type Connection, ComputeBudgetProgram, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import type { Logger } from "winston";
import { createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import type { QuoteResponse } from "@jup-ag/api";

export async function getJupiterSwapQuote(
    inputMint: PublicKey, 
    outputMint: PublicKey, 
    amount: number,
    slippageBps: number
) {
    const quoteEndpoint = 
        `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint.toBase58()}&outputMint=${outputMint.toBase58()}&amount=${amount}&slippageBps=${slippageBps}&swapMode=ExactOut&onlyDirectRoutes=true`;
    const quoteResponse = await (await fetch(quoteEndpoint)).json() as QuoteResponse;
    return quoteResponse;
}

export const retryRPCWithBackoff = async <T>(
    fn: () => Promise<T>,
    retries: number,
    initialDelay: number,
    logger?: Logger
): Promise<T> => {
    let lastError = new Error("Unknown error");
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (error instanceof Error) {
                if (error.message.includes('503')) {
                    const delay = initialDelay * (2 ** i);
                    if (logger) logger.warn(`RPC node unavailable, retrying in ${delay}ms...`);
                    
                    await new Promise(resolve => setTimeout(resolve, delay));
                    lastError = error;
                    continue;
                }
                throw error;
            }
            lastError = new Error(String(error));
        }
    }
    throw lastError;
}

export const createPriorityFeeInstructions = async (computeBudget: number) => {
    const computeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: computeBudget,
    });
    const computePriceIx = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: await 1_000_000 // TODO: Implement fetching priority fee
    });
    return [computeLimitIx, computePriceIx];
}

export async function createAtaIfNeeded(
    connection: Connection,
    ata: PublicKey,
    authority: PublicKey,
    mint: PublicKey
) {
    const oix_createAta: TransactionInstruction[] = [];
    const ataInfo = await connection.getAccountInfo(ata);
    if (ataInfo === null) {
        oix_createAta.push(
            createAssociatedTokenAccountInstruction(
                authority,
                ata,
                authority,
                mint
            )
        );
    }
    return oix_createAta;
}

export async function getTokenAccountBalance(connection: Connection, tokenAccount: PublicKey) {
    try {
        const balance = await connection.getTokenAccountBalance(tokenAccount);
        return Number(balance.value.amount);
    } catch {
        return 0;
    }
}
