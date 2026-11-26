-- P7: 课程包（enrollment）→ 课程大纲（outline）→ 今日课执行（session）→ 课后点评
-- 解决的问题：原先只有「生成一份教案」这一个动作，教案生成后没有归属（哪名学员的哪一节课）、没有状态、没有下一步。
-- 本迁移只新增表与列，不改动既有 48 课次主线，也不改动 plans/sessions 的既有语义。
PRAGMA foreign_keys = ON;

-- 课程包：学员「买了 10 节私教课」这件事本身的记录
CREATE TABLE IF NOT EXISTS enrollments (
  id                 TEXT PRIMARY KEY,
  student_id         TEXT NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  package_type       TEXT NOT NULL DEFAULT 'small'
                       CHECK (package_type IN ('solo','small','large')),
  class_name         TEXT,
  total_lessons      INTEGER NOT NULL CHECK (total_lessons BETWEEN 1 AND 200),
  used_lessons       INTEGER NOT NULL DEFAULT 0,
  lessons_per_week   INTEGER NOT NULL DEFAULT 2 CHECK (lessons_per_week BETWEEN 1 AND 7),
  minutes_per_lesson INTEGER NOT NULL DEFAULT 90 CHECK (minutes_per_lesson BETWEEN 30 AND 180),
  start_date         TEXT NOT NULL,
  expire_date        TEXT,
  goal               TEXT,
  stage              INTEGER NOT NULL DEFAULT 1 CHECK (stage BETWEEN 1 AND 3),
  -- adaptive：某节课未达标时自动插入同单元补强课；fixed：严格按购买课数排满，不插入
  pace_mode          TEXT NOT NULL DEFAULT 'adaptive' CHECK (pace_mode IN ('fixed','adaptive')),
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','completed','paused','cancelled')),
  note               TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_enrollments_student ON enrollments(student_id, status);
CREATE INDEX IF NOT EXISTS idx_enrollments_start ON enrollments(start_date DESC);

-- 课程大纲：一次报名拆成 N 节可执行、可追踪的课
CREATE TABLE IF NOT EXISTS outline_lessons (
  id            TEXT PRIMARY KEY,
  enrollment_id TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,          -- 课程包内第几节（1..N）
  unit_no       INTEGER NOT NULL CHECK (unit_no BETWEEN 1 AND 24),
  lesson_no     INTEGER NOT NULL CHECK (lesson_no BETWEEN 1 AND 48),
  lesson_type   TEXT NOT NULL CHECK (lesson_type IN ('A','B','R')),  -- R = 同单元补强 / 重练
  planned_date  TEXT,
  minutes       INTEGER NOT NULL DEFAULT 90,
  focus         TEXT,
  status        TEXT NOT NULL DEFAULT 'planned'
                  CHECK (status IN ('planned','taught','reviewed','skipped')),
  plan_id       TEXT REFERENCES plans(id) ON DELETE SET NULL,
  session_id    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  pace_json     TEXT,   -- 生成时的难度 / 剂量 / 预计课次 / 退阶链快照
  note          TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (enrollment_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_outline_enrollment ON outline_lessons(enrollment_id, seq);
CREATE INDEX IF NOT EXISTS idx_outline_date ON outline_lessons(planned_date, status);
CREATE INDEX IF NOT EXISTS idx_outline_session ON outline_lessons(session_id);

-- 授课记录扩展：执行状态、点评状态、3 要点达成、作业与下节重点、大纲关联
ALTER TABLE sessions ADD COLUMN enrollment_id     TEXT REFERENCES enrollments(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN outline_lesson_id TEXT;
ALTER TABLE sessions ADD COLUMN review_status     TEXT NOT NULL DEFAULT 'none';
ALTER TABLE sessions ADD COLUMN reviewed_at       TEXT;
ALTER TABLE sessions ADD COLUMN judge_vals_json   TEXT;
ALTER TABLE sessions ADD COLUMN homework          TEXT;
ALTER TABLE sessions ADD COLUMN next_focus        TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_outline ON sessions(outline_lesson_id);
CREATE INDEX IF NOT EXISTS idx_sessions_review ON sessions(review_status, lesson_date);

-- Down（人工执行）：
-- ALTER TABLE sessions DROP COLUMN next_focus; ... DROP TABLE outline_lessons; DROP TABLE enrollments;
