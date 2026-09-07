## Purpose

把筛选条件的发现、模型选择和最终前向验收分为互不冒充的数据用途，规定有限候选、点时样本、明确失败出口及可核验的晋级凭据，防止反复调参和挑选停止时点导致虚假的高命中率。

## ADDED Requirements

### Requirement: Research produces complete bounded candidate manifests

研究 SHALL 按design D7最多登记12个候选及参数推导，候选必须有完整输入、表达式、窗口、阈值、确认/失效/重置与期限。即时、短确认、回踩仅为互斥研究假设，不得同时成为永久必过漏斗。无可行候选 SHALL 输出NO_PROMOTABLE_MODEL。

#### Scenario: Selected data cannot support a feature
- **WHEN** 候选需要未支持的资金粒度或独立买家信息
- **THEN** 该候选不能进入正式验证，不通过新增默认值凑足条件

### Requirement: Development selection and final test datasets have distinct uses

系统 SHALL 按时间和chain+token分组隔离开发、选择及冻结后的最终集，保留dataset身份和已消费状态。选择集可用于挑条件，但 MUST NOT 再提供最终独立证明；标签、归一化及价格时点不得泄漏未来信息。

#### Scenario: Same token reappears in a different pool
- **WHEN** token已在开发集出现，随后新池进入最终采集窗口
- **THEN** 它不能通过换pool身份进入最终独立token组

#### Scenario: Test results inform a parameter change
- **WHEN** 最终结果被用于改条件或选新模型
- **THEN** dataset标为已消费，新模型必须使用新的未查看最终数据

### Requirement: Final evaluation follows a precommitted stopping protocol

最终测试 SHALL 冻结唯一模型、对照、基准、风险、预算、指标、容许差异和截止；遵循design D7固定一次评价及30天采集+24h成熟+2h补采上限。至少100token和80%可判定仅为检查点，不构成盈利或显著性保证。

#### Scenario: Metrics look good before scheduled cutoff
- **WHEN** 提前观察到有利收益
- **THEN** 不得据此提前通过；若用于决策则消费该集合，不再称独立最终测试

#### Scenario: Deadline arrives with too few valid baselines
- **WHEN** 截止后基准或先触达覆盖低于要求
- **THEN** 输出INCONCLUSIVE，不延长同一集合直到指标变好，也不删除缺失样本

### Requirement: Promotion requires joint quality coverage and operational evidence

晋级 SHALL 同时满足design D7的共同母集、第一合格机会、条件率/全部率、1.3x改善、2x非劣、捕获率、SL、成本、安全、覆盖及不确定性门禁。所有指标按配对基准版本分开，使用登记的token级成对重采样方法；无有效分母/界限时不得通过。

样本量和覆盖 SHALL 对两模型分别检查，分母为安全门后、执行前的第一市场合格机会，准备失败不得删除。主改善 SHALL 通过D7最坏缺失分配的敏感性门；成本 SHALL 按原10U准备roundTripLoss语义、双向新鲜报价和D7的中位数/P95及准备失败非劣界限判断。阶段C缺执行证据只能输出市场选择，阶段D另做完整执行验证。

#### Scenario: A model wins by publishing only one successful token
- **WHEN** 条件命中很高但样本/捕获/覆盖门不满足
- **THEN** 不生成晋级凭据，不能把零或极少推送判为高质量

#### Scenario: Price path wins but execution quality degrades
- **WHEN** 市场指标通过而安全或执行覆盖/成本门失败
- **THEN** 整体不晋级，分别报告市场效果与执行失败

#### Scenario: Better collection alone explains apparent improvement
- **WHEN** 新模型已证实成功率更高，但对照未知样本的保守分配足以消除主改善
- **THEN** 返回INCONCLUSIVE_MISSINGNESS，不将采集差异认定为筛选规则增益

#### Scenario: Preparation fails after market qualification
- **WHEN** 市场合格机会无法完成双向报价或因资源过期而没有虚拟确认
- **THEN** 仍在该模型分母中，基准缺失原因标MISSING_PREPARATION，不只比较报价完成者

### Requirement: Promotion evidence is immutable and version-bound

系统 SHALL 生成绑定模型、数据、基准、预算、风险及代码契约的晋级记录，仅PASS且未消费的匹配凭据可供validated模式引用。FAIL/INCONCLUSIVE/NO_PROMOTABLE_MODEL是有效研究交付，不得伪标为实施中的策略成功。

#### Scenario: A passed model is deployed with a different risk policy
- **WHEN** 风险策略哈希与凭据不一致
- **THEN** 凭据验证失败，需要对变更重新形成证据，不静默继承原胜率

#### Scenario: Semantic execution code changes after final validation
- **WHEN** 阶段E发布适配器或其准备逻辑与最终测试冻结构建产物的语义哈希不同
- **THEN** 拒绝沿用旧凭据，不能以只是部署改动为由跳过重验
