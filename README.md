# BSC Meme Signal Bot

Phase 1 is a GMGN-only BSC Meme signal service. It evaluates safety, route-specific
evidence and executable 10/50/100U quotes before delivering Telegram messages. It never
loads signing keys or places trades.

## Validation status

The YAML example starts in `dry_run` mode; the optional `.env.example` selects `live` once all credentials are filled in. V2 filtering is a shadow experiment
and does not produce additional formal notifications. Historical outcome evaluation uses
price-path target multiples and downside barriers, with time-based checkpoints as supporting data.

The request governor accounts for every physical request and retry against the Plus
20-weight/second ceiling. Live verification still encountered upstream `IP rate limit exceeded`
responses below that ceiling, including with the experimental 600 ms Quote spacing.
These changes have passed offline tests, but production rate-limit acceptance is incomplete;
publishing this repository does not establish production readiness or signal performance.

Local production configuration, databases, audit outputs, and one-off live debugging scripts
are intentionally excluded from version control. The design document records historical
requirements; current implementation and validation limits are described here and in the OpenSpec design.

## Development

Use Node.js 24 or newer. Install with `npm ci`, then run `npm run ci` for type checking,
linting, tests, and compilation. GitHub Actions also validates the OpenSpec documents
with the pinned `@fission-ai/openspec` CLI.

## Dependencies

- `better-sqlite3`: the single durable SQLite store and Outbox.
- `yaml`: parse the one runtime configuration file.
- `zod`: validate configuration before any network or database work.
- `decimal.js`: preserve quote, token and Wei precision.

Development dependencies provide TypeScript compilation, Node test execution through `tsx`,
and formatting/linting. For direct Node execution, put `config.yaml` and optional `.env` in
`~/.config/gmgn-signal-bot/`, with directory permissions `0700` and file permissions `0600`.

## Container operation

Copy `config.example.yaml` to `config.yaml` and `.env.example` to `.env` in the project directory.
Fill in the credentials, destination chat IDs and runtime mode in `.env`; they override YAML.
`TELEGRAM_ALLOWED_USER_IDS` is an optional administrator list, not a link-button allowlist.
GMGN links are open to everyone. Leaving administrators blank disables management actions
without blocking delivery. The current release handles legacy management callbacks; shortcut
commands have not been implemented.
Strategy settings stay in YAML. An empty `.env` retains YAML-only configuration. Blank required
fields or placeholder credentials prevent startup before any API requests or database writes.

Both files must be readable by the container account (UID/GID 999) with permissions `0600`.
Compose mounts them read-only as files, without adding secrets to the image or container environment.
SQLite data uses the named `signal-bot-data` volume:

```sh
docker compose up -d --build
```

The service accepts only GMGN OpenAPI and Telegram Bot API credentials. It has no private-key,
signing, swap, or order configuration.

### Backup and restore

Stop the container before a consistent file-level backup, then copy the SQLite database from the
named volume. Restore by stopping the container, replacing `signal-bot.db` in that volume with
the backup, and starting the container again. Keep the matching `config.yaml` revision with each
backup, together with its protected `.env`; configuration history in SQLite is secret-free.

### Upgrade and rollback

Build the new image, preserve the data volume, and start it with `docker compose up -d --build`.
Migrations run forward at startup. Before upgrading, take a backup. To roll back, stop the
container, restore the prior image and the pre-upgrade SQLite backup, then restart. Do not edit
applied migration files.

### Logs and secret rotation

Use the container runtime's log retention/rotation policy; application logs are JSON and redact
configured GMGN and Telegram secrets. Rotate a GMGN key or Telegram bot token in the mounted
`.env` file (or YAML for YAML-only operation), retain `0600` permissions, then restart the container.
Never put actual secrets in Compose definitions, images, or source control. See [operations](docs/operations.md)
for the local → GitHub → server deployment workflow.
