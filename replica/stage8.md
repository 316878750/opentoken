# OpenToken 第 8 阶段

## 8.1 监控和恢复

- [x] 2026-11-21 从 GitHub 验证两次 `schedule` 事件均运行了就绪探针，正式地址健康接口与登录检查通过。两次分别在北京时间 05:45 和 10:51 触发，实际间隔约 5 小时。 [第一次云端检查](https://github.com/316878750/opentoken/actions/runs/44823171577) · [第二次云端检查](https://github.com/316878750/opentoken/actions/runs/44858149825)
- [x] 以只读事务查正式库最近 7 次 Supabase Cron 执行，均按每 5 分钟成功运行，当前没有超时待核对请求或未关闭账务告警。
- [x] 在隔离 PostgreSQL 使用 004 版迁移生成合成请求。停留 16 分钟的待核对请求生成 `review_stale`，钱包预占保持原额。随后将合成备份恢复至另一空库，14 张表的数据摘要、余额、预占、账本及告警记录一致，账务异常为零。
- [x] 重新验证正式试点北京时间 2026-11-21 09:51 的加密备份。14 张表归档完整，快照内账务异常为零。
- [x] 2026-11-21 验证独立 Supabase 恢复项目为空，应用与正式试点相同的 004 版迁移，然后恢复合成归档。托管库 14 张表的数据摘要一致，账务异常为零。恢复后复查到一笔用量扣费和一笔超时预占告警，余额与账本净额均为 9.837100 美元，预占为 1.000000 美元，受限应用角色的权限校验通过。 [恢复手册](backup.md)
- [x] 2026-11-21 使用独立恢复项目的公开密钥完成合成用户的邮箱密码登录。Supabase Auth 返回的用户 ID 与备份前一致。使用签发的会话调用用户接口，再次核对了同一用户 ID。
- [x] 2026-11-21 激活 UptimeRobot 对正式试点健康接口的监控。试点运营在电脑断网时，用手机从 UptimeRobot 发出模拟 DOWN 通知，并确认 QQ 邮箱收到邮件。演练后复查正式健康接口，返回 HTTP 200 和 `status: ok`。 [UptimeRobot 测试通知说明](https://help.uptimerobot.com/en/articles/11602913-how-to-test-notifications-in-uptimerobot-quick-guide)

## 8.2 正式付费规则与沙盒验收

2026-11-21 已确认美元充值和套餐规则。充值档为 $5、$20、$50，实付充值本金等额入账。套餐费独立出账。基础版每账号每分钟 10 次调用、5 把可用密钥，Pro 为每月 $10、每分钟 60 次、20 把可用密钥。两档共用模型和费率，Pro 可查订阅账单。取消续费和续费失败保留至已付账期结束。首期支付和退款验收在 Stripe 沙盒执行。

调用优先扣赠送额度，再按充值到账时间消耗实付余额。充值后 30 天内可申请未消费且未预占的实付本金退款，最小金额 $0.01。运营审核后冻结对应金额，退款原路退回，OpenToken 承担支付处理费用。退款失败释放冻结，若此前已冲减则用反向流水恢复。订阅计费例外独立核对原发票。适用税费在结账时单列。

- [x] 2026-11-21 在 Stripe 沙盒完成 $5、$20、$50 三档 Checkout。签名回调均只记一笔等额充值。用运营对账命令逐笔核对 Stripe PaymentIntent、本地订单和钱包。
- [x] Pro 首期和 Test Clock 续费各 $10。Stripe 的两张发票与本地账单及已付账期一致，订阅付款期间钱包余额保持一致，续费回调重放后仍每期一张发票。
- [x] $5 充值全额退回 $5，$20 充值部分退回 $8.50。两笔均核对原始 Stripe 支付、Stripe 退款、本地订单和对应钱包冲减。
- [x] 用 Stripe 官方异步失败测试支付方式单独补做 $50 支付并关联隔离演练订单。$10 退款先成功、后收到真实 `refund.failed`。Stripe 和本地最终均为失败，钱包只有一笔 $10 冲减和一笔 $10 返还，余额恢复到 $50，退款冻结归零。
- [x] 重放真实签名回调及重试同一退款审批，发票、退款和钱包流水均无重复。错误签名返回 HTTP 400。006 版隔离备份和恢复校验覆盖 20 张表，账务异常为零。

### 沙盒配置和运营命令

在专用测试数据库迁移至 006，再启用 `stripe-sandbox`。`STRIPE_TEST_CREDIT_PRICE_ID` 对应 $5，另两档分别用 `STRIPE_TEST_CREDIT_20_PRICE_ID` 和 `STRIPE_TEST_CREDIT_50_PRICE_ID`，`STRIPE_TEST_SUBSCRIPTION_PRICE_ID` 对应 $10/月。Stripe 客户门户需配置账期结束时取消续费。正式税务配置在付费试点上线前核验。

运营人员在隔离数据库的管理连接上使用以下命令。每次审核生成独立的退款 UUID；重试时沿用该 UUID、订单、金额和审核人。CLI 连接 Stripe 中断时，已冻结的金额保留，核对期间使用原 UUID 查找已创建的 Stripe 退款。超出安全重试窗口的记录先人工核对。

```sh
pnpm db:stripe approve-refund REFUND_UUID ORDER_UUID CENTS APPROVER
pnpm db:stripe reconcile ORDER_UUID
pnpm db:stripe sync-refund REFUND_UUID
pnpm db:stripe cancel-approval REFUND_UUID REVIEW_NOTE
pnpm db:stripe sync-invoices ORDER_UUID
```

回调缺失时可用 `sync-refund` 从 Stripe 查证后补记。撤销未经提交的审批前，`cancel-approval` 会查询原支付的 Stripe 退款并核对最近一次发送时间。升级已有 005 版订阅的沙盒时，在启用新版本前对每个已关联的订阅订单执行 `sync-invoices`，导入实际的已付账期。

充值订单按 PaymentIntent 和原始充值流水核对。订阅按 Stripe 发票核对开通和续费的已付账期。运营审核拒绝使用赠送额度或已消费、已冻结的本金。退款处理跟踪 `refund.created`、`refund.updated` 和 `refund.failed`。如果 Stripe 先报成功而后报失败，钱包会新增返还流水。退款与反向流水都可按退款 UUID 核对。 [Stripe 退款事件](https://docs.stripe.com/refunds#refund-events) · [Stripe 异步退款测试](https://docs.stripe.com/testing#refunds)

## 8.3 小范围付费试点

经确认后向指定账号开放正式支付，核对 Stripe 订单、OpenToken 订单和钱包账本。
