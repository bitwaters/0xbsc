## Purpose

规定机器人如何用一致、可复核的入场与检查点口径评价正式信号和漏选样本，同时度量端到端延迟、GMGN 权重容量与运行健康，支持以样本数量而非开发天数验收。

## ADDED Requirements

### Requirement: Formal entry is measured after Telegram confirmation

Telegram 确认成功后，系统 SHALL 异步并行取得 10/50/100U 新买入 Quote，作为模拟跟单入场，并保存触发、推送前 Quote、Telegram 确认和模拟入场时间。该任务不得阻塞消息发送。没有有效模拟入场 Quote 时，对应仓位的可执行收益 MUST 记为缺失，不得用市场价格替代。

#### Scenario: Entry quote starts too late

- **WHEN** 模拟入场 Quote 在 Telegram 确认超过 5 秒后才开始
- **THEN** 系统标记为延迟样本且不把它纳入主要可执行收益口径

### Requirement: Market and executable returns remain distinct

系统 SHALL 分别计算基于 GMGN Kline/价格的市场收益，以及按模拟买入后实际代币数量取得卖出 Quote 的可执行收益；二者不得混合。

#### Scenario: Price rises but exit liquidity deteriorates

- **WHEN** Kline 市场收益为正而卖出 Quote 显示高成本或无法退出
- **THEN** 报告分别呈现市场收益与可执行结果，不把账面上涨计为可执行盈利

### Requirement: Outcome checkpoints and path metrics are reproducible

系统 SHALL 按配置的 1、3、5、15、30、60 分钟及可选叙事 120、240 分钟检查点采集结果，并计算 MFE、MAE 和 TP/SL。正式信号 MUST 在 Telegram 确认时固化发送前最新 Info 价格作为全部市场检查点的统一入场价格；未推送 Episode MUST 使用首次合格决策的价格。不得把每个检查点第一根 Kline 的收盘价重新当成入场价。正式信号的检查点卖出 Quote 若在目标时间超过 10 秒后才开始或完成，MUST 标记为 `late` 且不进入该检查点主要可执行收益。若单根最小粒度 Kline 同时触及止盈和止损且无法判断顺序，结果 MUST 标记为歧义而不得推断顺序。

#### Scenario: Both TP and SL are crossed in one candle

- **WHEN** 检查粒度内同一根 Kline 的高低点同时跨过配置止盈和止损
- **THEN** 系统保存 `ambiguous_same_candle`，不把该样本归入先止盈或先止损

#### Scenario: One-minute checkpoint has one candle

- **WHEN** 一分钟结果窗口仅包含一根完成 Kline
- **THEN** 系统仍以确认时固化价格计算收益和路径，不得因首尾为同一根 Kline 而把市场收益固定为零

### Requirement: Qualified but unsent Episodes are sampled within a bounded scope

系统 SHALL 为所有达到 65 分但未推送的 Episode 保存拒绝或过期原因、特征快照、配置版本和后续市场样本，以度量漏选；这包括通过 Info/Security/Pool 前置安全门但在评分后被 Holders/Traders/Creator 惰性安全门拒绝的候选，且跟踪只用于离线分析、绝不绕过正式安全门。创建者历史触发调整时还 MUST 保存调整前分数、调整后分数、实际扣分、累计创建数和开放比例。普通样本默认跟踪 60 分钟，强叙事样本最长 4 小时；默认只采集价格、Kline MFE/MAE 和结构结果，不执行三档 Quote。低于 65 分或前置 Info/Security/Pool 安全失败的候选可以保存判定审计，但 MUST NOT 创建结果采样任务。结果任务 SHALL 作为 SQLite 到期任务执行，不建立第二个内存观察池。

#### Scenario: A rejected token later performs strongly

- **WHEN** 达到 65 分但未推送的 Episode 在后续检查点显著上涨
- **THEN** 系统能够追溯拒绝原因和当时配置版本，用于离线调参而不回补历史信号

#### Scenario: A low-score discovery item is rejected

- **WHEN** 候选低于 65 分或前置安全失败
- **THEN** 系统保留必要审计字段但不安排持续结果采样，不消耗后续 Kline 或 Quote 配额

#### Scenario: Re-evaluation repeatedly schedules the same unsent checkpoints

- **WHEN** 同一 Episode 在多个发现事件或定时复评中仍达到未推送跟踪门槛
- **THEN** 每个未推送 `Episode + checkpoint` 只存在一条结果任务；后续正式发送独立创建 `Signal + checkpoint` 任务，保留原未推送样本，执行结果只按该任务 ID 写入

#### Scenario: Ordinary unsent tracking is configured for sixty minutes

- **WHEN** 未推送 Episode 没有可验证的强叙事且检查点配置包含 120 或 240 分钟
- **THEN** 系统只创建不超过 `evaluation.unsent_tracking_minutes` 的检查点；正式信号不受此上限影响

#### Scenario: An unsent Episode is re-evaluated

- **WHEN** 同一 Episode 的特征、原因或分数发生变化
- **THEN** 系统保留首次决策快照并单独更新 latest 快照，离线分析可同时复盘入场判断与最终判断

### Requirement: Latency is segmented and empirically calibrated

系统 SHALL 分别记录来源事件、采集、排队、各 API 批次、判定、Outbox、Telegram 请求和确认时间，并按延迟路径报告真实样本数量、负载档位、P50/P95/P99、失败率和阶段拆分。已有深度数据路径的 3 秒 P50/5 秒 P95、首次完整分析的 6 秒 P95，以及 GMGN Signal 和 Trending/Trenches 的 15 秒 P95 只作为开发期理论性能预算。系统 MUST NOT 把这些数字保存或展示为已验证基线、生产承诺或不可调整的发布门禁；真实基线和运行阈值只能在 T14 使用真实 GMGN API 与测试 Chat 完成分路径观测后建立。

#### Scenario: Candidate spent time in observation

- **WHEN** Episode 在正式条件成立前观察了数分钟
- **THEN** 系统单独报告观察等待，不把它计入 qualifying trigger 后的处理延迟

#### Scenario: Only theoretical latency estimates are available

- **WHEN** T14 尚未积累并报告对应路径的真实延迟样本
- **THEN** 系统把 3/5/6/15 秒标记为理论预算，仅报告当前观测值和样本量，不得宣称该路径已经验证达标或失败

#### Scenario: Live latency calibration completes

- **WHEN** T14 已按路径和负载档位完成真实 API 与测试 Chat 观测
- **THEN** 系统保存实测基线、样本范围和建议阈值的配置版本，并保留理论预算与实测结果的差异

### Requirement: API capacity and failures are observable without log explosion

成功 API 调用 SHALL 按端点和分钟聚合请求数、权重、P50/P95 和状态码，并保留最多一个滚动诊断窗口的实际发送、排队、权重、用途、重试与候选关联记录，分批到期删除；错误、429、重试、超时和慢请求 SHALL 逐条保留。系统 SHALL 监控活动 Episode、去重率、深度分析量、陈旧量、推送量、Quote 拒绝量、投递失败和结果任务积压。

#### Scenario: Rate usage approaches the software limit

- **WHEN** 分钟或秒级权重利用率接近配置软上限
- **THEN** 监控数据能够显示来源、优先级和延迟退化，且成功请求不会被永久逐条写入造成数据库膨胀

### Requirement: Quality validation is sample-count based

开发验收 SHALL 不设置固定运行天数；新币启动、老币复苏和趋势延续各累计至少 100 个独立正式信号后，才进行对应路线的稳定性与命中率结论。

#### Scenario: Calendar time passes without enough route samples

- **WHEN** 某路线运行很久但尚未积累 100 个独立正式信号
- **THEN** 系统继续积累样本且不因天数到达而宣称该路线质量验收完成

### Requirement: Evaluation coordinates and historical quality are immutable

系统 MUST 独立冻结入场价、entry_at_ms、target_at_ms、观察终点和评估版本；next_attempt_at_ms 只负责重试调度。安全拒绝、消息编辑和重试不得移动入场或目标。缺少可信原始基准的历史结果 SHALL 标记 legacy，不得以后来价格回填后混入新口径。

#### Scenario: A one-minute checkpoint retries ten minutes later

- **WHEN** 原定一分钟结果任务推迟执行
- **THEN** 市场路径仍截止原定目标，报价明确标记延迟，且初始价格不变

### Requirement: Path-first quality reports disclose coverage and first-touch uncertainty

系统 SHALL 以 1.3/1.5/2/3 等配置倍数、达标前入场跌幅、上下阈值首次触达和高点后回撤为主要路径指标；固定时间收益为辅助。市场机会与可执行收益 MUST 分开。主命中率 SHALL 为先达上涨目标数除以可判定总数，后者包括先达下跌界限和完整期未触达者；全部纳入数、待观察、未知和可判定覆盖率必须同时报告。报告按配置、路线和已发/未发队列分组并对 token 去重；未完成机会周期建模前保守采用各组首次 Episode。

#### Scenario: An entry-straddling or incomplete candle path cannot prove the outcome

- **WHEN** 存在入场前高低点混入、覆盖缺口、无时间戳或同根上下同时触达
- **THEN** 系统不得输出伪精确最高倍数或猜测先止盈；能够由完整前缀证明的首次触达可以保留，其余标记未知

#### Scenario: The observation horizon ends without touching either barrier

- **WHEN** 全部路径完整且上下目标都未触达
- **THEN** 样本计入可判定组的未触达项，而非从主命中率分母删除

#### Scenario: Only the boundary candles straddle the frozen observation window

- **WHEN** 行情连续且均已收盘，仅入场或目标时间落在 K 线内部
- **THEN** 系统 SHALL 报告 bounded 覆盖与保守上下界，保持原始入场和目标不变，不将边界不确定性误计为缺失行情

#### Scenario: Missing historical candles require repair

- **WHEN** path-v2 结果存在缺口或尚未收盘的 K 线
- **THEN** 系统 SHALL 使用全局加权调度进行有限次数补采，保留首次结果和原始退出报价，区分缺口与未收盘，并在预算耗尽后保留未知结论

### Requirement: Prewatch work deadlines and delivery failures are distinct

预观察研究 SHALL 使用独立的短请求期限，不刷新正式证据或执行正式候选恢复。推送前取消、准备失败、Telegram 发送失败与投递未知 SHALL 分别统计；历史取消不得重新投递。

#### Scenario: Research outlives its original discovery event

- **WHEN** 观察窗口有效但源事件已过期
- **THEN** 研究可采集新行情，正式证据时间保持不变，失败研究释放观察容量，限流则等待后续调度

#### Scenario: Buy pressure disappears before delivery

- **WHEN** 最新行情在调用 Telegram 前不再满足推送规则
- **THEN** 系统 SHALL 记录推送前取消，保留取消原因，不增加 Telegram 发送失败数
