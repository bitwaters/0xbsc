# BSC Meme Signal Bot

Phase 1 is a GMGN-only BSC Meme signal service. It evaluates safety, route-specific
evidence and executable 10/50/100U quotes before delivering Telegram messages. It never
loads signing keys or places trades.

## Validation status

The example configuration starts in `dry_run` mode. V2 filtering is a shadow experiment
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
and formatting/linting. Copy `config.example.yaml` to the required runtime path
`~/.config/gmgn-signal-bot/config.yaml`, replace placeholders, then set the directory to
`0700` and the file to `0600`.

## Container operation

Copy `config.example.yaml` to `config.yaml`, replace placeholders, and keep it out of Git.
The Compose definition mounts that file read-only and stores SQLite data in the named
`signal-bot-data` volume:

```sh
docker compose up -d --build
```

The service accepts only GMGN OpenAPI and Telegram Bot API credentials. It has no private-key,
signing, swap, or order configuration.

### Backup and restore

Stop the container before a consistent file-level backup, then copy the SQLite database from the
named volume. Restore by stopping the container, replacing `signal-bot.db` in that volume with
the backup, and starting the container again. Keep the matching `config.yaml` revision with each
backup; configuration history in SQLite is secret-free.

### Upgrade and rollback

Build the new image, preserve the data volume, and start it with `docker compose up -d --build`.
Migrations run forward at startup. Before upgrading, take a backup. To roll back, stop the
container, restore the prior image and the pre-upgrade SQLite backup, then restart. Do not edit
applied migration files.

### Logs and secret rotation

Use the container runtime's log retention/rotation policy; application logs are JSON and redact
configured GMGN and Telegram secrets. Rotate a GMGN key or Telegram bot token by updating only
`config.yaml`, retaining `0600` permissions, then restart the container. Never place secrets in
environment variables, Compose files, or source control.
