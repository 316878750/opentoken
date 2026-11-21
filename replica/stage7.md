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

- [ ] 在沙盒中验证托管结账、订单与支付回调。以验签后的服务端事件确认支付，按支付对象唯一键幂等入账，处理失败与重发。
- [ ] 用订阅账期和事件管理权益。用户确定支付商、可用地区、币种、套餐与退款口径后，再确定正式接入配置和上线验收。真实扣款单独授权。

[OpenAI 流式事件格式](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)
