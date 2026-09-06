## 1. Project Bootstrap and Configuration

- [x] 1.1 Initialize the strict TypeScript Node.js project, package scripts, formatter, linter and test runner with the seven-module directory structure from the design.
- [x] 1.2 Add only the planned runtime dependencies for SQLite, YAML, Zod and fixed-precision decimal arithmetic; document why each dependency is required.
- [x] 1.3 Create the single `config.yaml` example containing every GMGN, Telegram, security, polling, scoring, observation, Quote, evaluation, storage and logging setting without real secrets.
- [x] 1.4 Implement startup YAML parsing, schema and cross-field validation, file/directory permission checks, secret redaction, sanitized revision snapshots and SHA-256 configuration IDs.
- [x] 1.5 Add configuration tests for missing secrets, BSC enforcement, invalid percentages, route weights, soft/hard rate limits, Quote tiers and the prohibition on runtime values outside the YAML source.

## 2. Durable SQLite State

- [x] 2.1 Create versioned migrations for `tokens`, `events`, `episodes`, `signals`, `price_samples`, `api_stats` and `config_revisions` with WAL mode and required indexes.
- [x] 2.2 Add unique constraints for event keys, one active chain/token/route Episode and one signal per Episode, plus migration and constraint tests.
- [x] 2.3 Implement the serialized write queue, short transaction helpers and JSON/decimal serialization without losing large integer precision.
- [x] 2.4 Implement restart recovery for source snapshot hashes/sequences, active Episodes, Outbox states and due result tasks.

## 3. GMGN OpenAPI Contract and Scheduler

- [x] 3.1 Implement the native HTTP GMGN client with authenticated requests, IPv4-preferred keep-alive, timeouts, typed errors, one retry for eligible read failures, 429 cooldown and automatic redaction.
- [x] 3.2 Implement the shared weighted Token Bucket, hard/soft limits, endpoint weights, priorities, deadlines, jitter and non-reentrant poll keys with deterministic clock tests.
- [x] 3.3 Use the real personal API in a bounded, redacted contract suite to verify every Phase 1 endpoint's method, parameters, response shape, pagination/range and error behavior; assert configured weights against the supplied official table and separately observe 429 behavior.
- [x] 3.4 Capture real Signal labels and fields and create a versioned `signal_type -> semantic_category -> evidence_family` mapping; prove unknown types are stored but cannot trigger or score.
- [x] 3.5 Verify the usable Kline history/range and resolutions needed for 30-second, 1-minute, 5-minute and one-hour baselines, including empty and insufficient-history responses.
- [x] 3.6 Verify Quote field units and whether tax, DEX fee, price impact and Gas are included; freeze the interpretation as adapter fixtures and contract tests.
- [x] 3.7 Encode and test verified production limits: explicit Signal types with 14/15/16 rejected, 50 rows per Signal group, local Trenches truncation, 100-row SmartMoney/KOL/Holders/Traders limits, missing quota headers and `X-RateLimit-Reset` cooldown.

## 4. Discovery and Standard Events

- [x] 4.1 Implement configurable pollers for high-frequency and narrative Signal groups, Trenches phases, Trending intervals, Hot intervals, SmartMoney, KOL and Gas using the specified default cadence, ±10% jitter and non-reentrant scheduler.
- [x] 4.2 Implement response adapters that emit one normalized BSC event model with source time, observed time, token, evidence family, strength, TTL and redacted raw payload reference.
- [x] 4.3 Implement stable-ID event keys and snapshot hash/change-sequence event keys, persisting the previous normalized state across restarts.
- [x] 4.4 Add replay fixtures proving identical snapshots do not rescore, meaningful changes do, ranking thresholds are honored and asynchronous source arrivals aggregate rather than overwrite.
- [x] 4.5 Implement per-token keyed serialization with cross-token concurrency and test simultaneous source events against database uniqueness constraints.
- [x] 4.6 Add per-poller and per-adapter error boundaries plus capped exponential backoff, proving repeated failure cannot stop other work or continuously consume real-time weight and one success restores normal cadence.

## 5. Safety Gates and Data Normalization

- [x] 5.1 Implement zero-call safety filtering from discovery fields and unexpired cache before any candidate consumes deep-analysis weight.
- [x] 5.2 Implement the parallel Info/Security/Pool gate with critical-field missing retries and configured hard checks, including the initial 5% tax, 50% Top10, 10% team and 20% entrapment/bundler/sniper limits plus fail-closed handling for unmapped security flags/alerts.
- [x] 5.3 Implement DEX owner/mint/privilege and LP locked-or-burned checks plus the GMGN-verified Launchpad pool exception.
- [x] 5.4 Implement percentage, USD, token amount and Wei normalization with invalid-unit fail-closed behavior and boundary-value tests.
- [x] 5.5 Implement lazy Holders/Traders/Created Tokens retrieval and deep vetoes for creator abuse, concentrated holdings and coordinated SmartMoney exits.
- [x] 5.6 Add table-driven tests proving every safety failure overrides any possible score and never occupies an observation slot.

## 6. Route Features, Evidence and Scoring

- [x] 6.1 Implement shared Kline, liquidity, lifecycle, capital-flow, attention and holder/creator feature extraction with freshness-aware cache access.
- [x] 6.2 Implement and fixture-test the fixed algorithms for dormancy, breakout, upward trend, healthy pullback, restart and vertical-pump rejection while reading all numeric thresholds from YAML.
- [x] 6.3 Implement the exclusive route classifier with new-launch, revival and continuation priority and boundary tests around token age and lifecycle transitions.
- [x] 6.4 Implement the four evidence families, weak/strong triggers, per-family maxima, default TTLs and immediate invalidation on contrary events.
- [x] 6.5 Implement each route's exact six-dimension weight table, three-level scoring and freshness-weighted data completeness with the specified 30/30/60/180/300/3600-second data TTLs and no duplicate source contribution.
- [x] 6.6 Add route decision tests for the 65 observation threshold, 80 formal threshold, 0.70 completeness, two-family minimum and 90/120/60-second decisive-trigger windows.
- [x] 6.7 Add dedicated revival tests for completed-window baselines, zero/insufficient baselines, absolute fallbacks, required dormancy, structure breakout and re-dormancy before another revival.
- [x] 6.8 Test the exact completeness formula, new-launch growth prerequisite and deterministic Episode transitions for first/second low-score checks and temporary Quote-cost fallback.
- [x] 6.9 Replace the creator token-count hard veto with a YAML-driven creator-history quality adjustment capped at five points, preserve direct-hold and missing-data hard gates, persist/display the adjustment, and add regression tests.

## 7. Episode and Observation Lifecycle

- [x] 7.1 Implement the `DISCOVERED`, `OBSERVING`, `READY`, `DELIVERY_PENDING`, terminal and reset transitions with transition invariants.
- [x] 7.2 Implement one active Episode per chain/token/route, one successful new-launch signal per token and route-specific reset requirements.
- [x] 7.3 Implement the 60-Episode capacity, 20-per-route soft targets, quality ordering, capacity borrowing and demotion without discarding history.
- [x] 7.4 Implement route observation expiries, narrative extension, two-consecutive-low-score expiry and fresh-trigger re-entry.
- [x] 7.5 Implement immediate event-driven reevaluation and hash-staggered 30-second Info/Kline due times with route-appropriate Kline intervals.
- [x] 7.6 Add simulated-clock tests for expiry, evidence timeout, reverse invalidation, full-pool replacement, stagger distribution and restart continuation.

## 8. Executable Quote Gate

- [x] 8.1 Implement concurrent 10/50/100U buy Quote requests followed by concurrent per-position full-amount sell Quotes using arbitrary-precision quantities.
- [x] 8.2 Implement route/direction validation, sellability failure, maximum slippage, per-leg and round-trip cost formulas using the verified GMGN cost semantics.
- [x] 8.3 Implement the mandatory 10U decision, independent larger-tier decisions and `max_safe_position` calculation with table-driven cost-boundary tests.
- [x] 8.4 Implement Quote retry only after material price/liquidity change and the minimum interval, while treating route failure as a safety rejection rather than a temporary cost failure.
- [x] 8.5 Enforce 30-second Security/Pool and 5-second Quote freshness in the final transaction, including refresh and stale-trigger termination tests.

## 9. Telegram Delivery and Interaction

- [x] 9.1 Implement the SQLite Outbox transaction that atomically stores the final decision, stable signal ID, configuration revision, Quote snapshot and pending delivery.
- [x] 9.2 Implement native HTTP calls for Telegram send, edit, delete and callback acknowledgement with timeouts, redaction and response validation.
- [x] 9.3 Implement the compact signal template containing all required route, evidence, score, completeness, liquidity, three-tier cost, maximum-position, risk and timestamp fields plus the configured GMGN-detail, copy-contract, refresh, bought, stop-tracking and delete buttons.
- [x] 9.4 Implement Inline Keyboard callbacks using long polling, strict Chat/user authorization, signal-message association and idempotent repeated-update handling; refresh uses the GMGN scheduler, bought is annotation-only, stop affects message edits only, and delete never removes samples.
- [x] 9.5 Implement Outbox recovery, confirmed `message_id` storage, retryable failure and `DELIVERY_UNKNOWN` with at most one same-ID retry, possible-duplicate marking and fresh-trigger/security revalidation before retry.
- [x] 9.6 Implement post-send edits at 1/5/15/30/60 minutes, additional 120/240-minute narrative checkpoints, new supporting evidence and immediate material risk/Quote deterioration without creating a second signal in the same route state.
- [x] 9.7 Add mocked HTTP and crash-point tests for every Outbox boundary, unknown response, unauthorized callback, edit conflict and restart recovery.
- [x] 9.8 Prove a burst of qualifying candidates creates one Outbox item per still-fresh candidate with no daily, hourly, route or batch signal quota, and prove formal messages are never auto-deleted.

## 10. Signal Outcome Evaluation

- [x] 10.1 Create durable due tasks for formal signals and every score-at-least-65 unsent Episode at configured checkpoints without scheduling low-score or hard-safety failures and without introducing a second in-memory observation pool.
- [x] 10.2 Start post-confirmation 10/50/100U entry Quotes asynchronously, persist all timestamps and exclude entry requests started after five seconds from the primary executable-return cohort.
- [x] 10.3 Collect Kline price paths for tracked samples and checkpoint exit Quotes only for formal signals, marking formal exit requests started after ten seconds as late.
- [x] 10.4 Compute and store separate market return, executable return, MFE, MAE and TP/SL results with explicit same-candle ambiguity handling.
- [x] 10.5 Preserve rejection reason, feature snapshot, configuration revision and later outcome for false-negative analysis without ever backfilling an old Telegram signal.
- [x] 10.6 Add deterministic price-path and Quote fixtures covering profit, loss, rug/no-exit, late entry, late exit and ambiguous TP/SL.

## 11. Observability and Capacity Controls

- [x] 11.1 Instrument source event, observation, queue, API batch, decision, Outbox, Telegram request/confirmation and result timestamps with correlation IDs.
- [x] 11.2 Aggregate successful API counts, weights, statuses and P50/P95 by endpoint and minute while retaining individual 429, retry, timeout, error and slow-request records.
- [x] 11.3 Add metrics for active Episodes, deduplication, deep analyses, stale candidates, signals, Quote rejections, delivery failures and due-task backlog.
- [x] 11.4 Implement budget degradation that first postpones result tasks, then lowers low-score reevaluation, never postpones ready-candidate security/Quote, and expires stale real-time work.
- [x] 11.5 Build a latency diagnostic report that separates every stage, includes sample count/load band/P50/P95/P99/failure rate, compares observations with the provisional 3/5/6/15-second budgets, and never labels those budgets as verified SLOs.

## 12. Automated Verification

- [x] 12.1 Add unit tests for configuration, normalization, hashing, scoring, route algorithms, cost arithmetic and state transitions with no network dependency.
- [x] 12.2 Add recorded-response integration tests for all GMGN adapters and Telegram operations with secrets and personal identifiers scrubbed.
- [x] 12.3 Add concurrent replay tests for six-source bursts, 60 active Episodes, weighted scheduling, keyed ordering and duplicate prevention.
- [x] 12.4 Add fault-injection tests for GMGN timeouts/429/schema drift, SQLite lock/restart and Telegram confirmed/failed/unknown delivery.
- [x] 12.5 Add a repeatable end-to-end dry run that consumes captured inputs and verifies database rows, decision traces, message payloads and result tasks.
- [x] 12.6 Add CI checks for type safety, lint, all tests, migration reproducibility, committed-secret detection and OpenSpec strict validation.

## 13. Container and Operations

- [x] 13.1 Create a minimal single-service Docker image with non-root runtime, health check and pinned dependency installation.
- [x] 13.2 Create the single-container deployment definition with read-only mounted YAML, SQLite persistent volume, restart policy and no trading credentials.
- [x] 13.3 Document first-run configuration permissions, database backup/restore, upgrade migration, rollback, log retention and secret rotation.
- [x] 13.4 Run a container restart drill proving event deduplication, Episode, Outbox and result tasks recover without duplicate formal signals.

## 14. Live API and Quality Acceptance

- [x] 14.1 Run a bounded live GMGN smoke test for every used endpoint and record a new fully redacted capability matrix, response-shape fingerprint and initial observed latency report with its sample scope; do not present it as a stable baseline.
- [x] 14.2 Run a bounded stair-step live rate test with a stop-on-429 guard to validate the 20/s hard and 14/s soft strategy, reset behavior, polling freshness and observed maximum safe collection volume without uncontrolled quota pressure.
- [x] 14.3 Run real-API test-Chat flows, measure each end-to-end path across documented load bands, publish sample count/P50/P95/P99/failure and stage timing, compare with the theoretical budgets, then establish a versioned empirical baseline and recommended operating thresholds without a fixed-day requirement.
- [ ] 14.4 Enable formal signal collection with automatic trading disabled and accumulate at least 100 independent formal signals for each of the three routes, with no fixed day limit.
- [ ] 14.5 Produce route-level precision, executable-return, MFE/MAE, latency, rejection and false-negative reports; tune only YAML thresholds through versioned revisions.
- [ ] 14.6 Complete the Phase 1 go/no-go review; keep automated trading as a separate future OpenSpec change even if signal quality passes.

## 15. Milestone Reviews

- [x] 15.1 After tasks 1.1–1.5, perform a structured configuration/bootstrap review against the proposal, design and configuration specification; fix all findings and rerun the relevant checks before starting durable state work.
- [x] 15.2 After tasks 2.1–2.4, perform a structured SQLite durability, schema and recovery review; fix all findings and rerun migration/constraint/recovery tests before implementing the GMGN pipeline.
- [x] 15.3 After tasks 3.1–8.5, perform a structured data-path, safety, decision, Episode and Quote-gate review; fix all findings and rerun the affected unit/integration/concurrency tests before delivery work.
- [x] 15.4 After tasks 9.1–13.4, perform a structured delivery, evaluation, observability, test and operations review; fix all findings and rerun the full local verification suite before live acceptance.
- [ ] 15.5 Before declaring Phase 1 complete, perform a final requirements-by-requirement review covering every OpenSpec task, all six specifications, live acceptance evidence and the explicit exclusion of automatic trading.

## 16. Production False-Negative Remediation

- [x] 16.1 Debounce Trending/Hot rank snapshots with a YAML-configured rank step and prevent overlapping downstream processing for the same poller.
- [x] 16.2 Aggregate evidence before deep candidate API work and add a dedicated candidate scheduler priority below discovery feeds.
- [x] 16.3 Coalesce queued work per token to the latest persisted state and reuse Kline data within the observation interval.
- [x] 16.4 Refresh only the stale final-gate component in a bounded loop and timestamp Quote completion rather than request start.
- [x] 16.5 Add regression coverage, run full local verification, perform a structured review, redeploy, and compare live source/API/signal health.
- [x] 16.6 Admit safety-passed old-token momentum breakouts into bounded continuation observation without allowing a vertical pump to become formal before a healthy pullback and restart.
- [x] 16.7 Treat verified buy-side swaps as real trading and allow strong capital evidence to satisfy the new-launch growth prerequisite, with route and adapter regression tests.
- [x] 16.8 Make unsent outcome checkpoints idempotent per Episode/checkpoint, update results by task identity, preserve initial and latest decision snapshots, and cap ordinary unsent tracking at the configured duration.
- [x] 16.9 Expire a scheduled observation when its minimum evidence has disappeared and persist complete route-gate diagnostics so a due Episode cannot spin in the 250 ms loop.
- [x] 16.10 Run focused and full verification, perform a structured code review and fix all findings, apply a forward SQLite migration, redeploy with a backup, and verify live health/backlog behavior.
- [x] 16.11 Refresh GMGN presentation immediately before every send and scheduled edit, persist the refresh timestamp, and re-Quote material or stale pending deliveries.
- [x] 16.12 Freeze the Telegram-confirmed market entry price and use it for every formal checkpoint while preserving the first qualified price for unsent Episodes.
- [x] 16.13 Track score-at-least-65 post-score lazy-safety rejections for bounded market-only false-negative analysis.
- [x] 16.14 Require fresh, time-coherent net selling for coordinated tagged-wallet exit vetoes and debounce repeated hard-safety terminal Episodes by the matching data TTL.
- [x] 16.15 Treat every Telegram 429 form as retryable and add regression coverage for delivery preparation, edits, outcome baselines, candidate tracking and Episode cooldown.
- [x] 16.16 Run full verification, structured review and fixes, apply the forward migration, back up the live database, redeploy, and verify post-deploy health and freshness behavior.

## 17. Data quality and path-first filtering remediation (2026-09-05)

- [x] 17.1 Freeze evaluation entry/target independently of retries and safety snapshots; mark legacy samples and preserve unsent/formal histories separately.
- [x] 17.2 Preserve and validate candle timestamps, coverage and boundary ambiguity; implement path-first multiple/first-touch/drawdown metrics and aggregate denominators.
- [x] 17.3 Correct explicit security flags, lifecycle event times and coordinated-exit semantics, with regression tests.
- [x] 17.4 Require valid fresh route inputs, correct five-minute revival windows, independent growth and decisive triggers, and bounded soft-condition observation.
- [x] 17.5 Add configurable bounded prewatch and shadow V2 decisions with persisted inputs/reasons; keep experimental scores separate from delivery.
- [x] 17.6 Revalidate pending sends and independently update sent-signal risk status and display.
- [x] 17.7 Decouple discovery from candidate processing with bounded queues, implement conservative batched retention and semantic API validation.
- [x] 17.8 Run regression/integration/migration checks and document deployment, evidence gaps and remaining prospective validation.

## 18. READY recovery after Quote failures (2026-09-05)

- [x] 18.1 Diagnose the new-version funnel and distinguish duplicate sent-token decisions from independent blocked candidates.
- [x] 18.2 Schedule READY watchdogs and expiry, recover transient errors inside token serialization, and recover orphan READY states on restart without replaying stale signals.
- [x] 18.3 Serialize Quote requests through the shared weighted scheduler and preserve client cooldown handling.
- [x] 18.4 Add regression tests for 429 recovery, READY deadlines, restart handling and Quote serialization; run full local verification.
- [x] 18.5 Build and test on Node 24, preserve a rollback backup, deploy and verify production recovery; document evidence and limits.

## 19. Physical-request governor and 429 remediation (2026-09-06)

- [x] 19.1 Move every physical HTTP attempt and retry into one weighted, paced scheduler with global cooldown, bounded in-flight requests, durable restart state and complete rate-limit parsing.
- [x] 19.2 Preserve workflow priority and original deadlines, remove the external Quote FIFO, share fresh Gas/Traders reads, prioritize due observations over prewatch and preserve each Quote leg timestamp.
- [x] 19.3 Persist bounded attempt diagnostics and candidate error stages, expose limiter state in health metrics, and update the specifications.
- [x] 19.4 Add deterministic cross-layer regression and mixed-load/recovery tests, complete full checks and structured review.
- [ ] 19.5 Back up stopped production state, build on Node 24, perform bounded read-only mixed-endpoint acceptance, deploy and verify the new image and request accounting.
