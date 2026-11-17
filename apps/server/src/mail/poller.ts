import type { FastifyBaseLogger } from 'fastify';
import { ImapFlow } from 'imapflow';
import type { Config } from '../config.js';
import type { MailProcessor } from './processor.js';

/**
 * Watches the import mailbox: unread mails are processed, then marked as read (or moved to
 * IMAP_DONE_MAILBOX). With IDLE, new mail is picked up within seconds; the poll every
 * IMAP_POLL_MINUTES is the safety net. Connection problems only mean a retry later.
 */
export class MailPoller {
  private client: ImapFlow | null = null;
  private stopped = false;
  private running = false;
  private again = false;
  private timer: NodeJS.Timeout | undefined;
  private reconnectDelay = 10_000;

  constructor(
    private readonly config: Config,
    private readonly processor: MailProcessor,
    private readonly log: FastifyBaseLogger,
  ) {}

  static enabled(config: Config): boolean {
    return !!(config.IMAP_HOST && config.IMAP_USER && config.IMAP_PASSWORD);
  }

  start(): void {
    void this.connect();
    this.timer = setInterval(() => void this.run(), this.config.IMAP_POLL_MINUTES * 60_000);
    this.timer.unref();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new ImapFlow({
      host: this.config.IMAP_HOST!,
      port: this.config.IMAP_PORT,
      secure: this.config.IMAP_SECURE,
      auth: { user: this.config.IMAP_USER!, pass: this.config.IMAP_PASSWORD! },
      logger: false,
      disableAutoIdle: !this.config.IMAP_IDLE,
    });
    client.on('error', (err: Error) => this.log.warn({ err: err.message }, 'IMAP-Fehler'));
    client.on('close', () => {
      if (this.client === client) this.client = null;
      if (!this.stopped) setTimeout(() => void this.connect(), this.reconnectDelay).unref();
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15 * 60_000);
    });
    // New mail while idling.
    client.on('exists', () => void this.run());
    try {
      await client.connect();
      if (this.config.IMAP_DONE_MAILBOX) {
        // Create the done folder once; "already exists" is fine.
        await client.mailboxCreate(this.config.IMAP_DONE_MAILBOX).catch(() => undefined);
      }
      await client.mailboxOpen(this.config.IMAP_MAILBOX);
      this.client = client;
      this.reconnectDelay = 10_000;
      this.log.info({ mailbox: this.config.IMAP_MAILBOX }, 'Import-Postfach verbunden');
      await this.run();
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'Import-Postfach nicht erreichbar, neuer Versuch später');
      client.close();
    }
  }

  /** One pass over the unread mails; overlapping calls are folded into one more pass. */
  async run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    const client = this.client;
    if (!client) return;
    this.running = true;
    try {
      do {
        this.again = false;
        // With a done folder every mail in the folder is new (processed ones are moved away), even if a
        // mail client already marked it as read – the import folder may live in a personal mailbox.
        // Without one, read/unread is the only marker.
        const query = this.config.IMAP_DONE_MAILBOX ? { all: true } : { seen: false };
        const uids = (await client.search(query, { uid: true })) || [];
        for (const uid of uids) {
          try {
            const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
            if (msg && msg.source) await this.processor.process(msg.source);
            if (this.config.IMAP_DONE_MAILBOX) await client.messageMove(String(uid), this.config.IMAP_DONE_MAILBOX, { uid: true });
            else await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
          } catch (err) {
            this.log.warn({ err: (err as Error).message, uid }, 'Mail konnte nicht verarbeitet werden');
          }
        }
      } while (this.again && !this.stopped);
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'Abruf des Import-Postfachs fehlgeschlagen');
    } finally {
      this.running = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.client?.logout().catch(() => undefined);
  }
}
