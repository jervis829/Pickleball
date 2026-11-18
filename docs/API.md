# RESTful API 说明

基址：`/api/v1` · 同源部署时前端直接请求相对路径。完整机器可读描述见 [`openapi.yaml`](./openapi.yaml)。

## 1. 统一格式

成功：

```json
{ "success": true, "data": { "...": "..." }, "message": "OK", "timestamp": "2026-11-14T00:00:00.000Z" }
```

失败：

```json
{
  "success": false,
  "error": { "code": "VALIDATION_ERROR", "message": "输入校验失败", "details": [{ "field": "stage", "message": "不得大于 3" }] },
  "timestamp": "2026-11-14T00:00:00.000Z"
}
```

| 状态码 | 用途 | 常见 code |
|---|---|---|
| 200 | 查询 / 更新成功 | — |
| 201 | 创建成功 | — |
| 204 | 删除成功 | — |
| 400 | 请求体非法 JSON | `INVALID_JSON` |
| 401 | 未登录 / 凭证错误 | `UNAUTHORIZED`、`INVALID_CREDENTIALS` |
| 403 | 只读账号写入 / 来源不在白名单 | `FORBIDDEN`、`CORS_FORBIDDEN` |
| 404 | 资源或路由不存在 | `NOT_FOUND` |
| 409 | 并发版本冲突 | `REVISION_CONFLICT` |
| 413 | 请求体超过 5 MB | `PAYLOAD_TOO_LARGE` |
| 422 | 输入校验失败 | `VALIDATION_ERROR` |
| 429 | 触发限流 | `RATE_LIMITED` |
| 500 | 服务端错误（生产不返回堆栈） | `INTERNAL_ERROR` |

## 2. 认证

除 `GET /health` 与 `POST /auth/login` 外，全部端点需要 `Authorization: Bearer <JWT>`。

```bash
curl -X POST http://127.0.0.1:8787/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"<首次密码见 data/initial-admin.txt>"}'
# => { "success":true, "data": { "token":"...", "user":{...}, "expires_in":900 } }
```

密码用 scrypt + 随机盐存储；JWT 为 HS256，默认 15 分钟过期。角色：`admin` / `coach` 可写，`viewer` 只读。

## 3. 端点清单

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查（免鉴权） |
| POST | `/auth/login` | 登录（免鉴权） |
| GET | `/auth/me` | 当前账号与过期时间 |
| POST | `/auth/change-password` | 修改密码（`old_password` / `new_password`，新密码 ≥ 10 位） |
| POST | `/auth/logout` | 前端清 Token 即可，服务端返回 204 |
| GET | `/state` | 拉取全量 state + `revision` |
| PUT | `/state` | 全量同步 `{ state, revision }` |
| GET | `/export` | 导出数据库备份（含 `exported_at` 与 `revision`） |
| POST | `/import` | 导入备份（强制覆盖，重置版本号） |
| GET | `/stats` | KPI 数值 + 每个指标的公式定义 |
| GET | `/curriculum` | 24 教学单元（48 课次） |
| GET | `/students/:id/records` | 学员学习记录聚合（进度 / 时间线 / 安全标记） |
| GET | `/students` | 学员列表，支持 `page` / `pageSize` / `keyword` |
| POST | `/students` | 新增学员 |
| GET | `/students/:id` | 学员详情 |
| PATCH | `/students/:id` | 局部更新 |
| DELETE | `/students/:id` | 软删除 |
| GET/POST/GET/PATCH/DELETE | `/plans`、`/sessions`、`/assessments` | 同上四组 CRUD |

### 3.1 身体素质测评（P6）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/fitness-battery` | 9 项实测定义：测试协议、安全提示、5 档锚点、变异与年龄组系数、维度权重、免责声明 |
| POST | `/fitness-assessments` | 为学员开一份测评 `{ studentId, sex?, heightCm?, weightKg?, ageGroupCode?, testDate? }`；创建时固化测评表快照 |
| GET | `/fitness-assessments/:id` | 完整报告：9 维指数、雷达图数据源、强项/补强、计划适配建议、与教练自评的对照 |
| PUT | `/fitness-assessments/:id/results` | 录入单项 `{ results:[{ itemCode, rawValue, variantCode?, status?, note? }] }`；`status` 取 `measured/aborted/skipped/contraindicated`，非 `measured` 不计分 |
| POST | `/fitness-assessments/:id/finalize` | 生成报告并锁定；需 ≥6 项且覆盖 ≥4 个维度，否则 422 `INCOMPLETE_BATTERY` |
| POST | `/fitness-assessments/:id/apply-to-student` | 教练确认后把换算体能分写入 `students.fit_score`；可选 `{ fitScore }` 覆盖（0–5 整数） |
| GET | `/students/:id/fitness-assessments` | 该学员历史测评列表 + 趋势点 |
| GET | `/students/:id/fitness-latest` | 最新一份已完成报告（教案生成时用于 ④ 段适配） |

计分口径（`backend/src/services/fitness-scoring.js`，纯函数可单测）：

1. **变体 / 性别折算**先作用于原始值：`higher` 类（次数、距离、保持时间）用 `实测 ÷ 系数`，`lower` 类（计时、心率、反应距离）用 `实测 × 系数`；系数 >1 表示该版本更容易或该群体标准更低。
2. **查 5 档锚点**得 0-100 基础指数（10 / 35 / 60 / 80 / 100 五档线性插值）。
3. **年龄组让步在指数空间**：`index′ = 100 − (100 − index) × e`，`e` 取该维度的 `dimensionFactor`。e<1 放宽、e>1 收紧；对负值项目（坐位体前屈）与两个方向都一致。
4. **未测不当作 0 分**：只对测到的维度重新归一权重；中止/禁忌项 `indexValue = null`。

常见错误码：`UNKNOWN_ITEM`（项目不在测评表）、`INVALID_VALUE`（实测值非数字）、`INCOMPLETE_BATTERY`（项目/维度不足）、`ASSESSMENT_LOCKED`（已完成不可改写）、`NOT_COMPLETED` / `NO_SCORE`（未完成或无法换算就写入档案）。

列表统一返回 `{ items, total, page, pageSize }`，最大 `pageSize = 200`。

### 3.2 课程包 / 课程大纲 / 执行 / 点评（P7）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/curriculum-difficulty` | 24 单元的难度、并列新授点数、建议课次、放行判据、拆分建议，以及剂量模型与已知缺口 |
| POST | `/enrollments` | 登记课程包并生成大纲 `{ studentId, totalLessons, packageType?, lessonsPerWeek?, minutesPerLesson?, startDate?, startStage?, startUnit?, techLevel?, fitLevel?, ageGroup?, paceMode? }`；单事务写入课程包 + N 节大纲 |
| GET | `/enrollments` | 课程包列表（含大纲），支持 `studentId` / `status` 过滤 |
| GET | `/enrollments/:id` | 课程包详情 + 学员快照 + 逐节状态 |
| PATCH | `/enrollments/:id` | 改 `status`（active/completed/paused/cancelled）、`paceMode`（fixed/adaptive）、频次、时长、备注 |
| POST | `/enrollments/:id/lessons` | **执行一节课** `{ outlineLessonId?, planId?, date?, judge?, rpe?, attend? }`；不传 `outlineLessonId` 时取第一个待上课次 |
| POST | `/sessions/:id/review` | 课后点评 `{ judge, attend?, rpe?, note?, homework?, nextFocus?, judgeVals? }`；判据非「达标」时按节奏模式调整大纲 |
| GET | `/today` | 今日视图 `?date=YYYY-MM-DD`：当天待上课 / 待点评 / 已过期未上 |

关键口径：

1. **课次数量由难度与剂量推出，不由频次倒推。** 单节实球触球 = `32 × 技术系数 × 体能/年龄系数 × 时长系数`（成人技术 3 体能 3 满 90 分钟 = 32 次）；单节并列新授点上限 3 个；难度 5 的单元至少 3 节；单单元最多 4 节。课时不够覆盖时返回 `generated.truncated = true` 并说明排到了第几个单元，**不假装排完**。
2. **执行是单事务**：`sessions` 插入（`review_status = pending`）+ `outline_lessons.status = taught` + `enrollments.used_lessons + 1` + `students.used + 1`。任一步失败整体回滚。
3. **执行幂等**：同一 `outlineLessonId` 重复调用返回同一 `session`，`duplicated = true`，不会重复扣课时。
4. **点评会自动调大纲**：`paceMode = adaptive` 且判据非「达标」→ 下一个 `planned` 课次改为同单元 `R` 补强课，**不新增课时、不改单次时长**；`paceMode = fixed` → 不动大纲，返回 `adjust.action = 'hold'`。
5. `GET /state` 同时下发 `enrollments`（含 `outline`），离线也能看今天上哪节、哪节还没点评。

返回示例（执行一节课）：

```json
{
  "session": { "id": "R2F1...", "lesson": 1, "reviewStatus": "pending", "date": "2026-11-18" },
  "outlineLesson": { "id": "OL...", "seq": 1, "status": "taught" },
  "duplicated": false,
  "nextStep": { "action": "insert_r", "text": "自适应节奏：建议在第 2 节插入 1 节「第 1 单元补强（R）」…" }
}
```

常见错误码：`STUDENT_NOT_FOUND`（404）、`ENROLLMENT_NOT_FOUND`（404）、`OUTLINE_NOT_FOUND`（404，防止执行不属于该课程包的大纲课次）、`NO_PLANNED_LESSON`（409，课已上完）、`ENROLLMENT_CANCELLED`（409）、`VALIDATION_ERROR`（422，`totalLessons` 非 1–200 整数、`judge` 不在三档内）。

## 4. 字段映射（前端 state ↔ 数据库列）

| 实体 | 前端字段 | 数据库列 |
|---|---|---|
| students | `age` / `sizeLabel` / `expire` / `injury` / `techScore` / `fitScore` | `age_group` / `size_label` / `expire_date` / `injury_note` / `tech_score` / `fit_score` |
| plans | `studentIds` / `date` / `ageName` / `size` / `zones` / `text` | `plan_students` 关联表 / `lesson_date` / `age_name` / `class_size` / `zones_json` / `content` |
| sessions | `studentId` / `date` | `student_id` / `lesson_date`（`studentName` 由 JOIN 派生） |
| assessments | `studentId` / `date` / `vals` | `student_id` / `lesson_date` / `vals_json` |

## 5. 关键示例

### 5.1 全量同步（前端 save 的实际请求）

```bash
curl -X PUT http://127.0.0.1:8787/api/v1/state \
  -H 'authorization: Bearer <TOKEN>' -H 'content-type: application/json' \
  -d '{
    "revision": 3,
    "state": {
      "students": [{"id":"S001","name":"陈一","age":"adult","stage":1,"used":6,"total":48}],
      "plans": [{"id":"P001","lesson":7,"stage":1,"studentIds":["S001"],"tech":"网前 dink"}],
      "sessions": [], "assessments": [],
      "thresholds": {}, "defaults": {"minutes":90}, "prefs": {"theme":"dark"}, "demo": false
    }
  }'
# => { "success":true, "data": { "revision": 4 } }
```

服务端在**单个事务**内：软删本次快照未出现的记录 → upsert 快照记录 → 重建 `plan_students` → 写 settings → `revision + 1`。若提交版本与服务端不一致，返回 409，不做任何写入。

### 5.2 细粒度新增学员

```bash
curl -X POST http://127.0.0.1:8787/api/v1/students \
  -H 'authorization: Bearer <TOKEN>' -H 'content-type: application/json' \
  -d '{"name":"林二","age":"senior","stage":2,"used":24,"total":48,"injury":"右肩既往不适"}'
```

`age` 仅接受 `adult` / `youth` / `senior` / `mixed`；`stage` 1–3；课次 1–48；RPE 1–10。越界一律 422。

### 5.3 学习记录聚合

```bash
curl http://127.0.0.1:8787/api/v1/students/S001/records \
  -H 'authorization: Bearer <TOKEN>'
# data: { student, progress:{attendance_rate, used, total, ...},
#         safety:{injury_note, needs_assessment}, plans, sessions, assessments, timeline }
```

`safety.needs_assessment` 在**有伤病记录**或**青少年 / 常青**年龄段时为 `true`，仅作提示，不构成医疗判断。

## 6. 安全约定

- 所有 SQL 使用参数化查询；动态列名只来自服务端常量表，不拼接用户输入。
- 请求体上限 5 MB；按 IP 限流（默认 60 秒 600 次，可配置）。
- CORS 默认放行**与请求同源**的来源：直连 `127.0.0.1:8787`，以及经反向代理由 `Host` / `X-Forwarded-Host` 推导出的本站域名（HTTP、HTTPS、www 子域自动覆盖），**无需手工配置域名**；其它站点一律 403 `CORS_FORBIDDEN`。仅按实际到达的 Host 推导，不反射任意 Origin。
- 确有跨域接入时，在 `.env` 的 `CORS_ORIGINS` 用逗号分隔列出额外来源；该配置与同源来源取**并集**，不会把本站自己挡掉。
- 带 `Origin` 的 `OPTIONS` 预检：同源返回 204 + 允许方法；非白名单返回 403。
- 响应带 `X-Content-Type-Options`、`X-Frame-Options: DENY`、`Referrer-Policy`、`Permissions-Policy`、CSP。
- 日志为结构化 JSON，自动脱敏 `password` / `token` / `authorization` / `secret` 等字段，且不记录请求体。
- 生产环境（`NODE_ENV=production`）不返回内部错误详情与堆栈。

## 7. 安全边界

涉及学员伤病、疼痛、心血管风险、青少年与常青负荷时，系统仅输出「先经医生或专业人员评估」提示与退阶建议；**不做医疗诊断、不开具康复处方**。考核阈值未校准时，晋级判定一律返回「无法判定」，不编造标准值。

---

## v4.1 新增状态字段（`PUT/GET /api/v1/state`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `state.params` | object | 训练参数覆盖表（键见前端 `PARAMS`），写入 `settings` 表；缺省用教学建议默认值 |
| `students[].pkLevel` | number 0-5 | A 匹克球专项水平 |
| `students[].racketBase` | number 0-5 | B 其他挥拍类运动基础 |
| `students[].techScore` | number 0-5 | 由 A × B 矩阵综合评定的入班技术分 |
| `students[].fitScore` | number 0-5 | 入班体能分 |
| `students[].goal` | string | 技术晋级 / 兴趣体验 / 减脂塑形 / 比赛备战 / 专项补强 |

迁移 `002_v41_scoring.sql` 为存量库补 `students.pk_level` / `students.racket_base` 两列；旧快照缺字段时前端按 `techScore→A`、`B=0`、目标「技术晋级」兼容，不白屏。
