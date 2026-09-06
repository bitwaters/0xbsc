# BSC Meme TG 信号机器人最终开发方案

> 版本：v1.4
> 状态：历史需求与技术方案基线；当前实现和验收状态见 README
> 目标链：BSC
> 市场数据源：GMGN OpenAPI
> 消息渠道：Telegram Bot API

## 1. 项目目标

构建一个简单、稳定、易维护的 BSC Meme 代币信号机器人，通过 GMGN OpenAPI 发现潜力代币，在满足安全、时效、资金、量价和交易可执行性条件后推送 Telegram 信号。

核心目标：

- 同时覆盖新币启动、老币复苏和趋势延续。
- 主要面向分钟级持仓，强叙事信号允许观察至小时级。
- 适配单次 10–100U 小仓位。
- 所有通过规则的信号都推送，不设置每日数量限制。
- 重点追求少而准，同时通过观察样本控制漏报。
- 第一阶段只实现信号，不实现自动交易。
- 不提前建设交易账户、私钥、订单或自动止盈止损模块。

## 2. 项目边界

### 2.1 Phase 1 必须实现

- GMGN OpenAPI 直接 HTTP 连接。
- 六类发现来源：Signal、Trenches、Trending、Hot、SmartMoney、KOL。
- 新币启动、老币复苏、趋势延续三条路线。
- 前置安全硬过滤和推送前安全刷新。
- Kline、Holders、Traders、Creator 深度分析。
- 10U、50U、100U 买卖双向 Quote。
- 多来源异步证据聚合和观察复评。
- Telegram 发送、编辑、删除和 Inline Keyboard。
- SQLite 可靠投递、状态恢复和样本持久化。
- MFE、MAE、价格收益、可执行净收益和命中统计。
- GMGN 全局加权限流、延迟、错误和采集量监控。
- 所有可调参数集中在唯一 YAML 配置文件中。

### 2.2 Phase 1 不实现

- 自动买入或卖出。
- GMGN Swap/Multi-Swap。
- 策略订单创建或取消。
- 钱包私钥和 Ed25519 签名私钥加载。
- Web 管理后台。
- 多用户和多链。
- Twitter、DEXScreener、GoPlus 等其他行情、安全或叙事 API。
- 网页抓取、外部社交监听和文本 NLP。

市场、钱包和交易可执行性数据只使用 GMGN；Telegram Bot API 只负责消息传输。

## 3. 设计原则与术语

### 3.1 设计原则

- 安全硬过滤必须早于昂贵深度分析。
- 安全风险不能被高评分抵消。
- Quote 是推送前的最终交易可执行性硬门槛。
- 多来源只形成一套代币状态和一条信号管线。
- 相同来源事件精确去重，同一证据族封顶，避免重复加分。
- 结果跟踪不得抢占实时发现、观察复评和正式推送配额。
- 不为未来自动交易提前增加运行模块。

### 3.2 统一术语

| 名称       | 定义                                                                     |
| ---------- | ------------------------------------------------------------------------ |
| 候选流     | 六类发现来源标准化后进入处理队列的瞬时事件，不是持久池                   |
| Episode    | 同一代币在同一主路线中的一次观察、判定和推送过程                         |
| 观察池     | 已通过前置硬过滤并达到 65 分，但暂时不满足正式信号全部条件的活跃 Episode |
| 结果任务   | Episode 或信号结束后，持久化到 SQLite、按到期时间执行的低优先级评估任务  |
| 历史样本库 | 已完成处理的标准化事件、Episode、信号和结果数据                          |

正式文档和代码不使用“候选池”。结果任务也不实现为第二个内存池。

## 4. 技术栈

| 模块      | 技术选择                                 |
| --------- | ---------------------------------------- |
| 运行时    | Node.js 24 LTS                           |
| 开发语言  | TypeScript                               |
| GMGN HTTP | Node 原生 `https`，IPv4 优先、Keep-Alive |
| Telegram  | 直接调用 Telegram Bot API                |
| 数据库    | SQLite + `better-sqlite3`                |
| 配置      | YAML + Zod 校验                          |
| 测试      | Node 原生 `node:test`                    |
| 构建      | TypeScript `tsc`                         |
| 包管理    | npm                                      |
| 部署      | 单 Docker 容器                           |
| 日志      | stdout 结构化 JSON                       |

不引入 Redis、PostgreSQL、消息队列、NestJS、Prisma 或 Telegram Bot 框架。

## 5. 总体架构

```text
GMGN 六类轮询器
       │
       ▼
全局加权限流器
       │
       ▼
标准化 + 单一优先事件队列
       │
       ▼
精确事件去重
       │
       ▼
来源字段/缓存零成本过滤
       │
       ▼
Info + Security + Pool 前置硬过滤
       │
       ▼
Kline + 主路线判定
       │
       ▼
创建/合并代币/路线单活跃 Episode + 证据门槛
       │
       ▼
Holders + Traders + Creator 深度分析
       │
       ▼
三级评分 + 数据完整度 + 最新决定性触发
       │
       ├─ <65：保存并结束实时处理
       ├─ 未完全达标：观察池
       └─ 完全达标：安全刷新 + 三档双向 Quote
                              │
                              ├─ 通过：SQLite Outbox → Telegram
                              ├─ 成本暂时超标：观察池
                              └─ 安全性失败：拒绝
       │
       ▼
SQLite 持久结果任务 → 统计与消息更新
```

GMGN 任务优先级：

1. 正式候选的安全刷新和 Quote。
2. 六类市场发现轮询。
3. 活跃观察池复评。
4. 正式信号结果 Quote。
5. 未推送样本的结果采集。

Telegram 不消耗 GMGN 权重，但正式发送优先于非关键消息编辑。

## 6. GMGN 能力与已验证行为

真实 OpenAPI 审计结果：

- 72 个测试项。
- 68 项通过。
- Signal Type 14/15/16 被生产接口明确拒绝。
- Swap 订单查询因没有真实 `order_id` 未完成闭环。
- 未执行交易、策略创建、取消或发币操作。

审计产物和一次性验证脚本仅在本地保存，不随公开源码发布。上述结果是开发时的历史验证记录，不代表当前线上验收通过。

审计脚本是开发前一次性验证工具，其历史密钥读取方式不属于生产运行配置；正式机器人仍只读取第 17 节规定的一份 YAML。

生产实现必须兼容：

- Signal 必须显式传入类型，禁用 Type 14/15/16。
- Signal 每个 Group 最多按 50 条处理。
- 高频 Signal 类型合并在一个 multi-group POST，叙事类型合并在另一个 POST，不按类型逐个轮询。
- Trenches 可能忽略请求 `limit`，本地必须截断。
- SmartMoney/KOL 请求 200 时实际最多按 100 条处理。
- Top Holders/Traders 最大按 100 条处理。
- Wallet Stats 批量不稳定时逐钱包查询。
- 成功响应通常没有剩余额度响应头，客户端必须自己记账。
- 429 时读取 `X-RateLimit-Reset`，冷却期间不继续重试。

[GMGN 官方 Signal 说明](https://docs.gmgn.ai/index/alert-sniper-new-following-limit-orders)确认 Signal 包含 Dex 付费、价格上涨、ATH/关键市值、Pump、CTO 等类别，但当前公开材料没有提供可可靠引用的完整数字 Type 语义表。不得根据编号猜测含义：T3 必须用真实响应中的类型标签和字段建立 `signal_type → semantic_category → evidence_family` 映射；尚未映射的已支持 Type 继续采集和存档，但不能作为强触发或直接加分。

## 7. API 限额、轮询和并发

### 7.1 权重预算

Plus 套餐：

```text
服务端限频权重：20/秒
客户端持续软上限：14/秒
突发保留：6/秒
```

| API                                                  | 权重 |
| ---------------------------------------------------- | ---: |
| Trending、Info、Security、Pool、SmartMoney、KOL、Gas |    1 |
| Kline、Quote、Created Tokens                         |    2 |
| Trenches、Hot Searches、Market Signal                |    3 |
| Holders、Traders                                     |    5 |

所有 GMGN 调用必须经过同一个加权 Token Bucket：

- 持续不超过 14 权重/秒，瞬时不超过 20。
- 轮询加入约 ±10% 抖动。
- 同一轮询端点不并发重入。
- 只读网络错误最多自动重试一次。
- 业务错误不立即重试。
- 429 按服务端时间冷却。
- 新任务按优先级抢占尚未开始的低优先级任务，不中断已经发出的请求。

### 7.2 全局发现轮询

| 数据源            | 调用方式              |  频率 | 每分钟权重 |
| ----------------- | --------------------- | ----: | ---------: |
| 高频 Signal       | 一个 multi-group POST |  2 秒 |         90 |
| 叙事 Signal       | 一个 multi-group POST |  5 秒 |         36 |
| Trenches 三阶段   | 一个 POST             |  5 秒 |         36 |
| SmartMoney        | GET                   |  2 秒 |         30 |
| KOL               | GET                   |  3 秒 |         20 |
| Trending 1m/5m/1h | 三个 GET              |  5 秒 |         36 |
| Hot 1m/5m/1h      | 一个批量 POST         | 15 秒 |         12 |
| Hot 6h/24h        | 一个批量 POST         | 60 秒 |          3 |
| Gas Price         | GET                   | 30 秒 |          2 |
| 合计              | 约 147 次请求/分钟    |     — |        265 |

```text
基础平均消耗 = 265 ÷ 60 ≈ 4.42 权重/秒
软预算剩余 = 14 × 60 - 265 = 575 权重/分钟
```

### 7.3 观察池复评

观察 Episode 同时采用事件驱动和定时复评：

- 新的 Signal、Trending、SmartMoney、KOL、Hot 或 Trenches 事件到达时立即增量评分。
- 每个活跃 Episode 每 30 秒调用一次 Token Info 和一次 Kline。
- 复评到期时间按 Episode 哈希均匀分散在 30 秒窗口内，禁止 60 个 Episode 同时形成请求尖峰。
- 新币与趋势延续使用 30s Kline；老币复苏使用 1m Kline。
- 每个 Episode 每分钟约消耗 `2 × (Info 1 + Kline 2) = 6` 权重。
- Security 和 Pool 不随每轮复评调用，只在首次过滤、相关状态变化和推送前刷新。
- Quote 只在正式条件成立，或价格、流动性发生实质变化且达到最小重试间隔时调用。

60 个满额观察 Episode 最坏约消耗 360 权重/分钟。基础轮询加观察复评约为 625 权重/分钟，低于 840 的软件上限，剩余约 215 权重/分钟用于深度分析、最终 Quote 和结果任务。

一个从首次过滤到三档双向 Quote 的完整正式候选最坏约消耗 31 权重；观察池满额时，剩余软预算理论上支持约 6–7 个完整正式候选/分钟。该数字是容量基线，不是人为信号上限；真实到达量超过容量时，必须通过降低低分观察复评和延迟结果任务释放预算，不能排队补发已经陈旧的信号。

如果剩余预算不足，首先延迟结果任务，其次降低低分观察 Episode 的定时复评；不得延迟已经达到正式条件的安全刷新和 Quote。超过最新决定性触发窗口的候选禁止排队后补推送，必须记录为 `stale_before_decision`。

### 7.4 正式候选并行调用

为满足延迟目标，互不依赖的接口必须并行：

```text
第一批：Info + Security + Pool
第二步：Kline → 主路线与证据门槛
第三批：Holders + Traders + Created Tokens
第四批：Security + Pool 刷新、10/50/100U 买入 Quote
第五批：对应 10/50/100U 卖出 Quote
第六步：判定并写入 Outbox
```

第四、五批存在先后依赖，但每一批内部并行。若预算不足以在最新触发窗口内完成，不发送陈旧信号。

## 8. 多来源事件、证据和 Episode

### 8.1 精确去重与聚合

发现事件唯一键：

```text
有稳定事件 ID：event_key = source + source_event_id + token_address
快照没有事件 ID：event_key = source + interval + token_address + local_change_sequence + normalized_state_hash
```

`normalized_state_hash` 只哈希该来源用于判定的标准化字段，不包含采集时间。快照先与上一次哈希比较；完全相同则跳过，发生变化才增加本地 `local_change_sequence` 并生成事件。每个来源/周期/代币的最后哈希和序号持久化到 SQLite，进程重启后继续去重。

同一个代币和主路线同时最多一个活跃 Episode：

```text
active_episode_key = chain + token_address + primary_route
```

不生成难以验证的 `structure_fingerprint`，也不尝试判断不同 API 返回是否描述了“完全相同的市场事件”。系统只做：

- 相同来源事件精确去重。
- 每个证据族只保留当前仍有效的最强证据。
- 每个证据族和评分维度设置最高分。
- 后到事件只更新受影响的证据族、评分和数据完整度。
- 单一事件队列串行修改同一代币状态；数据库对活跃 Episode 和信号设置唯一约束。

### 8.2 四个证据族

| 证据族       | 主要来源                                       | 作用                       |
| ------------ | ---------------------------------------------- | -------------------------- |
| 生命周期     | Trenches、Token Info、迁移和开放交易状态       | 判断新币和迁移阶段         |
| 量价结构     | Market Signal、Trending、Kline、成交量和 swaps | 判断启动、突破、回调和趋势 |
| 资金行为     | SmartMoney、KOL、Traders、持仓变化             | 判断进入、持续和退出       |
| 注意力与叙事 | Hot、GMGN 热度、CTO、Platform Call、社交资料   | 判断关注扩散和叙事持续性   |

SmartMoney 和 KOL 同属资金行为；同时出现可以增强强度，但仍只算一个独立证据族。

候选进入深度分析必须满足以下任一条件：

- 一个强触发；例如迁移完成、显著放量突破、资金集群进入或高质量 Market Signal。
- 两个来自不同证据族的弱触发。

快照接口只处理新增、状态变化或排名显著变化；完全重复快照只更新时间戳。

### 8.3 异步到达

多来源不要求同时到达。第一个合格事件建立 Episode，后续来源在 Episode 和证据有效期内合并。字段定义：

```text
source_event_at   GMGN 事件实际发生时间
observed_at       机器人采集时间
fresh_until       证据参与评分的截止时间
evidence_family   证据族
strength          weak / strong
```

Episode 中：

- `first_trigger`：首次建立 Episode 的事件。
- `qualifying_trigger`：首次令完整正式条件成立的事件。
- `supporting_evidence`：判定时其他仍有效证据。

优先使用 `source_event_at` 判断新鲜度；字段缺失时使用 `observed_at` 并降低数据完整度。

### 8.4 证据有效期与立即失效

| 证据                    |  有效期 |
| ----------------------- | ------: |
| 生命周期、开盘和迁移    | 10 分钟 |
| 放量、突破和量价结构    |  3 分钟 |
| SmartMoney、KOL         |  5 分钟 |
| Hot 和普通热度          | 10 分钟 |
| 明确叙事、CTO、平台事件 | 30 分钟 |
| 推送前安全数据          |   30 秒 |
| 推送前 Quote            |    5 秒 |

正式推送还必须包含最新决定性触发：

| 路线     | 触发窗口 | 允许的决定性触发                      |
| -------- | -------: | ------------------------------------- |
| 新币启动 |    90 秒 | 迁移/开盘变化、最新放量或最新资金进入 |
| 老币复苏 |   120 秒 | 最新放量突破或最新资金重新流入        |
| 趋势延续 |    60 秒 | 回调结束并再次放量                    |

Hot、Trending、普通热度和旧叙事只能提供支持，不能单独决定入场。

TTL 是最长有效期。以下反向事件立即撤销相应证据：

- 跌回突破位或短周期结构被破坏。
- 同批 SmartMoney/KOL 快速卖出或净流向反转。
- 热度排名和搜索动量显著回落。
- 流动性快速撤出。
- 迁移或池状态异常。
- 大户、开发者突然集中卖出。

过期和失效证据保留在历史样本中，但立即退出当前分数和证据族计数。

### 8.5 GMGN 叙事代理边界

Telegram 卡片不展示“叙事”。GMGN Agent OpenAPI 未提供与网页端 AI 代币叙事一致的摘要字段，因此系统不使用 Token Info 的 `link.description`、名称翻译或 Hot、Trending、CTO 等信号标签代替叙事，也不为此引入额外 API。Hot、Platform Call、社交资料完整度、GMGN 热度变化及 KOL/SmartMoney 共振仍作为内部可观测信号，用于评分、触发原因与评估，不作为卡片叙事文本。

## 9. 前置安全硬过滤

### 9.1 两级过滤

第一级使用发现事件已有字段和未过期缓存，不产生额外调用；第二级只对初步合格候选并行调用 Info、Security、Pool。

通过第二级安全过滤并达到证据门槛后，才允许调用 Holders、Traders 和 Creator 等昂贵接口。

### 9.2 通用硬条件

| 条件       | GMGN 字段或来源                    | 初始要求             |
| ---------- | ---------------------------------- | -------------------- |
| 链和地址   | chain/address                      | BSC、地址格式有效    |
| 蜜罐       | `is_honeypot`                      | false                |
| 可卖       | `can_sell`/`can_not_sell`          | 明确可卖             |
| 黑名单     | `is_blacklist`                     | false                |
| 开源       | `is_open_source`                   | true                 |
| 买税       | `buy_tax`                          | ≤5%                  |
| 卖税       | `sell_tax`                         | ≤5%                  |
| Top10      | `top_10_holder_rate`               | ≤50%                 |
| 团队持仓   | `dev_team_hold_rate`               | ≤10%                 |
| Entrapment | `top_entrapment_trader_percentage` | ≤20%                 |
| Bundler    | `top_bundler_trader_percentage`    | ≤20%                 |
| Sniper     | `top70_sniper_hold_rate`           | ≤20%                 |
| 洗盘       | Rank 过滤和 GMGN 对应标记          | 不得存在明显洗盘风险 |
| 风险标志   | `flags`/`is_show_alert`            | 无配置为致命的风险   |

关键安全字段缺失时不评分、不占观察名额、不调用昂贵接口。允许在配置的短等待期内重查；仍缺失则结束本次事件，后续新触发可以重新进入候选流。

数值必须在 GMGN 适配层统一归一化：所有比例转换为内部 `[0,1]`，YAML 中以百分数书写的阈值只转换一次；无法解析、超出范围或单位不明确时按关键字段缺失处理。代币原始数量、Wei 和 Quote `input_amount/output_amount` 使用十进制字符串或 `BigInt`，禁止使用 JavaScript `Number` 承载；美元金额和收益计算使用固定精度十进制表示。

### 9.3 权限与 LP

- 已迁移至普通 DEX 的代币必须检查 `is_renounced`、`renounced_mint`、`privileges`、`lock_summary.is_locked`、`lock_percent` 和 `left_lock_percent`。
- Owner/Mint 权限必须已放弃，或者 GMGN 明确证明对应权限无风险。
- 普通 DEX 初始最低有效锁定或销毁比例为 80%，具体值在 YAML 调整。
- Launchpad 曲线阶段按平台池和迁移机制判断，不强制套用普通 LP 锁仓规则。
- 安全状态变化立即令 Episode 失效，不能由评分覆盖。

### 9.4 深度否决项

通过前置过滤和证据门槛后取得的 Creator、Holders、Traders 数据仍可产生硬否决：创建者直接持仓跨过硬阈值、持仓集中度跨过硬阈值、SmartMoney 集中退出，以及数据无法可靠映射。创建者累计发币数本身不作为门禁；仅当累计创建超过 5 个且开放比例低于 50% 时，将“持仓与创建者质量”降为 0.5，最多扣 5 分，再用调整后总分通过 65/80 门槛。开放比例达到 50% 时不因累计数量扣分。

## 10. 三条信号路线

### 10.1 路线判定优先级

1. 创建不超过 24 小时且仍处于首次启动阶段：新币启动。
2. 创建超过 24 小时、存在沉寂并重新激活：老币复苏。
3. 已有有效上涨趋势、完成回调并重新启动：趋势延续。

一次 Episode 只有一条主路线。

### 10.2 新币启动

- 创建时间不超过 24 小时。
- 初始最低流动性 10,000U。
- 存在真实买卖和有效池状态。
- 交易量、持币人数或资金关注正在增加。
- 满足一个强触发或两个不同证据族的弱触发。
- 每个代币最多推送一次成功的新币启动信号；被拒绝或过期的 Episode 在 24 小时窗口内遇到新触发时可以重新建立。新币启动已经成功推送后，后续机会进入趋势延续。

### 10.3 老币复苏

- 创建时间超过 24 小时。
- 前期存在明确沉寂。
- 当前 5 分钟成交量至少为此前 1 小时已完成 5 分钟窗口均值的 3 倍。
- 当前 swaps 至少为此前均值的 2 倍。
- 基线为零或样本不足时，必须同时达到 YAML 中的绝对成交量和 swaps 下限，不能用除零产生无限倍数。
- 初始最低流动性 20,000U。
- 价格突破近期局部结构。
- 至少一项额外确认：SmartMoney、KOL、Hot、CTO、Platform Call 或 Market Signal。
- 新的复苏 Episode 必须先重新形成沉寂阶段。

### 10.4 趋势延续

- 初始最低流动性 30,000U。
- 已形成有效上涨趋势。
- 回调没有破坏前一关键结构。
- 回调缩量，重新启动放量。
- 没有 SmartMoney 集中退出。
- Quote 成本没有明显恶化。
- 不追逐已严重垂直拉升的阶段。
- 新的延续 Episode 必须先出现一次满足配置的有效回调，再出现重新启动。

趋势、回调、突破、垂直拉升和沉寂的算法定义保留在代码并由测试固定；所有数值阈值、窗口和开关放在 YAML。配置文件不引入表达式语言或动态执行代码。

## 11. 评分、数据完整度与判定

### 11.1 路线权重

| 维度             | 新币启动 | 老币复苏 | 趋势延续 |
| ---------------- | -------: | -------: | -------: |
| 生命周期与阶段   |       20 |        5 |        0 |
| 量价与结构       |       25 |       30 |       40 |
| 资金行为         |       25 |       30 |       30 |
| 注意力与叙事     |       15 |       20 |       10 |
| 持仓与创建者质量 |       10 |       10 |       10 |
| 数据与信号时效性 |        5 |        5 |       10 |
| 合计             |      100 |      100 |      100 |

### 11.2 三级评分

每个评分维度只返回三个等级：

```text
0.0  不成立
0.5  弱成立
1.0  强成立

维度得分 = 路线维度权重 × 等级
总分 = 所有维度得分之和
```

弱/强阈值在 YAML 中配置。相同来源事件不重复处理，同一证据族和维度不能突破上限。

### 11.3 数据完整度

不再建立第二套复杂“置信度模型”。配置为每条路线列出必需分析字段及权重：

```text
data_completeness = 已取得且仍新鲜的必需字段权重
                    ÷ 路线必需字段总权重
```

缺失字段不得加分。安全关键字段缺失仍按硬过滤失败处理，不能依赖完整度放行。

动态数据超过统一缓存 TTL 后视为缺失，不再贡献分数或完整度；静态 Creator 历史可以使用较长缓存。初始 TTL 为：Info/Pool 30 秒、Kline 60 秒、Traders 180 秒、Holders 300 秒、Creator 历史 3600 秒。所有值从唯一 YAML 读取。

观察池不按固定周期刷新 Holders、Traders、Creator。只有新证据令候选有可能达到正式条件、但完整度因这些缓存过期而不足时，才并行刷新所需字段并重新判定。

### 11.4 状态判定

- 正式条件：`score >= 80`、`data_completeness >= 0.70`、至少两个独立证据族、存在路线要求的最新决定性触发。
- 观察条件：已通过前置硬过滤、`score >= 65`，但正式条件尚未全部满足，或 Quote 仅因暂时性成本不合格。
- 结束实时处理：`score < 65`、Episode 到期或硬条件失败。
- 达到正式条件后必须通过最新安全刷新和 Quote 才能推送。

## 12. 观察池和重新触发

### 12.1 观察时间与容量

| 路线         | 默认观察时间 |
| ------------ | -----------: |
| 新币启动     |      15 分钟 |
| 老币复苏     |      30 分钟 |
| 趋势延续     |      15 分钟 |
| 已确认强叙事 | 最长 60 分钟 |

- 活跃观察池上限为 60。
- 三条路线各以 20 个名额作为软目标，不是强制配额。
- 空位可以互相借用；低质量候选不能因为路线名额而挤掉明显更强的候选。
- 容量满时先按分数、数据完整度和证据新鲜度排序；路线软目标只在优先级接近时作为平局决胜项，不单独保证低质量候选入池。
- 被降级的 Episode 停止 30 秒定时复评，但保留历史和结果任务；新的强触发到达时可以重新竞争观察名额。

### 12.2 最小状态机

```text
DISCOVERED
  ├─ 安全失败/低于65 → REJECTED
  ├─ 达到观察条件 → OBSERVING
  └─ 达到正式条件 → READY

OBSERVING
  ├─ 达到正式条件 → READY
  ├─ 到期/连续两次低于65 → EXPIRED
  └─ 安全恶化 → REJECTED

READY
  ├─ 安全与Quote通过 → DELIVERY_PENDING
  ├─ 暂时性成本超标 → OBSERVING
  └─ 安全性失败 → REJECTED

DELIVERY_PENDING → SENT / SEND_FAILED
```

结果采集不是 Episode 状态，而是 SQLite 中的到期任务。

### 12.3 后续来源处理

| 当前状态                 | 后续来源处理                             |
| ------------------------ | ---------------------------------------- |
| OBSERVING                | 合并有效证据并立即增量评分               |
| 分数够但证据族不足       | 等待新的独立证据族                       |
| 分数和证据够但完整度不足 | 补齐数据后重新判断                       |
| 缺少最新决定性触发       | 等待路线要求的新触发，不使用旧事件推送   |
| Quote 成本暂时超标       | 相关状态实质变化且达到最小重试间隔后重试 |
| 已 SENT                  | 同一路线状态内只更新原 Telegram 消息     |
| 已结束且满足路线重置条件 | 创建新的 Episode                         |

## 13. 三档双向 Quote

### 13.1 调用方式

推送前先并行请求 10U、50U、100U 买入 Quote，再将每笔买入得到的代币数量分别并行请求完整卖出 Quote。

禁止使用 100U 的结果代替 10U、50U，也禁止只用买入报价推断卖出能力。

### 13.2 初始通过标准

| 仓位 | 单边最大损耗 | 最大往返损耗 |
| ---- | -----------: | -----------: |
| 10U  |           2% |           5% |
| 50U  |           3% |           6% |
| 100U |           5% |           8% |

通用条件：

- 请求最大允许滑点 5%。
- 买卖路由必须有效且方向一致。
- 无法卖出、路由异常或模拟异常：安全性失败，立即拒绝。
- 10U 双向测试必须通过，否则不推送。
- 50U、100U 独立判断，不因大仓位失败而拒绝可安全使用 10U 的信号。
- `max_safe_position` 为通过完整双向标准的最大测试仓位，并显示在 Telegram。
- Quote 推送时不得超过 5 秒。
- 成本超标但仍可安全卖出属于暂时性失败，可以回到观察池。

成本统一按 Quote 返回的美元价值计算：

```text
buy_leg_loss = (input_usd - bought_token_quote_value_usd) / input_usd
sell_leg_loss = (bought_token_quote_value_usd - reverse_output_usd) / bought_token_quote_value_usd
round_trip_loss = (input_usd - reverse_output_usd + estimated_total_gas_usd) / input_usd
```

如果 GMGN Quote 的输出金额已经包含税、DEX 费和价格冲击，不得再次手工扣除这些成本；只额外加入 Quote 尚未包含、且能从 GMGN 数据确定的 Gas。各成本分量和计算输入必须原样保存，避免重复扣费。

## 14. Telegram 与可靠投递

### 14.1 HTTP 能力

直接调用：

- `sendMessage`
- `sendRichMessage`（正文内嵌 CA 复制控件）
- `editMessageText`
- `editMessageReplyMarkup`
- `deleteMessage`/`deleteMessages`
- `answerCallbackQuery`
- `getUpdates` 长轮询
- Inline Keyboard

推荐按钮：

```text
[GMGN详情] [刷新状态]
```

CA 置于消息正文前部，整段地址作为 `copy_text` 控件点击复制，不占用底部按钮。卡片显示 MC、持有人数和基于 `visiting_count` 的浏览热度，不显示数据源、模拟可执行性或原始分/扣分/最终分拆解；叙事与有效社媒链接位于信号时间之前，缺失字段不显示空区块。板块之间保留明确空行，底部只保留 GMGN 详情按钮。

回调只允许配置中的 Chat 和用户操作。Telegram 消息删除不删除数据库样本。

### 14.2 SQLite Outbox

信号判定和投递状态写入同一个 SQLite 事务：

```text
DELIVERY_PENDING → SENDING → SENT
                         ├→ SEND_FAILED
                         └→ DELIVERY_UNKNOWN
```

- `signals` 对 `episode_id` 设置唯一约束，确保一个 Episode 只有一次正式推送。
- Telegram 成功后保存 `message_id` 和确认时间。
- 并发采集器只能创建一个 `signal_id`，因此本地判定不会重复推送。
- Telegram `sendMessage` 没有客户端幂等键；请求已经发出但未收到响应时无法证明 Telegram 是否成功，必须标记 `DELIVERY_UNKNOWN`，不能承诺严格 exactly-once。
- `DELIVERY_UNKNOWN` 默认最多重试一次，重试消息携带同一可见 `signal_id`；优先保证信号不丢失，但极端网络中断下可能出现一条重复消息，需记录 `possible_duplicate=true`。
- 进程启动时恢复未完成投递和结果任务。
- 重试发送前重新确认最新触发仍有效；陈旧信号标记失败，不补发。

### 14.3 消息更新

- 推送后 1、5、15、30、60 分钟更新；叙事信号增加 2、4 小时。
- 同一 Episode 出现新确认来源时，编辑原消息中的确认来源、评分和完整度。
- TP/SL 状态在跟踪任务检测到后更新，不承诺链上成交级实时性。
- 安全、流动性或 Quote 明显恶化时更新风险状态。
- 正式信号不自动删除；测试、重复和失败消息可以删除。

消息至少展示：路线、合约、触发来源、支持来源、分数、数据完整度、流动性、10/50/100U 往返成本、最大安全仓位、风险提示和时间戳。

## 15. 结果评估协议

### 15.1 正式信号入场口径

- 推送前 Quote 用于硬过滤。
- Telegram 确认成功后，异步并行取得 10/50/100U 新买入 Quote，作为模拟跟单入场价格和代币数量。
- 该调用不阻塞 Telegram 推送，优先级低于实时信号处理。
- 模拟入场 Quote 必须在 Telegram 确认后的 5 秒内开始；超过该时间则记录为延迟样本，不进入主要可执行收益口径。
- 同时保存 `qualifying_trigger_at`、推送前 Quote 时间、Telegram 确认时间和模拟入场 Quote 时间。
- 没有取得有效模拟入场 Quote 时，该仓位的可执行收益记为缺失，不能用市场价格伪装为可执行收益。

### 15.2 价格和可执行收益

普通信号记录 1/3/5/15/30/60 分钟，叙事信号增加 2/4 小时。

每个时间点区分两类指标：

- `market_return`：根据 GMGN Kline/价格计算，不包含真实交易成本。
- `executable_net_return`：根据模拟入场 Quote 的实际投入、对应卖出 Quote 的实际输出以及尚未包含在 Quote 中的 Gas 计算；不得重复扣除 Quote 已包含的税、DEX 费或价格冲击。

正式信号在配置的关键检查点对 10U、50U、100U 分别请求卖出 Quote。结果任务预算不足时可以延迟，但必须保存实际 Quote 时间和延迟；超过检查点 10 秒才开始的 Quote 标记为 `late`，不计入该检查点主要可执行收益。过期或缺失结果不得伪造。

### 15.3 MFE、MAE 和 TP/SL

- MFE/MAE 使用观察区间内 30s 或 1m Kline 的 `high/low`，不能只使用离散检查点收盘价。
- 开发前必须用真实 API 验证 Kline 返回数量和历史范围足以覆盖 60 分钟及 4 小时；不足时保留周期性 Kline 快照。
- 如果同一根最小粒度 Kline 同时穿过 TP 和 SL，结果标记 `ambiguous`，不推断先后顺序。
- 同时保存各时间点净收益、MFE、MAE 和多个可配置 TP/SL 组合的 first-hit 结果。
- “命中率”按明确标签分别统计，不压缩成一个无法解释的布尔值。

### 15.4 未推送样本

- 所有达到 65 分但未推送的 Episode 都建立结果任务，用于统计假阴性。
- 未推送样本默认跟踪 60 分钟，强叙事跟踪 4 小时。
- 默认只计算市场价格、Kline MFE/MAE 和结构结果，不批量执行三档 Quote，避免抢占实时 API 配额。
- 结果任务持久化 `next_sample_at`，调度器每次只读取到期任务，不设置 500/2000 两级内存池。
- 标准化结果永久积累，不设置采集天数限制。

## 16. 延迟和运行监控

### 16.1 理论估算参考（尚未验证）

- GMGN Signal 最新事件年龄暂按约 7–8 秒估算。
- SmartMoney 最新事件年龄暂按约 5 秒估算。
- KOL 最新事件年龄暂按约 3 秒估算。
- Info/Security/Pool/Holders/Traders/Kline 单次请求暂按约 0.27–0.35 秒估算。
- 单次 Quote 暂按约 1.1 秒估算，因此设计上按依赖分两批并行。

以上数字只用于开发阶段的并发设计和性能预算，不是经过连续真实流量验证的基线，也不代表 P50、P95 或生产承诺。不得在监控、报告或验收中标记为“已验证”。

### 16.2 暂定性能预算与实测方法

| 延迟路径                                                                    | 理论预算（待实测校准） |
| --------------------------------------------------------------------------- | ---------------------: |
| 已有深度数据的观察 Episode：`qualifying_trigger` 被采集 → Telegram 确认 P50 |                  ≤3 秒 |
| 已有深度数据的观察 Episode：`qualifying_trigger` 被采集 → Telegram 确认 P95 |                  ≤5 秒 |
| 首次发现且需完整分析的候选：采集 → Telegram 确认 P95                        |                  ≤6 秒 |
| GMGN Signal 实际事件 → Telegram 确认 P95                                    |                 ≤15 秒 |
| Trending/Trenches 实际变化 → Telegram 确认 P95                              |                 ≤15 秒 |

这些数值是架构设计假设，不是 Phase 1 开始实施前已经成立的硬验收线。T14 必须使用真实 GMGN API 和测试 Chat 按延迟路径记录样本数量、负载档位、P50/P95/P99、失败率和各阶段耗时，再建立“实测基线”和建议运行阈值；实测完成前只能报告与理论预算的差异，不能宣称达标或不达标。

分别记录事件发生、采集、排队、每批 API、判定、Outbox、Telegram 请求和确认时间。观察等待时间单独统计，不能混入处理延迟。实测按样本量积累，不设置固定测试天数。

### 16.3 监控存储

- 成功请求按端点和分钟聚合：请求数、权重、P50/P95、状态码。
- 错误、429、重试、超时和慢请求逐条保留。
- 不永久写入每一次成功请求，避免每天产生约 21 万行低价值日志。
- 监控活跃 Episode 数、事件去重率、深度分析量、过期量、推送量、Quote 拒绝量、投递失败量和结果任务积压。

## 17. 唯一配置文件

运行时只读取：

```text
~/.config/gmgn-signal-bot/config.yaml
```

唯一配置必须包含：

- GMGN API Key、Host、Chain 和公开 Quote Wallet 地址。
- Telegram Bot Token、Chat ID 和允许操作的用户。
- API 权重、软硬限额、任务优先级、超时、重试和全部轮询周期。
- Signal multi-group 类型分组。
- 所有安全阈值、路线窗口与数值阈值、弱/强评分阈值和路线权重。
- Episode、证据有效期、决定性触发、观察容量和复评周期。
- 10/50/100U Quote、成本、滑点和最小重试间隔。
- 结果时间点、TP/SL 组合和叙事观察时间。
- Telegram 文本、按钮和更新规则。
- SQLite 路径、日志级别和原始数据保留期。

核心初始配置结构：

```yaml
gmgn:
  host: https://openapi.gmgn.ai
  chain: bsc
  api_key: ''
  quote_wallet_address: ''
  rate_limit:
    server_weight_per_second: 20
    soft_weight_per_second: 14

telegram:
  bot_token: ''
  chat_id: ''
  allowed_user_ids: []

security:
  max_buy_tax_percent: 5
  max_sell_tax_percent: 5
  max_top10_holder_percent: 50
  max_dev_team_percent: 10
  max_entrapment_percent: 20
  max_bundler_percent: 20
  max_sniper_percent: 20
  min_dex_lp_locked_or_burned_percent: 80
  fatal_flags: []

observation:
  score_min: 65
  signal_score: 80
  data_completeness_min: 0.70
  min_evidence_families: 2
  active_capacity: 60
  route_soft_targets:
    new_launch: 20
    revival: 20
    continuation: 20
  refresh_seconds: 30
  ttl_minutes:
    new_launch: 15
    revival: 30
    continuation: 15
    narrative: 60

fresh_trigger_seconds:
  new_launch: 90
  revival: 120
  continuation: 60

evidence_ttl_seconds:
  lifecycle: 600
  price_structure: 180
  capital_flow: 300
  attention: 600
  narrative: 1800
  security_at_push: 30
  quote_at_push: 5

data_ttl_seconds:
  token_info: 30
  token_pool: 30
  kline: 60
  traders: 180
  holders: 300
  creator_history: 3600

quote:
  sizes_usd: [10, 50, 100]
  max_slippage_percent: 5
  minimum_required_size_usd: 10
  retry_min_seconds: 30
  limits:
    '10': { max_leg_loss_percent: 2, max_round_trip_loss_percent: 5 }
    '50': { max_leg_loss_percent: 3, max_round_trip_loss_percent: 6 }
    '100': { max_leg_loss_percent: 5, max_round_trip_loss_percent: 8 }

evaluation:
  checkpoints_minutes: [1, 3, 5, 15, 30, 60]
  narrative_checkpoints_minutes: [120, 240]
  entry_quote_max_delay_seconds: 5
  checkpoint_quote_max_delay_seconds: 10
  normalized_sample_retention: unlimited
```

约束：

- 不使用 `.env` 保存运行参数。
- 不在代码中硬编码可调数值。
- 配置文件权限 `600`，目录权限 `700`，不得提交 Git。
- 日志自动脱敏 API Key 和 Telegram Token。
- Phase 1 不读取任何签名私钥。
- 配置在启动时完整校验；修改后重启单容器加载，不实现 SIGHUP 热重载。
- 每个 Episode 和信号保存配置版本及 SHA-256。

GMGN 端点路径、认证/序列化协议、字段解析和数据库 schema 属于程序协议逻辑，不属于调参项。

## 18. SQLite 数据模型

第一版使用 7 张表：

| 表                 | 用途                                                     |
| ------------------ | -------------------------------------------------------- |
| `tokens`           | 代币基础信息、最新状态及各来源最后快照哈希/序号          |
| `events`           | 发现事件、标准化证据、有效期和可选原始 JSON              |
| `episodes`         | 主路线、状态、评分、完整度、安全与特征快照、结果任务时间 |
| `signals`          | 唯一推送、Outbox、Telegram message_id、Quote 和最终指标  |
| `price_samples`    | Episode/信号的价格、Kline 和可执行 Quote 样本            |
| `api_stats`        | 分钟聚合指标以及错误/慢请求记录                          |
| `config_revisions` | 配置版本、哈希和非密钥快照                               |

约束：

- WAL 模式、单写入队列、短事务和必要索引。
- `events.event_key` 唯一。
- 每个 `chain + token + route` 同时最多一个活跃 Episode。
- `signals.episode_id` 唯一。
- 可调特征、安全明细和多指标先使用 SQLite JSON 字段，确有查询需求后再拆表。
- 重复全市场快照不入库。
- 原始 API JSON 默认 7 天后清空，标准化事件和结果不自动删除。
- `config_revisions` 不保存 API Key、Telegram Token 或其他秘密。

## 19. 精简项目目录

```text
gmgn-signal-bot/
├── package.json
├── package-lock.json
├── tsconfig.json
├── Dockerfile
├── config.example.yaml
├── src/
│   ├── main.ts
│   ├── config.ts
│   ├── gmgn/
│   │   ├── client.ts
│   │   └── types.ts
│   ├── scheduler/
│   │   ├── rate-limiter.ts
│   │   └── scheduler.ts
│   ├── collectors/
│   │   ├── market.ts
│   │   ├── trenches.ts
│   │   └── wallets.ts
│   ├── engine/
│   │   ├── episode.ts
│   │   ├── filters.ts
│   │   ├── routes.ts
│   │   └── scoring.ts
│   ├── telegram/
│   │   ├── client.ts
│   │   └── formatter.ts
│   ├── evaluation.ts
│   ├── monitoring.ts
│   └── storage.ts
├── tests/
└── data/
```

`config.example.yaml` 只展示结构，程序不读取；运行时始终只有一份真实 `config.yaml`。

## 20. 开发任务

| #   | 任务                                                                                                    | 依赖   |
| --- | ------------------------------------------------------------------------------------------------------- | ------ |
| T1  | 初始化 TypeScript 项目、唯一配置和校验                                                                  | —      |
| T2  | 建立 7 张 SQLite 表、约束和恢复流程                                                                     | T1     |
| T3  | 实现 GMGN 客户端、加权限流和优先调度；用真实 API 固定 Signal Type 映射、Kline 历史范围与 Quote 成本语义 | T1     |
| T4  | 实现六类轮询器、标准事件和精确去重                                                                      | T2、T3 |
| T5  | 实现两级安全硬过滤和 GMGN 字段映射                                                                      | T4     |
| T6  | 实现路线判定、证据、三级评分和完整度                                                                    | T5     |
| T7  | 实现 Episode、观察容量、定时/事件复评和重置                                                             | T6     |
| T8  | 实现三档双向 Quote 和最大安全仓位                                                                       | T3、T6 |
| T9  | 实现 SQLite Outbox 和 Telegram 全部功能                                                                 | T2、T8 |
| T10 | 实现正式信号与未推送样本的结果评估                                                                      | T7、T9 |
| T11 | 实现延迟、权重、错误和业务指标                                                                          | T3–T10 |
| T12 | 编写单元、并发、回放和故障恢复测试                                                                      | T4–T11 |
| T13 | 建立单 Docker 容器和 SQLite 持久卷                                                                      | T12    |
| T14 | 真实 API 限额/延迟验收并开始三路线样本积累                                                              | T13    |

样本积累不设置开发天数上限，以独立样本数量作为阶段依据。

## 21. 验收标准

### 21.1 配置与安全

- 程序只读取一份 YAML，所有阈值无需改源码。
- Phase 1 不加载签名或交易私钥。
- 秘密不进入日志和 `config_revisions`。
- 安全字段缺失、蜜罐、不可卖、危险权限和不合格 LP 不能推送。

### 21.2 GMGN 与容量

- 所有调用经过全局加权限流器。
- 持续权重不超过 14/秒，瞬时不超过 20。
- 高频和叙事 Signal 分别批量调用，不按 Signal Type 逐个轮询。
- 观察 Episode 每 30 秒完成 Info + Kline 复评，或记录明确的预算降级原因。
- 不主动制造 429；429 后按服务端时间冷却。
- 结果任务积压不能延迟正式信号。

### 21.3 判定与去重

- 三条路线判定优先级固定，不能对同一事件产生多条主路线。
- 每个代币/路线同时只有一个活跃 Episode。
- 相同来源事件只处理一次，同一证据族和评分维度不突破上限。
- 过期或反向失效证据不参与评分。
- 不足两个证据族、完整度不足或缺少最新决定性触发时不能推送。
- 达到正式条件并通过 Quote 的信号全部推送，不设每日数量上限。
- 新的独立路线重置后允许重新产生信号。

### 21.4 Quote 和延迟

- 10/50/100U 买入 Quote 第一批并行，对应卖出 Quote 第二批并行。
- 10U 不可安全往返时不推送。
- 50U/100U 失败不会阻止安全的更小仓位信号，消息正确显示最大安全仓位。
- 对已有深度数据、首次完整分析、GMGN Signal、Trending/Trenches 四类延迟路径分别输出真实样本量、负载档位、P50/P95/P99、失败率和阶段拆分。
- 将实测结果与 3/5/6/15 秒理论预算比较，但在 T14 完成校准前不得把理论预算作为已验证基线或不可调整的发布门禁。
- 超过最新触发窗口的信号不补发。

### 21.5 Telegram 与恢复

- 能发送、编辑、删除、处理按钮和授权回调。
- `signals.episode_id` 唯一，竞争触发只能生成一次推送。
- 并发判定和普通失败重试不会重复创建信号。
- Telegram 响应未知时进入 `DELIVERY_UNKNOWN`；允许至多一次带相同 `signal_id` 的重试，并正确标记可能重复，不能虚假承诺 exactly-once。
- 同一 Episode 的后续确认只更新原消息。

### 21.6 结果质量

- 市场收益与可执行净收益严格分开。
- 10/50/100U 使用各自模拟入场数量和卖出 Quote。
- MFE/MAE 使用 Kline high/low，同 Kline 内 TP/SL 双触发标记 ambiguous。
- 缺失或延迟 Quote 显式记录，不伪造结果。
- Telegram 确认后超过 5 秒才开始的模拟入场 Quote 不进入主要可执行收益口径。
- 检查点后超过 10 秒才开始的卖出 Quote 标记 late，不冒充该检查点的可执行收益。
- 新币启动、老币复苏、趋势延续各累计至少 100 个独立正式信号。
- 所有达到 65 分的未推送 Episode 保留结果，用于评估漏报。
- 标准化样本不按时间自动删除。

## 22. 后续阶段

Phase 1 完成样本验证后，再单独设计：

- GMGN Swap 和交易确认。
- 钱包、签名密钥和权限隔离。
- 自动止盈止损。
- Anti-MEV。
- 自动交易失败恢复。
- 实盘仓位和风险上限。

自动交易必须作为独立变更设计和验收，不能因为当前信号代码预留接口而提前启用。
