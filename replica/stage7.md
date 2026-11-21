# OpenToken 第 7 阶段实施计划

> 实现按小段验收，已验证的工作备份到 GitHub，正式试点继续使用 main。

**目标**是把试点后的接入和运营能力扩展到流式调用、更多模型与分组、用量趋势、在线支付与订阅。

## 7.1 流式输出

- [x] 在 `tests/loop.test.mjs` 验证 SSE 分块、一次预占与一次流水、取消连接后的结算。使用隔离数据库与模拟上游。
- [x] 在 `lib/http.ts` 接受 `stream: true` 与可选的 `stream_options.include_usage`。在 `lib/gateway.ts` 让 JSON 和 SSE 共用派发及账务事务。先让 `mock-text` 用分块输出验证协议和结算。
- [x] 接入带最终 usage 帧的 OpenAI Chat Completions SSE 协议。向上游发送 `include_usage: true`，仅在最终用量有效且收到 `[DONE]` 后结算。客户端断开后继续读取，用量缺失、超预算或上游异常中断时保留预占并转待核对。
- [x] 用测试上游验收普通 JSON 路径兼容、并发限额、重复幂等键、客户端断开、上游断流、缺失和超预算用量，以及 SSE 正常结束。
- [x] 用指定供应商和模型完成一笔获授权的真实流式对账，确认上游返回最终 Token 用量、缓存拆分和 `[DONE]`。

开启 `ENABLE_UPSTREAM_STREAMING=1` 才允许已配置的真实上游响应流式请求。首批测试覆盖官方和兼容格式。已用 `deepseek-v4.1-flash-1017` 在隔离的 OpenToken 实例验收真实 SSE，确认仪表盘的预占和余额、使用记录的结算和释放、账本的单笔扣费一致。

## 7.2 更多模型与分组

- [x] 允许一个兼容上游配置多个模型，每个模型独立配置别名、价格、上限、流式能力和分组。
- [x] 通过 `db:seed` 发布配置和费率版本。调价关闭原版本并创建新版本，历史请求继续引用原费率。控制台展示分组、倍率和请求方式。
- [x] 用测试上游验证跨分组请求无法入场，以及两个分组的模型目录、上游选择和费用计算。
- [x] 确认首批新增模型的 ID、费率和试点分组，并在隔离目录验证新旧模型并存。
- [x] 兼容带结束原因的事件同时携带最终用量的 SSE 格式。缺失 `[DONE]`、用量重复或不一致时仍转待核对。在隔离环境重现该格式并核对预占、扣费、释放和单笔流水。
- [x] 用真实 `deepseek-v4-pro` 流式请求验证网关读取带结束原因的最终用量事件，并在 `[DONE]` 后完成单笔结算。仪表盘、使用记录和账本的预占、扣费和释放一致。
- [x] 在校验加密备份后，将 `deepseek-v4-pro` 的费率写入正式试点数据库，并以受限应用角色读回核对。
- [x] 2026-11-21 发布到 Render 正式试点（构建提交 `c49dc3c`）。登录后核对目录包含 `deepseek-v4-pro` 和 `mock-text`，新模型已开启流式，试点分组倍率为 1，输入、缓存读取和输出费率符合配置。

`UPSTREAM_ADDITIONAL_MODELS_JSON` 是 JSON 数组。新增模型共用当前兼容上游的 URL 和密钥，按模型配置 `alias`、`model`、`inputUsdPerMtok`、`cachedUsdPerMtok`、`outputUsdPerMtok`。可选字段为 `responseModel`、`maxContextTokens`、`tokenField`、`streaming` 和 `groups`。每个分组填写 `code`、`name`、`multiplierBps`，如 `9000` 表示 0.9 倍。省略分组时使用试点分组。新增模型开启流式还需全局启用 `ENABLE_UPSTREAM_STREAMING`。运行 `db:seed` 后再更新托管环境。删除运行配置可撤出目录，历史请求及其引用的费率继续可查。

首批新增模型使用现有试点分组（1 倍），按每百万 Token 收取 9 美元输入费、0.3 美元缓存读取费、27 美元输出费。使用 8,192 Token 的 OpenToken 上下文限额。

```dotenv
ENABLE_UPSTREAM_STREAMING=1
UPSTREAM_ADDITIONAL_MODELS_JSON='[{"alias":"deepseek-v4-pro","model":"deepseek-v4-pro","inputUsdPerMtok":"9","cachedUsdPerMtok":"0.3","outputUsdPerMtok":"27","maxContextTokens":8192,"streaming":true}]'
```

正式试点原目录仅开放 `mock-text`。本次启用兼容上游时同时设置 `UPSTREAM_PUBLISH_PRIMARY=0`，只开放获准的新模型 `deepseek-v4-pro` 和既有的 `mock-text`。旧费率及历史记录仍可查询。

既有模型调价时，数据库与服务配置切换期间会暂时隐藏该模型。持有旧分组密钥的客户端会收到明确的费率不一致错误，且不会预占或扣费。两个配置一致后恢复接入。

## 7.3 用量趋势

- [x] 从当前账号的用量记录按本地自然日汇总请求数、已结算 Token 与扣费，补齐没有用量的日期。
- [x] 仪表盘显示含今天在内的最近 7 天与 30 天，支持切换指标和查看每日明细。测试覆盖跨时区日期边界、空数据、账号隔离和已结算金额对账。
- [x] 2026-11-21 发布到 Render 正式试点（构建提交 `46a6850`）。使用试点验收账号按北京时间逐日核对 7 天与 30 天的请求数、已结算 Token 和实际扣费。使用记录与钱包用量流水按请求号匹配，空白日期补零，两个区间和今日概览均对得上。

## 7.4 在线支付与订阅

- [x] 接入 Stripe 测试 Checkout。在本地验证签名、币种和金额校验、钱包入账、相同事件重发及不同事件标识指向同一笔支付。
- [x] 接入测试订阅和 Stripe Customer Portal。在本地验证开通、成功续费更新账期、续费异常、取消、延迟回调防重复开通，以及账号隔离。
- [x] 2026-11-21 以 Stripe 沙盒验收充值、续费、取消和签名回调。Checkout 测试付款仅入账一次，已验证真实回调重放和错误签名。用 Test Clock 生成已付款的续费账单，OpenToken 同步新账期。已验证客户门户链接，并通过 Stripe 沙盒 API 取消订阅，取消回调同步了双方状态。续费和取消期间钱包余额与充值流水保持一致。

使用独立的沙盒数据库，先迁移至 005，再用沙盒数据库管理员连接运行 `node --env-file=.env.local scripts/database.mjs stripe-sandbox`。命令会拒绝已有真实上游请求的数据库。启用标记后，网关会在该数据库禁用真实上游路由，Stripe 测试充值只用于模拟调用。

在沙盒服务设置 `STRIPE_TEST_SECRET_KEY`（`sk_test_`）、`STRIPE_TEST_WEBHOOK_SECRET`、`STRIPE_TEST_CREDIT_PRICE_ID` 和 `STRIPE_TEST_SUBSCRIPTION_PRICE_ID`。价格分别使用美元一次性价和周期价。配置 Stripe 测试 Customer Portal，从 Stripe 测试事件转发至 `/api/stripe/webhook`。沙盒端到端验收使用 Stripe 测试卡。每笔充值按等额测试余额入账，订阅显示支付状态和当前账期。回跳页展示订单，钱包余额以通过验签的支付事件为准。

订阅 Checkout 在 Stripe 确认已过期或终止前会阻止再次开通。若与 Stripe 的首次创建通信中断，可用原浏览器继续同一个结账请求。若订单已过期且缺少 Stripe 会话号，网关按订单创建时间和编号核对 Stripe 会话。已完成但待回调的结账继续阻止重复开通，确定没有创建会话时才放行。

收到 `invoice.paid` 或 `invoice.payment_failed` 后，网关向 Stripe 读取订阅的最新状态和账期。订阅账单不进入充值流水。Webhook 重复投递按事件 ID 去重。

如需使用专用的沙盒客户门户，可设置 `STRIPE_TEST_PORTAL_CONFIGURATION_ID`（`bpc_`）。留空时使用 Stripe 沙盒默认配置。

正式套餐权益、税费、币种和退款口径另行确认。

本机 PostgreSQL 演练已核对 17 张表、零账务异常，恢复后订单、事件、测试钱包和隔离标记一致。旧版 14 表归档仍可校验。

[OpenAI 流式事件格式](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)

[Stripe Checkout 履约](https://docs.stripe.com/checkout/fulfillment) · [Stripe Webhook 验签](https://docs.stripe.com/webhooks/signature)
