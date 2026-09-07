## Purpose

在共享 GMGN 套餐与串行报价通道下隔离市场规则比较和真实执行测试，保护正式推送的资源与延迟，并把无法执行的影子样本显式记录，避免排队竞争被误认为筛选效果。

## ADDED Requirements

### Requirement: Offline comparison does not create per-model API traffic

事实流回放 SHALL 完全离线，多模型读取同一已经采集的输入；新增请求只能由登记模式的公共采集、配对测量和唯一执行影子按父预算申请，不为每个离线模型开流水线。没有对应安全/报价证据的离线样本 MUST 标执行未评估，不能与真实带排队执行样本混为同口径。

#### Scenario: Twelve models replay a dataset
- **WHEN** 候选模型在同一冻结数据集比较
- **THEN** 不发GMGN或Telegram请求，缺少执行证据的条目保留市场研究标签

### Requirement: Research budgets admit weighted endpoints without spending formal reserve

研究新增流量 SHALL 遵守design D6的2权重/s补充、容量5的桶、滚动分钟120上限、物理并发1及父预算；全局仍执行14 soft/20 hard和6 reserve。预算检查与实际准入 MUST 原子化，所有重试重新计权，shadow不得冒充formal。

#### Scenario: A weight-five request waits on an empty research bucket
- **WHEN** 没有其他消耗、桶从0补充2.5秒且全局预算充足
- **THEN** 权重5请求可准入；实现不得因错误的每秒2硬上限永久拒绝该端点

#### Scenario: Several purposes request at once
- **WHEN** 采集、基准和执行同时请求
- **THEN** 子预算总和不能越过研究父预算或花掉正式reserve，未获准者保留资源原因

### Requirement: Formal work can suspend research execution

正式待办/在途、延迟超限、429、cooldown或监控故障 SHALL 暂停新增研究请求。执行影子只允许1个模型、1个在途机会及1个待办；Quote逐腿准入并保持当前响应后间隔。非抢占阻塞上界不满足登记容忍值时 MUST 关闭新增影子Quote，不宣称零影响。

#### Scenario: Formal request arrives while shadow buy is in flight
- **WHEN** 影子买入请求已经开始而正式请求到达
- **THEN** 记录不可抢占阻塞，下一条研究卖腿不得越过正式请求，过期报价不能继续作为新鲜结果

#### Scenario: Quote completion gap increases after throttling
- **WHEN** 物理超时加学习后的间隔超过3秒初始阻塞上限
- **THEN** 禁用新增研究Quote，按协议恢复或要求新预算验证，不缩短服务端冷却

### Requirement: Quote reuse and resource exclusions are auditable

Quote复用 SHALL 匹配链/池版本/钱包/输入输出资产/方向/精确数量/slippage/语义，并满足判定时已返回、TTL和市场刷新条件。超预算或过期 SHALL 记录EXECUTION_NOT_EVALUATED_RESOURCE及原时刻，不补用更晚价格或计成市场拒绝。

#### Scenario: Same token has different buy output amounts
- **WHEN** 两个10U请求得到不同token数量
- **THEN** 不能仅因同token和10U标签复用不匹配的卖出Quote

### Requirement: Mixed-load evidence precedes execution mode

启用execute_shadow前 SHALL 对相同到达流进行研究开/关负载对照，报告正式延迟增量、请求预算、不可抢占等待和影子覆盖。无预算、无测量或实测超阈值 MUST 阻止启用执行模式；observe/off仍可用。

#### Scenario: Budget validation is incomplete
- **WHEN** 配置试图开启新增请求影子但缺少协议或混合负载证据
- **THEN** 拒绝该模式并报告原因，不以默认空预算运行
