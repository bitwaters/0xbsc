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

## Immutable signal cards

Signals show the pre-send reference price and a fixed UTC snapshot time. After sending,
the original card is never automatically edited. Price-path evaluation and internal risk
tracking continue independently. Exact delivery payloads and decision/quote snapshots are
recorded before each request; confirmed delivery links its specific immutable attempt.
Old refresh callbacks explain that the card is frozen and direct users to GMGN.

Migration 014 cancels only pending Telegram edits, including edits from previous releases.
It preserves completed edit history and all outcome tasks. Previously edited cards have
no trustworthy original full payload, so their snapshot link remains empty; the stored
frozen entry price is preserved and no historical card is reconstructed or resent.

### 研究底座（尚未切换正式筛选）

Compose 显式启用 `RESEARCH_MODE=observe`，复用现有 GMGN 响应记录事实、物理请求时间及公共候选母集，不增加 API 请求。应用直接启动且未配置研究节点时默认 off。正式 publisher 仍使用 legacy 规则，发送后的卡片保持冻结；成功和未知发送的 token 锁跨进程、池版本保留，UNKNOWN 不自动重发。

`.env` 可配置 `RESEARCH_MODE=off|observe` 和 `RESEARCH_RUN_ID`。新 run 必须使用新的 ID；不能通过重启覆盖已终止的研究记录。详细进度及限制见 [实施记录](openspec/changes/redesign-signal-funnel/implementation.md)。

构建后可使用以下离线命令；audit / replay / precheck 不调用 GMGN 或 Telegram，也不读取运行凭据：

```sh
npm run research -- audit --db /path/to/existing.sqlite --format markdown
npm run research -- manifest validate --file model.json
npm run research -- replay --file replay-input.json
npm run research -- measurement-report --file measurement-ledger.json --format markdown
npm run research -- budget-check
npm run research -- readiness
npm run research -- deployment-precheck --db /path/to/existing.sqlite
```

`replay-input.json` 明确提供 models、facts、frames、events 和脱敏 legacyConfig。用 `--db` 时以 factIds 从只读数据库及同目录 research-archives 读取校验后的事实。所有决定只使用当时已返回的数据；离线输出标记安全/执行未评估。

`dataset freeze --db DB --file PLAN` 会写入本机数据用途台账并固定 token 分组/截止/事实引用；不能在开发集、选择集和最终集间重用同一 token 的新池。`select --file CANDIDATES` 与 `evaluate-paired --file INPUT` 提供有限模型选择及成对统计。统计 PASS 不是晋级凭据；当前构建未开放 collect、execute_shadow 或 validated publisher。

`measurement-report` 的输入分为 `expected` 注册样本和 `observations` 实际测量，类型见 `src/research/measurement-report.ts`。缺失测量仍进入全部分母；按 run、模型、轨道、协议、真实/模拟确认和观察上限分别输出四个目标的分类、条件率、全部率、覆盖、缺失成功区间及基准等待。重复样本、改变坐标或以无效基准声明成功会报错。报告是离线账本诊断，不验证输入的采集来源，也不生成晋级凭据。

当前 Info 缺少已验证的价格来源时间，市场主基准报告 UNAVAILABLE。该版本提供测量与诊断工具，不能据此声称新规则已提高命中率。最终前向验证与正式切换仍须完成提案剩余任务。部署和回滚均保留服务器原数据库；开始新格式正式发布后，只能回到带 `org.0xbsc.publication-compatibility=global-token-lock-v1` 的已登记镜像。
