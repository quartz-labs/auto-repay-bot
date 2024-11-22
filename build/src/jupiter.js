var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import { AddressLookupTableAccount, PublicKey, TransactionInstruction } from "@solana/web3.js";
export function getJupiterSwapQuote(inputMint, outputMint, amount) {
    return __awaiter(this, void 0, void 0, function* () {
        const quoteEndpoint = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint.toBase58()}&outputMint=${outputMint.toBase58()}&amount=${amount}&slippageBps=50&swapMode=ExactOut&onlyDirectRoutes=true`;
        const quoteResponse = yield (yield fetch(quoteEndpoint)).json();
        return quoteResponse;
    });
}
export function getJupiterSwapIx(walletPubkey, connection, quoteResponse) {
    return __awaiter(this, void 0, void 0, function* () {
        const instructions = yield (yield fetch('https://quote-api.jup.ag/v6/swap-instructions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                quoteResponse,
                userPublicKey: walletPubkey.toBase58(),
                useCompression: true,
            })
        })).json();
        if (instructions.error) {
            throw new Error("Failed to get swap instructions: " + instructions.error);
        }
        const { swapInstruction, addressLookupTableAddresses } = instructions;
        const getAddressLookupTableAccounts = (keys) => __awaiter(this, void 0, void 0, function* () {
            const addressLookupTableAccountInfos = yield connection.getMultipleAccountsInfo(keys.map((key) => new PublicKey(key)));
            return addressLookupTableAccountInfos.reduce((acc, accountInfo, index) => {
                const addressLookupTableAddress = keys[index];
                if (accountInfo) {
                    const addressLookupTableAccount = new AddressLookupTableAccount({
                        key: new PublicKey(addressLookupTableAddress),
                        state: AddressLookupTableAccount.deserialize(accountInfo.data),
                    });
                    acc.push(addressLookupTableAccount);
                }
                return acc;
            }, new Array());
        });
        const addressLookupTableAccounts = [];
        addressLookupTableAccounts.push(...(yield getAddressLookupTableAccounts(addressLookupTableAddresses)));
        const ix_jupiterSwap = new TransactionInstruction({
            programId: new PublicKey(swapInstruction.programId),
            keys: swapInstruction.accounts.map((key) => ({
                pubkey: new PublicKey(key.pubkey),
                isSigner: key.isSigner,
                isWritable: key.isWritable,
            })),
            data: Buffer.from(swapInstruction.data, "base64"),
        });
        return {
            ix_jupiterSwap,
            jupiterLookupTables: addressLookupTableAccounts,
        };
    });
}
