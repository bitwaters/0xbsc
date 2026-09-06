# Operations

## First run

Copy `config.example.yaml` to the project root as `config.yaml` and set the file to `0600`.
Alternatively, make `config.yaml` a symlink to a protected configuration file outside the project.
Compose mounts this one file read-only at `~/.config/gmgn-signal-bot/config.yaml` inside the container.
For direct Node execution, place the configuration at that path in the current user's home directory.
Never create a `.env` file for runtime
secrets and never add signing or trading credentials.

Build and run the container: `docker compose up --build -d`.

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
age. Secret rotation is a controlled restart: replace the protected YAML, preserve its permissions,
then restart the single container. Configuration history stores only sanitized snapshots and hashes.
