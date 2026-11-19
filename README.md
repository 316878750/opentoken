# OpenToken

受邀用户可登录、创建 API 密钥、调用模型，并在控制台核对预占和扣费。应用连接 Supabase Auth 和 PostgreSQL。模拟模型 `mock-text` 固定返回演示用量。启用官方上游后，`openai-mini` 可调用 OpenAI 的非流式文本接口。

需要 Node.js 22.9+ 和 pnpm。将 [.env.example](.env.example) 复制到 `.env.local`，在后者配置 Supabase 项目、数据库连接和密钥。创建受邀测试用户后，从项目根目录运行：

```powershell
pnpm install
pnpm db:migrate
pnpm db:check
pnpm db:seed
pnpm dev
```

打开[本机控制台](http://127.0.0.1:3000)并使用 Supabase 测试账号登录。进入 **API 密钥 → 创建密钥**，在弹窗保存完整密钥。点“模拟调用一次”，并在概览和使用记录查看预占和结算。给试点用户发放一次 USD 10.00 内部演示额度后，首笔模拟请求会预占 USD 2.00、实际扣 USD 0.75。

真实验收需显式设置 `ENABLE_OPENAI=1`，并在 `.env.local` 填入 OpenAI API key 与试点账号。执行 `pnpm build` 再执行 `pnpm verify:live`，验收脚本会启动自己的本机进程并只提交一次真实请求，然后校验上游 Token、预占、使用记录、钱包流水和仪表盘余额。详见[数据库、环境变量与真实验收步骤](replica/backend.md)。

```powershell
pnpm build
pnpm test
```

自动化用例运行在隔离的本机环境，通过 `pg` 连接 PostgreSQL 协议测试服务器。身份与上游由测试替身提供。
