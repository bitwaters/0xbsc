## Purpose

建立能够从相同市场事实重现相同决定的统一机会模型，并把研究资格、风险执行资格及真实投递隔离，使模型切换可追踪、锚点不可漂移且历史发送与回滚行为保持可靠。

## ADDED Requirements

### Requirement: Models are complete versioned decision contracts

模型 SHALL 明确必需字段、来源/时效、表达式、参数、激活/确认/失效/重置、机会期限与入场约束。判定 SHALL 输出逐阶段PASS/FAIL/UNKNOWN/NOT_EVALUATED及输入身份，不得自由执行任意脚本或临时替换参数。正式及影子 MUST 使用同一模型判断语义，差别仅在允许的执行与发布模式。

#### Scenario: A model omits its reset predicate
- **WHEN** 尝试加载缺少重置或必需参数的manifest
- **THEN** 加载失败并给出契约错误，不由运行时代填默认规则

#### Scenario: Same facts are replayed after restart
- **WHEN** 输入身份、状态和模型版本一致
- **THEN** 决定和机会身份保持一致，不因为新的进程时间变成新启动

### Requirement: Market opportunity identity cannot drift

系统 SHALL 冻结机会起点/价格、激活事实与模型版本，并采用持久化的状态转移和并发保护。新机会 MUST 有重置后新事实上的重新激活，不能由旧事件续期、发送失败或报价刷新生成。池变化 SHALL 使原机会失效并触发新池验证。

#### Scenario: Price rises while quotation waits
- **WHEN** 最新价格违反原模型的入场约束
- **THEN** 原机会等待或失效，不能通过抬高锚点或切换较宽模型创建发送资格

#### Scenario: Pool migrates while delivery is unknown
- **WHEN** token出现新池但旧发送仍为UNKNOWN
- **THEN** 可以记录新池研究，跨池防重发锁继续生效，不产生第二条真实推送

### Requirement: Research does not bypass safety or delivery integrity

新引擎 SHALL 保留所绑定风险策略的硬约束，UNKNOWN不得发送；最终复核 SHALL 只验证原机会与最新事实，不重新拼凑旧路线分数。真实发送 SHALL 仅由唯一已选择publisher发起，卡片、请求快照及其市场基准保持不可变。

#### Scenario: Trader baseline is missing
- **WHEN** 必需协调退出检查没有可比基线
- **THEN** 进入数据等待，不视为安全通过，也不把该机会误记为永久市场失败

### Requirement: Validated publication requires matching promotion evidence

validated发布模式 MUST 验证模型、风险、基准、预算、代码契约和数据集状态与晋级凭据一致；无有效凭据时停止publisher启动，不静默切legacy。research off以及未配置新节点时 SHALL 保持原部署行为。

#### Scenario: Model changes after passing validation
- **WHEN** 参数或表达式哈希与凭据不同
- **THEN** 禁止validated启动并报告不匹配，明确配置legacy后才可运行legacy

### Requirement: Cutover and rollback preserve delivery locks

切换 SHALL 排空可结束的旧准备并保留已发送/UNKNOWN防重发状态，研究READY不得被旧版本误投递。回滚 MUST 使用兼容增量数据库的镜像，不回灌旧DB、不清除投递锁，旧历史解读仍有效。

阶段A SHALL 登记能识别全局投递锁和decision_format的兼容legacy镜像作为最低回滚版本。切换 MUST 持有唯一发布租约，并隔离另一格式的未完成准备；阶段D前冻结新适配器干运行路径，阶段E只激活该路径。

#### Scenario: Rollback follows a new-engine delivery
- **WHEN** 已有新模型发送记录后回到legacy
- **THEN** 旧publisher识别该token的发送/未知锁，不重发该机会，历史快照不改变

#### Scenario: Rollback image predates compatibility support
- **WHEN** 目标镜像无法识别新全局锁或投递格式
- **THEN** 回滚检查失败，不启动该publisher，也不通过恢复旧DB绕过检查
