## Purpose

规定正式信号推送前如何使用 GMGN 的真实双向报价验证 10、50、100U 仓位可买可卖、计算完整往返成本，并向用户给出保守的最大安全仓位。

## ADDED Requirements

### Requirement: Each configured position is quoted in both directions

系统 SHALL 先并行取得 10U、50U、100U 的买入 Quote，再把每笔实际买到的代币数量分别并行取得完整卖出 Quote。不得用一个仓位替代另一仓位，也不得仅凭买入 Quote 推断可卖性。

#### Scenario: Buy route exists but reverse route fails

- **WHEN** 任一仓位能够买入但对应全部代币无法获得有效卖出路由
- **THEN** 系统将其视为安全失败并拒绝正式信号

### Requirement: The minimum executable position must pass

10U 双向测试 MUST 通过；默认最大单边损耗与最大往返损耗分别为 2% 和 5%。50U 默认为 3% 和 6%，100U 默认为 5% 和 8%，最大请求滑点默认为 5%。

#### Scenario: Ten dollars passes while larger sizes fail

- **WHEN** 10U 满足完整标准而 50U 或 100U 因冲击成本失败但仍可卖出
- **THEN** 系统允许信号通过，并把 `max_safe_position` 设置为通过完整标准的最大测试仓位

#### Scenario: Ten dollars exceeds cost limit but remains sellable

- **WHEN** 10U 可安全卖出但暂时超过成本阈值
- **THEN** 系统不得推送，可在价格或流动性实质变化且超过最小重试间隔后回到 Quote 判定

### Requirement: Quote cost is calculated once from preserved inputs

系统 SHALL 依据买入输入美元价值、买后代币估值、反向输出美元价值和 GMGN Quote 尚未包含的可确定 Gas 计算单边及往返损耗，并 SHALL 保存所有输入与成本分量。已包含于 Quote 的税、DEX 费和价格冲击 MUST NOT 再次扣除。

#### Scenario: Quote already includes token tax

- **WHEN** 已验证的 GMGN Quote 语义表明输出已扣除代币税
- **THEN** 系统不再按 Security 税率重复扣减，仅保留税率作为风险与审计字段

### Requirement: Delivery uses fresh security and quote data

写入正式投递前，Security 和 Pool 数据 MUST 不超过 30 秒，Quote MUST 不超过 5 秒；Quote 年龄 SHALL 从最旧有效报价腿的实际请求时刻计算，每腿分别保存请求与完成时间；整组完成时间不得刷新较早报价的年龄。系统 SHALL 在有界刷新循环中只刷新当前陈旧的组件，任何刷新后的安全失败 SHALL 拒绝投递。

#### Scenario: Quote expires while delivery decision is pending

- **WHEN** 最终判定时 Quote 年龄超过 5 秒
- **THEN** 系统重新报价或因触发陈旧而终止，不得使用过期报价发送

### Requirement: Quote requests avoid concurrent endpoint bursts

系统 SHALL 在统一全局权重与优先队列内，限制同一运行实例至多一个在途 Quote 请求；正式候选、模拟入场和结果退出共享该通道并按实际用途排队，不得另建不可抢占的 FIFO。单次失败 MUST NOT 使后续排队请求永久阻塞，所有请求仍受原客户端冷却策略约束。

#### Scenario: Concurrent quote legs include a failing request

- **WHEN** 三个仓位同时申请 Quote，其中一个请求失败
- **THEN** 实际 Quote 调用不重叠，失败向调用方传播，后续请求仍通过调度器和冷却检查执行
