## Purpose

使 GMGN 发现、行情及风险输入成为有来源时间、物理请求时间、可用时间与质量状态的可审计事实，让研究模型使用同一母集并揭示缺失和资源排除，避免由旧筛选或缓存产生无法复现的结果。

## ADDED Requirements

### Requirement: Facts preserve point-in-time provenance

系统 SHALL 为每个业务响应保存独立事实身份、端点/池版本、原始物理attempt、排队/请求/返回时间、来源时间状态、语义版本、内容哈希和经过允许字段清单过滤的数据。重放 MUST 仅使用评价时刻已经返回的事实，HTTP Date或代币创建时间 MUST NOT 充当行情来源时间。

#### Scenario: A response arrives after a historical decision
- **WHEN** 某响应在判定时间之后才返回，即使其来源时间较早
- **THEN** 该历史判定不得使用该响应，后续判定可以引用并保留原时间

#### Scenario: A cached payload is read again
- **WHEN** 多次评估复用同一个响应
- **THEN** 事实身份和来源时间保持不变，不增加独立确认次数

#### Scenario: Price source time is unknown
- **WHEN** GMGN响应缺少经过验证的价格来源时间
- **THEN** 数据可作为标记不确定的研究诊断，不能伪造确认后可靠基准

### Requirement: Universe admission is independent of legacy market gates

系统 SHALL 在旧评分/路线/证据市场准入之前建立公共发现母集，按固定seed和分层采样清单选择跟踪对象。每个模型 SHALL 得到相同的已采集事实，不得通过自己的通过结果单独提高采样优先级。来源风险仍可阻止交易与发送。

#### Scenario: Legacy rejects a token for missing evidence
- **WHEN** token已被发现但没有旧要求的证据家族
- **THEN** token仍在公共母集中，按公共采样协议进入研究，不能绕过安全直接推送

#### Scenario: Collection capacity is full
- **WHEN** 新候选无法进入热集或到期任务队列
- **THEN** 保留母集记录、分层及RESOURCE_EXCLUDED原因，不删除为“未发现”或计作市场失败

### Requirement: Data quality has explicit unsupported and unknown states

系统 SHALL 检查金额单位、比例分母、K线连续/边界/冲突、钱包覆盖及累计计数语义，并输出字段支持矩阵。交易次数、头部钱包或滚动窗口差分 MUST NOT 冒充全市场新增独立资金。模型必需字段不支持时 SHALL 拒绝该模型的验证运行。

#### Scenario: A proposed feature requires unique new buyers
- **WHEN** 现有输入只有交易次数或头部交易者快照
- **THEN** 审计输出UNSUPPORTED_FEATURE，不构造独立买家数并静默放行模型

### Requirement: Research data is bounded and free of credentials

研究数据 SHALL 按design D3的容量、保留和打包策略管理。API认证头、密钥、Telegram凭据和私钥 MUST NOT 进入事实、数据集或提案。存储不足 SHALL 停止新增研究并记录不完整运行，不删除仍被验证引用的样本维持表面覆盖。

#### Scenario: A pinned dataset exceeds storage budget
- **WHEN** 引用事实使研究存储达到登记上限
- **THEN** run标记STORAGE_BUDGET_EXHAUSTED或INCONCLUSIVE，正式历史和冻结卡片不被清理

#### Scenario: Online payload is pruned after verified archival
- **WHEN** 被引用的事实payload已打包并校验后清理在线副本
- **THEN** fact_id目录及决定引用保留，回放能通过校验和定位归档，归档仍计入容量预算
