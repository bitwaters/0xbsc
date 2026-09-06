export class GmgnError extends Error {
  constructor(
    readonly kind: 'network' | 'timeout' | 'http' | 'schema' | 'rate_limit',
    message: string,
    readonly status?: number,
    readonly retryAtMs?: number
  ) {
    super(message);
  }
}
