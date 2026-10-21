import type { Db } from './db';

/** One point of the per-minute history. */
export interface Snapshot {
  t: number;
  online: number;
  ops: number;
  requests: number;
  errors: number;
  rss: number;
}

/** Totals for one day (UTC date), kept for 60 days. */
export interface DayStats {
  day: string;
  registrations: number;
  active: number;
  edits: number;
  requests: number;
  errors: number;
}

export interface LogEvent {
  t: number;
  kind: 'info' | 'warn' | 'error' | 'admin' | 'signup';
  text: string;
}

const HISTORY = 24 * 60;
const DAYS = 60;
const EVENTS = 200;

const today = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

/**
 * Counters, a 24-hour per-minute history and daily totals.
 * Daily totals live in the database (stats.json) so they survive restarts.
 */
export class Metrics {
  /** Since the server started. */
  counters: Record<string, number> = {};
  series: Snapshot[] = [];
  events: LogEvent[] = [];
  readonly started = Date.now();
  private minute = { ops: 0, requests: 0, errors: 0, failedLogins: 0 };
  /** Failed sign-ins in each of the last five minutes. */
  private failedWindow: number[] = [];
  private activeToday = new Set<string>();

  constructor(private readonly db: Db) {
    const stored = db.stats as { days?: DayStats[]; active?: { day: string; ids: string[] } };
    if (stored.active?.day === today()) this.activeToday = new Set(stored.active.ids);
  }

  inc(name: string, n = 1): void {
    this.counters[name] = (this.counters[name] ?? 0) + n;
  }

  private day(): DayStats {
    const stats = this.db.stats as { days?: DayStats[] };
    const days = (stats.days ??= []);
    const d = today();
    let last = days[days.length - 1];
    if (!last || last.day !== d) {
      last = { day: d, registrations: 0, active: 0, edits: 0, requests: 0, errors: 0 };
      days.push(last);
      if (days.length > DAYS) days.splice(0, days.length - DAYS);
      this.activeToday.clear();
    }
    return last;
  }

  private bump(field: 'registrations' | 'edits' | 'requests' | 'errors', n = 1): void {
    this.day()[field] += n;
    this.db.touch('stats');
  }

  get days(): DayStats[] {
    this.day();
    return (this.db.stats as { days: DayStats[] }).days;
  }

  request(group: string, status: number): void {
    const cls = status >= 500 ? '5xx' : status >= 400 ? '4xx' : '2xx';
    this.inc(`http_${group}_${cls}`);
    this.minute.requests++;
    if (status >= 500) {
      this.minute.errors++;
      this.bump('errors');
    }
    this.bump('requests');
  }

  ops(count: number): void {
    this.inc('op_batches');
    this.inc('ops', count);
    this.minute.ops += count;
    this.bump('edits');
  }

  registration(): void {
    this.inc('registrations');
    this.bump('registrations');
  }

  failedLogin(): void {
    this.inc('logins_failed');
    this.minute.failedLogins++;
  }

  /** Someone did something today (counted once per user per day). */
  active(userId: string): void {
    const d = this.day();
    if (this.activeToday.has(userId)) return;
    this.activeToday.add(userId);
    d.active = this.activeToday.size;
    (this.db.stats as Record<string, unknown>).active = { day: d.day, ids: [...this.activeToday] };
    this.db.touch('stats');
  }

  event(kind: LogEvent['kind'], text: string): void {
    this.events.push({ t: Date.now(), kind, text });
    if (this.events.length > EVENTS) this.events.shift();
    if (kind === 'admin' || kind === 'error' || kind === 'warn') console.log(`[planar] ${kind}: ${text}`);
  }

  /** Closes the current minute. Returns its totals for alert checks. */
  tick(online: number): Snapshot & { failedLogins5m: number } {
    const point: Snapshot = {
      t: Date.now(),
      online,
      ops: this.minute.ops,
      requests: this.minute.requests,
      errors: this.minute.errors,
      rss: process.memoryUsage().rss,
    };
    this.series.push(point);
    if (this.series.length > HISTORY) this.series.shift();
    this.failedWindow.push(this.minute.failedLogins);
    if (this.failedWindow.length > 5) this.failedWindow.shift();
    this.minute = { ops: 0, requests: 0, errors: 0, failedLogins: 0 };
    return { ...point, failedLogins5m: this.failedWindow.reduce((a, b) => a + b, 0) };
  }
}
