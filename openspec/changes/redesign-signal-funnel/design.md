## Context

动机见 proposal.md。基线为 b55f025；当前正式链路正常采集、共用 GMGN 20 权重/秒限流，Quote 同通道串行且响应后至少间隔 1000ms。卡片与发送快照已冻结；`responseTiming` 保存物理请求/完成时间，但未形成持久化、可关联的事实契约；`evaluation/entry.ts` 的逻辑调用时间不能作为物理新鲜度证明。

现有影子导出截至 2026-09-07 10:11:43 UTC，16 个首次合格 token 的 2x/-10% 结果有 12 个未知，且多数影子未独立追踪。不把这些记录当作最终验收集。原方案和 Review 位于 `artifacts/review-2026-09-07/`，仅提供背景，新增行为以本变更的 specs 与 design 为准。

## Goals / Non-Goals

**Goals:**

- 让数据采集、点时回放、机会判定、最终复核、基准采样与模型晋级均有确定的输入、输出、错误和测试。
- 能独立回答“市场条件有无增益”和“部署后的延迟是否耗尽机会”；记录无信号的真实原因。
- 不预定获胜形态，以有限实验和未查看数据产生最小模型；质量不成立就输出 NO_PROMOTABLE_MODEL。

**Non-Goals:**

- 本次提案不执行代码或部署；未来开发也不保证盈利、绝对命中率或一定有晋级模型。
- 不自动交易，不改已发卡片，不迁入本机 DB，不补发历史信号，不扩展到 GMGN 之外的数据源。
- 不在本变更中放宽合约/LP/持仓安全底线；预测性风险标签的研究不替代安全门。

## Decisions

### D1. 五阶段实施与交付门

| 阶段 | 可执行工作和产物 | 进入下一阶段的确定条件 |
|---|---|---|
| A 事实与兼容 | 增量 schema、响应时间/来源契约、只读审计 CLI、现有调用的被动记录、legacy 回放适配器 | 现有发送行为回归通过；数据契约审计输出支持/不支持矩阵；无凭据持久化 |
| B 有界测量 | 公共母集采样、三轨基准、预算清单校验、混合负载回放、结果追踪与字段覆盖报告 | 预算校验和基准反例通过；不能验证来源时间时允许交付工具，但主市场轨道标不可用，不进入依赖它的质量验收 |
| C 有限研究 | 开发数据报告、候选 manifest、选择集结果、唯一模型包或 NO_PROMOTABLE_MODEL | 最多 12 个事先登记的候选；按 D7 排序选出一个符合预筛条件的模型，完整冻结全部清单 |
| D 独立最终测试 | 新 token 的前向测试、固定截止报告、晋级凭据或 FAIL/INCONCLUSIVE | D7 的指标/覆盖/不确定性条件全部通过；任何改模型均重新取最终测试集 |
| E 兼容切换 | 激活已冻结的 publisher 适配、配置切换、legacy 资格路径移除、回滚演练与部署清单 | 凭据匹配当前模型/基准/预算版本；无未处理投递；代码检查与回滚演练通过 |

研究参数未知是 C 阶段的输出，不是 A/B 开发任务中的任意 TODO。每阶段可明确结束为“不支持/证据不足”，不为了完成任务强迫晋级。相比一次重写正式筛选，这样可保留旧服务行为并为替代模型积累独立证据；相比继续给旧链加 if，事实与模型接口只建立一次。

### D2. 模块边界与 GMGN 字段契约

新增 `src/research/`（清单、回放、数据集、选择和验收）、`src/decision/model.ts` 与 `opportunity.ts`、`src/evaluation/baselines.ts`、`src/gmgn/facts.ts`。`src/index.ts` 只接入编排；市场规则与最终检查使用同一个版本化纯判断器。旧 `routes/scoring/shadow` 在过渡期作为 legacy 适配器，不参与新模型的前置准入。

| 来源及权重 | 使用的已接入字段 | 约束和缺失输出 |
|---|---|---|
| Info 1 | `price.price`、`liquidity`、`price.buy_volume_1m/5m`、`sell_volume_1m/5m`、`volume_1m/5m`、`buys_1m`、`swaps_1m/5m`、池地址、创建时间和 launchpad 状态 | 有限非负金额、分母为零则比例未知；交易次数不等于买家数；创建时间不充当价格时间 |
| Kline 2 | `time/open/high/low/close/volume`、`completed`；swaps 可选 | GMGN 现有适配按毫秒 time 和请求分辨率解释；检查连续性/边界/同时间冲突；不补造无成交 K 线 |
| Security 1、Pool 1 | 税、权限、可卖性、风险标志、LP；池地址、流动性 | 原安全适配和阈值不变；池与 Info 不匹配为 UNKNOWN，不借助高市场分抵消 |
| Holders 5 | `address/amount_percentage/is_suspicious` | 排除已验证池地址后计算，重复地址/缺字段按现有 typed reason；仅是头部覆盖 |
| Traders 5 | 地址/标签、累计买卖数量/金额及余额 | 比较同钱包、同语义、有效基线；转账不一致/覆盖变化为 UNKNOWN；不能宣称全市场新增钱包 |
| Created Tokens 2 + Info stat | `open_ratio`、创建数量、创建者直接持仓 | 直接持仓仍属安全；历史只作分析标签，不额外给新模型加扣分 |
| Signal 3、Trenches 3、Trending 1、Hot 3、Smart Money/KOL 1 | 事件/快照、token、来源时间、类型、方向 | 用于公共发现与风险消息，来源无价格时间证明力；不自动等同当前买压 |
| Quote 2、Gas 1 | `output_amount`、`tx.amount_in_usd/amount_out_usd/gas_limit`、请求 slippage、原生币 USD 价 | 用现有 Decimal 解析和成本语义；不能将 requested slippage 当实际滑点，不重复添加未单列费用 |

事实 envelope：`fact_id(UUID), chain, token, pool_revision, endpoint, purpose, model_id?, attempt_id, queued_at, requested_at, received_at, source_at?, source_time_status, source_contract_version, semantic_hash, payload_version, sanitized_payload, quality_flags`。返回来源时间只有经过端点实证审计的价格/交易时间字段可设置 VERIFIED；HTTP Date、代币出生时间、事件时间、收到时间都不能替代。当前 Info 解析尚未验证价格来源时间，默认 UNKNOWN；实现 audit 命令输出证据，禁止猜字段。无法验证时保留观察诊断，不算可靠主基准。

`available_at=received_at`；重放只读 `available_at <= evaluation_at` 的记录。物理重试各有 attempt，缓存保留原 fact_id 和时间；同值但有更晚可靠来源时间可成为新事实，同缓存或无新来源证明的重复不能充当独立确认。数值相同本身不等于重复，也不等于资金持续。

每个物理请求通过 `GmgnContext.purpose` 显式携带 `legacy_formal/shared_collection/shadow_execution/baseline/outcome`，不能只靠 priority 推断；保留既有优先级语义。物理 transport 在拿到 admission 后记录 requested_at，返回时记录 received_at，并将 attempt/fact 关联持久化。API headers、认证参数、私钥、Telegram Token 不进 payload；钱包/代币地址仅保留业务需要的公开标识。

### D3. 公共母集、存储与有界数据生命周期

新增增量表（下一未占用迁移号，实施时检查）：

| 表 | 不变身份/约束 | 可变部分 |
|---|---|---|
| `research_facts` | fact_id；attempt+endpoint 响应唯一；原始事实不可覆盖 | 引用计数/归档状态 |
| `research_universe` | chain+token+pool_revision；首次发现信息 | latest_seen、采样层、风险状态 |
| `research_runs` | run_id；dataset/model/budget/baseline manifest 哈希 | 阶段、截止、结果、消费状态 |
| `market_opportunities` | token+pool_revision+model_hash+activation_fact_id 唯一；anchor_price/time 永久不变 | 状态、版本号、失效原因；CAS 更新 |
| `funnel_decisions` | run+opportunity+evaluation_fact_set_hash 唯一；记录输入 IDs 和每阶段结果 | 只追加，不把 latest 覆盖首个决定 |
| `evaluation_baselines` | run/opportunity/signal 可关联；track+protocol_hash 唯一；价格/时间冻结 | PENDING→VALID/UNVERIFIED/MISSING，终态只追加新版本，不重置 |
| `research_outcome_tasks` | baseline+target/horizon+task_kind 唯一 | due/attempt/deadline/status；重试不改观察终点 |
| `dataset_memberships`、`promotion_certificates` | token 唯一用途组、数据集哈希；凭据绑定全部 manifest | 消费/撤销状态，保留历史 |

所有任务仍用同一个 SQLite 写队列，事务中不发网络请求。旧 signals、episodes、delivery snapshots 不回填新含义；可以外键关联，不能把 research READY 写成旧 READY。新机会和 legacy Episode 分别存储，只有经发布适配器才产生 outbox。

公共母集在来源标准化后、旧市场证据/评分之前记录。安全拒绝可以进入低频研究抽样，不执行报价或推送。采样键 `hash(run_seed, chain, token, pool_revision)` 确定：每个运行层内稳定；计入层和概率，不仅保存通过者。容量淘汰保存 RESOURCE_EXCLUDED，不能删除母集条目。模型不能自主提高其候选采样频率。

初始工程保护默认值（不是市场资格阈值）：公共热集最多 20 token，按固定 hash 顺序轮转；新增采集预算按 D6；结果待办最多 200，溢出落排除记录；无引用事实保留 7 天，run 引用事实固定打包为本地 dataset 文件并保存校验和后才能清理；研究 SQLite/归档合计上限 2 GiB，达到上限停止新增研究采集，旧正式服务继续，报告 STORAGE_BUDGET_EXHAUSTED。禁止无限 pin；若引用集合超预算则终止该 run 为 INCONCLUSIVE，不删掉困难样本继续验收。正式已有 DB 历史不计作可删除研究垃圾。

已打包事实的ID及校验和目录留在DB；回放解析器按fact_id读取在线记录或已校验归档。只清理payload副本，不级联删除决定、数据集成员或引用目录。归档也计入2GiB，不能靠搬文件绕过容量门。

### D4. 统一模型与机会契约

`evaluate(state, facts, evaluationAt, manifest) -> {stageResults, transition, requiredFacts, decisionContext?}` 不直接调用 API。阶段结果为 PASS/FAIL/UNKNOWN/NOT_EVALUATED；DATA_WAIT 与 RESOURCE_EXCLUDED 分开。所有必需输入满足同一 manifest 的来源/TTL规则，数据不足不能默认零或通过。

模型包必须定义：所需字段、变换、固定参数、候选激活、确认、失效、重置谓词、最大机会寿命、入场约束、版本；谓词只使用登记表达式和当前可用事实。未填完整/使用不支持字段/存在自由执行脚本时拒绝加载。使用有限比较、布尔 AND/OR、Decimal 算术和窗口聚合，不引入任意代码注入式策略语言。具体公式在 D7 有限研究中产生，加载器与回放器可先独立实现。

状态：WATCHING→START_CANDIDATE→READY→CONSUMED；任何未消费状态可到 INVALIDATED/MISSED。数据等待保存原状态，不刷新 anchor；资源等待超过 manifest.deadline 变 MISSED(RESOURCE)。同一次机会只在激活谓词由 false→true 且新 activation_fact 上建立。失效后必须先观察到 reset_predicate 的独立新事实，再允许下一次 false→true 激活；进程重启、pool 名字变动、同源新消息、发送取消不满足重置。

池迁移单独生成 pool_revision，原机会 INVALIDATED(POOL_CHANGED)，旧未发送准备取消；新池重新验证安全并重新激活，不能借迁移复制旧 READY。已发送或投递未知的 token 具有跨 pool 的防重发锁；UNKNOWN 不自动超时解除。每个机会是否允许二次发布由显式新激活和发布去重契约决定，研究可以继续。

触发只表示启动候选，不表示事后已经证明延续。短确认、即时和回踩是互斥研究模型，不是三个必过门。上游标签不能替代 market 条件；安全/可执行资格通过同一风险契约在昂贵环节前后按需复核。

最终准备使用冻结的 DecisionContext（机会、模型、anchor、risk facts、入场约束、报价事实），刷新只更新事实引用与验证结果，不换模型/重写锚点。买压、价格或 pool 失效须取消而不是重新分类到较宽路线。旧安全阈值沿用部署 revision，并将风险策略哈希纳入比较；不可在新旧模型间暗中改变安全要求。

### D5. 配对基准、结果和 F1 的确定实现

三个轨道均包含 protocol_hash，不能混算：

1. `card_reference_legacy`：原卡片价格/实际观测区间、请求及确认时间分别保存；原冻结数据与历史结果不改，只叫相对卡片参考表现。
2. `post_confirmation_market_v1`：在确认之后物理发出的 Info 请求中，按 response received 顺序选第一份来源可验证且新鲜的价格。初始测量协议：总等待上限 5s、单请求物理超时 2s、最多 2 次物理尝试且不越总期限、price source_at 不早于确认、来源到收到不超过 2s；这是数据协议初值，不是行情入场阈值，选择集前可登记新版，最终测试期间不变。time=received_at；source_at 至 received_at 为边界不确定区间。若边界内不能排除目标先触及，对该目标 UNKNOWN。无可靠 source_at 时 UNVERIFIED，不以请求时间代填。
3. `post_confirmation_quote_v1`：最低 10U 买入 Quote，物理开始/完成都在确认后 5s 总期限内，最多 1 次尝试；配对实际 token 数量、成本与收到时间。报价为可获得的模拟执行条件，非成交证明。后续只能用同数量卖出 Quote 计算模拟出场；K 线结果不可替代。该请求受研究预算和正式优先约束，无容量则 MISSING_RESOURCE，不回退卡片价。

基准采样先持久化 PENDING，再调度；所有机会包含无基准记录且保留在分母。断电恢复超过期限直接终态缺失，不能第二天重新抓低价。首次合格观测由 CAS 冻结，即使后来的并发响应价格更低也不覆盖。失败原始原因、排队时间、物理时间、来源时间及盲区一并保存。

影子虚拟确认为准备完成时间 + 注册的固定延迟：默认研究场景 1000ms，并明确 SIMULATED；只有选择前获得的独立投递日志能生成其他场景，不能在测试中重新拟合。基准请求不得早于虚拟确认。对照模型使用相同基准协议和固定延迟场景；真实确认与模拟确认的差异不隐瞒。

上述虚拟确认用于阶段D完整准备试验。阶段C离线市场选择没有逐模型准备，使用独立的`decision_market_replay_v1`诊断协议：第一市场合格决定时已返回且来源可验证、来源年龄≤2s的最新价格事实，price与该决定的evaluation_at配对，按同样边界不确定规则分析其后路径。不追加API、不虚构准备完成；无可用价格则缺失。它是三轨中的市场轨道的独立协议版本，不能称确认后入场表现或与阶段D合并。阶段C的80%覆盖和排序只在此协议内比较双方；真正发送后的空间必须由阶段D的确认后协议重新证明。

市场主指标每目标分别为 TP/SL/NOT_TOUCHED/CENSORED/UNKNOWN/MISSING_BASELINE；`TP/(TP+SL)` 只为条件命中率；`TP/N_all` 是全部应评估样本的已证实成功比例；基准有效率、先触达可判定率和完整但未触达率另列。先跌后涨在原阈值下仍 SL，同时可标为高波动延续。未知不能按失败或成功插补。

以倍数1.3/1.5/2/3及下跌10%为事件目标，时间只控制覆盖。初始共同观察上限 24h，各机会从自身配对基准起算；统一采样 cadence：前10min每30s、10–60min每2min、其后每10min，并由全局预算降低实际抓取而不改请求的观察坐标。按 token/pool/range 复用已存 K 线，单次结果任务最多2次补洞、总3次捕获；24h未触达标CENSORED/NOT_TOUCHED而非亏损。不为每根K线执行卖出Quote；执行轨道仅在已观测目标事件或60s审计时点申请预算内的退出报价，迟到时只报实际时点模拟结果，不声称精确在阈值成交。

历史若只有发送前价，不能产生新主轨道；已有确认后 Quote 的逻辑时间不足以证明物理时效。可加入诊断回放，不能纳入最终测试。若可信主基准覆盖达不到 D7，结果明确 INCONCLUSIVE_DATA，工程仍可交付，不放宽来源条件去凑命中。

### D6. 资源清单与 F2 的确定实现

事实流离线比较不新增每模型请求；真实执行试验至多1个影子模型、1个影子机会在途、1个待办（按稳定hash选取，其他记录排除）。所有物理请求共享当前 scheduler 和 persistent cooldown；重试逐次计权，不借runLogical重复扣费，也不跳过物理通道限制。

新增研究模式默认 `off`；可选 `observe`（仅记录现有响应，不新增API）、`collect`（公共补采/基准/结果）、`execute_shadow`（唯一模型执行）。正式 publisher 默认 legacy，模型无有效凭据不得选 new。

初始非市场预算：研究全部新增流量使用每秒补充2权重、容量5权重的token bucket（启动空桶），并另设滚动60s最多120权重；不是每个滚动秒只能花2，积累2.5s后允许权重5的Holders/Traders请求。每个子用途还受父预算限制，不能相加突破；正式保留现有6权重 reserve和14 soft/20 hard，不让研究消耗reserve，任何滚动1s仍不得超过全局20。研究物理并发1，网络超时最多2s、物理attempt不超过2（Quote1），所有研究Quote含基准和退出合计最多6次/min。Quote服务时间单独核算，物理间隔不得短于当前学习后的1000–3000ms；可选大额Quote默认关闭。预算消耗与正式/研究准入检查在同一调度临界区完成，失败准入不扣费，实际重试重新扣费。

任何正式待办/在途、关键请求等待超过2s、cooldown或指标采集故障，暂停新增研究请求。恢复要求连续60s无正式待办且关键等待未超2s、无cooldown；正式流量经常活跃时允许研究少量甚至零执行，必须显示资源不可行，不伪造覆盖。超时+学习后间隔为非抢占最坏阻塞，初始允许阻塞上限3s；若超过3s（例如间隔学到2000ms），自动禁用研究Quote。上述值是保守工程实验上限，不宣称已满足生产SLO；execute_shadow须额外通过对应混合负载测试。

Quote每条腿重新准入，不预占完整买卖对，卖腿等待导致买腿过期则有限重试或RESOURCE_EXCLUDED。复用键包含chain/pool_revision/钱包/输入输出token/方向/精确数量/slippage/语义版本；received<=decision time、requested TTL合格、无实质市场变化才允许复用，不能只按token+10U。研究结果不能改变正式优先级。

验收用同一实录到达流+mock传输时延做研究开/关对照，记录新增阻塞、正式P50/P95/P99、各模式请求数/权重/资源排除。执行影子不得让任何模拟正式请求新增超过3s的非抢占等待；真实试验若观测到该阈值或出现429立即暂停研究，保留证据。不得发送测试Telegram验证，使用现有真实投递日志或mock；需要额外消息另属后续授权范围。

### D7. 有限研究程序与 F3 的确定实现

初始研究以现有数据开发，不宣布发现“最优参数”。实现一个 manifest 生成/校验/回放工具：每个候选完整定义字段、表达式、窗口、数值、激活/确认/重置/失效、机会期限，不能在运行中学习或留空。阶段C由开发报告输出该manifest；不支持字段的候选先被校验拒绝，不偷用缺失值。

研究计划先登记最多12个候选，分最多3种确认方式（即时/短确认/回踩对照），每方式最多4种参数组合。组合由开发集的预先登记分位数候选或明确的业务比较点产生；开发报告列原始分布、采集粒度、重叠窗口依赖与参数推导。选择集只运行登记模型，新增候选需新selection_run，不可反复在同一最终集上搜索。市场模型初次freeze若还不能给出明确的规则manifest，阶段C未完成，不推进D。

候选起点和样本单位：公共研究起点由不依赖后续表现的固定发现事实/可用变化事实确定并固化，低活跃和未启动也保留。每token在各数据用途组主统计只用该模型第一合格机会；更多机会另表以token聚类，不扩大主样本数。阶段C按决定时诊断基准、阶段D按确认后基准衡量后续价格，都不从最初发现价替代等待后入场价。不同模型是否触发本身计入共同母集覆盖率，不能只比较双方都通过者。

三阶段数据用途：
- 开发集：已查看历史与新增开发数据；用于字段、标签、参数、归一化和预算估计。
- 选择集：开发完成后登记的新token组，用于有限模型比较；是调参/模型选择用途，不是最终证明。
- 最终集：唯一模型、完整基准/资源/评价协议与对照冻结后才开始，新token组不得在前两阶段出现。按chain+token分组跨pool不拆分；回看窗口和标签不能跨用途泄漏，拟合时不得看未来才成熟的结果。

阶段C预筛：决定时诊断基准有效率及1.3x/2x目标先触达可判定率均≥80%，独立合格token≥100；这两个目标的全母集已证实TP数量/母集token数均不低于对照，且不能以只留极少信号获得较高条件率。选择按1.3x的已证实TP/all qualified差值、再2x差值、再更少条件数量、最后model_hash字典序排序；这是选择算法，非显著性声明。无候选满足则 NO_PROMOTABLE_MODEL，不自动扩展搜索。

最终测试清单固定：至少100个独立合格token且每个主目标可判定≥80%；最多采集30天，再等每个已纳入机会24h观察期+最大2h补采，届时只评价一次。该截止是资源/数据成熟安排，不把时间到达作为盈亏。若样本不足为INCONCLUSIVE，不延长直到结果好看；下一run需新未查看token。

最终门禁：在共同母集上，对“该模型每token第一合格机会”的1.3x和2x轨道分别报告条件率、TP/all qualified、母集捕获率、未知、基准等待与成本；相对冻结legacy对照，1.3x TP/all qualified差值的单侧95%下界>0，2x差值下界≥-0.05；母集TP捕获率差值下界≥-0.02；新模型同目标SL/all qualified差值上界≤0.02。使用按token重采样的成对bootstrap（母集token连同双方有/无信号一起重采样，10000次，seed来自run哈希）；任一分母为0或结果无有效界限判INCONCLUSIVE，不填0。四类条件都要满足，不挑有利指标；这是初始预登记取舍，测试前可生成新协议，但不能用测试结果修改本轮标准。金额/市场涨幅不混合，执行基准有效率不足80%或Quote成本/安全退步不得晋级。

上述100token及80%门对新模型和对照分别检查，不能以合并数量或只取双方成功采样交集满足。市场比较以安全门后、执行准备前的第一市场合格机会为分母，准备失败和资源排除仍留在其中；阶段D准备未完成的样本没有虚拟确认，主基准记MISSING_PREPARATION。共同母集包含双方均未触发者，不能只保留能完成报价的样本。阶段C只做D5决定时协议下的市场选择，离线缺失执行证据不得标执行通过；阶段D才对唯一入选模型做完整执行验证，对照使用同一协议的基准采集，所有对照补采也在研究父预算内，不另起第二条并行准备流水线。

缺失敏感性同时展示每个目标的成功比例区间：[TP/N, (TP+U)/N]；U为该目标的UNKNOWN、MISSING_BASELINE及仍无法判定目标的CENSORED之和。MISSING_PREPARATION是MISSING_BASELINE的原因，不另增结果类别或重复计数。完整区间未触达为NOT_TOUCHED，只说明观察上限内未触达，不外推终生失败；观察区间不完整为CENSORED，已发生但先后不明为UNKNOWN。1.3x主改善还须通过保守敏感性门：新模型TP/N减对照(TP+U)/N的bootstrap单侧95%下界>0；否则INCONCLUSIVE_MISSINGNESS，不把采集覆盖改善直接宣布为市场规则增益。此门很可能需要比80%更完整的数据；不能为了获胜放宽。

执行成本使用现有`quote/gate.ts`的10U准备阶段`roundTripLoss=max(0,(buy.inputUsd-sell.outputUsd)/buy.inputUsd)`及单腿损失，保留成本语义、物理新鲜度和同数量校验；不以未来卖出价计算准备成本。两组各至少100个独立市场合格token，准备双向报价及确认后买入基准各覆盖≥80%。准备中无路由/超原风险阈值的样本记录执行失败，不删样本；任何实际允许发布的记录都必须通过原安全/成本硬门。对有效准备成本，使用同一token bootstrap：新模型减对照的中位数和P95 roundTripLoss差值，其单侧95%上界均≤0.01（绝对1个百分点）；准备失败比例差值上界≤0.02；不满足或分母不足不得晋级。这些是冻结的初始非劣容忍值，不是零成本承诺；缺失原因/比例分组报告，任一组低于覆盖门则INCONCLUSIVE。历史缺物理时刻的准备报价只作诊断。

最终验收期间只查看健康/覆盖，收益结果到固定截止才解封；任何提前查看并据此改模型、挑停止时点或换指标都将该dataset标CONSUMED_FOR_SELECTION，不能继续给本模型发独立凭据。失败/证据不足可以交付，但任务不得标成策略成功。

晋级凭据由验证CLI生成，包含model/dataset/baseline/budget/risk-policy/code schema哈希、指标结果、时间、状态。它是本机可核验的校验记录，不是密码学盈利保证；运行时核对全部哈希和未消费状态，模型变动立即失效。默认模型不自动晋级为正式，发布配置只能引用通过的凭据。

代码契约哈希由明确列入manifest的模型解释器、字段适配、风险/准备、基准和评价实现构建产物产生；不是整个仓库commit哈希。最终测试开始前必须完成并冻结发布适配器的干运行路径，阶段E只激活已验证路径。改变上述语义依赖必须使凭据失效；仅文档/日志改动可以保留，不能为适配器代码升级随意排除语义依赖。

### D8. 配置、命令与实现落点

新增唯一YAML的非秘密 `research` 节点：mode、run_id、manifest_path、max_storage_bytes、baseline_protocol、budget；旧配置未提供时完全off。研究market参数只在versioned model manifest，不能在index和pre-send各复制一份。`publication.engine=legacy|validated`、model_hash、certificate_path 初始legacy。若选validated却无有效凭据，publisher启动失败并报错，不发送、不静默回退legacy；恢复legacy必须在后续启动明确选择legacy配置。未配置新节点的旧部署仍按原模式启动。

计划CLI（通过 `npm run research -- <command>`，不新建服务）：`audit`（字段/来源/覆盖）、`dataset freeze`、`manifest validate`、`replay`、`select`、`evaluate-final`、`budget-check`、`promotion verify`。默认只读/离线，任何新增API只能由运行服务按mode和budget采集；CLI不创建独立GmgnClient，禁止`replay`访问网络。输出标准JSON+Markdown，所有错误有reason和阶段，不发送Telegram。

运行时模块分工：client/facts负责物理证据；discovery负责母集；安全模块负责原风险；model负责纯规则；storage负责CAS和任务；scheduler负责每物理attempt的预算；baselines/outcomes负责结果；outbox只负责统一准备与不可变发送。所需 meaningful tests 映射见tasks。

## Risks / Trade-offs

- Info 无可靠价格source_at → 主市场轨道可能不可用；阶段A直接输出不支持，不能用HTTP Date伪装。可做诊断研究与Quote模拟，但不能通过主门禁。
- 30s K线无法证明快速先触达 → 保留边界UNKNOWN，预先评估覆盖可行性；不以更多轮询造出秒级成交。
- 2权重/s研究预算和严格正式优先可能采不到足够样本 → 分层报告资源排除，离线比较与执行验证分开；预算修订必须单独冻结并重做负载验证。
- 长生命周期与存储限额冲突 → 24h共同观测上限及2GiB停止规则使工作可完成；截断不算失败，不宣称完整链上生命周期。
- 新旧24h/60min结果不可比 → 新轨道以baseline协议哈希和固定观察终点独立存储/分组；旧表只关联不改写，不复用旧quality_version制造同口径假象。
- 单次100token未必有统计把握 → 界限不确定则INCONCLUSIVE；不减少所需不确定性要求去迎合样本数。
- 重构破坏历史delivery → 新表/新模型状态与旧表隔离，阶段E前不切publisher；旧snapshot触发器保留。

## Migration Plan

1. 本地增量schema和research off合入后，运行 `npm run ci`（Node24）及迁移/恢复回放。GitHub→SEA pull→compose，启动off验证原调用/发送不变。无本机DB迁移。
2. observe只录既有响应；得到audit报告后，按审批过的部署变更启用有界collect，不能在服务器改代码。模型与budget清单不包含凭据，可随代码发布；`.env`和真实config保持服务器已有位置。
3. 完成选择和最终验证后准备切换：停止新outbox准入，等待PENDING准备退出；有DELIVERY_UNKNOWN则保持token锁且阻止不安全切换，不重发。新publisher适配写旧投递表时使用显式model_id/strategy_version，新模板不伪装成new_launch评分。
4. validated模式只允许有效凭据且schema兼容的版本，失败则启动失败并报警，不静默切另一模型。阶段A先交付能识别全局token投递锁及decision_format/publisher_version的兼容legacy镜像并登记digest，作为最早允许的回滚版本；不能直接回滚到未经兼容的b55f025。回滚先关新准入，恢复明确legacy配置和该兼容镜像；不同decision_format的未完成准备必须取消或隔离，不能由legacy错误消费。数据库不回滚、不导旧备份覆盖新delivery状态，已发送/未知锁仍保留。切换和回滚均通过单进程独占发布租约防止两个publisher并行。
5. 删除旧正式资格代码在切换验收后单独commit，保留只读legacy回放/历史解析。旧路线/评分键在validated模式报废弃配置错误，在legacy模式仍按旧语义；避免一边要求回滚一边全局拒绝旧配置。市场策略无晋级证据时阶段E不执行。

## Open Questions

无阻塞工程启动的未决设计。GMGN来源时间可用性、市场参数和模型是否能晋级分别是A/C/D的可失败交付，已有明确输入、算法、终态与后续门禁；不得将未通过阶段当作待开发者随意补值的配置。
