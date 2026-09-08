import { createHash } from 'node:crypto';
import { canonicalJson } from '../discovery/events.js';

export const hashValue = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
export const measurementProtocol = Object.freeze({
  version: 2,
  quoteSizing: '10U-requested-native-atoms-actual-returned-usd',
  horizonMs: 86400000,
  baselineDeadlineMs: 5000,
  physicalTimeoutMs: 2000,
  sourceMaxAgeMs: 2000,
  simulatedConfirmationDelayMs: 1000,
  targets: [1.3, 1.5, 2, 3] as const,
  stopMultiple: 0.9,
  marketAttempts: 2,
  quoteAttempts: 1,
  captures: 3,
  hotTasks: 200
});
export type BaselineTrack =
  | 'trial_card_reference_v1'
  | 'card_reference_legacy'
  | 'post_confirmation_market_v1'
  | 'post_confirmation_quote_v1'
  | 'decision_market_replay_v1';
export const protocolHash = (track: BaselineTrack): string =>
  hashValue({ track, ...measurementProtocol });
export type Outcome = 'TP' | 'SL' | 'NOT_TOUCHED' | 'CENSORED' | 'UNKNOWN' | 'MISSING_BASELINE';
export const outcomes: readonly Outcome[] = [
  'TP',
  'SL',
  'NOT_TOUCHED',
  'CENSORED',
  'UNKNOWN',
  'MISSING_BASELINE'
];
