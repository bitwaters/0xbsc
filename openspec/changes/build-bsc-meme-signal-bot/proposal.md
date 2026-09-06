## Why

BSC Meme 代币机会窗口通常只有数分钟，需要一个仅依赖 GMGN OpenAPI 市场数据、能够兼顾新币启动与老币复苏、并以可执行报价和前置安全检查控制误报的低延迟 Telegram 信号系统。当前已有经过真实 API 审计和多轮简化审阅的开发方案，现在需要把它固化为可验证、可分步实施的工程契约。

## What Changes

- 建立 GMGN OpenAPI 单一市场数据入口，统一六类发现源、加权限流、优先调度、缓存、事件标准化和精确去重。
- 建立前置安全硬过滤、路线判定、证据有效期、三级评分、数据完整度和观察 Episode 状态机，覆盖新币启动、老币复苏、趋势延续三条路线；正式候选还须通过 YAML 可审计的惰性深度持仓与带标签钱包退出 veto，创建者累计发币与开放率仅影响质量评分。
- 对正式候选执行 10/50/100U 双向 Quote，输出可执行成本和最大安全仓位；任何安全硬条件不能被评分抵消。
- 通过 SQLite Outbox 可靠推送 Telegram，并支持消息编辑、删除、Inline Keyboard、受限回调和不确定投递状态处理。
- 不设置每日、每小时或每批信号数量配额；所有仍新鲜且通过安全、评分、完整度和双向 Quote 门禁的信号都进入投递。
- 持久化正式信号与未推送样本，按统一入场口径计算市场收益、可执行收益、MFE/MAE、TP/SL，并监控 GMGN 权重、容量、错误和端到端延迟。
- 使用单进程 TypeScript、单 SQLite、单 Docker 容器和唯一 YAML 配置文件，避免引入 Redis、消息队列、数据库服务或 Telegram 框架。
- Phase 1 明确不包含自动交易、私钥、签名与 GMGN Swap；自动交易后续以独立变更设计。

## Capabilities

### New Capabilities

- `gmgn-data-pipeline`: GMGN 六类发现源、标准事件、精确去重、加权限流、优先调度、缓存及真实 API 契约验证。
- `signal-decision-engine`: 前置安全过滤、三路线判定、证据聚合、评分、完整度、观察 Episode 和重新触发规则。
- `executable-quote-gate`: 10/50/100U 双向报价、成本判定、推送前刷新和最大安全仓位计算。
- `telegram-signal-delivery`: SQLite Outbox、Telegram HTTP 推送、编辑/删除/按钮、回调鉴权及投递恢复。
- `signal-evaluation-observability`: 信号与未推送样本的结果评估、延迟分解、GMGN 权重容量和运行指标。
- `single-file-runtime-configuration`: 唯一 YAML 中的运行参数与秘密、启动校验、脱敏和单容器持久化要求。

### Modified Capabilities

无。当前项目没有既有 OpenSpec 能力规范。

## Impact

- 新增 TypeScript/Node.js 服务、SQLite schema、Docker 构建、单一 YAML 配置示例以及单元、回放、并发和故障恢复测试。
- 外部系统仅为 GMGN OpenAPI 和 Telegram Bot API；市场与交易可执行性数据不得接入其他 API。
- 生产依赖预计包括 `better-sqlite3`、YAML 解析器、Zod 和固定精度十进制库；HTTP 使用 Node 原生能力。
- 真实 GMGN API 测试会消耗套餐权重，必须通过全局 Token Bucket、测试预算和脱敏审计执行。
