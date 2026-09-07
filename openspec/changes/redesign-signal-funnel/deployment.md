# SEA 部署验收（2026-09-07 UTC）

## 最新追加部署

- 应用代码：`efa5e79be548350a35eea5ce721a9765a91fde47`，已按本地→GitHub→SEA拉取→Compose构建部署完成；Node24本地315/315测试及镜像内CI通过。
- 容器：`ce84419bb97a`，healthy；容器 `.Image`：`sha256:1e13eeecd47ddd00cb20592f37c37ce998f0ea98ddd4da7f9d605e337180ed6c`；登记镜像 `bsc-meme-signal-bot:research-compat-efa5e79`。
- 实测时刻 `1788801570011`：live + observe，正式配置revision未改变，researchInFlight=0、pendingWrites=0、stoppedReason=null。
- 事实3,631份，候选母集1,003个；SENT17、SEND_FAILED50；近2min记录57次API请求，全部200/success。该短窗口跨越重启，仅用于运维核验。
- 当前完成18/39项，21项未完成。新增分轨测量报告与CENSORED分类修复；新模型仍未启用，市场主基准UNAVAILABLE，最终run尚未开始。剩余工程与数据限制见implementation.md及measurement-feasibility.md。
- 本批无schema迁移，保留原SEA数据库和此前兼容镜像；没有传输凭据或测试发信。后续纯文档提交不改变此应用构建。

## 前次部署记录

应用代码提交：`33315d358c05c8178be85ff6d8b45841d794810d`。后续验收文档提交不改变该应用构建；同步文档时核对应用文件无差异，不重复重启。

- 路径：`/www/wwwroot/0xbsc`；GitHub：`bitwaters/0xbsc`，main。
- 流程：本地修改/测试/提交 → GitHub推送 → SEA `git pull --ff-only` → Docker Compose构建部署 → 实测；发现解包问题后已返回本地修复，再次完成上述流程。
- 最终容器：`074b1a8b8184`；Compose等待健康检查通过，healthy。
- SEA实际镜像ID：`sha256:0df62f5012b3c89ac6663750b38b1105c8d58369a03acf98fba115c818ab0e3c`。
- 登记镜像：`bsc-meme-signal-bot:research-compat-33315d3`；标记 `org.0xbsc.publication-compatibility=global-token-lock-v1`。另保留a025208的兼容镜像。兼容回滚保留当前数据库和发送锁，禁止还原旧DB或使用不支持发送锁的旧镜像。
- 备份：服务器数据卷内 `/var/lib/gmgn-signal-bot/backups/pre-research-a025208-cold.sqlite`，5,036,322,816字节，0600；停服后用SQLite backup完成，发送状态计数与原库一致。未导入本机数据库，未上传凭据。未完成的在线备份已删除。

## 实际模式与记录

- `runtime.mode=live`；正式publisher为legacy。
- `research.mode=observe`，run `research-observe-v1` ACTIVE；不增加研究API请求，不启用新模型真实发送。
- 正式配置revision仍为 `156c13855e51b058cfd01474419c25e6a216aafb845eb35b0740cfb725c95103`，与部署前相同。
- 核验时刻 `1788800469128`：事实2,758份，候选母集743个，待写0，stoppedReason=null，researchInFlight=0。
- 最近2min：212次请求全部200/success，无该窗口内429或失败。此为短时运维核验，不是长期性能或策略收益证明。
- 发现解包复验最近1min：Hot 699行、Signal 1,000行、Trenches 1,260行、Trending 1,100行，以上记录质量标志为0；修复前这些端点的payload为空，旧事实保留其不完整标志，不回写历史。
- SENT从部署前16条增至17条，17个SENT锁保留；SEND_FAILED仍50条。新增正式信号format=legacy-v1，publisher=legacy，已关联冻结快照，发送快照仅1份。没有手动发送测试消息。

## 提案未完成

前次核验时17/39项完成（最新进度见文首）。新市场主基准仍UNAVAILABLE / PRICE_SOURCE_TIME_UNVERIFIED，新模型未完成选择及独立验收，未切换正式规则。真实配对采集、完整新publisher与执行编排、全链路负载证据、最终run/晋级凭据等工程仍未全部完成，不能把它们一概描述为仅等待30天数据。

如仅需关闭被动记录，可在SEA项目目录执行 `RESEARCH_MODE=off docker compose up -d --no-build`，保留兼容镜像、现有数据和发送锁。代码问题继续在本地修复后推送部署，不直接修改服务器源码。
