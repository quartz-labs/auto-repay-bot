import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
    WALLET_KEYPAIR: z.string()
        .transform((str) => {
            try {
                const numbers = JSON.parse(str);
                if (!Array.isArray(numbers) || !numbers.every((n) => typeof n === 'number')) {
                    throw new Error();
                }
                return new Uint8Array(numbers);
            } catch (error) {
                throw new Error("Invalid keypair format: must be a JSON array of numbers");
            }
        })
        .refine((bytes) => bytes.length === 64, {message: "Keypair must be 64 bytes long"}),
    RPC_URL: z.string().url(),
    USE_AWS: z.string().transform((str) => str === "true"),
    AWS_SECRET_NAME: z.string(),
    AWS_REGION: z.string(),
    PORT: z.coerce.number().min(0),
    EMAIL_TO: z.string()
        .transform((str) => {
            try {
                const emails = str.split(',').map(email => email.trim());
                if (!emails.every(email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Error();
                return emails;
            } catch (error) {
                throw new Error("Invalid email list format: must be comma-separated email addresses");
            }
        }),
    EMAIL_FROM: z.string().email(),
    EMAIL_HOST: z.string(),
    EMAIL_PORT: z.coerce.number().min(0),
    EMAIL_USER: z.string().email(),
    EMAIL_PASSWORD: z.string(),
});

const config = envSchema.parse(process.env);
export default config;
