# OpenToken 小范围试点部署

## 上线前核对

| 项目 | 状态 |
| --- | --- |
| 应用代码和迁移 | 部署构建通过，29 项隔离测试通过。试点库已应用迁移 001–004。 |
| 试点数据库 | Supabase 项目 `opentoken`，使用低权限应用账号。数据库内每五分钟运行账本对账。 |
| 备份与恢复 | 已校验包含线上验收流水的试点加密快照，覆盖 14 张表，零账务异常。隔离 PostgreSQL 已完成恢复演练，已启用本机每日备份任务。 |
| 正式 HTTPS 地址 | Render 免费 Web Service `opentoken-pilot` 已在新加坡上线。登录与健康接口均返回 HTTP 200。 |
| Supabase Auth | 已配置正式站点地址与 `/invite` 重定向，公开注册已关闭。 |
| 告警通知 | GitHub Actions HTTPS 检查已启用并通过首次运行。Codex 本机自动化发送故障邮件。告警测试邮件已提交发送，收件确认待回执。 |

试点入口仅供受邀用户。放出链接前，在目标 Supabase 项目的 **Authentication → Sign In / Providers** 关闭公开注册，保留邮箱和密码登录。在 **URL Configuration** 设置正式 HTTPS 地址，并把正式地址的 `/invite` 加入 Auth 重定向列表。用公开 Auth 设置确认 `disable_signup` 为 `true`。

## 托管设置

在 Render 创建免费 Web Service，从 GitHub 导入 `316878750/opentoken` 的 `main` 分支，运行环境选 Node，健康检查路径设为 `/api/health`。应用入口为 [OpenToken 登录](https://opentoken-pilot.onrender.com/login)，兼容网关使用同一域名下的 `/v1`。[Render 的 Next.js 部署说明](https://render.com/docs/deploy-nextjs-app)

构建命令安装锁定的依赖并构建应用。

```sh
corepack pnpm@11.25.0 install --frozen-lockfile && corepack pnpm@11.25.0 build
```

启动命令读取 Render 分配的外部地址和监听端口。[Render 环境变量](https://render.com/docs/environment-variables)

```sh
APP_ORIGIN="${APP_ORIGIN:-$RENDER_EXTERNAL_URL}" node node_modules/next/dist/bin/next start --hostname 0.0.0.0 --port "$PORT"
```

从现有 Supabase 项目取得应用连接和公开 Auth 配置。托管环境填写以下变量。

| 变量 | 内容 |
| --- | --- |
| `APP_ORIGIN` | 正式 HTTPS 源地址。用 Render 分配的地址时，由启动命令从 `RENDER_EXTERNAL_URL` 设置。 |
| `NODE_VERSION` | `24.22.1`。 |
| `SKIP_INSTALL_DEPS` | `true`。由构建命令按锁文件安装依赖。 |
| `SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY` | 同一个试点项目的 Auth 地址和公开密钥。 |
| `DATABASE_URL` | `opentoken_app` 低权限数据库连接，带 `sslmode=verify-full`。 |
| `DATABASE_CA_BASE64` | Supabase 官方数据库 CA PEM 的 Base64。托管 Node 通过此变量验证证书和数据库主机名。 |
| `GATEWAY_SECRET` | 原试点的 32 字节十六进制网关密钥。恢复时同一值能继续验证已有 API 密钥。 |
| `ENABLE_OPENAI` | 首轮可设为 `0`，试点从 `mock-text` 走完调用和结算。真实上游按已核准范围显式启用。 |

管理员迁移连接和邀请密钥由运营端保管。PowerShell 可将项目 CA 文件转换为托管变量。

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path -LiteralPath '.env.supabase-ca.pem').Path))
```

部署后检查正式域名的 `/login` 和 `/api/health` 都返回 HTTP 200。再登录检查会话 Cookie 使用 `HttpOnly`、`Secure` 和 `SameSite=Strict`，并确认不同账号只能看到自己的密钥、使用记录和账本。

## 监控

- 配置仓库的 Actions 变量 `OPENTOKEN_PILOT_URL` 为正式 HTTPS 源地址。**Pilot health** 每 15 分钟检查登录页和健康接口，可手动运行。Render 免费实例闲置后会休眠，健康检查允许等待启动并重试一次。健康接口核对数据库权限、Supabase Auth、关闭公开注册的设置和网关配置，探针只读取服务状态。[Render 免费实例限制](https://render.com/docs/free)
- 在托管平台查看应用错误日志，在 Supabase Cron 查看 `opentoken-billing-maintenance` 的运行结果。用 `pnpm db:billing alerts` 检查账务告警。
- [首次 GitHub Actions 检查已通过](https://github.com/316878750/opentoken/actions/runs/44739829526)。Codex 本机自动化「OpenToken 试点故障邮件」每 30 分钟读取工作流结果，每次故障最多发送一封邮件。邮件转发依赖本机 Codex 和 Gmail 连接。测试邮件已发出，收件箱的实际投递待收件人确认。

## 邀请和验收

正式地址就绪后，按确认名单逐一发放邀请，记录每人的验证状态。现有已确认账号直接使用正式登录地址。新账号的邀请可由运营用 `pnpm pilot:invite RECIPIENT_EMAIL` 生成。命令从本地运营环境读取 `APP_ORIGIN`、`SUPABASE_URL` 和 `SUPABASE_SECRET_KEY`，返回一次性设密链接。通过已授权的邮件渠道把链接发给指定收件人。收件人设置密码后进入登录页。若邀请已经验证但密码未能保存，可在同一浏览器内重试，设置会话最长保留 10 分钟。若设置会话过期，运营需协助恢复账号。默认 Supabase SMTP 只能向项目团队成员投递，如改用 Supabase 发信，应配置自有 SMTP。[Supabase 生成邀请链接](https://supabase.com/docs/reference/javascript/auth-admin-generatelink) · [Supabase SMTP 配置](https://supabase.com/docs/guides/auth/auth-smtp)

1. 接受邀请、设置密码并登录。
2. 创建一把 API 密钥，保存只在创建时显示的完整密钥。
3. 通过内部兑换码为测试账户到账。在余额和流水中找到同一笔补额。
4. 发起一次非流式模型调用。在概览记录预占及释放，在使用记录和钱包流水用请求 ID 核对扣费。
5. 将每一步的通过状态记录到运营验收记录。保留请求 ID 和收据 ID，配置和凭据留在本地。

2026-11-20 在 Render 正式地址完成了运营验收。Supabase 试点账号可登录，会话 Cookie 使用 `HttpOnly`、`Secure` 和 `SameSite=Strict`。密钥创建时返回完整值，后续列表只显示前缀，验收后已撤销临时密钥。试点补额 3.00 美元已入账，一笔 `mock-text` 非流式请求预占 2.00 美元、扣费 0.75 美元、释放 1.25 美元。仪表盘、使用记录和钱包流水金额一致。受邀用户自行走查的结果另行登记。

已向首轮唯一确认的试点账号发出邀请邮件。试点用户可以用已有账号及已入账的验收额度走查，收件回执和用户自行验收结果待确认。

## 备份恢复

试点开启前和线上验收后均生成了加密快照。Codex 本机自动化「OpenToken 每日加密备份」每天 02:15（北京时间）创建并校验加密快照。需要本机可运行且能连接 Supabase。密钥和备份分开保存。恢复演练使用隔离目标库，并比对登录用户标识、钱包、预占和流水。详见 [加密备份与恢复手册](backup.md)。
