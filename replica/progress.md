# OpenToken 开发进度表

更新于 2026 年 11 月 28 日。第 9 阶段管理员后台已发布到 Render 正式试点。在线支付、订阅和退款已通过 Stripe 沙盒验收，8.3 正式收款继续暂停。[管理员入口](https://opentoken-pilot.onrender.com/admin) · [正式发布提交](https://github.com/316878750/opentoken/commit/eafef033ca82ffab7570e40df44265783435e1cf) · [上线验证记录](deploy.md#第-9-阶段正式试点发布记录)

| 阶段 | 状态 | 范围 | GitHub 提交 |
| --- | --- | --- | --- |
| 1–3 调研、MVP 与后端 | 核心功能已上线 | 登录、API 密钥一次性展示、调用、预占扣费和用量查询。已接入 Supabase Auth 和 PostgreSQL，第三方上游的真实非流式调用已完成账务核对。 | [MVP `e032230`](https://github.com/316878750/opentoken/commit/e0322309ac865b8c7f046b493a22bffa933bfed4) · [后端 `f4adc69`](https://github.com/316878750/opentoken/commit/f4adc6966ba4cd97c1bb97a45397acf8248c998d) · [上游验收 `fcaa6b8`](https://github.com/316878750/opentoken/commit/fcaa6b87ab4507c6ab1e129619615568c6e67557) |
| 4–5 账务核对与试点补额 | 已上线 | 支持处理待核对账务。运营通过命令行签发兑换码，试点用户在控制台兑换补额。 | [`5f1d56b`](https://github.com/316878750/opentoken/commit/5f1d56bfea5f6f5a686025bd98c82a14d87d9ddd) |
| 6 部署与小范围试点 | 已上线 | Render HTTPS 试点已开放，完成登录、接入、调用、查账与补额体验，以及首次定时健康检查和加密备份。 | [部署 `996b944`](https://github.com/316878750/opentoken/commit/996b94422f60b8562448039f68e553b558bd457a) · [运维 `dff9411`](https://github.com/316878750/opentoken/commit/dff941194c3f015adde8ae736064e0574e72fc91) |
| 7.1–7.2 流式输出、模型与分组 | 已上线 | 正式试点目录已开放 `deepseek-v4-pro` 流式调用，预占、扣费和释放已核对。`deepseek-v4.1-flash-1017` 完成真实上游隔离验收。 | [流式验收 `93c1bae`](https://github.com/316878750/opentoken/commit/93c1bae06eb3788ec7869516a702abb6aba0a839) · [正式发布 `2ee6eb2`](https://github.com/316878750/opentoken/commit/2ee6eb29f94b6177687635d9e9045a8cc9fe4b27) |
| 7.3 用量趋势 | 已上线 | 最近 7 天和 30 天的请求数、Token 用量和扣费均与使用记录、钱包账本核对一致。 | [部署 `46a6850`](https://github.com/316878750/opentoken/commit/46a6850cdc0d03d6ddabee7bc8ce6ef5ebefb3b2) · [验收 `89e037d`](https://github.com/316878750/opentoken/commit/89e037d4c7b305c037ea7b921308c39f6d6de080) |
| 7.4 在线支付与订阅 | 仅 Stripe 沙盒验收 | 通过充值到账、订阅开通、续费、取消和 Webhook 重放验收。 | [`b65d369`](https://github.com/316878750/opentoken/commit/b65d36906264479649b276bbe3fe1b09164cbc44) |
| 8.1 云监控与恢复 | 监控已启用，隔离恢复通过 | 电脑离线时收到 UptimeRobot 测试告警邮件。独立恢复库完成账务核对，恢复后的合成用户登录成功。 | [告警 `7bfa342`](https://github.com/316878750/opentoken/commit/7bfa34244063d6f8a9ebf160a0d40de0cb440625) · [恢复登录 `df2d740`](https://github.com/316878750/opentoken/commit/df2d7400deee2e5fa1f62ebac6ec5ae4aba8f0ae) |
| 8.2 支付对账与退款 | 仅 Stripe 沙盒验收 | 逐笔核对 Stripe、本地订单和钱包账本，覆盖充值、续费、全额退款、部分退款、退款失败冲正及 Webhook 重放。 | [`81f06d7`](https://github.com/316878750/opentoken/commit/81f06d7c1a1c9dad0090de013061ae6c25a60286) |
| 8.3 小范围付费试点 | 暂停在正式收款接入前 | 首轮范围已确认为一个已验证账号。开发分支已准备白名单、默认关闭的结账开关和只读预检。正式白名单尚未启用，真实收款未开放。 | [`fcee122`](https://github.com/316878750/opentoken/commit/fcee1221134d05b4b6fd4817c3b20e0548965694) |
| 9.1 管理员入口、角色与审计 | 已上线 | 验证普通用户和有效 API 密钥无法进入后台，同一会话撤权后下一次请求即被拒绝。登录与管理员审计记录已核对。[验收详情](stage9.md#91-运行与验收) | [`1ceb5ab`](https://github.com/316878750/opentoken/commit/1ceb5ab665a4801700eefa5967cacacc43880cbe) |
| 9.2 兑换码管理 | 已上线 | 已验收后台签发、查询、作废与一次性明文。运营按单码和 UTC 日限额管控。并发或重复核销仅产生一笔入账，与钱包流水和审计一致。[验收详情](stage9.md#92-兑换码管理) | [`3b6d066`](https://github.com/316878750/opentoken/commit/3b6d0663a0da4d62fc266def08696ea34a2521d1) |
| 9.3 渠道管理与模型绑定 | 后台已上线，生产密钥引用待登记 | 已验收新增、测试、启停、密钥轮换、回退与账务核对。权重、自动切换及自动上线策略已纳入配置和校验，运行采用单路由。[验收详情](stage9.md#93-渠道管理与模型绑定) | [`f3ce7b5`](https://github.com/316878750/opentoken/commit/f3ce7b5399daee6190da447462f06dcfd3cdda17) |
| 9.3 模型与费率管理 | 已上线 | 新建模型、模型上下架、分组启停、版本化费率及变更审计。已核对并发发布、调价前后预占与扣费、旧渠道接管和缓存用量校验。[验收详情](stage9.md#模型与费率管理) | [`f64bf70`](https://github.com/316878750/opentoken/commit/f64bf7081484afb6eb18ae44449e02904e6fa0b5) |
| 9.4 用户管理 | 已上线，邀请凭据待配置 | 分页查询、运营脱敏、邀请链接、钱包摘要、停用恢复、后台角色与审计。已核对并发权限保护、旧会话失效、在途结算及邀请结果核对。[验收详情](stage9.md#94-用户管理) | [`31cd7bd`](https://github.com/316878750/opentoken/commit/31cd7bdc88b657194076d95296f27f95056ddf4c) |
| 9.4 补充 · 删除用户 | 已上线 | 仅系统管理员可删除，须确认用户 ID 和填写原因。删除撤销访问、密钥和角色，保留订单与账本。已核对在途结算、并发删除、审计回滚及 Stripe 未结账拦截。[验收详情](stage9.md#删除账号) | [`1f95d5a`](https://github.com/316878750/opentoken/commit/1f95d5a93b0b5521a2183486dc82e2f7ab3ab831) |
| 9.5 登录日志与操作日志 | 已上线 | 只读筛选、分页及脱敏。运营人员仅能读取本人操作，兑换码核销可关联钱包收据。构建和 65 项回归通过。[验收详情](stage9.md#95-登录日志与操作日志) | [`bb5231d`](https://github.com/316878750/opentoken/commit/bb5231d30e79d1dd85e8a3d1464c1798846065f4) |
| 9.5 系统设置 | 已上线 | 站点公告、支持链接、展示时区和运营签发额度可版本化发布及回退。已验证并发冲突、按角色访问、签发限额和审计。[验收详情](stage9.md#95-系统设置) | [`b8176b0`](https://github.com/316878750/opentoken/commit/b8176b0aa4e55fe770ed7c41ea363a1497de47be) |
| 9.6 整体验收与发布准备 | 已完成，正式试点已上线 | 68 项回归通过。原生 PostgreSQL 核对两笔调用、32 张表的加密备份与恢复、设置及应用回退，账务差异为零。[验收记录与发布顺序](stage9-release.md) | [`2438b2b`](https://github.com/316878750/opentoken/commit/2438b2b9b745170e2f4d28eacb5f5200e43ba927) |

## 8.3 暂停位置

恢复后先确认 Stripe 正式账户的激活状态、首轮客户所在地区及税费处理方式。确认后再接入正式 Checkout、Webhook 和退款，随后验收一笔真实充值及原路退款。[第 8 阶段验收与发布清单](stage8.md)

其他验收细节见[第 7 阶段记录](stage7.md)和[试点部署记录](deploy.md)。
