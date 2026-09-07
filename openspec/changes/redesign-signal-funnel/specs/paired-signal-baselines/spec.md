## Purpose

分别报告相对卡片、确认后市场及报价模拟执行的结果，通过不可改写的价格时间配对、明确的采样与截断协议，防止推送前涨幅、排队延迟和缺失数据被误计为推送后的高命中率。

## ADDED Requirements

### Requirement: Card and post-confirmation baselines remain separate

系统 SHALL 分开保存card_reference、post_confirmation_market和post_confirmation_quote及协议版本。主市场轨道 MUST 选择design D5规定的第一份合格确认后行情，将价格与实际可用时点配对；卡片价格不能用确认时间重新标记。已发卡片和旧结果 MUST NOT 被改写。

阶段C离线选择 SHALL 仅使用D5定义的独立decision_market_replay协议，不依赖逐模型在线准备；此诊断版本 MUST NOT 混入阶段D确认后市场轨道或作为正式晋级证据。

#### Scenario: Price already rose before confirmation
- **WHEN** 卡片为1.00，确认后第一合格基准为1.30，之后仅在1.30到1.31之间
- **THEN** 卡片参考轨道可以达到相对1.00的1.3x，但新主市场轨道不得判为1.3x成功

#### Scenario: Price timestamp cannot be verified
- **WHEN** 确认后请求返回缺少可靠价格时间的Info
- **THEN** 主轨道保持UNVERIFIED/MISSING，不回退为卡片价或以HTTP时间伪装价格时间

#### Scenario: Offline selection has no per-model preparation
- **WHEN** 阶段C候选仅在事实流中产生市场合格决定
- **THEN** 以决定时已可用且来源合格的价格按独立诊断协议比较，不新增报价，也不把它当确认后可执行收益

### Requirement: Physical time controls eligibility and recovery

系统 SHALL 根据物理请求开始与响应时间执行采样上限，而非provider调用前时间；等待上限、次数及来源年龄按协议冻结。第一份有效基准通过原子写入确定，后到更低价格不得覆盖。无基准记录 MUST 保留在全部应评估样本中。

#### Scenario: Quote queued immediately but dispatched late
- **WHEN** 逻辑调用发生在确认后1秒但实际Quote请求在确认后6秒才发出
- **THEN** 不纳入5秒协议的有效基准，报告排队迟到与缺失

#### Scenario: Restart occurs after baseline deadline
- **WHEN** PENDING采样恢复时已经超过原协议期限
- **THEN** 终结为缺失而不重新定入场价，后续数据只能作为诊断

### Requirement: Market and executable outcomes use compatible coordinates

市场路径 SHALL 从配对的市场基准之后开始，边界内不能证明先触达时标UNKNOWN。执行收益 MUST 使用确认后买入Quote数量与相同数量的后续卖出Quote，不使用K线高点充当成交。真实确认与模拟确认 SHALL 有不同标志，模拟延迟在数据使用前固定。

#### Scenario: Candle spans the price observation boundary
- **WHEN** 无法排除目标已在基准实际可用之前触达
- **THEN** 该目标为UNKNOWN，不按响应后首根高点直接判TP

#### Scenario: Exit route cannot be observed
- **WHEN** 市场达到2x但没有合格卖出报价
- **THEN** 市场结果与执行缺失分别展示，不声称可实现2x收益

### Requirement: Outcome horizons and denominators are immutable

系统 SHALL 使用冻结目标倍数、下跌线、观察上限和采样协议；重试只改调度时间，不改入场/退出坐标。每轨道每目标 SHALL 同时报告TP、SL、未触达、截断、未知、无基准及全部应评估样本；条件率不得冒充总体胜率。

#### Scenario: Lifecycle observation reaches resource horizon
- **WHEN** 24h共同观察上限结束且没有确定先触达
- **THEN** 保留NOT_TOUCHED/CENSORED或UNKNOWN，不按到期判亏，不无限延长直到出现盈利

#### Scenario: Legacy card-only result is imported into a report
- **WHEN** 历史样本只有发送前价及旧60min轨道
- **THEN** 单独列为旧版本，不混入新24h确认后轨道的验收分母
