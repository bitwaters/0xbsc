# Operations

## First run

On SEA, the repository and both runtime files live in `/www/wwwroot/0xbsc`:

- `config.yaml`: copy of the checked-in `config.example.yaml`, holding strategy settings.
- `.env`: copy of `.env.example`, holding runtime credentials and an optional administrator list. Never commit the actual file.

Fill `GMGN_API_KEY`, `GMGN_QUOTE_WALLET` (a public BSC address), `TELEGRAM_BOT_TOKEN`,
and `TELEGRAM_CHAT_IDS`. Use comma-separated numeric IDs for lists.
`TELEGRAM_ALLOWED_USER_IDS` is optional and identifies administrators for privileged management
actions. Empty or omitted means no administrators; it does not restrict signal delivery or GMGN
link clicks. Everyone can use the GMGN link button and the native contract-copy control.
The current release retains legacy management callbacks but does not implement shortcut commands.
Future management commands must use the administrator policy, never a public-link permission check.
`RUNTIME_MODE=live` enables formal delivery; `dry_run` runs without formal notifications.
Do not put signing keys or seed phrases in either file. Quote values containing `#` or spaces.
The application reads the file as data and does not expand shell variables or execute expressions.

On the server, both files need permissions `0600` and owner/group `999:999` for the container
account. Compose mounts them read-only under a private `0700` directory inside the container;
it does not pass their contents as container environment variables. If an editor replaces either
file while saving, restore its ownership and permissions before recreating the container.

```sh
cd /www/wwwroot/0xbsc
chown 999:999 config.yaml .env
chmod 600 config.yaml .env
docker compose up --build -d
```

A fresh installation creates an empty persistent volume. Existing local databases are not copied.
Keep this service directory out of web document roots and deny HTTP access to dotfiles and runtime
configuration. File mode `0600` prevents unrelated website accounts from reading credentials.

## Deployment workflow

Make all source, Docker, and configuration-template changes locally; test and push them to GitHub.
The server only pulls committed changes and performs deployment operations:

```sh
cd /www/wwwroot/0xbsc
git pull --ff-only origin main
docker compose up -d --build
docker compose ps
```

Inspect health and redacted logs on SEA. If a defect is found, fix and test locally, push to GitHub,
then pull and redeploy on SEA. Never patch tracked source directly on the server. Operator-filled
`.env` and `config.yaml` are ignored runtime files, not source changes. Preserve them across pulls.

## Backup and recovery

The named `signal-bot-data` volume contains the SQLite database. Stop the service before taking a
consistent copy of the database and any WAL companion files. Restore them together into the named
volume, then start the same or a newer forward-compatible image. Startup migrations are checksum
protected and do not rewrite applied migrations.

## Upgrade and rollback

Create a database backup before upgrading. Deploy a new image, inspect structured logs and health,
and retain the prior image until the migration and restart recovery checks pass. To roll back, stop
the container, restore the previous image and the paired database backup; do not edit migration
history in place.

## Logs and secret rotation

Collect stdout JSON logs with the host's container logging policy and bound retention by size and
age. Secret rotation is a controlled restart: replace the protected credential file, preserve its ownership and permissions,
then restart the single container. Configuration history stores only sanitized snapshots and hashes.

## Runtime quality repairs (2026-09-06)

Prewatch research uses a fresh 30-second request budget while preserving the source event's
original timestamps and evidence expiry. It cannot refresh formal evidence or run formal READY
recovery. Rejected or failed research releases its bounded watch slot; rate limiting retains the
watch for a later scheduled attempt.

Migration 013 separates pre-send cancellations, preparation failures, Telegram transport failures,
and unknown delivery in durable metrics. Historical terminal `SEND_FAILED` states and original
error/timestamp fields remain intact for compatibility; use `delivery_failure_kind` to interpret
that state. Cancellations do not trigger automatic resending or count as Telegram failures.

Path evaluation keeps the frozen entry price/time and target. Boundary OHLC uncertainty is
reported as `bounded`, with conservative price/drawdown bounds; actual gaps and unfinished
candles remain `incomplete` with separate diagnostics. Missing bars are never synthesized or
assumed to mean no trades. Proven first touches remain valid only when the preceding path is
known. Unknown/ambiguous observations do not become losses.

Each capture may make at most two targeted gap requests, within the existing shared weighted
GMGN scheduler. Incomplete paths receive at most three captures, at least 30 seconds apart.
Boundary-only uncertainty does not retry indefinitely. Captures use actual fetch time when
checking candle closure. Retries preserve initial checkpoint evidence and original exit quotes;
a late quote cannot replace a missing historical executable exit.

At first upgrade, up to 100 incomplete path-v2 checkpoints from the last 24 hours are queued
for bounded repair. Legacy samples are excluded. `initial_checkpoint_json` preserves the
original result; entry/target/horizon coordinates remain unchanged. The report exposes repaired
checkpoint counts, bounded coverage, pending repairs and coverage reasons. These counters are
not evidence of signal profitability or permission to enable a shadow strategy.
