import type { Logger } from 'pino';

export interface EmailMessage {
  /** Category, for logs and metrics. */
  kind: 'verify-email' | 'password-reset' | 'account-exists' | 'account-locked' | 'incident-opened' | 'incident-resolved';
  to: string;
  subject: string;
  text: string;
  /** A single-use link, kept separate so transports can decide whether to log it. */
  link?: string;
}

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Masks an address for logs: "jane.doe@example.com" -> "ja***@example.com". */
export function maskEmail(address: string): string {
  const [local = '', domain = ''] = address.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
}

/**
 * Writes emails to the log instead of delivering them. Used until the
 * Postmark account exists (G1 decision). Links are logged only when
 * EMAIL_LOG_LINKS=true, which is allowed only where there are no real users.
 */
export class LogEmailSender implements EmailSender {
  constructor(
    private readonly logger: Logger,
    private readonly includeLinks: boolean,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    this.logger.info(
      {
        email: {
          kind: message.kind,
          to: maskEmail(message.to),
          subject: message.subject,
          link: this.includeLinks ? message.link : undefined,
        },
      },
      'email not delivered (log transport)',
    );
  }
}

/** Test double: keeps sent messages in memory. */
export class InMemoryEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }

  lastTo(address: string): EmailMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to === address);
  }
}
