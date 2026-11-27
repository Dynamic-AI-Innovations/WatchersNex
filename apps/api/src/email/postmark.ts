import type { EmailMessage, EmailSender } from './email.js';

/**
 * Delivers through Postmark's HTTPS API (G1 decision: transactional-only
 * provider; account email on the 'outbound' stream, alerts on their own
 * stream once the alerting module exists).
 */
export class PostmarkEmailSender implements EmailSender {
  constructor(
    private readonly serverToken: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const response = await this.fetchImpl('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': this.serverToken,
      },
      body: JSON.stringify({
        From: this.from,
        To: message.to,
        Subject: message.subject,
        TextBody: message.text,
        MessageStream: 'outbound',
        Tag: message.kind,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      // The body may echo the recipient; report the status only.
      throw new Error(`Postmark rejected the message (HTTP ${response.status})`);
    }
  }
}
