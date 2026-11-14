# 匹克球教学管理平台 · Pickleball Academy Console

面向球馆主教练、前台与店长的教学管理系统：**学员档案 → 选学员（可多选）+ 年龄段 + 课次 + 课时 → 自动生成详细教案 → 教学追踪 → 量化考核与晋级判定**。

本版本把原先的「单文件 HTML + localStorage 原型」升级为**前后端分离、数据落 SQLite 数据库、带账号鉴权与备份能力**的可部署系统，并同步到 GitHub 仓库 `jervis829/Pickleball`。

---

## 1. 本次改造范围

| 项 | 改造前 | 改造后 |
|---|---|---|
| 数据存储 | 浏览器 localStorage，换设备/清缓存即丢失 | SQLite 数据库 `data/pickleball.db`，分表、事务、WAL、软删除 |
| 数据访问 | 前端直接读写内存 state | 前端 `api.js` 统一走 `/api/v1`，保留 localStorage 作离线缓存 |
| 账号 | 无 | scrypt 密码哈希 + HS256 JWT；管理员/教练/只读三种角色 |
| 课程体系 | 硬编码在 HTML 里 | 同一份 24 单元数据源写入 `curriculum_units` 表，可由 API 读取 |
| 并发 | 无 | `revision` 乐观锁，冲突返回 409 并提示刷新，不静默覆盖 |
| 备份 | 导出/导入本机 JSON | 导出/导入直接作用于数据库，含版本号与时间戳 |
| 审计 | 无 | `audit_logs` 记录写操作（不记录请求体与敏感字段） |
| 部署 | 双击 HTML | `npm start` 或 Docker Compose，同源托管前端 |
| 代码管理 | 无 | Git 仓库 + GitHub `jervis829/Pickleball` |

**原有功能全部保留**：48 课次体系、年龄段分层（成人/青少年/常青/混合班）、多学员班、学员学习记录详情、逐段可直接带课的详细动作清单（④ 体能段按课次规则按需安排）、自动场地动线、量化考核与阈值校准、Tweaks 外观切换。

---

## 2. 技术选型与取舍

| 层 | 采用方案 | 理由 |
|---|---|---|
| 前端 | 原生单文件 HTML + ES2022（零构建） | 沿用已交付的设计系统与教案生成引擎，避免重写丢失 48 课次与逐段详细内容 |
| API 层 | `frontend/api.js` | 统一 fetch、错误处理、450ms 防抖同步、登录遮罩、离线降级 |
| 后端 | Node.js 22 内置 `http` | 分层架构（routes → controllers → services → repositories → middlewares），**零外部依赖**，`npm start` 直接可跑 |
| 数据库 | SQLite（`node:sqlite`，WAL 模式） | 单馆单教练规模足够；真实 SQL 表、索引、外键、迁移脚本、事务 |
| 鉴权 | scrypt + 自实现 HS256 JWT | 密码永不明文存储；Token 默认 15 分钟过期 |
| 安全 | 参数化查询、输入校验、CORS 白名单、限流、安全头、CSP、日志脱敏 | 对应 OWASP Top 10 的基础防护 |
| 测试 | `node:test` 集成测试 | 15 项覆盖鉴权、CRUD、聚合、乐观锁、备份、校验、静态资源 |

> **为何没用脚手架默认的 React + Express + PostgreSQL + Prisma**：该组合适合多人协作、需要弹性伸缩的 SaaS。本项目是单馆使用、且已有经过验证的成熟前端；全量重写会丢失已交付的 48 课次体系与逐段详细教案。因此保留前端，按同样的分层规范落地后端；第 16 节给出升级到 PostgreSQL 的路径。

---

## 3. 目录结构

```
pickleball/
├── package.json                  # 根脚本：start / dev / migrate / seed / test / check
├── .env.example                  # 配置样例（复制为 .env，.env 不入库）
├── .gitignore                    # 忽略 data/、*.db、.env、密钥文件
├── Dockerfile / docker-compose.yml
├── README.md
├── docs/
│   ├── API.md                    # RESTful API 说明与示例
│   ├── ER.md                     # ER 图与数据字典
│   ├── openapi.yaml              # OpenAPI 3.0 描述
│   └── 匹克球训练体系_初学者到高阶.md   # 体系数据源（v2 课次版）
├── database/
│   ├── migrations/001_init.sql   # 建表、索引、外键、初始版本号
│   └── seeds/
│       ├── curriculum.json       # 从前端抽取的 24 教学单元
│       └── seed.js               # 幂等种子
├── frontend/
│   ├── index.html                # 完整前端（含教案生成引擎）
│   └── api.js                    # 数据访问层
├── backend/
│   ├── src/
│   │   ├── config/               # 环境变量、密钥、管理员初始化
│   │   ├── db/                   # 连接（WAL/外键/事务）、迁移执行
│   │   ├── utils/                # 统一响应、校验、日志脱敏、密码与 JWT
│   │   ├── middlewares/          # 安全头、CORS、限流、请求体、鉴权、错误处理
│   │   ├── repositories/         # 参数化 SQL：各实体 + 聚合 state + 杂项
│   │   ├── services/             # 鉴权、实体校验、state、统计与学习记录
│   │   ├── controllers/          # 请求解析与响应格式化
│   │   ├── routes/               # 路由表 + 静态资源托管
│   │   ├── server.js             # HTTP 服务与请求链
│   │   └── index.js              # 启动入口
│   └── tests/api.test.js         # 集成测试
└── data/                         # 运行时生成，gitignore；数据库与首次密码
```

---

## 4. 快速开始（3 步）

```bash
# 1. 要求 Node.js >= 22.5（本环境为 22.22.2）
node -v

# 2. 进入项目并启动（无需 npm install，零外部依赖）
cd pickleball
npm start

# 3. 浏览器打开
#    http://127.0.0.1:8787
```

启动时按顺序自动完成：执行迁移 → 写入 24 教学单元 → 创建管理员账号 → 生成 JWT 密钥（若未配置）。

可选配置：复制 `.env.example` 为 `.env`，按需设置端口、绑定地址、管理员密码、JWT 密钥、跨域白名单与限流阈值。本站同源来源（含经 HTTPS 反代访问的域名）自动放行，**不需要**把域名填进 `CORS_ORIGINS`；该变量只用于真正的跨域接入。

---

## 5. 首次登录与安全约定

| 项 | 默认值 | 说明 |
|---|---|---|
| 账号 | `ADMIN_USER`，默认 `admin` | `.env` 可改 |
| 密码 | 未设置 `ADMIN_PASSWORD` 时**随机生成** | 首次启动写入 `data/initial-admin.txt` 并在控制台提示；文件权限 600 |
| Token | `JWT_TTL_SECONDS`，默认 900 秒（15 分钟） | 过期后前端自动弹出登录框 |
| 修改密码 | 设置页 →「数据服务与账号」→ 修改密码 | 新密码至少 10 位；改完请删除 `data/initial-admin.txt` |

前端未登录时不阻断使用，会进入**离线模式**：数据仅存本机浏览器，侧边栏明确标注「离线 · 仅本机」，不会伪装成已同步。

---

## 6. 数据模型

| 表 | 用途 | 关键约束 |
|---|---|---|
| `users` | 系统账号 | 用户名唯一、密码 scrypt 哈希、角色 CHECK |
| `students` | 学员档案 | 年龄段/阶段 CHECK、索引 name/stage |
| `plans` | 教学计划（教案） | 课次 1–48 CHECK、全文 `content` |
| `plan_students` | 计划↔学员（多对多） | 复合主键 + 双外键，支持多人班多选 |
| `sessions` | 授课记录 / 教学追踪 | 外键到学员、RPE 1–10 CHECK |
| `assessments` | 量化考核记录 | `vals_json` 存各单项实测值 |
| `settings` | 阈值 / 默认假设 / 界面偏好 | 键值 JSON |
| `curriculum_units` | 24 教学单元（48 课次数据源） | 单元号主键、阶段 CHECK |
| `audit_logs` | 写操作审计 | 不记录请求体与敏感字段，保留最近 5000 条 |
| `state_meta` | 聚合 state 的 `revision` | 单行，乐观锁 |
| `schema_migrations` | 已应用迁移版本 | 幂等迁移 |

全部业务表含 `created_at` / `updated_at` / `deleted_at`，删除一律软删除。完整 ER 图与字段字典见 `docs/ER.md`。

---

## 7. API 概览

基址 `/api/v1`，统一响应 `{ success, data, message, timestamp }`，错误 `{ success, error: { code, message, details }, timestamp }`。

| 类别 | 端点 |
|---|---|
| 系统 | `GET /health` |
| 认证 | `POST /auth/login`、`GET /auth/me`、`POST /auth/change-password`、`POST /auth/logout` |
| 聚合 | `GET /state`、`PUT /state` |
| 备份 | `GET /export`、`POST /import` |
| 统计 | `GET /stats` |
| 课程体系 | `GET /curriculum` |
| 学员记录 | `GET /students/:id/records` |
| CRUD | `GET/POST /{students,plans,sessions,assessments}`、`GET/PATCH/DELETE /{...}/:id` |

完整说明、示例与错误码见 `docs/API.md` 与 `docs/openapi.yaml`。

---

## 8. 数据写入与并发策略

```
用户操作 → save() 立即写 localStorage（离线缓存）
        → 450ms 防抖 → PUT /api/v1/state { state, revision }
        → 服务端单事务：软删未出现记录 → upsert 快照 → 写 settings → revision+1
        → 返回新 revision；前端侧边栏显示「已连接 · 同步于 HH:MM:SS」
```

| 场景 | 行为 |
|---|---|
| 服务未启动 / 网络断开 | 自动降级为离线模式，数据留在本机，状态栏明确标注 |
| Token 过期 | 自动弹登录框，成功后重放原请求 |
| 其他设备已修改 | 服务端 `revision` 不匹配 → 409 + 提示刷新，**不覆盖** |
| 细粒度 CRUD | 同样递增 `revision`，与聚合同步共用一把锁 |
| 导入备份 | 走 `POST /import`，强制覆盖并重置版本号，成功后前端自动刷新 |

---

## 9. 可执行步骤（球馆落地 SOP）

| 步骤 | 责任人 | 执行频率 | 交付物 | 完成判据 |
|---|---|---|---|---|
| 启动服务并首次登录、修改管理员密码 | 店长 | 部署时一次 | 可访问的中台 + 新密码 | 侧边栏显示「已连接数据库」，`data/initial-admin.txt` 已删除 |
| 建学员档案（姓名/年龄段/阶段/已耗课次/伤病） | 前台 + 主教练 | 入班时 | 学员档案 | 必填项完整；有伤病字段即触发评估提示 |
| 校准考核阈值（P50/P75/P90、权重、晋级线） | 主教练 | 每期入班后 | 阈值表 | 六项全部有值、标注样本量与统计日期 |
| 选学员 + 年龄段 + 课次 + 课时 → 生成教案 | 主教练 | 每次课前 | 详细教案 | 逐段有动作、口令、判据；60/90 分钟时间自动换算；保存后可在总览查到 |
| 课后补录出勤 / 判据 / RPE / 反馈 | 主教练 | 每次课后 | 授课记录 | 3 个要点逐人打勾、反馈按人分开 |
| 阶段末录入实测 → 晋级判定 | 主教练 | 第 16 / 32 / 48 课 | 考核记录表 | 阈值已校准，实战与规则单项过线才判晋级 |
| 导出数据库备份 | 店长 | 每周 / 每次批量改动前 | JSON 备份文件 | 文件名含日期，可成功回滚导入 |
| 代码变更提交 GitHub | 维护者 | 每次改动后 | Commit / PR | `npm test` 全绿后再提交 |

### 9.1 教案生成规则（v4.1）

| 项 | 规则 |
|---|---|
| 体系版本 | 《匹克球训练体系_初学者到高阶.md》v4.1：24 单元 × 2 课次 = 48 课次，按初阶 / 中阶 / 高阶技术点排序；补入 flick / roll volley / roll dink 等手法层，终点对齐 USA Pickleball 4.0 自评清单。 |
| 单次时长 | 选 60 / 90 分钟后按「段级配比」出时长；60 分钟靠**删内容**压缩（讲 2 个要点、砍复述、三步改两步、短局 4 分），不做等比压时间；段时长合计严格等于所选课时。 |
| 训练参数 | 次数 / 组次 / 球数 / 时长 / 距离全部输出**具体实数**，来自「体系与设置 → 训练参数」，可逐项覆盖并同步数据库；教案不再出现方括号占位。发球机档位、药球重量、弹力带色阶、命中成功率与考核阈值属器材型号 / 本馆实测，未录入时自动改教练手喂 / 自重版本 / 逐球记达标。 |
| 入班技术 0-5 | **双维综合评定**：A 匹克球专项水平 × B 其他挥拍类运动基础，档案内点评分参照矩阵一键带入。A 定主线，B 只把起步分抬到上限 3；例：网球 / 乒乓职业运动员 A0 B5 → 技术 3 分。5 分只给匹克球 4.0+。 |
| 入班体能 0-5 | 独立按运动背景评（0 无运动背景、5 任何项目职业运动员）。0-1 分自动取消 ④ 段并降强度；常青自评 4-5 也按 3 执行；混合班取全班最低分。 |
| 分数驱动 | 技术分改变球数 / 触球量 / 要点数（0-1：×0.6；5：×1.4）；体能分改变组数 / RPE / 休息（0-1：×0.5；5：×1.5）。多人班技术分取平均向下取整、分差 ≥2 追加「分层任务」（同一动作两档球数，仍不分组到不同区域）。 |
| 训练目标 | 5 类（技术晋级 / 兴趣体验 / 减脂塑形 / 比赛备战 / 专项补强）只改段配比、对抗形式、体能与作业口径，**不改 48 课次技术主线**；目标不一致时按技术晋级为主线并提示分班。 |
| 迁移纠错 | B≥3 且 A≤2（转项运动员）自动追加「短引拍 / 强制上网 / soft hands / 两跳规则」模块，并压缩基础讲解。 |
| 高阶加练 | 技术 5 分在教案末尾追加选修段（ATP+Erne 组合、shake & bake、hands battle、flick / roll 连击），不占主线课时，也可转私教。 |
| 专项体能 / 步伐段 | A 新授课安排 ④ 段；B 巩固课与第 16 / 32 / 48 课考核课不安排。热身里的 2-3 min 步伐激活始终保留。入班体能 0-1 分时自动取消，安全优先。 |
| 功能区 | **无需选择**。默认全程在标准球场；教案按本课次内容自动写明最多 1 处「可选替代」（发球机→教练手喂、打墙→同伴对喂、丁克→标准场地网前），整队往返。 |
| 教学组织 | 全员同一场地由 1 名教练统一讲解、统一发令；不分组到不同区域、不设自运行区、不发放任务卡。私教自动一对一主带。 |
| 教案结构 | 当课次技术拆解（练什么）→ 逐段详细动作（怎么带）→ 场地与器材动线（可选替代）→ 安全与退阶 → 调整说明 → 高阶加练（条件触发）。 |
| 自检 | `npm test` 含 19 项 API + 技术覆盖率（8 族 / ≥2 手法 / 必需术语 / 无占位残留）+ 前端生成引擎（1440 组组合断言数值确实变化）。 |

---

## 10. 量化指标（服务端实时计算，均附公式）

| 指标 | 定义与公式 | 统计周期 | 责任人 |
|---|---|---|---|
| 在册学员 | `COUNT(students WHERE deleted_at IS NULL)` | 实时 | 店长 |
| 在训学员 | `COUNT(students WHERE status = 在训)` | 实时 | 店长 |
| 近 7 日计划数 | `COUNT(plans WHERE date >= 今日 - 7 天)` | 每日 | 主教练 |
| 出勤率 | 出勤记录数 ÷ 授课记录数 × 100%（无记录为 null，不填 0） | 每周 | 主教练 |
| 待考人数 | `status = 待考` 或已耗课次 ≥ 阶段考核课次 − 2 且本阶段无考核记录 | 每周 | 主教练 |
| 续费预警人数 | 剩余课次 `(total − used)` ≤ 预警课次（默认 3，可配置） | 每周 | 店长 |
| 阈值已校准 | `t1/t2/t3/line2/line3/w` 六项全部有值 | 实时 | 主教练 |

接口 `GET /api/v1/stats` 的 `definitions` 字段会一并返回每个指标的公式，前端可追溯，不展示无来源数字。

---

## 11. 风险与注意事项

| 风险 | 触发信号 | 应对措施 | 责任人 |
|---|---|---|---|
| 数据库文件损坏 / 误清空 | 学员数骤降、导入误操作 | 按第 12 节每周导出备份；清空前强制确认 | 店长 |
| 多端同时编辑 | 409 同步冲突提示 | 刷新页面获取最新 revision 后再编辑 | 主教练 |
| 弱口令 / 密钥外泄 | 使用默认随机密码未改、`.env` 入库 | 首次登录立即改密；`.env`、`data/` 已 gitignore；生产用密钥管理注入 | 维护者 |
| 公网直接暴露 | 从非本机访问 | 默认仅绑定 `127.0.0.1`；对外须配 HTTPS 反向代理。同源来源按请求 Host 自动放行，恶意域仍返回 403 `CORS_FORBIDDEN` | 维护者 |
| 阈值未校准却给出晋级结论 | 设置页出现黄色提示 | 系统一律显示「无法判定」，不编造标准值 | 主教练 |
| 学员伤病 / 青少年 / 常青负荷 | 档案含伤病记录或选择对应年龄段 | **先经医生或专业人员评估**；教案自动追加退阶与 RPE 上限提示。系统不做医疗诊断、不开具康复处方 | 主教练 |

> 安全边界：系统不承诺晋级率、转化率、减脂效果或伤病恢复；涉及疼痛、心血管风险、青少年与中老年负荷时，须先经医生或专业人员评估。

---

## 12. 备份与恢复 SOP

```bash
# 方式 A：界面操作
# 设置页 / 总览 → 导出 JSON（GET /export，含 revision 与导出时间）
# 恢复：导入 JSON（POST /import）→ 前端自动刷新

# 方式 B：直接复制数据库文件（须先停服务，避免 WAL 未落盘）
cp data/pickleball.db  backups/pickleball-$(date +%F).db
cp data/pickleball.db-wal backups/            # 若存在
```

`data/` 不入 Git；如需跨设备迁移，导出 JSON 是推荐方式，直接拷贝 `.db` 仅同版本、同架构适用。

---

## 13. 测试与自检

```bash
npm test          # 15 项 API 集成测试（独立测试库 data/test-pickleball.db，自动清理）
npm run check     # 入口语法检查
npm run migrate   # 单独执行迁移
npm run seed      # 单独重建 24 教学单元与管理员
```

测试覆盖：健康检查、鉴权与错误密码、JWT、空库结构、课程体系 24/48、全量同步回读、409 乐观锁、细粒度 CRUD、学习记录聚合、KPI 公式、导出导入闭环、422 校验、软删除、静态资源与安全头、路径穿越防护。

---

## 14. Docker 部署

```bash
# 生产建议先生成 .env 并显式设置 ADMIN_PASSWORD / JWT_SECRET
docker compose up -d --build
# 访问 http://localhost:8787
```

`docker-compose.yml` 把 `./data` 挂为卷，容器重建不丢数据；默认单服务，无额外数据库容器。

---

## 15. GitHub 版本管理

仓库：`https://github.com/jervis829/Pickleball`（分支 `main`）。

```bash
git init
git remote add origin https://github.com/jervis829/Pickleball.git
git add .
git commit -m "feat: 教学管理平台全栈化（SQLite + JWT + API 层）"
git push -u origin main
```

提交前检查：`.env`、`data/*.db`、`data/initial-admin.txt`、`data/jwt-secret.txt` 均已在 `.gitignore` 中，**绝不入库**。

**当 WorkBuddy GitHub 连接为只读时**（返回 `403 Resource not accessible by integration`），用 PAT 一键推送：

```bash
# 1. 在 .env 中追加一行（该文件已 gitignore，不会进对话记录或仓库）
#    GITHUB_PAT=<具备 repo 权限的 Personal Access Token>
# 2. 执行
bash scripts/publish-to-github.sh
```

脚本把令牌以一次性 `http.extraheader` 传给 git，不写入 remote URL、不落盘、不打印；推送成功后建议在 GitHub 撤销或轮换该令牌。

---

## 16. 边界与下一步

- 当前为**单机单馆**部署：数据存本机 SQLite，不做多设备实时同步；多教练同时写入靠乐观锁提示冲突，不做自动合并。
- 教案生成引擎在前端（纯函数），课程体系数据已同步入库，可由 `/api/v1/curriculum` 供未来的移动端或第二前端复用。
- 若要升级为多场馆 / 多教练 SaaS：把 `repositories` 层的参数化 SQL 适配到 PostgreSQL（表结构可平移），引入 Redis 做会话与热点缓存，前端教案生成拆为共享模块，并加 CI/CD 与数据库迁移流水线。
- 阈值、药球重量、发球机档位等 `[占位]` 仍按体系文档保留，需由本馆实测值填充，系统不代填。

---

## 17. SSH 部署到服务器（生产）

当前生产环境（2026-11-14 首次部署并验证）：

| 项 | 值 |
|---|---|
| 服务器 | 阿里云 Ubuntu 24.04.3 LTS，`47.93.190.91` |
| 访问地址 | **`https://ajtech.top`**（HTTP 自动 301 跳转；Nginx 443 → `127.0.0.1:8787`） |
| HTTPS | Let's Encrypt 证书，覆盖 `ajtech.top` + `www.ajtech.top`，有效期至 2027-02-11；`certbot.timer` 自动续期，续期演练已通过 |
| 应用 | systemd 服务 `pickleball`，运行用户 `pkb`，目录 `/opt/pickleball` |
| 运行时 | Node 22.22.2 官方二进制装在 `/opt/node22`（服务器 apt 只有 Node 18，不改动系统包） |
| 数据库 | `/opt/pickleball/data/pickleball.db`，属主 `pkb`，密钥文件权限 600 |

### 一键部署

```bash
cp .deploy.env.example .deploy.env     # 填 DEPLOY_HOST / USER / KEY 或 PWD，可选 DOMAIN
python3 -m venv .venv-deploy && .venv-deploy/bin/pip install paramiko
.venv-deploy/bin/python scripts/deploy.py
```

`scripts/deploy.py` 按「SSH → 远端备份 → SFTP → 语法校验 → 环境/服务配置 → systemd 重启 → curl 真机验证 → 日志」执行，任一步失败自动回滚：

- **白名单打包**：只用 `git ls-files`，`.env`（含 GitHub PAT）、`.deploy.env`、`data/`、`.git` 绝不上传
- **保留数据**：切换版本时把服务器上已有的 `data/` 原样移入新版本，数据库与密钥不丢失
- **环境自适应**：检测 `/opt/node22`，缺失时从官方源（回退 npmmirror）下载安装
- **网络**：填了 `DEPLOY_DOMAIN` 且 Nginx 可用时，新增独立 `conf.d/pickleball.conf` 做反代（不改动既有站点），应用自动收敛为仅监听 `127.0.0.1`
- **HTTPS 幂等**：若 conf 已由 certbot 管理（含 `ssl_certificate`），重新部署**保留不覆盖**；若证书存在但 conf 丢失，自动重建 443 + 80 跳转
- **验证**：health、首页、`api.js`、域名路由（HTTP/HTTPS 两种场景）逐项 curl，并打印初始管理员凭据与 journalctl 日志

### 常用运维

```bash
systemctl status pickleball
systemctl restart pickleball
journalctl -u pickleball -n 50 --no-pager
cat /opt/pickleball/data/initial-admin.txt   # 首次密码；登录后立即改密并删除该文件

certbot certificates                        # 证书与到期日
certbot renew --dry-run                     # 续期演练
systemctl list-timers certbot.timer --no-pager
```

回滚（时间戳见部署输出）：

```bash
systemctl stop pickleball
mv /opt/pickleball /opt/pickleball.failed
mv /opt/pickleball.bak.<时间戳> /opt/pickleball
systemctl start pickleball
```

### 上线注意

- 应用只监听 `127.0.0.1:8787`，公网统一由 Nginx 代理；云安全组只需放行 80/443，**不要放行 8787**。
- HTTPS 已配好（签证书前的配置备份在 `/etc/nginx/conf.d/pickleball.conf.bak.<时间戳>`）；`/etc/nginx/conf.d/pickleball.conf` 由 certbot 管理，不要手工改写。
- 自动续期由 `certbot.timer`（每天两次）执行，到期前 30 天开始；国内网络偶发 ACME 超时会自动重试，可用 `certbot renew --dry-run` 检查。
- **仍需立即修改 `admin` 初始密码并删除 `initial-admin.txt`**。
- 浏览器登录若提示「来源不在白名单」：说明 `Origin` 与后端按请求 `Host` 推导出的同源来源不一致（常见于自建反代未传 `Host` / `X-Forwarded-Host`）。复现命令（错密码时应返回 **401** 而非 403）：`curl -i -X POST https://ajtech.top/api/v1/auth/login -H 'Origin: https://ajtech.top' -H 'content-type: application/json' -d '{"username":"admin","password":"x"}'`。确认 Nginx 含 `proxy_set_header Host $host;`；确需额外来源时才填 `CORS_ORIGINS`。
- `.deploy.env` 含服务器密码，已被 `.gitignore` 排除，绝不入库、不进对话。
- 定期备份 `data/pickleball.db`（见 §12），数据库不随代码部署覆盖。
