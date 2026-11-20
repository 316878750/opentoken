# OpenToken 后端接入

本阶段沿用 [架构](architecture.md) 中的流水、金额与用量结构。常规运行依赖真实 Supabase Auth 和 PostgreSQL。模拟、官方 OpenAI 与 OpenAI 兼容上游使用同一个钱包、限额、预占、结算和报表路径。PGlite 仅在测试中提供隔离的 PostgreSQL 协议服务。

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
6. 将试点用户邮件填入 `PILOT_EMAIL`，执行 `pnpm db:seed`。命令导入模型目录，并对这个已验证用户发放一次 USD 10.00 内部额度，重复执行不会重复入账。未设置邮箱时只导入目录。其他用户首次登录创建零余额钱包。

## 上游与真实验收

使用 `ENABLE_OPENAI=1` 启用真实模型，并显式选择 `UPSTREAM_MODE`。服务端把密钥发送到对应 HTTPS 端点，禁止重定向。模式或配置缺失时直接失败。

- `official` 模式的应用代号为 `openai-mini`，固定调用官方 `gpt-5.4-mini-2026-03-17`。设置使用自己 OpenAI 项目的 `OPENAI_API_KEY`。 [官方模型和费率](https://developers.openai.com/api/docs/models/gpt-5.4-mini) · [Chat Completions 文档](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- `compatible` 模式的应用代号为 `compatible-chat`。在 `.env.local` 设置第三方专用的 `COMPATIBLE_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`，以及三项每百万 Token 的 USD 费率 `UPSTREAM_INPUT_USD_PER_MTOK`、`UPSTREAM_CACHED_USD_PER_MTOK`、`UPSTREAM_OUTPUT_USD_PER_MTOK`。默认发送 `max_tokens`，如该供应商要求 `max_completion_tokens` 则设置 `UPSTREAM_MAX_TOKENS_FIELD`。响应中的模型名应等于请求模型，如服务商公开文档明示另一响应名称可设置 `OPENAI_RESPONSE_MODEL`。预占默认按 8192 个输入 Token 的本地报价上限，支持 `UPSTREAM_MAX_CONTEXT_TOKENS`。更改费率后重新运行 `pnpm db:seed`，旧请求仍关联原费率版本。

两个模式均发送非流式文本。费用由 OpenToken 根据上游返回的 Token 和冻结费率计算。兼容服务可以通过请求响应头或完成响应 ID 提供关联编号，缓存读取支持标准用量字段、`prompt_cache_hit_tokens` 和 `prompt_cache_miss_tokens`。输入和缓存单价不同时，缺少缓存拆分会进入待核对。模型、用量或预占约束不匹配同样进入待核对。服务商自己账户中的最终账单需另行核对。

每次调用先在事务里冻结费率和保守预占。验收只允许 16 个输出 Token。结算写入一笔扣费流水并释放剩余预占。官方上游明确拒绝时释放预占。兼容上游的非成功状态、超时、回包缺少用量或账本结果不确定时保留预占，将请求标为待核对。

执行 `pnpm verify:live` 前先确认试点账号有额度且没有其他活跃调用。验收命令从本机 `.env.local` 读取 `PILOT_EMAIL` 和 `PILOT_PASSWORD`，登录并创建专用临时密钥，通过网关发送一条固定短请求，之后撤销该密钥。它将用量记录、实际流水金额、账面余额及预占释放变化对账。执行记录保存在已忽略的 `.demo-data/live-check.json`，用来防止重复付费调用。记录只含用量、余额和关联编号。如果上游较快，仪表盘轮询可能错过处理中快照，脚本会单独报告该事实，并核对用量记录保留的预占凭据。控制台使用与脚本相同的概览和用量接口。

## 异常账单与对账

迁移 002–003 增加运营处理记录、对账告警和后台命令。命令使用管理员数据库连接，应用数据库角色无权查询运营凭据、处理账单或运行扫描。

```powershell
pnpm db:migrate
pnpm db:check
pnpm db:billing list
pnpm db:billing show REQUEST_ID
pnpm db:billing resolve REQUEST_ID settle OPERATOR EVIDENCE_ID INPUT_TOKENS CACHED_TOKENS OUTPUT_TOKENS
pnpm db:billing resolve REQUEST_ID release OPERATOR EVIDENCE_ID
pnpm db:billing scan
pnpm db:billing alerts
pnpm db:billing schedule
```

按请求 ID 或上游编号取得上游用量或未扣费凭据，再运行对应命令。操作人填运营身份标识，凭据填工单或记录编号。结算使用请求绑定的历史费率。费用超过原预占，或流水、审计记录与预占数据有冲突时，命令会报错并保留待核对状态。处理动作、数据库会话身份、凭据编号及原待核对原因会写入审计记录。同样的处理参数可安全重试，冲突的决定会报错。

`schedule` 用 Supabase Cron 注册同名任务，每五分钟运行一次。扫描释放两分钟以上且仍未派发、账务数据一致的预占。有冲突的预占和两分钟以上的派发中请求进入待核对。若派发中的请求随后收到有效上游结果，且运营尚未处理，网关仍可按正常流程结算或释放。扫描会记录余额与流水净额、钱包和密钥预占、密钥累计扣费及请求流水的差异，并标记超过十五分钟的待核对请求。没有差异后会关闭对应告警。金额按微美元记录，待核对超时按秒记录。用 `db:billing alerts` 查看未关闭的告警，在 Supabase Cron 查看任务运行记录。旧命令 `pnpm db:review-stale` 也可运行同一轮扫描。

## 试点用户补额

迁移 004 增加兑换事务和逐账号尝试次数限制。签发和作废使用管理员连接。应用数据库角色通过受限函数写入补额，直接写流水的权限限于扣费所需列。兑换码表只存 SHA-256 摘要。

```powershell
pnpm db:migrate
pnpm db:check
$expiry = (Get-Date).AddDays(7).ToString("yyyy-MM-dd'T'HH:mm:sszzz")
pnpm db:redeem issue 5.00 $expiry
pnpm db:redeem void CODE_ID
```

`issue` 的金额单位是 USD，支持最多六位小数。命令只在签发时返回明文码，同时返回用于运营查询的码 ID。可以用 ID 作废未兑换码。

试点用户登录后，从 **概览 → 兑换额度** 打开兑换页。成功后显示收据编号、到账金额和时间，并刷新账面余额、预占和可用余额。钱包流水可按额度到账和模型扣费筛选。用同一码重试时，同一用户可取回原收据。过期、作废、错误或已被其他账号使用的码统一返回不可用。账号在一分钟内累计五次无效尝试后暂时受限，已到账的同账号重试仍可取回原收据。

## 验证及边界

本地构建、7 项隔离测试和生产依赖审计通过。隔离测试使用两个独立账号，以受限数据库角色执行读写，核对了模拟调用和兼容上游替身的预占、单笔扣费、剩余额度释放和结果不确定时的保留。已提供的 Supabase URL 和 publishable key 通过 Auth settings 只读检查。云数据库连接、云端账户登录及真实上游扣费还需单独验收。

- [x] Auth 会话在服务端验证，钱包、密钥、用量与流水查询按账号限定。原始密钥仅在创建响应显示，摘要带服务端 HMAC。
- [x] 网关限制请求大小并校验入参，执行钱包金额、密钥限额、每分钟调用数和可选幂等键检查。
- [x] 明确拒绝释放预占，模糊结果保留预占。费率版本与请求、流水关联。上游日志仅保留请求编号和受控状态字段。
- [x] 在试点 Supabase 项目运行迁移、检查应用角色权限，并使用第三方兼容服务验证一笔真实调用。官方 OpenAI 模式由替身测试覆盖。
- [ ] Supabase 登录频率限制和生产备份由项目设置管理。实际设置待连接后核对。自助注册、找回密码、支付、邮件和流式调用不在本次范围。
