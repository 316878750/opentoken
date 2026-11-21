# OpenToken 试点备份与恢复

## 备份范围

OpenToken 使用 `pg_dump` 自定义格式，在同一个 PostgreSQL 只读快照中保存业务表、`auth.users` 和 `auth.identities`。迁移至 004 的快照覆盖 14 张表。迁移至 005 的快照覆盖 17 张表，另包含 Stripe 沙盒标记、订单和事件。认证用户 UUID、密码哈希、API 密钥摘要、钱包及账本都在加密范围内。归档和校验清单均以 AES-256-GCM 加密，原生数据库工具的明文数据通过内存传递。备份和恢复命令按试点规模限制单份归档与恢复 SQL 各为 256 MiB。

恢复环境先用对应版本的项目迁移重建 `gateway` 结构、函数和权限，并由目标 Supabase 提供托管 `auth` 表结构。会话、刷新令牌、MFA、OAuth/SMTP/回调配置、JWT 签名密钥、数据库和上游凭据、Storage 对象、数据库角色密码、扩展与定时任务配置需要独立管理。恢复后用户重新登录。已有 OpenToken API 密钥是否继续可用取决于同一 `GATEWAY_SECRET`，该密钥从批准的密钥存储取得。

## 创建与校验

1. 安装和源数据库同一主版本的 PostgreSQL 客户端工具。试点使用 PostgreSQL 17，在 Windows 可从 EDB 获取官方便携工具，设置 `BACKUP_PG_BIN` 指向含 `pg_dump`、`pg_restore` 和 `psql` 的目录，也可使用 `PATH` 中的工具。检查工具版本一致。 [PostgreSQL Windows 二进制工具](https://www.enterprisedb.com/download-postgresql-binaries?lang=en)
2. 使用当前试点的 `MIGRATION_DATABASE_URL`，连接字符串使用直连地址或 5432 会话连接池和 `sslmode=verify-full`。脚本读取 `.env.supabase-ca.pem`，也可通过 `BACKUP_PG_SSL_ROOT_CERT` 指定该目标的 CA 文件。
3. 准备只有操作账号和系统管理员可读的密钥目录。将 `BACKUP_KEY_FILE` 指向该目录下的文件，首次使用时运行 `keygen`。Windows 先在目录属性或 `icacls` 中确认 ACL，系统默认的工作区 ACL 可能允许其他本机账号读取。将密钥与备份分开保存，并在批准的密钥存储中保存可恢复的副本。

在仓库根目录运行。将示例路径替换为实际的受保护目录和归档文件。

```powershell
$env:BACKUP_PG_BIN = '.demo-data/pgsql/bin'
$env:BACKUP_KEY_FILE = 'C:\secure\opentoken-backup.key'
node scripts/backup.mjs keygen
node --env-file=.env.local scripts/backup.mjs create
node scripts/backup.mjs verify .demo-data/backups/opentoken-<timestamp>-<id>.otbk
```

`keygen` 拒绝覆盖已有密钥。`create` 在 `.demo-data/backups` 生成带 UTC 时间的加密归档。`verify` 验证 GCM 认证标签、按迁移版本检查归档目录并解码整个 `pg_dump` 数据，输出快照时间、表数与账务异常数量。校验会在创建文件之前执行一次。每次重要变更前及试点期间每天保留一份校验通过的归档。实际可恢复时间点以最后成功校验的试点归档为准。

## 隔离恢复演练

1. 在隔离 PostgreSQL 实例上创建新空库，库名使用 `opentoken_restore_` 前缀。准备与源一致的 `auth.users` 和 `auth.identities` 表结构及受限 `opentoken_app` 数据库角色。对 Supabase 项目则由平台预置 Auth 结构。
2. 将目标库连接放入单独的本地环境文件或进程环境，设置该目标的 `MIGRATION_DATABASE_URL`，运行 `node --env-file=.env.recovery.local scripts/database.mjs migrate`。保持用户表和 `gateway` 业务表为空。目标库的迁移版本必须与归档匹配。恢复 004 归档时，用第 6 阶段提交 `dff9411` 的迁移脚本准备目标库，恢复校验成功后再迁移到 005。若迁移到 005，备份任务应按 17 张表校验。
3. 准备专用的 `BACKUP_TARGET_DATABASE_URL`。恢复命令会核对目标 PostgreSQL 主版本、表清单、迁移版本和空库状态，锁定表后在同一事务内恢复，保留外键和触发器检查，并对比每张表的行数、数据摘要和账务异常数量。任何一步失败均回滚。演练使用合成用户、账务和认证数据，创建演练归档后先移入 `.demo-data/backup-drills`。

```powershell
$env:BACKUP_TARGET_DATABASE_URL = 'postgresql://backup_operator@127.0.0.1:55492/opentoken_restore_drill'
node scripts/backup.mjs restore '.demo-data/backup-drills/opentoken-<timestamp>-<id>.otbk'
```

正式恢复时创建全新 Supabase 项目，先完成相同的迁移与空库核对，再设置目标证书和连接。远程恢复命令要求显式提供**新项目**的项目引用，脚本会检查该引用并拒绝源项目。目标地址可使用 `db.<项目引用>.supabase.co` 或用户名为 `postgres.<项目引用>` 的会话连接池。恢复后在开放业务流量前检查 `db:check`、邮箱重新登录、钱包余额与冻结额、计费/兑换历史及账务异常，按项目手册配置 Auth、网关凭据和账务维护后再切换。托管 Supabase 替换项目仍需在实际切换前单独演练。 [Supabase 项目备份与恢复](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)

### 托管项目合成数据演练

在本地创建库名以 `opentoken_restore_fixture_` 开头的演练源库，只写入合成用户和账务数据。匹配目标的 PostgreSQL 主版本、Auth 表结构和迁移版本。使用单独的备份密钥执行 `create`，归档会记录合成演练源标记。

为专用 Supabase 恢复项目准备相同迁移版本的空库，配置 `BACKUP_TARGET_DATABASE_URL` 和目标数据库 TLS 证书。运行 `node scripts/backup.mjs restore-drill <fixture-archive> <recovery-project-ref>`。此命令要求归档来自本地演练源库，并要求项目引用匹配目标连接。它使用同一套事务内表清单、空库、数据摘要和账务验证。
