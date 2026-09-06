# Operations

## First run

On SEA, the repository and both runtime files live in `/www/wwwroot/0xbsc`:

- `config.yaml`: copy of the checked-in `config.example.yaml`, holding strategy settings.
- `.env`: copy of `.env.example`, holding six operator-filled fields. Never commit the actual file.

Fill `GMGN_API_KEY`, `GMGN_QUOTE_WALLET` (a public BSC address), `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_IDS`, and `TELEGRAM_ALLOWED_USER_IDS`. Use comma-separated numeric IDs for lists.
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
