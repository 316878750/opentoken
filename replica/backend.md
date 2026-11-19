# OpenToken 后端接入

本阶段沿用 [架构](architecture.md) 中的流水、金额与用量结构。常规运行依赖真实 Supabase Auth 和 PostgreSQL。`mock-text` 和官方 `openai-mini` 使用同一个钱包、限额、预占、结算和报表路径。PGlite 仅在测试中提供隔离的 PostgreSQL 协议服务。

## 配置和迁移

1. 在自己的 Supabase 项目关闭公开注册，并创建已验证邮件、带密码的受邀测试用户。控制台使用邮箱和密码登录。应用只把 Supabase access token 放入 HttpOnly Cookie，HTTPS 时加 Secure。试点会话到期需要重新登录。退出会清除本机 Cookie 并通知 Supabase。已签发的 access token 仍按原定到期时间失效。
2. 在 Supabase SQL Editor 或管理员连接中建立应用角色。使用自选密码并保存到本机 `.env.local` 中的连接串。如果项目已有同名角色，先核对其权限与用途。

   ```sql
   CREATE ROLE opentoken_app LOGIN PASSWORD '<自行设置强密码>'
     NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
   ```

3. 从 Supabase 的 Connect 页面复制管理员连接串到 `MIGRATION_DATABASE_URL`。将运行连接串 `DATABASE_URL` 的账号换成 `opentoken_app` 及其密码。会话池用户名通常为 `opentoken_app.<project-ref>`。远程连接均使用 `sslmode=verify-full`。如果 Node 环境缺少项目 CA，将 Supabase 提供的 CA 证书交给 Node 信任配置，例如在启动进程前设置 `NODE_EXTRA_CA_CERTS`。可用直接连接或会话池，个人 Windows 本机可能需要会话池。密码里的保留字符需做 URL 编码。 [Supabase 数据库连接](https://supabase.com/docs/guides/database/connecting-to-postgres)
4. 在 `.env.local` 配置项目 URL、publishable key 和 `GATEWAY_SECRET`。后者应为固定的 32 字节随机十六进制值，可用 PowerShell 在本机生成。更换该值会使已签发的 OpenToken API 密钥失效。

   ```powershell
   [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
   ```

5. 执行 `pnpm db:migrate` 创建带版本记录的 `gateway` 私有 schema 并授权；执行 `pnpm db:check` 核对应用角色。保持 `gateway` 不在 Supabase Data API 的公开 schema 列表。运行账户按表授予最小权限，费率只读，钱包流水只允许读与插入。
6. 将试点用户邮件填入 `PILOT_EMAIL`，执行 `pnpm db:seed`。命令导入两个目录模型，并对这个已验证用户发放一次 USD 10.00 内部额度，重复执行不会重复入账。未设置邮箱时只导入目录。其他用户首次登录创建零余额钱包。

## 官方 OpenAI 和真实验收

官方模型固定使用 `gpt-5.4-mini-2026-03-17`，应用模型代号为 `openai-mini`，适配 `https://api.openai.com/v1/chat/completions`。启用需要 `ENABLE_OPENAI=1` 和自有项目的 `OPENAI_API_KEY`。密钥只在服务端读取，目标 URL 固定，不跟随重定向。请求用非流式文本，关闭存储选项，并使用默认服务层。应用结算按目录费率快照和 OpenAI 返回的输入、缓存读取、输出 Token 计算。 [官方模型和费率](https://developers.openai.com/api/docs/models/gpt-5.4-mini) · [Chat Completions 文档](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)

每次调用先在事务里冻结费率和保守预占。本次验收只允许 16 个输出 Token。官方模型使用完整上下文上限估算，按种子价预占 USD 0.300072。结算写入一笔扣费流水并释放剩余预占。上游明确拒绝时释放预占，超时、回包缺少用量或账本结果不确定时保留预占，将请求标为待核对。服务进程意外退出后，运营可用 `pnpm db:review-stale` 把超过 2 分钟的在途记录标为待核对。该命令保留原有预占，人工核对规则和自动调度仍待完善。

执行 `pnpm verify:live` 前先确认试点账号有额度且没有其他活跃调用。验收命令从本机 `.env.local` 读取 `PILOT_EMAIL` 和 `PILOT_PASSWORD`，登录并创建专用临时密钥，通过网关发送一条固定短请求，之后撤销该密钥。它将用量记录、实际流水金额、账面余额变化和已结算费用变化对账。执行记录保存在已忽略的 `.demo-data/live-check.json`，防止重复付费调用；不会写入密码、OpenAI key 或模型正文。如果上游较快，仪表盘轮询可能错过处理中快照，脚本会单独报告该事实，并核对用量记录保留的预占凭据。控制台的人机验收使用与脚本相同的概览和用量接口。

## 验证及边界

本地构建、4 项隔离测试和生产依赖审计通过。隔离测试使用两个独立账号，以受限数据库角色执行读写，核对了模拟调用和 OpenAI 替身的预占、单笔流水、拒绝释放和结果不确定时的保留。已提供的 Supabase URL 和 publishable key 通过 Auth settings 只读检查。云数据库连接、云端账户登录及真实 OpenAI 扣费还需单独验收。

- [x] Auth 会话在服务端验证，钱包、密钥、用量与流水查询按账号限定。原始密钥仅在创建响应显示，摘要带服务端 HMAC。
- [x] 网关限制请求大小并校验入参，执行钱包金额、密钥限额、每分钟调用数和可选幂等键检查。
- [x] 明确拒绝释放预占，模糊结果保留预占。费率版本与请求、流水关联。上游日志仅保留请求编号和受控状态字段。
- [ ] 在用户提供的云项目上运行迁移、检查权限与备份，并验证一笔真实调用。需要数据库连接、OpenAI API key 和测试账号；无凭据时只运行隔离的替身验收。
- [ ] Supabase 登录频率限制和生产备份由项目设置管理。实际设置待连接后核对。自助注册、找回密码、支付、邮件和流式调用不在本次范围。
