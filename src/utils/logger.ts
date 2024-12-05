import { Writable } from "node:stream";
import winston, { createLogger, type Logger, transports } from "winston";
import nodemailer from "nodemailer";
import config from "../config/config.js";

export class AppLogger {
    protected logger: Logger;

    constructor(name: string) {
        const consoleFormat = winston.format.combine(
            winston.format.colorize(),
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.printf(({ level, message, timestamp }) => {
                return `[${timestamp}] ${level}: ${message}`;
            })
        )

        const mailFormat = winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.json({ space: 2})
        )

        const mailTransporter = nodemailer.createTransport({
            host: config.EMAIL_HOST,
            port: config.EMAIL_PORT,
            secure: false,
            auth: {
                user: config.EMAIL_USER,
                pass: config.EMAIL_PASSWORD,
            },
        });

        const mailTransportInstance = new winston.transports.Stream({
            stream: new Writable({
                write: (message: string) => {
                    for (const admin of config.EMAIL_TO) {
                        mailTransporter.sendMail({
                            from: config.EMAIL_FROM,
                            to: admin,
                            subject: `${name} Error`,
                            text: message,
                        });
                    }
                    return true;
                }
            }),
            level: 'error',
            format: mailFormat,
        });

        this.logger = createLogger({
            level: 'info',
            transports: [
                new transports.Console({ format: consoleFormat }),
                mailTransportInstance
            ],
            exceptionHandlers: [
                new transports.Console({ format: consoleFormat }),
                mailTransportInstance
            ],
            rejectionHandlers: [
                new transports.Console({ format: consoleFormat }),
                mailTransportInstance
            ],
        });

        process.on("uncaughtException", (error) => {
            this.logger.error(error.message);
        });

        process.on("unhandledRejection", (reason) => {
            this.logger.error(reason);
        });
    }
}