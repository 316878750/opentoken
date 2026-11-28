# OpenToken 小范围试点部署

## 11.1 密钥日常管理正式试点发布

2026 年 11 月 28 日，GitHub `main` 从 `63506a3` 快进到 `511f1e6`。Render 已提供新版密钥页及查询接口，沿用现有数据库结构。发布前复跑 73 项回归和 390 像素宽的 Chrome 隔离验收，全部通过。[正式试点密钥页](https://opentoken-pilot.onrender.com/keys) · [部署提交](https://github.com/316878750/opentoken/commit/511f1e652c808a775300cea33bc1fc3439188056)

| 正式站点核对项 | 结果 |
| --- | --- |
| 搜索与筛选 | 在手机视口创建一把临时密钥，按名称和公开前缀均能找到。按停用状态筛选结果为空，切换为启用并选择试点分组后只显示该密钥。 |
| 分页 | 测试账号共 5 条记录。默认每页 10 条，首尾翻页按钮均禁用。仅在验收浏览器将列表请求设为每页 2 条，使用正式数据依次核对 2、2、1 条记录、末页禁用和返回上一页。默认页长跨页另用 11 条隔离记录验证。 |
| 编辑与明文 | 修改名称、累计额度和 RPM 后刷新，重新打开编辑窗口，三项值均已保存。创建时可保存完整密钥，刷新后的列表、编辑窗口和查询响应均只展示公开前缀。 |
| 累计额度 | 将累计额度改为 0.000001 美元，下一笔 `mock-text` 请求返回 402（`key_budget_exceeded`），该密钥的使用记录仍为空。 |
| RPM 与扣费 | 将额度调至 4 美元，一笔非流式模拟调用成功。随后将 RPM 从 4 调至 1，下一笔请求立即返回 429（`rate_limit`）。该密钥只有一笔已结算使用记录，预占 2.00、实扣 0.75、释放 1.25 美元。请求编号对应一笔 −0.75 美元钱包流水，余额减少 0.75 美元，预占余额回到调用前的值。 |

验收结束后已撤销临时密钥并复核其状态。正式健康检查通过，8.3 正式收款继续暂停。

## 10.4 移动端正式试点发布

2026 年 11 月 28 日，GitHub `main` 从 `df8d819` 快进到 `e258f81`，Render 正式试点已提供新版手机菜单和卡片列表。本次发布无需数据库迁移。使用已登录的试点账号，在 Chrome 的 390 × 844 触控视口完成以下核对。[应用提交](https://github.com/316878750/opentoken/commit/e258f819a5c52149a407ced71bd329969573629e)

| 项目 | 正式站点验收 |
| --- | --- |
| 菜单 | 确认默认收起，触控展开、收起后可再次打开。由用户控制台进入后台用户管理，再通过菜单返回模型价格页。 |
| 模型比价 | 切换基础单价与含倍率单价，逐项核对两条正式目录记录的输入、缓存读取和输出价格。卡片的接入链接位于屏内。当前目录每个模型仅有一个分组；同一模型跨分组比价已在隔离环境验证。 |
| 钱包查账 | 在钱包流水筛选模型扣费，点已有流水的请求编号打开使用记录。该笔预占 2.00 美元，实扣 0.75 美元，释放 1.25 美元，钱包流水为 −0.75 美元。 |

上线后健康检查通过。此次核对沿用历史流水，未发起新的模型调用或支付，8.3 正式付费试点继续暂停。

## 第 10 阶段正式试点发布

2026 年 11 月 28 日，GitHub `main` 从 `9086d93` 快进到 `469f2bc`，Render 正式试点已提供新版页面。此次发布无需数据库迁移，发布前重跑 71 项隔离回归，全部通过。[应用发布提交](https://github.com/316878750/opentoken/commit/469f2bc93a8d32f266c5c79f6f0560f5080c0442)

| 阶段 | 正式站点验收 |
| --- | --- |
| 10.1 用户控制台与首次接入 | 确认新版登录页已生效。试点账号成功登录，仪表盘可读取可用余额，使用记录页可按 OpenToken 请求 ID 查询。 |
| 10.2 管理员后台体验 | 在用户管理页核对系统管理员可见的七个模块入口、当前页面标记和列表分页。 |
| 10.3 模型选型与接入 | 读取正式目录的两条模型与分组组合，验证筛选无结果、重置和从费率行进入所选模型的接入指引。逐项比对发布前后的模型、分组、三项单价、倍率及流式能力，一致。 |

上线后健康检查通过。正式业务验收采用只读操作，未发起模型调用。试点支付开关关闭，8.3 继续暂停。

## 第 9 阶段正式试点发布记录

2026 年 11 月 28 日，先核对正式 Supabase 项目标识、运行角色与迁移角色。发布前创建并独立验证 AES-256-GCM 快照，覆盖 14 张表，账务差异和未解决账务告警均为 0。原始归档和验证凭据仅存放在本机。

在同一事务应用迁移 005–015，随后以 `opentoken_app` 核对权限。数据库中原有的 4 条生效费率逐项匹配，钱包余额、额度明细、使用预占及退款冻结核对差异为 0。Stripe 正式结账、付费试点名单和沙盒标记均关闭。

发布前重新构建并通过 68 项隔离测试。`main` 原有的七个独有提交均能在候选分支找到等效补丁，合并保留了两边的历史。发布提交的文件树与通过验收的候选版本一致。[第 9 阶段发布提交](https://github.com/316878750/opentoken/commit/eafef033ca82ffab7570e40df44265783435e1cf)

管理员入口为 [OpenToken 管理员后台](https://opentoken-pilot.onrender.com/admin)。访客跳转到登录页，登录成功后返回后台。首开授权前，同一已验证账号访问后台页面返回 404，访问后台会话与系统设置接口返回 403。通过受控的运维流程将指定账号授予首个系统管理员角色后，重新登录返回 `system_admin`。正式域名使用带 Secure、HttpOnly、SameSite=Strict 属性的会话 Cookie，首开授权可在操作日志中查询。

七个后台模块的页面和读取接口均已在正式站点验证。健康检查返回 200，仪表盘、使用记录和兑换页面可读。用户目录中展示的两个模型与分组组合，其费率、倍率和流式能力与上线前一致。本次上线验证使用只读业务操作，没有产生模型调用或资金流水。8.3 继续暂停。

### 渠道密钥引用与邀请签发

2026 年 11 月 28 日，Render 正式服务已保存渠道登记表 `CHANNEL_CREDENTIALS_JSON`、渠道专用变量 `CHANNEL_ZEROCODE_PRIMARY` 及正式项目的 `SUPABASE_SECRET_KEY`，并重新部署。供应商沿用原地址 `https://zerocode.kaynlab.asia/v1`，登记时已核对两项密钥分别与本机配置一致。

管理员在「渠道管理 → 新增渠道」实际选中 `zerocode-primary · OpenAI 兼容`。正式接口返回该引用可用，目的地址与原供应商一致。此次验收止于选择引用，后续发布渠道时再测试模型与分组绑定。

用户管理返回 `canInvite=true`。后台为指定测试邮箱签发了一次邀请，链接指向正式域名的 `/invite`，一次性令牌格式通过校验。按邮箱查到一条待接受的普通用户记录，按操作编号查到一条成功的签发审计。部署后健康检查通过，支付入口关闭，8.3 继续暂停。

## 历史上线前核对

| 项目 | 状态 |
| --- | --- |
| 应用代码和迁移 | 第 7.3 阶段正式试点构建通过，39 项隔离测试通过。上线后已核对用量趋势的 7 天和 30 天数据。试点库已应用迁移 001–004。 |
| 试点数据库 | Supabase 项目 `opentoken`，使用低权限应用账号。数据库内每五分钟运行账本对账。 |
| 备份与恢复 | 2026-11-20 首次由本机任务计划程序自动生成并校验试点快照，覆盖 14 张表，零账务异常。隔离恢复演练已通过。 |
| 正式 HTTPS 地址 | Render 免费 Web Service `opentoken-pilot` 已在新加坡上线。登录与健康接口均返回 HTTP 200。 |
| Supabase Auth | 已配置正式站点地址与 `/invite` 重定向，公开注册已关闭。 |
| 监控与告警 | UptimeRobot 已启用。运营人员确认电脑断网时仍收到模拟 DOWN 邮件。本机定时检查和 GitHub Actions 检查也已通过。 |
| 用户试用 | 首轮试点用户反馈已登录并体验全部功能，未发现问题。 |

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

下列定时检查为早期试点记录。2026 年 11 月 23 日起，GitHub 和 Windows 的 15 分钟探针及本机每日加密备份已取消。本次发布只执行了一次备份。

- 配置仓库的 Actions 变量 `OPENTOKEN_PILOT_URL` 为正式 HTTPS 源地址。**Pilot health** 每 15 分钟检查登录页和健康接口，可手动运行。Render 免费实例闲置后会休眠，健康检查允许等待启动并重试一次。健康接口核对数据库权限、Supabase Auth、关闭公开注册的设置和网关配置，探针只读取服务状态。[Render 免费实例限制](https://render.com/docs/free)
- 在托管平台查看应用错误日志，在 Supabase Cron 查看 `opentoken-billing-maintenance` 的运行结果。用 `pnpm db:billing alerts` 检查账务告警。
- UptimeRobot 在云端监控正式试点的 `/api/health`。2026-11-21，运营人员在电脑断网时通过手机发送模拟 DOWN 通知，并确认 QQ 邮箱收到邮件。复验可在监控详情页使用 **Test Notification**。 [第 8 阶段验收记录](stage8.md) · [UptimeRobot 测试通知说明](https://help.uptimerobot.com/en/articles/11602913-how-to-test-notifications-in-uptimerobot-quick-guide)
- 2026-11-21 已验证 GitHub Actions 原生定时运行。最初两次成功运行相隔约 5 小时。 [首次定时检查](https://github.com/316878750/opentoken/actions/runs/44823171577) · [第二次定时检查](https://github.com/316878750/opentoken/actions/runs/44858149825)
- Windows 任务计划程序的 **OpenToken Pilot Health** 每 15 分钟用 Node 运行 `scripts/pilot-health.mjs`。首个定时运行中，`/api/health` 和 `/login` 都返回 HTTP 200。最近一次结果保存在本机 `.demo-data/pilot-health-scheduled.json`。
- Codex 本机自动化「OpenToken 试点故障邮件」每 30 分钟检查 GitHub 与 Windows 探针中最新的有效结果。邮件转发需要本机 Codex 可运行并保持 Gmail 连接。试点运营已确认收到告警测试邮件。

## 邀请和验收

正式地址就绪后，按确认名单逐一发放邀请，记录每人的验证状态。现有已确认账号直接使用正式登录地址。新账号的邀请可由运营用 `pnpm pilot:invite RECIPIENT_EMAIL` 生成。命令从本地运营环境读取 `APP_ORIGIN`、`SUPABASE_URL` 和 `SUPABASE_SECRET_KEY`，返回一次性设密链接。通过已授权的邮件渠道把链接发给指定收件人。收件人设置密码后进入登录页。若邀请已经验证但密码未能保存，可在同一浏览器内重试，设置会话最长保留 10 分钟。若设置会话过期，运营需协助恢复账号。默认 Supabase SMTP 只能向项目团队成员投递，如改用 Supabase 发信，应配置自有 SMTP。[Supabase 生成邀请链接](https://supabase.com/docs/reference/javascript/auth-admin-generatelink) · [Supabase SMTP 配置](https://supabase.com/docs/guides/auth/auth-smtp)

1. 接受邀请、设置密码并登录。
2. 创建一把 API 密钥，保存只在创建时显示的完整密钥。
3. 通过内部兑换码为测试账户到账。在余额和流水中找到同一笔补额。
4. 发起一次非流式模型调用。在概览记录预占及释放，在使用记录和钱包流水用请求 ID 核对扣费。
5. 将每一步的通过状态记录到运营验收记录。保留请求 ID 和收据 ID，配置和凭据留在本地。

2026-11-20 在 Render 正式地址完成了运营验收。Supabase 试点账号可登录，会话 Cookie 使用 `HttpOnly`、`Secure` 和 `SameSite=Strict`。密钥创建时返回完整值，后续列表只显示前缀，验收后已撤销临时密钥。试点补额 3.00 美元已入账，一笔 `mock-text` 非流式请求预占 2.00 美元、扣费 0.75 美元、释放 1.25 美元。仪表盘、使用记录和钱包流水金额一致。受邀用户自行走查的结果另行登记。

2026-11-20，首轮试点用户反馈已用受邀账号登录并体验全部功能，未发现问题。

## 备份恢复

试点开启前和线上验收后均生成了加密快照。2026-11-20 通过 Windows 一次性任务自动完成了快照生成与校验。早期曾由 Codex 本机自动化「OpenToken 每日加密备份」在每天 02:15（北京时间）执行。需要本机可运行且能连接 Supabase。密钥和备份分开保存。恢复演练使用隔离目标库，并比对登录用户标识、钱包、预占和流水。详见 [加密备份与恢复手册](backup.md)。
