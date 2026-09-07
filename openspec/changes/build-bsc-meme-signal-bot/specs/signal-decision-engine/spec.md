## Purpose

规定候选从低成本发现到前置安全过滤、三条互斥路线、有效证据聚合、确定性评分和有限观察 Episode 的完整决策行为，确保信号少而准且能捕捉老币复苏。

## ADDED Requirements

### Requirement: Hard safety filtering precedes expensive analysis

系统 MUST 先利用事件字段和新鲜缓存做零调用过滤，再仅对初步候选并行获取 Info、Security 和 Pool。关键安全字段缺失、不可卖、蜜罐、黑名单、非开源、致命风险或超过配置阈值时，候选 MUST NOT 评分、占用观察名额或调用昂贵深度接口。

默认硬阈值 SHALL 为：买税与卖税各不超过 5%，Top10 持仓不超过 50%，团队持仓不超过 10%，Entrapment、Bundler 和 Sniper 指标各不超过 20%。这些阈值从唯一 YAML 读取。

达到初步正式评分条件后，系统 MUST 在 Episode 最终决策和 Quote 前惰性读取 Holders、Traders 和 Created Tokens。排除已识别池地址后单一持仓默认不超过 20%、可疑持仓累计默认不超过 10%、创建者直接持仓默认不超过 10%，以上均为独立硬 veto。当 GMGN `tags` 或 `maker_token_tags` 命中 YAML 认可标签时，系统 SHALL 通过两个时间跨度有效的快照计算近期买卖增量和余额变化；默认三个及以上钱包各自净售出量达到期初持仓的 5%，且卖出金额增量大于买入金额增量，合计净售出量达到可比较标签钱包期初总持仓的 20%，才判为协调退出。MUST NOT 用 netflow 收益字段符号代替净卖出，也不得相加不同钱包的个人百分比。快照基线不足或余额变化疑似转账时 SHALL 保留具体 unknown 原因并等待复查。响应形状、地址、标签或数值不能明确映射时 MUST 阻止正式推送；这些标签和阈值是可版本化的风险策略而非对钱包主体的事实判定。

创建者累计发币数 MUST NOT 单独成为硬 veto。仅当累计创建超过 YAML 默认值 5 且开放比例低于 YAML 默认值 50% 同时成立时，系统 SHALL 将“持仓与创建者质量”维度从 `1` 降为 `0.5`，并将最终扣分限制为 YAML 配置且不超过 5 分；开放比例达到 50% 时，累计创建数量不得导致扣分。调整后的分数 MUST 重新通过观察与正式门槛，且风险和扣分明细 SHALL 随决策保存。明确的创建者直接持仓等硬风险仍不可由高分抵消。

配置列出的致命 `flags` SHALL 直接拒绝候选。GMGN 返回尚未映射的风险标志或 `is_show_alert` 但系统无法证明其非致命时，候选 MUST 阻止正式推送并保存脱敏样本，直到契约映射明确；不得把未知风险当作安全。

#### Scenario: Candidate fails a hard security condition

- **WHEN** 任一前置或深度安全硬条件失败
- **THEN** 系统结束或拒绝本次 Episode，且任何高分不得覆盖该结果

#### Scenario: Tagged wallets sold at unrelated times

- **WHEN** 三个以上带标签钱包累计卖出达到比例门槛，但最近活动超出新鲜窗口或彼此跨度超过协同窗口
- **THEN** 系统不得仅凭累计卖出比例判为当前协同退出

#### Scenario: Critical field is temporarily missing

- **WHEN** 关键安全字段无法解析或暂时缺失
- **THEN** 系统可在配置的短等待期内重查，但在字段明确前不得继续深度分析

#### Scenario: GMGN adds an unknown security flag

- **WHEN** Security 返回当前版本没有语义映射的风险 flag 或无法解释的告警
- **THEN** 系统不发送正式信号，记录字段和配置版本供契约更新，且不允许评分覆盖

#### Scenario: Prolific creator has a healthy open ratio

- **WHEN** 创建者累计创建数量超过 5，但开放比例达到或超过 50%
- **THEN** 系统不得仅因累计数量拒绝候选或降低分数

#### Scenario: Prolific creator has a low open ratio

- **WHEN** 创建者累计创建数量超过 5 且开放比例低于 50%
- **THEN** 系统最多扣 5 分并用调整后分数重新判定；若仍达到 80 分则可继续正式信号链路并展示风险提示

### Requirement: LP and permission checks respect pool lifecycle

普通 DEX 代币 SHALL 验证 Owner/Mint 权限以及 LP 锁定或销毁比例，默认有效比例不得低于 80%；Launchpad 曲线阶段 SHALL 按 GMGN 给出的平台池和迁移机制判断，不得机械套用普通 DEX 锁仓条件。

#### Scenario: Launchpad token has no conventional LP lock record

- **WHEN** GMGN 明确表明代币仍处于受支持的 Launchpad 曲线阶段
- **THEN** 系统使用平台池例外规则判断，而不因缺少普通 DEX 锁仓字段直接误杀

### Requirement: Every Episode has exactly one primary route

系统 SHALL 按固定优先级将活动 Episode 归为新币启动、老币复苏或趋势延续，且相同链、代币和主路线同时最多存在一个活动 Episode。

#### Scenario: Token matches more than one route superficially

- **WHEN** 同一时刻的特征可能满足多条路线的部分条件
- **THEN** 系统依次按首次启动、沉寂后复苏、趋势回调后延续的语义选出唯一主路线

### Requirement: New-launch signals cover first-stage opportunities

新币启动 SHALL 要求创建不超过 24 小时、首次启动阶段、有效池和真实买卖、至少 10,000U 流动性、成交量/持币人数/资金关注至少一项正在增长，以及一个强触发或两个不同证据族的弱触发。每个代币最多成功推送一次新币启动信号。

#### Scenario: Previously rejected new token receives a fresh trigger

- **WHEN** 代币仍在 24 小时窗口内、先前 Episode 已拒绝或过期且出现新触发
- **THEN** 系统可以建立新的新币 Episode；若已成功推送过新币信号，则后续机会只能进入其他合格路线

重复命中同一惰性安全拒绝原因时，系统 SHALL 在该深度数据的配置 TTL 内复用拒绝结论，不为每个来源事件创建新的终态 Episode；TTL 后的新鲜触发仍可重新评估。

### Requirement: Revival signals require measurable dormancy and reactivation

老币复苏 SHALL 要求创建超过 24 小时、先前存在明确沉寂、至少 20,000U 流动性、当前 5 分钟成交量达到此前一小时已完成 5 分钟窗口均值的 3 倍、swaps 达到 2 倍、突破局部结构，并有至少一项额外资金或注意力确认。若基线为零或样本不足，MUST 使用配置的绝对成交量和 swaps 下限。

#### Scenario: Old token spikes without a valid dormant baseline

- **WHEN** 老币只有价格波动但无法证明此前沉寂，且绝对量与 swaps 也未同时达到下限
- **THEN** 系统不得生成复苏正式信号

#### Scenario: A sent revival later wants to reactivate again

- **WHEN** 同一代币已发送过复苏信号后再次活跃
- **THEN** 系统只有在重新形成配置要求的沉寂阶段并出现新鲜复苏触发后才建立新 Episode

### Requirement: Continuation signals require a healthy pullback and restart

趋势延续 SHALL 要求至少 30,000U 流动性、既有上涨趋势、未破坏结构的缩量回调、重新放量启动、无 SmartMoney 集中退出、Quote 未显著恶化且不处于严重垂直拉升阶段。

#### Scenario: Price rises without a qualifying pullback

- **WHEN** 代币持续垂直上涨但没有满足配置的有效回调与重新启动
- **THEN** 系统不得将其判为趋势延续正式信号

### Requirement: Evidence is asynchronous, capped and expiring

系统 SHALL 将证据归入生命周期、量价结构、资金行为、注意力与叙事四族；同族只保留仍有效的最强证据且不能突破该族或评分维度上限。候选进入深度分析 MUST 至少有一个强触发或两个不同证据族的弱触发，并 MUST 在发起 Info、Security、Pool 或 Kline 深度请求前完成该证据预门禁。生命周期、量价、资金、普通注意力和明确叙事的默认最长有效期分别为 600、180、300、600 和 1800 秒，反向事件 SHALL 立即撤销相关证据。Hot、Trending、普通热度和旧叙事只能支持已有机会，不得单独成为正式信号的决定性触发。

#### Scenario: Supporting source arrives after the first trigger

- **WHEN** 新来源在活动 Episode 和证据有效期内到达
- **THEN** 系统只更新受影响证据、完整度和分数并立即重新判定

#### Scenario: SmartMoney flow reverses before delivery

- **WHEN** 先前资金流入证据仍在 TTL 内但出现同批集中退出
- **THEN** 系统立即撤销对应证据并重新判定，不等待 TTL 自然到期

### Requirement: Scoring is deterministic and gated by completeness

每条路线 SHALL 使用固定合计 100 的维度权重，每一维仅允许 `0`、`0.5`、`1` 三个等级，维度得分为路线权重乘以等级，总分为所有维度得分之和。数据完整度 MUST 等于“已取得且仍新鲜的路线必需字段权重之和 ÷ 该路线必需字段总权重”。正式信号 MUST 同时满足分数至少 80、数据完整度至少 0.70、至少两个独立证据族，以及路线要求的新鲜决定性触发；观察门槛默认为 65。

初始路线权重 SHALL 为：

| 维度             | 新币启动 | 老币复苏 | 趋势延续 |
| ---------------- | -------: | -------: | -------: |
| 生命周期与阶段   |       20 |        5 |        0 |
| 量价与结构       |       25 |       30 |       40 |
| 资金行为         |       25 |       30 |       30 |
| 注意力与叙事     |       15 |       20 |       10 |
| 持仓与创建者质量 |       10 |       10 |       10 |
| 数据与信号时效性 |        5 |        5 |       10 |

新币、复苏、延续的决定性触发默认必须分别发生在最近 90、120、60 秒内。Info、Pool、Kline、Traders、Holders、Creator History 的默认缓存 TTL SHALL 分别为 30、30、60、180、300、3600 秒；超过 TTL 的字段不计分也不计入完整度。缺失字段不得加分，安全关键字段缺失仍直接失败。

创建者历史质量调整 SHALL 使用同一三级维度等级：健康历史为 `1`，累计创建超过 5 且开放比例低于 50% 为 `0.5`；在初始权重下影响分别为 0 分和最多 5 分。系统 MUST 保存调整前分数、调整后分数、实际扣分、累计创建数和开放比例，避免把该统计误报为硬安全结论。

#### Scenario: High score relies on stale or incomplete data

- **WHEN** 计算分数达到 80，但新鲜必需字段完整度不足或没有新鲜决定性触发
- **THEN** 系统不得进入正式投递，只能观察或结束

#### Scenario: Cached deep data expires

- **WHEN** 深度字段过期但新证据使候选补齐后可能达到正式条件
- **THEN** 系统只刷新实际需要的过期字段并重新判定；若候选仍不可能达标则不消耗该调用

### Requirement: Episode transitions are deterministic

发现项在安全失败或初次评分低于 65 时 SHALL 进入 `REJECTED`；达到观察条件进入 `OBSERVING`；达到正式条件进入 `READY`。观察 Episode 到期或连续两次低于 65 SHALL 进入 `EXPIRED`，安全恶化 SHALL 进入 `REJECTED`。`READY` 只有在安全刷新和 Quote 通过后才能进入 `DELIVERY_PENDING`；仅因成本暂时超标且仍可安全卖出时 SHALL 回到 `OBSERVING`。投递最终进入 `SENT`、`SEND_FAILED` 或 `DELIVERY_UNKNOWN`。

#### Scenario: Observed candidate falls below threshold once

- **WHEN** 活动观察 Episode 首次复评低于 65 且未触发安全失败
- **THEN** 系统保留 Episode 到下一次复评；只有连续第二次仍低于 65 才使其过期

#### Scenario: Ready candidate has temporary high round-trip cost

- **WHEN** 候选仍可买卖且安全，但 10U 往返成本暂时超过配置阈值
- **THEN** 系统回到观察状态，并只在实质变化和最小重试间隔满足后再次 Quote

### Requirement: The observation pool is bounded but not quota-limited

活动观察池 SHALL 最多容纳 60 个 Episode，新币、复苏、延续各 20 个仅为软目标。默认观察期分别为 15、30、15 分钟；确认强叙事时最长 60 分钟。满额时 SHALL 依据分数、完整度和证据新鲜度竞争，路线软目标只作为接近候选的平局条件。

#### Scenario: Pool is full when a stronger candidate arrives

- **WHEN** 新候选明显优于池中最低质量候选
- **THEN** 系统降级最低质量 Episode、停止其定时复评并让更强候选入池，不受硬路线配额阻止

### Requirement: Re-evaluation is event-driven and staggered

新证据到达 SHALL 立即触发增量复评；每个活动 Episode 默认每 30 秒刷新一次 Info 和适合路线的 Kline，截止时间 SHALL 分散在窗口内。Holders、Traders 和 Creator 仅在候选可能达标且缓存过期时按需刷新。

#### Scenario: Sixty Episodes become active

- **WHEN** 观察池达到容量上限
- **THEN** 系统把定时复评均匀分散，避免同一时刻产生请求尖峰

### Requirement: Momentum breakouts receive bounded observation without bypassing continuation confirmation

通过硬安全门、最低证据门和流动性门的旧币，在 Kline 已突破且保持上升趋势但尚未形成健康回调与放量重启时，SHALL 以 continuation 兼容语义进入有界观察。该兼容路径 MUST NOT 直接产生正式信号；垂直拉升期间 SHALL 继续观察，只有后续标准 continuation 条件完整成立且垂直拉升消失后，才允许按 80 分正式门槛继续。

#### Scenario: Old token breaks out vertically before a pullback

- **WHEN** 旧币安全、流动性、证据、突破和上升趋势均满足，但健康回调或重启尚未完成
- **THEN** 系统创建或复用 continuation 观察 Episode，不创建 Quote 或 Telegram 正式信号

#### Scenario: Momentum watch cools into a confirmed continuation

- **WHEN** 同一 Episode 后续形成健康回调与放量重启、不再垂直拉升，且全部新鲜度和评分门槛满足
- **THEN** 系统可以进入标准 continuation 正式判定

### Requirement: New-launch activity and growth use independent market evidence

新币“真实交易” SHALL 接受一分钟存在买单且总 swaps 为正，不要求同一分钟必须存在卖单。增长 SHALL 由一分钟成交量相对五分钟均值加速独立满足；强资金标签和普通排行注意力均不得代替成交量增长。

#### Scenario: Buy-only first minute has verified swaps and strong capital evidence

- **WHEN** 新币一分钟有买单、总 swaps 为正、卖单为零且存在强资金证据
- **THEN** 真实交易条件可以成立，但若没有可验证成交量加速，增长条件仍不成立，其他门槛照常执行

### Requirement: Scheduled observations use a bounded soft-failure grace

定时复评时若最低证据门已不成立或路线软失配，系统 SHALL 从首次失配起保留配置宽限期，并更新下次复评时间；重复失配不得延长该宽限或原 Episode 到期时间。宽限内不得凭陈旧证据正式发送，硬安全风险仍立即拒绝。

#### Scenario: Due Episode has no active minimum evidence

- **WHEN** 一个 OBSERVING Episode 到期复评，但其最低证据已经过期
- **THEN** Episode 在宽限内安排未来复评，宽限到期则结束，不会在下一次 250 毫秒循环无条件再次出现

### Requirement: Formal completeness requires real fresh inputs

系统 MUST 验证 Info 的价格和流动性、与主池匹配的有效 Pool、路线必需的连续已完成 Kline，并使用实际采集时间检查新鲜度。强资金或 attention MUST NOT 代替结构证据，普通 attention 不得刷新决定性触发时间。

#### Scenario: Empty candles arrive with strong capital and attention

- **WHEN** Info 和证据存在但 Kline 为空或必要覆盖不完整
- **THEN** 完整度不能为 100%，且不得产生正式信号

### Requirement: Research prewatch and V2 never imply delivery permission

系统 SHALL 在可配置容量、期限和调度预算内保存预观察候选与 V2 对照决策。研究模式可补采市场数据，但 MUST NOT 绕过正式证据门创建投递或交易。尚未获取的惰性安全、Quote 与发送前复核 SHALL 明确列为待验证。

#### Scenario: V2 qualifies before the old rule

- **WHEN** 新的结构和持续买入条件达到影子候选门槛
- **THEN** 系统保存特征、样本、评分和原因，且 deliveryQualified 仍为 false

### Requirement: READY candidates cannot become unscheduled after transient failures

系统 MUST 为 READY 候选保存有限的复评时间和原观察终点。Quote 或其他正式阶段请求发生临时错误时，系统 SHALL 在同币串行处理内部保存具体原因、按限流冷却安排重新观察，且不得延长原观察终点。READY 也必须接受定时复评和到期清理。重启恢复 SHALL 对无投递记录的 READY 重新验证，不能直接发送旧决策。

#### Scenario: A buy Quote returns HTTP 429 after formal scoring

- **WHEN** 候选已经写入 READY，但 Quote 请求因 429 抛错
- **THEN** 候选按冷却时间回到 OBSERVING，保留冻结入场与原观察终点，下一次必须重新通过行情、安全、新鲜度和 Quote 门槛

### Requirement: Proven unattempted cancellations permit independent fresh opportunities

旧发送前取消记录 SHALL 保持终态。只有 `pre_send_cancelled` 且无 Telegram 请求时间、发送快照、确认记录时，新的独立触发 MAY 建立新的 Episode。新触发 MUST 晚于旧周期结束、满足新鲜窗口及路线重置条件；实际尝试或发送结果未知的旧信号不得借此重复发送。

#### Scenario: Buy pressure recovers after an unattempted cancellation

- **WHEN** 买压丢失导致发送前取消，之后出现满足路线重置的新鲜独立触发
- **THEN** 系统允许建立新候选重新经过全部安全和报价检查，旧信号保持取消且不可补发

### Requirement: Holder vetoes preserve specific evidence quality reasons

系统 SHALL 区分非池单钱包超限、可疑持仓累计超限、池身份缺失和响应字段不完整。已识别池合约 SHALL 在钱包标识检查前排除。缺失或重复钱包、没有非池钱包的列表仍 MUST 阻止正式发送，不能将未知解释为安全。

#### Scenario: A known pool has no wallet suspicious flag

- **WHEN** 池地址可识别、非池钱包字段完整，但池合约缺少钱包可疑标识
- **THEN** 池合约不会造成钱包字段误判；非池钱包仍须通过原有集中度阈值

#### Scenario: An orphan READY already exceeded its observation horizon

- **WHEN** 重启或定时扫描遇到已到期 READY
- **THEN** 系统将其结束，不补发过期信号，也不继续占用活动候选名额
