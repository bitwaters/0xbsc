## Purpose

规定策略参数由 YAML 管理，运行凭据可由同目录受保护的 .env 文件覆盖，合并后完整校验并以最少组件部署。

## ADDED Requirements

### Requirement: Runtime configuration has one source of truth

生产进程 SHALL 读取 `~/.config/gmgn-signal-bot/config.yaml` 管理全部策略与存储参数。按部署要求，同目录可选的 `.env` SHALL 只覆盖 RUNTIME_MODE、GMGN_API_KEY、GMGN_QUOTE_WALLET、TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_IDS 和 TELEGRAM_ALLOWED_USER_IDS 六个字段，优先于 YAML；空文件或缺失文件保持原 YAML 行为。非空 `.env` MUST 填写模式、GMGN Key、公开报价钱包、Telegram Token 和目标 Chat；管理员 TELEGRAM_ALLOWED_USER_IDS MAY 留空或省略，合并后管理员名单为空且不得继承 YAML 中的管理员。未知字段或其他必填值缺失拒绝启动。程序不得把进程环境当作隐式配置来源。SEA 上两个文件 MUST 位于 `/www/wwwroot/0xbsc/`，由 Compose 只读挂载，不写入镜像或容器环境。

#### Scenario: Required value is missing or invalid

- **WHEN** 启动时配置缺少必填字段、阈值越界、权重不合计 100 或包含不支持的链
- **THEN** 系统输出不含秘密的明确错误并拒绝启动

### Requirement: Configuration is data, not executable logic

配置 SHALL 只包含数据值，不得支持表达式语言或动态代码。趋势、回调、突破、沉寂、垂直拉升和协议字段解析算法 SHALL 在代码中固定并由测试约束，算法使用的数值阈值仍 MUST 来自唯一 YAML。

#### Scenario: Operator tunes a threshold

- **WHEN** 用户修改 YAML 中已声明的安全、评分、观察或 Quote 数值并重启服务
- **THEN** 系统使用新值且无需修改源码

### Requirement: Secrets and configuration history are protected

进程读取的配置文件权限 MUST 为 `600`、其容器内目录权限 MUST 为 `700`，日志 MUST 脱敏 GMGN API Key 与 Telegram Token。每个 Episode 和信号 SHALL 保存配置版本与 SHA-256；配置历史不得保存秘密。

#### Scenario: API error includes an authenticated request context

- **WHEN** 系统记录请求失败、诊断信息或脱敏审计
- **THEN** 输出中不得出现完整 API Key、Telegram Token 或认证头

### Requirement: Phase 1 runs as a minimal durable deployment

系统 SHALL 以单个 Node.js/TypeScript 进程、单个 SQLite 数据库和单个 Docker 容器运行，SQLite 使用持久卷。Phase 1 MUST NOT 读取签名私钥或启用自动交易；配置变化通过重启容器生效，不实现热重载。

#### Scenario: Container restarts

- **WHEN** 容器在持久卷保持不变的情况下重启
- **THEN** 系统恢复事件去重、活动 Episode、Outbox、信号和结果任务，并使用重新校验后的唯一配置继续运行

#### Scenario: Operator configures an env file

- **WHEN** 操作者在项目目录填写 .env 并重新创建容器
- **THEN** 程序以只读文件合并凭据和模式，保持其余 YAML 参数不变；错误和配置历史不输出凭据
