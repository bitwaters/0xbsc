# 2026-09-08 本批实施状态（优先于下方历史记录）

实施任务30/39；本批交付研究采集、完整风险/报价干运行、持久化三轨基准、结果/退出采集、有限候选与选择工具、最终运行登记/消费/评价/凭据验证。正式publisher仍legacy，SEA继续observe。**提案尚未全部完成，也没有新规则已提高命中率的证明。**

本批新增完成：2.5、2.7、3.1、3.2、3.4、3.5、4.2–4.5、6.1、6.4。4.5的勾选表示负载测量工具和拒绝不充分证据的门禁完成，不代表线上研究已经获准启用。部署实测另见deployment.md。

## 已交付的工程

- `decision/preparation.ts`先做原安全核验，再记录市场合格坐标，随后10U买腿/同数量卖腿/最终风险和原模型复核。失败取消原机会，保持锚点；安全未验证者不进入执行分母或报价。
- `research/runtime.ts`接入collect与单模型execute_shadow，共用既有GmgnClient/scheduler；observe不新增请求。源数据窗口超过5000事实明确排除，不截取后假装完整。最终复核只刷新Info/security/pool，深度数据按原TTL核验。
- ACTUAL确认接在既有outbox确认回调，先核对持久化SENT/确认时间；SIMULATED固定为准备完成时刻+1000ms。准备完成时间先冻结，重启不重做报价、不移动基准；未完成准备没有虚拟确认时间。
- 基准PENDING先落库、CAS终态及持久化attempt；研究HTTP自动重试关闭，由持久化任务控制2/1/3次上限。正式请求原重试策略不变；attempt新增research标记，负载对照剔除研究自身流量。
- 市场结果按1.3/1.5/2/3倍和0.9先触达，24h观察、2h补采；200待办是市场任务与Quote退出的共同上限。范围缓存检查完整性、身份和归档引用；缺口保留UNKNOWN/CENSORED。
- Quote独立保存名义请求10U和返回实际美元金额，避免整数WBNB换算使合法报价永远无法满足“恰等于10”。协议升为v2，哈希隔离旧口径；卖出只能配对原买入数量，晚到只能报告实际可用时刻。
- 有限候选生成最多3×4；注册分位数输入必须追溯开发数据集fact与字段值。选择前冻结候选、风险、legacy对照及语义构建；离线相同事实/事件回放，新旧都做同一安全检查，执行证据保持NOT_EVALUATED。
- 最终登记固定30天+26h、一次解封；提前使用不可撤回地消费数据。evaluate-final从冻结DB账本构造配对样本，统计PASS不直接变成可用凭据；核验数据、全部协议、代码依赖、消费和撤销状态。语义构建包含明确入口及其传递依赖和package-lock，文档改动不改哈希。
- 排空工具只取消没有本token投递预留的PENDING；独占租约阻止并发发送/排空，SENT/UNKNOWN锁不清除，必须提供实际兼容镜像ID，DB不可降级。

## 未完成边界

| 任务    | 当前产物                                                                    | 仍需完成                                                                                |
| ------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 2.6     | 风险/准备干运行、冻结卡片模板、版本/代码哈希、validated拒绝启动与legacy兼容 | 新正式publisher配置/运行绑定的完整正向路径及最终冻结；现有validated配置不能据此直接上线 |
| 5.2–5.4 | 候选登记、追溯检查、离线选择和NO_PROMOTABLE_MODEL工具                       | 真实开发/独立选择数据报告及唯一模型包；不能把空集夹具当成真实选择                       |
| 6.5–6.6 | 最终run生命周期与一次评价工具                                               | 满足B、2.6和C后登记并实际完成30天+26h独立实验                                           |
| 7.1–7.3 | 兼容投递锁、回滚预检/排空工具                                               | 匹配PASS后激活新正式publisher、验收和清理旧资格路线                                     |

当前阻塞不是单纯等时间：先解决数据来源时钟与负载证据，再完成最终发布冻结和模型选择，才可开始最终实验。现阶段删除旧正式资格路线或直接打开新发布会让生产失去可用发布路径，因此保留。

## 部署前真实数据证据

2026-09-08 12:49:23 UTC，SEA累计研究响应12047、Info1518；Info无已验证价格来源时间。研究母集按池记录8165行，20个采样名额（不是8165个独立token统计）。正式SENT17、SEND_FAILED50。最近15min请求：200=36、401=4、无HTTP状态=8；稍后仍观察到间歇401与正常200并存。该异常在本批部署前已存在，传输实现强制IPv4；未把它断言为密钥失效，也未修改用户凭据。

当前主市场基准UNAVAILABLE / PRICE_SOURCE_TIME_UNVERIFIED，不能用接收时刻、HTTP Date或代币创建时刻补填。GMGN官方文档的Kline CLI参数为秒，但CLI转换为API毫秒；现有API毫秒坐标保留，未误改单位。参考[GMGN市场文档](https://raw.githubusercontent.com/GMGNAI/gmgn-skills/main/skills/gmgn-market/SKILL.md)。

以下为历史批次记录，数字和“尚未实现”描述仅代表当时状态。

---

# 本轮实施与发布记录（2026-09-07）

当前任务 **18/39 完成，21 项未完成**。这不是整个提案完成或新规则通过验收。下文保留前批记录；本节为最新状态。

## 本轮已交付

- 2.3–2.4：冻结配置哈希的 legacy 市场回放、统一研究决定输出、manifest validate / replay CLI；从已有事实和校验归档读取，不发 API / Telegram 请求。安全与执行缺失明确 NOT_EVALUATED，不把市场 PASS 当正式通过。
- 3.3：1.3/1.5/2/3 倍与 -10% 先触达、边界/缺口/冲突 UNKNOWN、24h 未触达与等待区分。
- 3.6：`measurement-report` 独立注册分母与实际测量，缺失记录不消失；按 run/模型/轨道/协议/确认类型/观察期分组，输出全部类别、覆盖、成功区间与等待分位数。追加修复：不完整行情且无已观测触达为 CENSORED，缺口之后触达为 UNKNOWN。合成账本验证通过；[测量可行性报告](measurement-feasibility.md) 明确主基准不支持，尚不能进入阶段C。
- 4.1：同一 scheduler 准入临界区的研究空桶 2 权重/s、容量5、滚动分钟120与全局 reserve；物理研究请求2s绝对超时，Quote不重试。
- 5.1：数据用途冻结/跨池 token 隔离；拒绝伪造未来冻结时刻。5.3 的选择工具与排序测试已实现，但尚未登记并运行真实选择集，任务保持未完成。
- 6.2–6.3：共同母集 token 配对 bootstrap 10000 次、固定 seed、样本/覆盖/捕获/SL/缺失敏感性/10U 成本非劣检验。统计 PASS 明确不是晋级凭据。

其余已编写但未整体验收的组件：baseline PENDING/CAS/期限存储、Quote同数量配对、分段任务坐标与3次捕获上限、干运行发布接口、合成混合到达负载 CLI。相应完整任务仍不勾选，避免把接口或合成测试当真实接通。

## 验证与发布边界

- Node24 `npm run ci`：315/315测试通过，类型检查、lint、编译通过。
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

代码审查与修复见[code-review.md](code-review.md)。部署实测记录见[deployment.md](deployment.md)。

---

# 实施记录

## 阶段 A 模块与兼容基线（任务1.1）

实施起点：b55f025；旧迁移截至014。新增015研究事实、016投递兼容，原迁移校验和不变。未读取真实config/.env；没有请求GMGN或Telegram。

| 入口                    | 现状及实施边界                                                                                       | 验证依据                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| gmgn/client + scheduler | 每次物理attempt持久化审计；成功响应新增允许字段fact，保留排队/请求/返回时间；失败仍走既有attempt审计 | test/gmgn/client、scheduler、governor及research/facts  |
| gmgn/api                | 原缓存与WeakMap对象身份保留，复用不额外生成fact                                                      | research/facts的gas缓存场景                            |
| discovery/runtime       | 公共母集钩子在旧排名、证据、评分及工作队列之前；不把研究对象加入正式处理                             | research/storage及既有discovery测试                    |
| safety + quote/gate     | 原风险/税/LP/协调退出/成本阈值和Decimal口径不变；10U roundTripLoss仍来自同数量双向准备报价           | test/safety、test/quote；src/gmgn/quote.ts原成本契约   |
| storage                 | 015独立表与CAS/不可变触发器；不覆盖旧signals/episodes/cards；共享串行写队列                          | research/storage、storage/database及旧版本升级fixtures |
| outbox                  | 016为发布兼容基础：独占租约、HTTP前持久化UNKNOWN锁、跨池/跨版本防重复；旧格式解析保留                | research/publication、delivery/outbox                  |
| config/index            | 缺research节点等于off；observe仅旁路记录；研究配置不改正式revisionId，不误清候选                     | config/load及全量回归                                  |

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
