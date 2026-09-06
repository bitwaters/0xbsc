## Purpose

规定所有运行秘密、轮询周期、阈值、评分、观察、报价、Telegram、存储和评估参数如何集中在一份经过完整校验的 YAML 中，并以最少组件安全部署。

## ADDED Requirements

### Requirement: Runtime configuration has one source of truth

生产进程 SHALL 只读取 `~/.config/gmgn-signal-bot/config.yaml`。所有可调阈值、周期、排名变化步长、开关、路线权重、创建者历史发币数/开放率阈值及最多 5 分的扣分上限、Signal 分组、GMGN API Key、公开 Quote 钱包、Telegram Token、Chat 和允许用户、SQLite 路径及保留策略 MUST 位于该文件，不得分散到 `.env`、源码或其他运行配置。

#### Scenario: Required value is missing or invalid

- **WHEN** 启动时配置缺少必填字段、阈值越界、权重不合计 100 或包含不支持的链
- **THEN** 系统输出不含秘密的明确错误并拒绝启动

### Requirement: Configuration is data, not executable logic

配置 SHALL 只包含数据值，不得支持表达式语言或动态代码。趋势、回调、突破、沉寂、垂直拉升和协议字段解析算法 SHALL 在代码中固定并由测试约束，算法使用的数值阈值仍 MUST 来自唯一 YAML。

#### Scenario: Operator tunes a threshold

- **WHEN** 用户修改 YAML 中已声明的安全、评分、观察或 Quote 数值并重启服务
- **THEN** 系统使用新值且无需修改源码

### Requirement: Secrets and configuration history are protected

配置文件权限 MUST 为 `600`、目录权限 MUST 为 `700`，日志 MUST 脱敏 GMGN API Key 与 Telegram Token。每个 Episode 和信号 SHALL 保存配置版本与 SHA-256；配置历史不得保存秘密。

#### Scenario: API error includes an authenticated request context

- **WHEN** 系统记录请求失败、诊断信息或脱敏审计
- **THEN** 输出中不得出现完整 API Key、Telegram Token 或认证头

### Requirement: Phase 1 runs as a minimal durable deployment

系统 SHALL 以单个 Node.js/TypeScript 进程、单个 SQLite 数据库和单个 Docker 容器运行，SQLite 使用持久卷。Phase 1 MUST NOT 读取签名私钥或启用自动交易；配置变化通过重启容器生效，不实现热重载。

#### Scenario: Container restarts

- **WHEN** 容器在持久卷保持不变的情况下重启
- **THEN** 系统恢复事件去重、活动 Episode、Outbox、信号和结果任务，并使用重新校验后的唯一配置继续运行
