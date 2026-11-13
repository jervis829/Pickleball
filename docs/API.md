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

列表统一返回 `{ items, total, page, pageSize }`，最大 `pageSize = 200`。

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
