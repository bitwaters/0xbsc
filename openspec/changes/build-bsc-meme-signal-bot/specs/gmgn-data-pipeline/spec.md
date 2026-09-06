## Purpose

规定机器人如何仅使用 GMGN OpenAPI 发现 BSC Meme 机会、控制套餐权重、标准化并去重异步事件，以及在机会失效前为后续判定提供新鲜且可追溯的数据。

## ADDED Requirements

### Requirement: GMGN is the exclusive market-data provider

系统 SHALL 仅通过 GMGN OpenAPI 获取代币、市场、钱包行为、安全和交易可执行性数据，并 SHALL 将链固定为 BSC。Telegram Bot API 仅可用于消息传输，不得成为市场证据来源。

#### Scenario: Unsupported market-data integration is configured

- **WHEN** 配置或代码路径尝试启用 GMGN 以外的市场数据 API
- **THEN** 系统拒绝启动或拒绝该数据进入信号判定

### Requirement: Six discovery families are polled continuously

系统 SHALL 采集 Market Signal、Trenches、Trending、Hot Searches、SmartMoney 和 KOL，并 SHALL 支持每类来源独立配置周期、分组和抖动。快照接口只把新增、状态改变或达到配置排名变化幅度的记录转为事件；排名变化步长默认由唯一 YAML 配置为 5，同一档位内的排名抖动不得重复触发深度分析。

默认采集基线 SHALL 为：高频 Signal 2 秒、叙事 Signal 5 秒、Trenches 三阶段 5 秒、SmartMoney 2 秒、KOL 3 秒、Trending 的 1m/5m/1h 各 5 秒、Hot 的 1m/5m/1h 批量 15 秒、Hot 的 6h/24h 批量 60 秒、Gas 30 秒；每个周期加入约 ±10% 抖动，同一轮询器不得并发重入。

#### Scenario: Multiple sources observe the same token at different times

- **WHEN** 一个代币先后出现在不同发现来源中
- **THEN** 系统分别保留来源事件并将其交给同一代币的活动 Episode 聚合，而不是要求来源同时出现

#### Scenario: Snapshot has no meaningful change

- **WHEN** 新快照的判定字段标准化哈希与该来源、周期和代币的上一快照相同
- **THEN** 系统不生成新事件且不重复评分

#### Scenario: Poll execution lasts longer than its interval

- **WHEN** 某来源的前一轮请求尚未结束而下一截止时间到达
- **THEN** 系统跳过并记录该次重入，不并行启动同一轮询器

### Requirement: Every GMGN request consumes a shared weighted budget

系统 MUST 让所有 GMGN 请求通过一个全局加权限流器。默认服务端上限为每秒 20 权重、持续软件上限为每秒 14 权重，并 SHALL 使用以下初始权重：Trending、Info、Security、Pool、SmartMoney、KOL、Gas 为 1；Kline、Quote、Created Tokens 为 2；Trenches、Hot Searches、Market Signal 为 3；Holders、Traders 为 5。权重支持由唯一配置调整，但调整前必须有官方套餐资料或真实限频观测依据。

#### Scenario: Budget is temporarily insufficient

- **WHEN** 一个请求无法立即取得所需权重
- **THEN** 系统按安全刷新与正式候选、实时发现、已满足证据预门禁的候选分析、观察复评、结果任务的优先顺序调度，且不得超过硬上限

#### Scenario: GMGN returns rate limiting

- **WHEN** GMGN 返回 429 和冷却信息
- **THEN** 系统遵守服务端冷却、记录限频事件并停止立即重试

### Requirement: Verified GMGN response limits are enforced locally

Market Signal MUST 显式携带类型并禁用生产接口拒绝的 Type 14/15/16；每个 Signal Group 最多处理 50 条。Trenches 即使忽略请求 `limit` 也 MUST 本地截断；SmartMoney、KOL、Top Holders 和 Top Traders 每次最多处理 100 条。成功响应没有剩余额度头时，系统 MUST 继续按本地权重记账；429 SHALL 优先使用 `X-RateLimit-Reset` 冷却。

#### Scenario: Trenches returns more rows than requested

- **WHEN** Trenches 响应超过配置的本地最大条数
- **THEN** 系统在适配层确定性截断，且截断前的额外记录不进入事件队列

#### Scenario: Unsupported Signal Type is configured

- **WHEN** 配置把 Type 14、15 或 16 放入生产 Signal 分组
- **THEN** 启动校验失败并指出该类型已被真实接口拒绝

### Requirement: Polling degrades by freshness priority

系统 SHALL 在预算紧张时先延迟结果任务，再降低低分观察 Episode 的定时复评；系统 MUST NOT 延迟已经达到正式条件的安全刷新与 Quote。超过路线最新决定性触发窗口的候选 MUST 标记为 `stale_before_decision`，不得排队后补推送。

#### Scenario: Arrival volume exceeds analysis capacity

- **WHEN** 候选到达量超过当前权重预算可完成的深度分析量
- **THEN** 系统释放低优先级预算并丢弃已陈旧候选，而不是以历史机会补发信号

#### Scenario: Multiple persisted snapshots queue for one token

- **WHEN** 同一代币的候选分析仍在运行且又连续持久化多个新快照
- **THEN** 系统保留当前执行和最新待执行状态，安全地合并中间状态，不让过期快照挤占实时发现预算

### Requirement: Capacity accounting has a reproducible baseline

默认发现计划 SHALL 约为 147 次请求和 265 权重/分钟。60 个活动 Episode 的定时 Info/Kline 复评 SHALL 约消耗 360 权重/分钟；在 14 权重/秒软上限下，预留约 215 权重/分钟给深度分析、Quote 和结果任务。一个完整正式候选的容量估算 SHALL 按最坏约 31 权重计算，对应满观察池时理论约 6–7 个完整候选/分钟；这些数字是容量基线而不是信号数量上限。

#### Scenario: Runtime accounting diverges from the baseline

- **WHEN** 实际分钟权重或请求量持续偏离基线
- **THEN** 系统按端点和任务类别报告差异，以真实观测更新配置，而不是静默提高信号筛选门槛

### Requirement: Events are exactly deduplicated and restart-safe

有稳定来源事件 ID 时，事件键 SHALL 由来源、来源事件 ID 和代币地址构成；无事件 ID 的快照 SHALL 由来源、周期、代币地址、本地变化序号和标准化状态哈希构成。最后哈希和序号 MUST 持久化。

#### Scenario: Process restarts after ingesting a snapshot

- **WHEN** 重启后再次收到与重启前完全相同的快照
- **THEN** 系统从 SQLite 恢复哈希与序号并拒绝生成重复事件

#### Scenario: An unchanged token reappears after evidence expiry

- **WHEN** 快照内容未变化，但该来源上一次证据 TTL 已到期后仍在榜或重新上榜
- **THEN** 系统以递增序号生成一次续期事件，使当前机会可重新参与证据判定；重启恢复不得永久压制该事件

### Requirement: Source timestamps and normalized values are trustworthy

每个事件 SHALL 保存来源事件时间、采集时间、证据族、强度和有效截止时间。比例 SHALL 归一化到 `[0,1]`；原始代币数量、Wei 和 Quote 数量 MUST 使用十进制字符串或任意精度整数；单位不明确的关键值 MUST 视为缺失。

#### Scenario: Source event timestamp is unavailable

- **WHEN** GMGN 响应没有可靠的事件发生时间
- **THEN** 系统使用采集时间判断新鲜度并降低数据完整度

### Requirement: Real API contracts are verified before production polling

系统 SHALL 用真实个人 GMGN API Key 验证已使用端点的认证、字段、分页或历史范围、Signal 类型标签、错误、权重和延迟。未知 Signal Type SHALL 被采集存档，但在映射为语义类别和证据族前不得作为强触发或直接加分。

#### Scenario: A previously unseen Signal Type appears

- **WHEN** 生产采集收到尚无已验证语义映射的 Signal Type
- **THEN** 系统保存脱敏原始样本并将其标记为未映射，不把它用于正式信号触发

### Requirement: A failing source is isolated from other sources

每个轮询器和响应适配器 SHALL 有独立错误边界。超时、业务错误或 schema 校验失败 MUST 记录来源与脱敏响应摘要，并只让该轮失败；不得终止其他来源、活动 Episode、Outbox 或结果任务。只读网络错误最多自动重试一次，业务错误不得立即重试；同一来源连续失败 SHALL 在统一调度器内执行带上限的指数退避，成功一轮后恢复正常周期。

#### Scenario: One discovery response changes schema

- **WHEN** 单个来源返回无法通过适配器校验的结构
- **THEN** 系统隔离该轮数据、产生可定位告警并继续运行其他来源与投递链路

#### Scenario: One source repeatedly fails

- **WHEN** 同一来源连续多轮超时、业务错误或 schema 失败
- **THEN** 系统逐步延长该来源下一次尝试时间并限制最大退避，不让失败轮询持续抢占实时权重

### Requirement: Discovery work and retention are bounded

系统 SHALL 用有界、可合并的候选队列解耦发现采集和深度分析，并保存队列溢出错误。留存 SHALL 分批清理超过配置期限且无业务审计引用的明细，保留候选关联事件与来源恢复快照。HTTP 成功但明确业务 code 失败或缺失成功 envelope data 时 MUST 视为语义失败。

#### Scenario: Slow candidates arrive during continued polling

- **WHEN** 候选分析耗时但发现源有新事件
- **THEN** 事件持久化及证据归并继续推进，同键待处理工作合并且并发与队列大小不超配置

#### Scenario: Retention reaches an event referenced by a candidate

- **WHEN** 候选关联事件早于留存时间
- **THEN** 保留该审计记录，同时允许删除无引用且非最新恢复快照的过期事件

### Requirement: Physical retries share admission and durable rate-limit recovery

系统 MUST 在每次实际 HTTP 尝试前扣除端点权重，网络重试不得继承首次请求的免费通行。调度 SHALL 按权重平滑发送并限制全局在途数量，Quote 使用同一优先队列中的单在途通道。HTTP 状态不得因 JSON 解析失败而丢失；服务端头、reset_at 和 Retry-After 的有效解禁时间取较晚者，并持久化未结束冷却。缺失信息采用有界保守退避，不能立即循环请求。

#### Scenario: Another request triggers a ban before a network retry

- **WHEN** 一个请求网络失败而另一个请求已建立有效冷却
- **THEN** 重试不发出、不扣权重，排队任务收到可恢复的限流原因；冷却结束后只允许一个探测请求，成功后恢复有界并发

#### Scenario: The process restarts before the server reset

- **WHEN** 重启读取同一凭证标识下未结束的冷却与发送节奏状态
- **THEN** 服务继续等待原解禁时间，不能用进程重启清除限制

#### Scenario: Evaluation and formal work request the same endpoint

- **WHEN** 历史结果和即时正式候选均请求 Quote 或 Gas
- **THEN** 请求保留真实用途、原始期限和端点权重；正式请求优先于尚未发送的结果请求，缓存命中不扣 HTTP 权重

#### Scenario: Quote rate limiting occurs below the aggregate Plus budget

- **WHEN** 隔离只读验收证明 Quote 在总权重未耗尽时仍触发限流
- **THEN** 系统保留 Plus 总预算及 Quote 官方权重，另以唯一 YAML 中可审计的端点间隔控制发送节奏；其他接口不因 Quote 等待而被整条队列阻塞，不能跳过任一买卖报价腿
