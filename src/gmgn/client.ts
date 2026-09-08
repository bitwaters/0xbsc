import { Agent, type RequestOptions, request } from 'node:https';
import { URL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { GmgnError } from './errors.js';
export { GmgnError } from './errors.js';
import type { Admission, GmgnScheduler } from './scheduler.js';
import { gmgnContext } from './context.js';
import { apiMetricEndpoint } from '../observability/metrics.js';
import { createMarketFact, type MarketFact, type RequestPurpose } from './facts.js';

const facts = new WeakMap<object, MarketFact>();
export function responseFact(value: unknown): MarketFact | undefined {
  return value !== null && typeof value === 'object' ? facts.get(value) : undefined;
}

export interface HttpResponse<T> {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: T;
}
const timings = new WeakMap<object, { requestedAtMs: number; completedAtMs: number }>();
export function responseTiming(
  value: unknown
): { requestedAtMs: number; completedAtMs: number } | undefined {
  return value !== null && typeof value === 'object' ? timings.get(value) : undefined;
}
export interface RequestInput {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  timeoutMs?: number;
  absoluteTimeoutMs?: number;
}
export type HttpTransport = (
  input: RequestInput,
  headers: Record<string, string>
) => Promise<HttpResponse<unknown>>;

export interface ApiObservation {
  input: RequestInput;
  occurredAtMs: number;
  latencyMs: number;
  status: number | null;
  kind: 'success' | 'rate_limit' | 'retry' | 'timeout' | 'error';
  retryCount: number;
  detail?: string;
  attempt?: {
    id: string;
    startedAtMs: number;
    queuedAtMs: number;
    weight: number;
    priority: string;
    availableWeight: number | null;
    inFlight: number | null;
    correlationId: string | null;
    purpose?: RequestPurpose;
    research?: boolean;
    rateLimit: RateLimitInfo | null;
  };
}

export function gmgnRetryDeadline(error: unknown, nowMs: number, fallbackDelayMs = 30_000): number {
  if (
    error instanceof GmgnError &&
    error.kind === 'rate_limit' &&
    error.retryAtMs !== undefined &&
    Number.isFinite(error.retryAtMs)
  )
    return Math.max(nowMs + 1_000, error.retryAtMs + 250);
  return nowMs + fallbackDelayMs;
}

export class GmgnClient {
  readonly #observedPools = new Map<string, string>();
  #cooldownUntilMs = 0;
  readonly #transport: HttpTransport;

  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      timeoutMs?: number;
      now?: () => number;
      transport?: HttpTransport;
      scheduler?: GmgnScheduler;
      weights?: Record<string, number>;
      missingResetDelayMs?: number;
      onObservation?: (observation: ApiObservation) => void;
      onFact?: (fact: MarketFact) => void;
      onFactError?: () => void;
    }
  ) {
    if (!options.transport && !options.scheduler)
      throw new Error('Live GMGN transport requires the shared scheduler');
    this.#transport = options.transport ?? nodeHttpsTransport(options.baseUrl);
  }

  get cooldownUntilMs(): number {
    return Math.max(this.#cooldownUntilMs, this.options.scheduler?.cooldownUntilMs ?? 0);
  }

  async read<T>(input: RequestInput): Promise<T> {
    const context = gmgnContext();
    const deadlineMs = context.deadlineMs ?? (this.options.now?.() ?? Date.now()) + 30_000;
    try {
      return await this.attempt<T>(input, 0, true, deadlineMs);
    } catch (error) {
      if (
        error instanceof GmgnError &&
        error.kind === 'network' &&
        !(context.research || context.purpose === 'shadow_execution')
      )
        return this.attempt<T>(input, 1, false, deadlineMs);
      throw error;
    }
  }

  async write<T>(input: RequestInput): Promise<T> {
    return this.attempt<T>(
      input,
      0,
      false,
      gmgnContext().deadlineMs ?? (this.options.now?.() ?? Date.now()) + 30_000
    );
  }

  private attempt<T>(
    input: RequestInput,
    retryCount: number,
    retryEligible: boolean,
    deadlineMs: number
  ): Promise<T> {
    const now = this.options.now?.() ?? Date.now();
    if (now < this.cooldownUntilMs)
      return Promise.reject(
        new GmgnError('rate_limit', 'GMGN client is cooling down', 429, this.cooldownUntilMs)
      );
    const context = gmgnContext();
    const endpoint = apiMetricEndpoint(input.path);
    const research = context.research === true || context.purpose === 'shadow_execution';
    if (research)
      input = {
        ...input,
        timeoutMs: Math.min(input.timeoutMs ?? 2000, 2000),
        absoluteTimeoutMs: 2000
      };
    if (!this.options.scheduler)
      return this.perform(
        input,
        retryCount,
        retryEligible,
        undefined,
        context.correlationId,
        context.purpose,
        research,
        deadlineMs
      );
    const weight = this.options.weights?.[endpoint];
    if (!weight || !Number.isFinite(weight))
      return Promise.reject(new Error(`missing configured GMGN weight: ${endpoint}`));
    return this.options.scheduler.schedule({
      research,
      weight,
      priority: context.priority ?? 'candidate',
      deadlineMs,
      ...(endpoint === 'quote' ? { channel: 'quote' } : {}),
      run: (admission) =>
        this.perform<T>(
          input,
          retryCount,
          retryEligible,
          admission,
          context.correlationId,
          context.purpose,
          research,
          deadlineMs
        )
    });
  }

  private async perform<T>(
    input: RequestInput,
    retryCount: number,
    retryEligible: boolean,
    admission?: Admission,
    correlationId?: string,
    purpose: RequestPurpose = 'legacy_formal',
    research = false,
    deadlineMs = (this.options.now?.() ?? Date.now()) + 30000
  ): Promise<T> {
    const startedAtMs = this.options.now?.() ?? Date.now();
    if (startedAtMs >= deadlineMs)
      throw new GmgnError('queue_timeout', 'task deadline expired in request queue');
    input = {
      ...input,
      absoluteTimeoutMs: Math.min(input.absoluteTimeoutMs ?? 30000, deadlineMs - startedAtMs)
    };
    const token = typeof input.query?.address === 'string' ? input.query.address.toLowerCase() : '';
    // Bind ancillary responses to the pool known when the physical request starts.
    // A later Info response cannot relabel an older request across a migration.
    const poolRevision = this.#observedPools.get(token);
    const attemptId = randomUUID();
    let rateLimit: RateLimitInfo | null = null;
    const observe = (status: number | null, kind: ApiObservation['kind'], detail?: string) =>
      this.options.onObservation?.({
        input,
        occurredAtMs: this.options.now?.() ?? Date.now(),
        latencyMs: (this.options.now?.() ?? Date.now()) - startedAtMs,
        status,
        kind,
        retryCount,
        attempt: {
          id: attemptId,
          startedAtMs,
          queuedAtMs: admission?.queuedAtMs ?? startedAtMs,
          weight: admission?.weight ?? this.options.weights?.[apiMetricEndpoint(input.path)] ?? 0,
          priority: admission?.priority ?? 'unmanaged_test',
          availableWeight: admission?.availableWeight ?? null,
          inFlight: admission?.inFlight ?? null,
          correlationId: correlationId ?? null,
          purpose,
          research,
          rateLimit
        },
        ...(detail === undefined ? {} : { detail })
      });
    let response: HttpResponse<unknown>;
    try {
      response = await this.#transport(
        {
          ...input,
          timeoutMs: input.timeoutMs ?? this.options.timeoutMs ?? 8000,
          query: {
            ...input.query,
            timestamp: Math.floor((this.options.now?.() ?? Date.now()) / 1_000),
            client_id: randomUUID()
          }
        },
        {
          'x-apikey': this.options.apiKey,
          accept: 'application/json',
          'content-type': 'application/json',
          'user-agent': 'gmgn-signal-bot/0.1'
        }
      );
    } catch (error) {
      if (error instanceof GmgnError) {
        observe(
          error.status ?? null,
          error.kind === 'timeout' ? 'timeout' : 'error',
          error.message
        );
        throw error;
      }
      const wrapped = new GmgnError(
        'network',
        redact(error instanceof Error ? error.message : String(error), this.options.apiKey)
      );
      observe(null, retryEligible ? 'retry' : 'error', wrapped.message);
      throw wrapped;
    }
    const responseBody = response.body as Record<string, unknown> | null;
    const rateCode =
      responseBody && typeof responseBody === 'object'
        ? (safeScalar(responseBody.error ?? responseBody.code) ?? '')
        : '';
    if (
      response.status === 429 ||
      (responseBody &&
        typeof responseBody === 'object' &&
        (safeScalar(responseBody.code) === '429' ||
          /^(RATE_LIMIT_|ERROR_RATE_LIMIT_BLOCKED)/.test(rateCode)))
    ) {
      rateLimit = parseRateLimitResponse(
        response,
        this.options.now?.() ?? Date.now(),
        this.options.missingResetDelayMs
      );
      // Only whitelisted fields leave the client; arbitrary response text is never logged.
      rateLimit = Object.fromEntries(
        Object.entries(rateLimit).map(([key, value]) => [
          key,
          typeof value === 'string' ? redact(value, this.options.apiKey) : value
        ])
      ) as unknown as RateLimitInfo;
      const retryAtMs = rateLimit.retryAtMs;
      this.#cooldownUntilMs = Math.max(this.cooldownUntilMs, retryAtMs);
      if (apiMetricEndpoint(input.path) === 'quote') this.options.scheduler?.noteRateLimit('quote');
      this.options.scheduler?.pause(this.#cooldownUntilMs);
      observe(response.status, 'rate_limit', JSON.stringify(rateLimit));
      throw new GmgnError(
        'rate_limit',
        'GMGN returned rate limit',
        response.status,
        this.#cooldownUntilMs
      );
    }
    if (response.status < 200 || response.status >= 300) {
      observe(
        response.status,
        'error',
        JSON.stringify(httpFailureDiagnostic(response, this.options.apiKey))
      );
      throw new GmgnError('http', `GMGN returned HTTP ${response.status}`, response.status);
    }
    const body = response.body as Record<string, unknown> | null;
    if (
      !body ||
      typeof body !== 'object' ||
      ('code' in body && ![0, '0', 200, '200'].includes(body.code as number | string)) ||
      ('code' in body && (body.data === null || body.data === undefined))
    ) {
      observe(response.status, 'error', 'GMGN business code or response data invalid');
      throw new GmgnError('schema', 'GMGN business code or response data invalid', response.status);
    }
    const completedAtMs = this.options.now?.() ?? Date.now();
    if (completedAtMs >= deadlineMs) {
      observe(response.status, 'timeout', 'GMGN response arrived after request deadline');
      throw new GmgnError('timeout', 'GMGN response arrived after request deadline');
    }
    timings.set(response.body as object, {
      requestedAtMs: startedAtMs,
      completedAtMs
    });
    if (this.options.onFact) {
      try {
        const fact = createMarketFact({
          ...(poolRevision ? { poolRevision } : {}),
          request: JSON.parse(redact(JSON.stringify(input), this.options.apiKey)) as RequestInput,
          response: JSON.parse(
            redact(JSON.stringify(response.body), this.options.apiKey)
          ) as unknown,
          attemptId,
          queuedAtMs: admission?.queuedAtMs ?? startedAtMs,
          requestedAtMs: startedAtMs,
          receivedAtMs: completedAtMs,
          purpose
        });
        // Scrub even a credential echoed into an otherwise allowed response field.
        facts.set(response.body as object, fact);
        if (fact.token && fact.endpoint === 'info' && fact.poolRevision !== 'unresolved') {
          if (this.#observedPools.size >= 20000)
            this.#observedPools.delete(this.#observedPools.keys().next().value!);
          this.#observedPools.set(fact.token, fact.poolRevision);
        }
        this.options.onFact(fact);
      } catch {
        this.options.onFactError?.();
      }
    }
    observe(response.status, 'success');
    return response.body as T;
  }
}

export interface RateLimitInfo {
  errorCode: string;
  message: string | null;
  requestId: string | null;
  resetHeader: string | null;
  resetBody: string | null;
  retryAfter: string | null;
  limit: string | null;
  remaining: string | null;
  retryAtMs: number;
  fallbackUsed: boolean;
}
function header(response: HttpResponse<unknown>, name: string): string | null {
  const value = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1];
  return safeScalar(Array.isArray(value) ? value[0] : value);
}
function safeScalar(value: unknown): string | null {
  return typeof value === 'number' || typeof value === 'string'
    ? String(value).slice(0, 160)
    : null;
}
function resetTime(value: string | null): number {
  if (value === null || !value.trim()) return NaN;
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? numeric > 10_000_000_000
      ? numeric
      : numeric * 1000
    : Date.parse(value);
}
export function parseRateLimitReset(value: string | string[] | undefined, nowMs: number): number {
  const time = resetTime(safeScalar(Array.isArray(value) ? value[0] : value));
  return Number.isFinite(time) && time > nowMs ? time : nowMs + 30_000;
}
export function parseRateLimitResponse(
  response: HttpResponse<unknown>,
  nowMs: number,
  missingDelayMs = 30_000
): RateLimitInfo {
  const body =
    response.body && typeof response.body === 'object'
      ? (response.body as Record<string, unknown>)
      : {};
  const errorCode = safeScalar(body.error ?? body.code) ?? 'HTTP_429';
  const resetHeader = header(response, 'x-ratelimit-reset');
  const resetBody = safeScalar(body.reset_at);
  const retryAfter = header(response, 'retry-after');
  const retryTime =
    retryAfter === null
      ? NaN
      : /^\d+(?:\.\d+)?$/.test(retryAfter)
        ? nowMs + Number(retryAfter) * 1000
        : Date.parse(retryAfter);
  const deadlines = [resetTime(resetHeader), resetTime(resetBody), retryTime].filter(
    (x) => Number.isFinite(x) && x > nowMs
  );
  const fallbackUsed = deadlines.length === 0;
  const retryAtMs = fallbackUsed
    ? nowMs + Math.max(missingDelayMs, /BANNED|BLOCKED/.test(errorCode) ? 300_000 : 30_000)
    : Math.max(...deadlines) + 250;
  return {
    errorCode,
    message: safeScalar(body.message),
    requestId: header(response, 'x-request-id') ?? header(response, 'x-trace-id'),
    resetHeader,
    resetBody,
    retryAfter,
    limit: header(response, 'x-ratelimit-limit'),
    remaining: header(response, 'x-ratelimit-remaining'),
    retryAtMs,
    fallbackUsed
  };
}

export function redact(value: string, secret: string): string {
  return value.replaceAll(secret, '[REDACTED]');
}

export function nodeHttpsTransport(baseUrl: string): HttpTransport {
  const url = new URL(baseUrl);
  const agent = new Agent({ keepAlive: true, family: 4 });
  return async <T>(
    input: RequestInput,
    headers: Record<string, string>
  ): Promise<HttpResponse<T>> => {
    const target = new URL(input.path, url);
    for (const [key, value] of Object.entries(input.query ?? {}))
      if (value !== undefined) target.searchParams.set(key, String(value));
    const payload = input.body === undefined ? undefined : JSON.stringify(input.body);
    const options: RequestOptions = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: input.method,
      path: `${target.pathname}${target.search}`,
      family: 4,
      agent,
      headers: { ...headers, ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) }
    };
    return new Promise((resolve, reject) => {
      const req = request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('aborted', () => reject(new GmgnError('network', 'GMGN response aborted')));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: text.length === 0 ? (null as T) : (JSON.parse(text) as T)
            });
          } catch {
            // Preserve status/headers even for HTML or malformed 429 responses.
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: null as T });
          }
        });
      });
      req.setTimeout(input.timeoutMs ?? 8_000, () =>
        req.destroy(new GmgnError('timeout', 'GMGN request timed out'))
      );
      if (input.absoluteTimeoutMs !== undefined) {
        const timer = setTimeout(
          () => req.destroy(new GmgnError('timeout', 'GMGN physical deadline exceeded')),
          input.absoluteTimeoutMs
        );
        req.once('close', () => clearTimeout(timer));
      }
      req.on('error', (error) => reject(error));
      if (payload) req.write(payload);
      req.end();
    });
  };
}

/** Classifications only: never persist arbitrary response messages or echoed credentials. */
export function httpFailureDiagnostic(response: HttpResponse<unknown>, secret: string) {
  const body =
    response.body && typeof response.body === 'object'
      ? (response.body as Record<string, unknown>)
      : {};
  const message = (safeScalar(body.message ?? body.msg ?? body.error) ?? '').toLowerCase();
  const classification = /timestamp|expired|clock/.test(message)
    ? 'request_time'
    : /ip|whitelist|allowlist/.test(message)
      ? 'ip_policy'
      : /key|token|auth|signature/.test(message)
        ? 'authentication'
        : 'unclassified';
  const safeId = (value: unknown): string | null => {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value)) return null;
    return redact(value, secret);
  };
  return {
    status: response.status,
    classification,
    requestId: safeId(
      response.headers['x-request-id'] ??
        response.headers['x-trace-id'] ??
        response.headers['cf-ray']
    ),
    serverDate:
      typeof response.headers.date === 'string' &&
      Number.isFinite(Date.parse(response.headers.date))
        ? new Date(response.headers.date).toISOString()
        : null,
    jsonBody: response.body !== null && typeof response.body === 'object'
  };
}
