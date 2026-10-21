// Telegram notifications for the server admin.

export interface AlertOptions {
  /** Bot token from @BotFather. */
  token?: string;
  /** Chat to post into (your user id, or a group/channel id). */
  chatId?: string;
  /** API base (tests point this at a fake server). */
  api?: string;
}

const QUIET_MS = 15 * 60_000;

export class Alerts {
  private last = new Map<string, number>();

  constructor(private readonly opts: AlertOptions) {}

  get configured(): boolean {
    return !!(this.opts.token && this.opts.chatId);
  }

  /**
   * Sends a message. Alerts with the same `key` are sent at most once per 15
   * minutes (pass `force` for messages that must always go out).
   */
  async send(key: string, text: string, force = false): Promise<boolean> {
    if (!this.configured) return false;
    const now = Date.now();
    if (!force && now - (this.last.get(key) ?? 0) < QUIET_MS) return false;
    this.last.set(key, now);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`${this.opts.api ?? 'https://api.telegram.org'}/bot${this.opts.token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: this.opts.chatId, text: `Planar · ${text}`, disable_web_page_preview: true }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return true;
        // Never log the URL: it contains the token.
        console.error(`[planar] telegram alert failed: HTTP ${res.status}`);
        if (res.status < 500 && res.status !== 429) return false;
      } catch (e) {
        console.error(`[planar] telegram alert failed: ${(e as Error).name}`);
      }
      await new Promise((r) => setTimeout(r, attempt ? 0 : 3000));
    }
    return false;
  }
}
