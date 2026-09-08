export class GmgnError extends Error {
  constructor(
    readonly kind: 'network' | 'queue_timeout' | 'timeout' | 'http' | 'schema' | 'rate_limit',
    message: string,
    readonly status?: number,
    readonly retryAtMs?: number
  ) {
    super(message);
  }
}
