/**
 * Magic-link email, delivered through SMTP (Mailpit locally, 05 §8).
 *
 * The transport comes from `SMTP_URL`, so pointing staging at a real provider
 * is configuration, not code. No audio, lyrics or prompts ever appear in an
 * email (13 §3).
 */
import { createTransport, type Transporter } from "nodemailer";

import type { Config } from "../config.js";

export interface Mailer {
  send(message: { to: string; subject: string; text: string; html?: string }): Promise<void>;
  close(): void;
}

/** Creates the SMTP mailer described by the configuration. */
export function createMailer(config: Config): Mailer {
  const transport: Transporter = createTransport(config.smtpUrl);
  return {
    async send(message) {
      await transport.sendMail({
        from: config.mailFrom,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html === undefined ? {} : { html: message.html }),
      });
    },
    close() {
      transport.close();
    },
  };
}
