# OpenToken 开发进度表

更新于 2026 年 11 月 21 日。正式试点的最新上线功能是 7.3 用量趋势。在线支付、订阅和退款已通过 Stripe 沙盒验收。8.3 暂停在正式收款接入前。第 9 阶段系统管理员后台已列入规划，待开发。[正式试点入口](https://opentoken-pilot.onrender.com/login)

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
| 9 系统管理员后台 | 已规划，待开发 | 渠道管理、模型管理、兑换码管理、用户管理、登录日志、操作日志和系统设置。[权限、开发顺序和验收标准](stage9.md) | 待开发验收后补录 |

## 8.3 暂停位置

恢复后先确认 Stripe 正式账户的激活状态、首轮客户所在地区及税费处理方式。确认后再接入正式 Checkout、Webhook 和退款，随后验收一笔真实充值及原路退款。[第 8 阶段验收与发布清单](stage8.md)

其他验收细节见[第 7 阶段记录](stage7.md)和[试点部署记录](deploy.md)。
