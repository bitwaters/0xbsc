## Purpose

规定通过 Telegram Bot HTTP API 可靠发送、更新和管理信号的外部行为，包括 SQLite Outbox 恢复、按钮权限、投递不确定性以及单一 Episode 的消息一致性。

## ADDED Requirements

### Requirement: Signal decision and outbox intent are atomic

系统 SHALL 在同一 SQLite 事务中固化最终判定、唯一信号 ID、配置版本、Quote 快照和待投递状态。每个 Episode 最多创建一个信号记录。

#### Scenario: Process crashes before Telegram request

- **WHEN** 数据库事务已提交但 Telegram 请求尚未发出时进程退出
- **THEN** 重启后系统从 Outbox 恢复并继续该投递，不重新生成信号判定

### Requirement: Delivery refreshes displayed market data immediately before rendering

每次初始发送、延迟发送或恢复发送在渲染 Telegram 卡片前，系统 SHALL 通过统一 GMGN 调度器刷新 Info，并把价格、MC、流动性、持有人数、浏览热度和刷新时间原子写回 Outbox 决策。若刷新发现价格或流动性达到配置的实质变化阈值，或原 Quote 已超过五秒，系统 MUST 有界重做 Quote；触发已经陈旧或新 Quote 不再通过时不得发送。确认发送后 SHALL 冻结原始卡片，不得继续编辑价格、评分、依据或原始时间。

#### Scenario: Market moves while Quote and Telegram work are pending

- **WHEN** 安全阶段 Info 快照与实际发送前 Info 相比已发生实质变化
- **THEN** 系统使用发送前快照显示 MC，并重新验证 Quote 后才允许发送

### Requirement: Telegram is called directly over HTTP

系统 SHALL 直接使用 Telegram Bot API 支持发送、编辑、删除消息、`getUpdates` 长轮询和 Inline Keyboard，不引入 Telegram Bot 框架。消息 MUST 展示路线、合约、触发及支持来源、分数、完整度、流动性、三档往返成本、最大安全仓位、风险提示和时间戳；创建者历史触发扣分时，风险提示 MUST 展示累计创建数、开放比例和实际扣分。当前外部按钮集合 SHALL 仅包括 GMGN 详情 URL 按钮；合约复制使用消息正文原生复制控件。两者 MUST 对所有阅读者开放，不经过机器人管理员鉴权；GMGN 按钮文字从 YAML 读取。

#### Scenario: A formal signal is delivered successfully

- **WHEN** Telegram 确认 `sendMessage` 成功
- **THEN** 系统保存 `message_id`、确认时间和已发送状态

### Requirement: Callback actions are authorized

兼容旧消息的管理回调 MUST 仅接受合并配置中允许的 Chat 和管理员用户；空管理员名单 MUST 拒绝全部管理回调，但不得阻止正式推送和公共链接访问；每个回调 SHALL 验证消息或信号关联后再执行动作。旧刷新回调 SHALL 告知原始信号已冻结并引导到 GMGN，不修改原消息；标记已买只保存用户注释，MUST NOT 发起交易；停止跟踪只停止该消息后续自动编辑，后台标准质量采样继续执行；删除消息只调用 Telegram 删除并标记消息不可再编辑，MUST NOT 删除数据库样本。GMGN 详情和复制合约不得产生交易副作用。回调状态变更 MUST 幂等，同一个 Telegram update 被长轮询重复取得时不得重复产生副作用。

#### Scenario: Unauthorized user presses a button

- **WHEN** 用户 ID 或 Chat ID 不在允许范围内
- **THEN** 系统拒绝动作、记录安全事件且不修改信号或消息状态

#### Scenario: Telegram repeats an already handled callback

- **WHEN** 重启或长轮询恢复后再次收到相同 callback update
- **THEN** 系统确认或忽略重复 update，并保持信号状态与首次处理后的结果一致

#### Scenario: User marks a signal as bought

- **WHEN** 授权用户点击“标记已买”
- **THEN** 系统只记录用户标记和时间，不更新原消息，不调用 GMGN Swap、签名或任何交易接口

#### Scenario: User stops message tracking

- **WHEN** 授权用户点击“停止跟踪”
- **THEN** 系统停止该 Telegram 消息的自动编辑，但继续执行并保存标准结果任务以保证质量统计完整

### Requirement: Delivery uncertainty is explicit

Telegram 请求在可能已送达但响应未知时 MUST 标记为 `DELIVERY_UNKNOWN`。系统不得宣称严格 exactly-once；最多允许一次使用相同可见 `signal_id` 的重试，并 MUST 标注可能重复。重试前 MUST 重新确认决定性触发仍新鲜且安全状态仍可接受；陈旧信号不得补发。

#### Scenario: Connection drops after request body is sent

- **WHEN** 客户端无法判断 Telegram 是否已经创建消息
- **THEN** 系统进入 `DELIVERY_UNKNOWN`，按配置最多重试一次且保留相同信号身份

#### Scenario: Telegram rate limits a known unsent request

- **WHEN** Telegram 通过 HTTP 状态或 API `error_code` 返回 429
- **THEN** 系统保留 `PENDING` 状态并按 `retry_after` 延迟，不得将其永久标记为 `SEND_FAILED`

### Requirement: Original signal cards are immutable after sending

系统 SHALL 在每次发送请求前持久保存完整消息正文、按钮、判定、Quote 和请求时间；确认成功后关联该次快照。投递未知重试 MUST 分别保留尝试快照，不覆盖前次证据。后续新证据、风险及结果 SHALL 仅保存在后台跟踪数据和独立报告，不改写原卡片，不产生重复正式信号。每个原卡 SHALL 标注推送参考价及固定快照时间。

#### Scenario: Market changes after confirmation

- **WHEN** 价格、流动性、风险或支持证据在发送后变化
- **THEN** 原卡片及发送快照保持不变，冻结入场价和标准结果采样继续有效

#### Scenario: Upgrade encounters old edit tasks

- **WHEN** 升级时存在待执行的定时或即时卡片编辑任务
- **THEN** 系统取消这些编辑任务，保留已完成编辑历史及所有质量采样，不为缺少原始正文的历史卡片制造快照

### Requirement: Every qualifying signal is delivered without a count quota

系统 MUST 为每个仍在决定性触发窗口内、通过安全刷新、正式评分、数据完整度和 10U 双向 Quote 门禁的信号创建 Outbox 记录，不得设置每日、每小时、每路线或每批推送数量上限。容量不足只能按实时任务期限降级低优先级工作，不得以隐藏信号配额代替容量治理。

#### Scenario: Many candidates qualify in one minute

- **WHEN** 多个候选在同一分钟各自通过全部正式条件且仍新鲜
- **THEN** 系统为每个候选投递；只有因处理完成前已经陈旧的候选才记录失败而不补推

### Requirement: Formal signal messages are not auto-deleted

正式信号 SHALL 保留原始发送快照；只有测试、确认重复、失败消息或授权用户明确删除的消息可以删除。

#### Scenario: Formal tracking reaches its last checkpoint

- **WHEN** 正式信号完成所有结果检查点
- **THEN** 系统保存后台最终结果，不编辑或自动删除 Telegram 原消息，不删除数据库样本

### Requirement: Every send uses current evidence and later risk tracking stays separate

系统 MUST 在实际发送前重新验证路线、基础安全、买卖方向、结构失效位及触发和 Quote 新鲜度。已 SENT 信号的后台风险记录 SHALL 独立于活动 Episode 查询，并记录检查时间和实际通过、失败或未知状态；仅刷新价格不得把安全状态显示成刚刚全部复核通过。

#### Scenario: Buy pressure disappears while a message is pending

- **WHEN** 待发送候选的最新买卖方向反转或跌破关键支撑，即使 Quote 仍可成交
- **THEN** 系统阻止该次投递并保存发送前拒绝原因

#### Scenario: Risk appears after the Episode ended

- **WHEN** 已 SENT 代币后续检查发现风险，而原 Episode 已终止
- **THEN** 系统仍能记录该信号风险状态，且不创建原卡编辑任务

#### Scenario: Public links and administrator actions are separate

- **WHEN** 未配置管理员或普通阅读者点击 GMGN 链接
- **THEN** 链接仍可直接打开，不产生 callback_query；旧消息的修改类回调维持管理员鉴权。当前版本尚未实现快捷指令，后续管理指令 MUST 仅允许管理员执行
