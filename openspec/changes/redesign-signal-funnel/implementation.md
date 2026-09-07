# 本轮实施与发布记录（2026-09-07）

当前任务 **18/39 完成，21 项未完成**。这不是整个提案完成或新规则通过验收。下文保留前批记录；本节为最新状态。

## 本轮已交付

- 2.3–2.4：冻结配置哈希的 legacy 市场回放、统一研究决定输出、manifest validate / replay CLI；从已有事实和校验归档读取，不发 API / Telegram 请求。安全与执行缺失明确 NOT_EVALUATED，不把市场 PASS 当正式通过。
- 3.3：1.3/1.5/2/3 倍与 -10% 先触达、边界/缺口/冲突 UNKNOWN、24h 未触达与等待区分。
- 4.1：同一 scheduler 准入临界区的研究空桶 2 权重/s、容量5、滚动分钟120与全局 reserve；物理研究请求2s绝对超时，Quote不重试。
- 5.1 / 5.3：数据用途冻结/跨池 token 隔离、有限选择预筛与固定排序，NO_PROMOTABLE_MODEL 失败出口。
- 6.2–6.3：共同母集 token 配对 bootstrap 10000 次、固定 seed、样本/覆盖/捕获/SL/缺失敏感性/10U 成本非劣检验。统计 PASS 明确不是晋级凭据。

其余已编写但未整体验收的组件：baseline PENDING/CAS/期限存储、Quote同数量配对、分段任务坐标与3次捕获上限、干运行发布接口、合成混合到达负载 CLI。相应完整任务仍不勾选，避免把接口或合成测试当真实接通。

## 验证与发布边界

- Node24 `npm run ci`：310/310测试通过，类型检查、lint、编译通过。
- OpenSpec strict validate 与 git diff --check 通过。
- 发布文件扫描214项，没有匹配本机现有 GMGN/Telegram 凭据或私钥头；配置/数据库/artifacts/scripts仍被排除。
- `budget-check` 为生产 scheduler 的合成争用反例：研究买腿在途时正式到达，最大新增等待2000ms；4次研究发出、4次卖腿因资源排除。证据hash `f0765a5abab1ba98a5323cf33ce9a9d26d94854fb49837b959fd596818a78bcd`。这是合成夹具证据，**不授权 execute_shadow**，不代替全链路混合负载验收。
- SEA部署前：版本b55f025；容器healthy；近15min 3866次请求全部200；SENT 16、SEND_FAILED 50、PENDING 0。该计数为部署前快照，不是新模型收益结果。
- Compose显式选择observe，应用缺省仍off。正式publisher仍legacy，新增研究请求及新模型真实发送保持关闭。不会导入本机数据库、改写历史卡片或发送测试消息。
- 镜像标记 `org.0xbsc.publication-compatibility=global-token-lock-v1`；部署后登记SEA实际镜像ID，回滚不恢复旧DB或解除UNKNOWN锁。

## 剩余任务和阻塞

工程尚未完成：真实确认配对采集、完整新publisher/最终风险及报价适配、collect/execute_shadow编排、全链路负载证据、最终run登记/唯一解封/晋级凭据、切换清理。详见tasks.md未勾选项。这些不能声称仅需等待市场数据。

数据契约阻塞：现有可审计Info价格无已验证来源时间，无法取得主市场基准的80%可判定覆盖证明。不能用响应时间/HTTP Date替代，更不能把卡片前涨幅计为推送后命中。解决/修订这一契约后，仍需完成有限开发和独立选择；选出唯一模型后才可启动固定30天+24h+2h最终测试。最终run尚未启动，正式新策略未激活。

SEA首轮核验发现发现类响应解包不全；已返回本地修复并增加回归测试，正式发现逻辑不变。Docker权限设置改为COPY --chown，避免复制后递归改依赖文件所有权。

代码审查与修复见[code-review.md](code-review.md)。部署实测记录将在deployment.md中登记。

---

# 实施记录

## 阶段 A 模块与兼容基线（任务1.1）

实施起点：b55f025；旧迁移截至014。新增015研究事实、016投递兼容，原迁移校验和不变。未读取真实config/.env；没有请求GMGN或Telegram。

| 入口 | 现状及实施边界 | 验证依据 |
|---|---|---|
| gmgn/client + scheduler | 每次物理attempt持久化审计；成功响应新增允许字段fact，保留排队/请求/返回时间；失败仍走既有attempt审计 | test/gmgn/client、scheduler、governor及research/facts |
| gmgn/api | 原缓存与WeakMap对象身份保留，复用不额外生成fact | research/facts的gas缓存场景 |
| discovery/runtime | 公共母集钩子在旧排名、证据、评分及工作队列之前；不把研究对象加入正式处理 | research/storage及既有discovery测试 |
| safety + quote/gate | 原风险/税/LP/协调退出/成本阈值和Decimal口径不变；10U roundTripLoss仍来自同数量双向准备报价 | test/safety、test/quote；src/gmgn/quote.ts原成本契约 |
| storage | 015独立表与CAS/不可变触发器；不覆盖旧signals/episodes/cards；共享串行写队列 | research/storage、storage/database及旧版本升级fixtures |
| outbox | 016为发布兼容基础：独占租约、HTTP前持久化UNKNOWN锁、跨池/跨版本防重复；旧格式解析保留 | research/publication、delivery/outbox |
| config/index | 缺research节点等于off；observe仅旁路记录；研究配置不改正式revisionId，不误清候选 | config/load及全量回归 |

冻结行为：卡片与发送快照不可变，不恢复消息编辑，不自动交易。安全强化的预期差异：生产publisher不再自动重试UNKNOWN发送；已确认/不确定token跨路线/池的重复准入被锁阻止。lease过期不会解除token锁，只有明确获知未发送（如Telegram返回429）的本次预留可以释放。此项属于提案要求的兼容保护，不改变市场分数或风险阈值。

## 来源契约证据

`test/fixtures/research-contract-shapes.json`只收录2026-09-03 GMGN实录审计的端点路径和响应字段类型，并注明原文件SHA-256。它不是原始响应值，也没有物理时间证明。Info包含价格/滚动成交量，但没有已验证价格来源时钟；Holders/Traders的历史结构只证明列表存在，不证明全钱包覆盖。

因此当前audit固定报告市场主基准UNAVAILABLE / PRICE_SOURCE_TIME_UNVERIFIED；禁止用HTTP Date、创建时间、逻辑调用时间代填。新事实记录可用来排查覆盖和排队，但本批不能产生模型晋级凭据。

## 阶段边界

本批配置仅接受off/observe。collect/execute_shadow尚未完成共享预算与负载验收，配置拒绝这些值；没有开放会抢占正式流量的新采集入口。具体市场规则、有限选择、独立前向验证与正式切换仍为后续任务。任务勾选只表示对应已实现且测试通过，不表示整个提案完成。

## 本批验证与构建证据

- 完成任务：1.1–1.8、2.1–2.2，共10/39；其余29项未勾选。
- Node.js 24：`npm run ci`通过（287/287测试、类型检查、lint、构建）。Dockerfile内相同检查通过。
- 本地兼容镜像：`0xbsc:research-compat-20260907`。
- 最低回滚构建ID：`sha256:23248327f707764003aae1ee4cc394773e1b8159c7bace60ecc9e03fd67d5513`。这是本机image ID，不是已发布的Registry digest；在SEA部署前须通过既定GitHub流程构建/登记目标镜像，不假定云端已存在本机镜像。
- 容器验收使用`--network none --read-only --tmpfs /tmp`，仅在临时SQLite中迁移并运行audit；通过，退出后容器删除，没有挂载真实配置、凭据或数据库。
- OpenSpec严格校验通过；未提交GitHub、未部署SEA。

配置入口目前只支持：`research: { mode: observe, run_id: audit-1, max_storage_bytes: 2147483648 }`；缺省off。只读命令：`npm run research -- audit --db <已有数据库路径> --format markdown`。模型清单校验：`npm run research -- manifest validate --file <模型JSON>`；清单只有研究用途，未接管publisher。

公共采样帧每60s按固定hash顺序分层轮转，容量20；帧间新token仍完整写入母集，记录资源排除，待下一帧选择，不能通过新消息强制全母集重排。保留采样状态/概率变动历史。observe不会基于这些名额发起任何新请求。

实施自查已修复：记录配置影响正式revision、UNKNOWN在配置切换后失锁、状态JSON绕过锚点列冻结、归档落盘后崩溃造成未计费孤儿文件、每次事件重排全母集造成写队列竞争。对应测试或实现约束已经纳入本批；尚未做真实市场效果与新增请求混合负载验证。

下一批任务从2.3开始：legacy对照回放、完整发布干运行、三轨基准、共享预算与负载门禁。采集/市场选择/最终验收仍未运行，不把本批10项完成当作筛选质量已改善。
