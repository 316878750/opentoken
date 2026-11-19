# Model Gateway 本地 MVP

这个本地试点实现了登录、分组密钥签发、模拟模型调用和用量对账。需要 Node.js 22+ 和 pnpm。在项目根目录运行：

```powershell
pnpm install
pnpm dev
```

打开 [本机控制台](http://127.0.0.1:3000)。默认演示账号为 `demo@example.test`，密码为 `local-demo-only`。首次登录时会初始化本地数据库，可能比后续登录慢。服务只绑定本机回环地址，从同一地址访问浏览器与 API。演示账号、余额和密钥只用于本机测试。

1. 登录后进入 **API 密钥 → 创建密钥**，填名称并使用演示分组。保存一次性显示的密钥。
2. 在弹窗先打开“在新标签页看余额”和“在新标签页看请求”。回到密钥弹窗，点击“模拟调用一次”。默认处理时间约 12 秒，可切到另外两个标签页观察预占。
3. 新数据库初始账面余额为 USD 10.00。默认示例调用预占 USD 2.00，可用余额降为 USD 8.00。结算后预占归零，账面和可用余额均为 USD 9.25，使用记录显示实际扣费 USD 0.75。后续调用继续从当前余额扣减。
4. 勾选“我已保存密钥”并完成。刷新密钥页后只显示前缀。

也可用保存好的密钥调用 `POST http://127.0.0.1:3000/v1/chat/completions`。此示例假定你已把本机密钥放到 `DEMO_API_KEY` 环境变量。

```powershell
$headers = @{ Authorization = "Bearer $env:DEMO_API_KEY"; 'Idempotency-Key' = [guid]::NewGuid().ToString() }
$body = @{ model = 'mock-text'; messages = @(@{ role = 'user'; content = 'ping' }); max_completion_tokens = 128 } | ConvertTo-Json -Depth 4
Invoke-RestMethod -Uri 'http://127.0.0.1:3000/v1/chat/completions' -Method Post -Headers $headers -ContentType 'application/json' -Body $body
```

PGlite 使用 [架构 SQL](replica/schema.sql)，持久化数据默认位于 `.demo-data/`。请只运行一个进程访问同一数据目录。要从全新演示余额开始，可把 `DEMO_DATA_DIR` 指向新的目录。可用 `DEMO_EMAIL`、`DEMO_PASSWORD` 修改演示账号，用 `DEMO_DELAY_MS` 修改模拟等待时间。架构里的 Supabase 登录、真实上游、兑换与运营对账属于后续阶段。

```powershell
pnpm build
pnpm test
```

测试启动独立的本机进程和临时数据库，检查认证、一次性密钥、在途预占、结算、账本金额、幂等和密钥限额。
