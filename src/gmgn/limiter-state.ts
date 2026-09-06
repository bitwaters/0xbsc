import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

export interface LimiterState {
  blockedUntilMs: number;
  nextDispatchAtMs: number;
  channelNextAtMs?: Record<string, number>;
}
/** Contains no credential. Atomic replacement preserves cooldown and pacing across restarts. */
export class LimiterStateFile {
  private readonly identity: string;
  constructor(
    private readonly path: string,
    baseUrl: string,
    apiKey: string
  ) {
    this.identity = createHash('sha256').update(`${baseUrl}\0${apiKey}`).digest('hex');
  }
  read(): LimiterState {
    if (!existsSync(this.path)) return { blockedUntilMs: 0, nextDispatchAtMs: 0 };
    const value = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, unknown>;
    if (value.identity !== this.identity) return { blockedUntilMs: 0, nextDispatchAtMs: 0 };
    if (
      typeof value.blockedUntilMs !== 'number' ||
      !Number.isFinite(value.blockedUntilMs) ||
      typeof value.nextDispatchAtMs !== 'number' ||
      !Number.isFinite(value.nextDispatchAtMs)
    )
      throw new Error('Invalid persisted GMGN limiter state');
    const channels = value.channelNextAtMs;
    if (
      channels !== undefined &&
      (!channels ||
        typeof channels !== 'object' ||
        Object.values(channels).some((time) => typeof time !== 'number' || !Number.isFinite(time)))
    )
      throw new Error('Invalid persisted GMGN endpoint limiter state');
    return {
      blockedUntilMs: value.blockedUntilMs,
      nextDispatchAtMs: value.nextDispatchAtMs,
      ...(channels ? { channelNextAtMs: channels as Record<string, number> } : {})
    };
  }
  save(value: LimiterState): void {
    writeFileSync(`${this.path}.tmp`, JSON.stringify({ identity: this.identity, ...value }), {
      mode: 0o600
    });
    renameSync(`${this.path}.tmp`, this.path);
  }
}
