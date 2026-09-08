# 研究工具和部署操作

当前部署使用legacy正式publisher和observe；以下研究命令均不发送Telegram、不执行交易。数据写入命令仍只修改运行账本，源代码只能在本地修改，经GitHub发布到SEA。

## 入口

容器内通过 `node dist/research/cli.js`，本地Node24编译后通过 `npm run research --`。`--db`必须指向运行数据库；生产库路径为`/var/lib/gmgn-signal-bot/signal-bot.db`。禁止上传本机数据库。

| 命令                                                               | 用途/约束                                                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `audit --db DB [--format markdown]`                                | 只读字段支持、母集和覆盖审计                                                                     |
| `manifest validate --file MODEL.json`                              | 完整有限表达式及字段/TTL校验，不晋级                                                             |
| `replay --file INPUT.json [--db DB]`                               | 无网络确定性回放；可从归档读取factIds                                                            |
| `measurement-report --file LEDGER.json [--format markdown]`        | 各轨道/协议/确认方式的分母与缺失报告，不签凭据                                                   |
| `budget-check [--db DB]`                                           | 无DB为合成争用夹具；有DB为真实到达流+mock传输的开/关对照；INCONCLUSIVE不准启用execute_shadow     |
| `budget-register --db DB --file EVIDENCE.json`                     | 登记匹配当前构建的真实到达流PASS报告                                                             |
| `dataset freeze --db DB --file PLAN.json`                          | 锁定开发/选择/最终用途、token跨池身份及事实；最终需要26h成熟                                     |
| `candidates generate --file PLAN.json [--db DB]`                   | 最多3×4完整候选；注册时核对开发事实ID及原字段值                                                  |
| `selection-register --db DB --config CONFIG.yaml --file PLAN.json` | 输入candidatePlanId/startAtMs；必须在选择窗口前登记，冻结风险/对照/构建                          |
| `select-recorded --db DB --config CONFIG.yaml --file INPUT.json`   | 输入registrationId/datasetId；只对注册候选、同一安全与legacy对照回放；消费选择集                 |
| `select --file INPUT.json` / `evaluate-paired --file INPUT.json`   | 纯统计工具；任意输入统计结果都不是独立晋级凭据                                                   |
| `final-register --db DB --file PLAN.json`                          | 输入runId/selectionId/budgetEvidenceId/startAtMs；需要匹配的唯一选择结果和负载证据，固定30天+26h |
| `final-close --db DB`                                              | 只关闭已到登记截止的最终run，不移动截止                                                          |
| `final-expose --db DB --file INPUT.json`                           | 输入runId；明确将数据消费为选择用途并撤销凭据，不能恢复独立性                                    |
| `evaluate-final --db DB --file INPUT.json`                         | 输入runId/datasetId；按冻结DB账本一次评价，缺样本/来源时间不能产生有效PASS                       |
| `promotion verify --db DB --file INPUT.json`                       | 输入certificateId/contracts；核对当前代码/迁移/锁文件/预算/模型/风险与DB来源                     |
| `deployment-precheck --db DB --compatibility global-token-lock-v1` | 只读发布锁/待办/租约检查                                                                         |
| `drain-preparation --db DB --file IMAGE.json`                      | 输入实际Docker inspect取得的imageId/compatibility；租约未释放则阻止，保留UNKNOWN/SENT锁          |
| `readiness`                                                        | 当前固定事实契约的阻塞说明，不等于完整线上健康检查                                               |

所有JSON用UTF-8实际换行。配置文件可能包含凭据，只通过已有安全路径读取，不放进报告或GitHub。最终评价默认固定SIMULATED主比较组；ACTUAL真实确认采样单独保留，不能用仅已发送的样本替代执行准备前的对照分母。

## 启用限制

- 缺research配置等于off；Compose当前默认observe。collect允许公共补采但仍占同一父预算；不能把它理解为新正式推送。
- execute_shadow需要`research.manifest_path`和`research.budget_evidence_path`，并要求14/20权重配置、6权重保留、完整真实到达流预算证明及当前构建哈希。研究请求总量、Quote次数、并发和正式优先均由同一个scheduler约束。
- `publication.engine=validated`当前拒绝启动，不回退旧引擎；完整正向新发布绑定及最终冻结仍见任务2.6，不能靠修改这个配置键绕过未完成工作。
- 当前Info价格来源时间没有验证支持，独立选择/最终实验前置门不成立；不登记假最终run，不等待30天后直接宣布通过。

## 部署/回滚

本地改动→Node24 CI/review→GitHub main→SEA目录git pull→Compose build→服务数据卷内一致性备份→Compose up→检查版本、迁移、健康、研究停止原因、请求状态与投递锁。必要的生成报告保存在服务器运行卷或/tmp，不修改服务器源码。

回滚只切换已登记、带`global-token-lock-v1`兼容标记的应用镜像；保留当前数据库与已确认/不确定token锁。禁止恢复旧库以实现应用回滚。未知Telegram发送不能自动重发，测试消息不发送。
