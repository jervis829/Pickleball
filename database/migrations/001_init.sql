-- Up: 匹克球教学管理平台 v1 数据库结构 (SQLite)
-- 命名：小写下划线、复数表名、created_at/updated_at/deleted_at、显式外键、参数化查询由仓储层保证

PRAGMA foreign_keys = ON;

-- 系统账号
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'coach' CHECK (role IN ('admin','coach','viewer')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_users_username ON users(username) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);

-- 学员档案
CREATE TABLE IF NOT EXISTS students (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  phone       TEXT,
  age_group   TEXT NOT NULL DEFAULT 'adult' CHECK (age_group IN ('adult','youth','senior','mixed')),
  stage       INTEGER NOT NULL DEFAULT 1 CHECK (stage BETWEEN 1 AND 3),
  size_label  TEXT,
  total       INTEGER DEFAULT 48,
  used        INTEGER DEFAULT 0,
  expire_date TEXT,
  injury_note TEXT,
  tech_score  REAL,
  fit_score   REAL,
  goal        TEXT,
  status      TEXT DEFAULT '在训',
  note        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_students_name ON students(name);
CREATE INDEX IF NOT EXISTS idx_students_stage ON students(stage);
CREATE INDEX IF NOT EXISTS idx_students_deleted ON students(deleted_at);

-- 教学计划（教案）
CREATE TABLE IF NOT EXISTS plans (
  id          TEXT PRIMARY KEY,
  lesson      INTEGER NOT NULL CHECK (lesson BETWEEN 1 AND 48),
  stage       INTEGER NOT NULL DEFAULT 1 CHECK (stage BETWEEN 1 AND 3),
  tech        TEXT,
  minutes     INTEGER DEFAULT 90,
  lesson_date TEXT,
  age_group   TEXT,
  age_name    TEXT,
  class_size  TEXT,
  zones_json  TEXT,
  focus       TEXT,
  content     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_plans_lesson ON plans(lesson);
CREATE INDEX IF NOT EXISTS idx_plans_date ON plans(lesson_date);
CREATE INDEX IF NOT EXISTS idx_plans_deleted ON plans(deleted_at);

-- 计划与学员（多对多，支持多人班选多名学员）
CREATE TABLE IF NOT EXISTS plan_students (
  plan_id    TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  PRIMARY KEY (plan_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_plan_students_student ON plan_students(student_id);

-- 授课记录（教学追踪）
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  student_id  TEXT REFERENCES students(id) ON DELETE SET NULL,
  lesson_date TEXT,
  lesson      INTEGER CHECK (lesson BETWEEN 1 AND 48),
  minutes     INTEGER,
  attend      TEXT,
  judge       TEXT,
  rpe         INTEGER CHECK (rpe IS NULL OR (rpe BETWEEN 1 AND 10)),
  note        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_student_id ON sessions(student_id);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(lesson_date);
CREATE INDEX IF NOT EXISTS idx_sessions_deleted ON sessions(deleted_at);

-- 量化考核记录
CREATE TABLE IF NOT EXISTS assessments (
  id          TEXT PRIMARY KEY,
  student_id  TEXT REFERENCES students(id) ON DELETE SET NULL,
  stage       INTEGER NOT NULL DEFAULT 1 CHECK (stage BETWEEN 1 AND 3),
  lesson_date TEXT,
  vals_json   TEXT,
  total       REAL,
  conclusion  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_assessments_student_id ON assessments(student_id);
CREATE INDEX IF NOT EXISTS idx_assessments_deleted ON assessments(deleted_at);

-- 键值对配置：考核阈值 / 默认假设 / 界面偏好
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 课程体系：24 教学单元 × 2 课次 = 48 课次（版本化数据源）
CREATE TABLE IF NOT EXISTS curriculum_units (
  unit_no    INTEGER PRIMARY KEY CHECK (unit_no BETWEEN 1 AND 24),
  stage      INTEGER NOT NULL CHECK (stage BETWEEN 1 AND 3),
  tech       TEXT NOT NULL,
  focus_a    TEXT, focus_b TEXT,
  fit        TEXT, foot TEXT, org TEXT, play TEXT,
  hw         TEXT, err TEXT, fix TEXT, kp TEXT, drill TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_curriculum_stage ON curriculum_units(stage);

-- 操作审计（不记录请求体，避免敏感数据落盘）
CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT,
  method     TEXT,
  path       TEXT,
  status     INTEGER,
  detail     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);

-- 聚合 state 版本号：多端并发写入的乐观锁
CREATE TABLE IF NOT EXISTS state_meta (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  revision  INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO state_meta (id, revision, updated_at) VALUES (1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Down（供回滚工具使用；SQLite 不支持脚本内注释式 Down，保留语句供人工执行）
-- DROP TABLE IF EXISTS state_meta;
-- DROP TABLE IF EXISTS audit_logs;
-- DROP TABLE IF EXISTS curriculum_units;
-- DROP TABLE IF EXISTS settings;
-- DROP TABLE IF EXISTS assessments;
-- DROP TABLE IF EXISTS sessions;
-- DROP TABLE IF EXISTS plan_students;
-- DROP TABLE IF EXISTS plans;
-- DROP TABLE IF EXISTS students;
-- DROP TABLE IF EXISTS users;
