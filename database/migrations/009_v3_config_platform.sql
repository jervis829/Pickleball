-- V3.0 配置驱动课程大纲 + 模块 0-5 评分 + 7 类 0-10 汇总 + 历史快照报告 + 零道具体能 + 班级/私教教学计划（60 分钟标准课时）

ALTER TABLE students ADD COLUMN gender TEXT NOT NULL DEFAULT 'male';
ALTER TABLE students ADD COLUMN birth_year INTEGER;
ALTER TABLE students ADD COLUMN fitness_age_group TEXT NOT NULL DEFAULT 'a18';
ALTER TABLE students ADD COLUMN racket_bg TEXT;

-- 可热更新的课程大纲配置存储（单一配置源，修改后无需改代码）
CREATE TABLE IF NOT EXISTS curriculum_config_store (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  version     TEXT NOT NULL,
  config_json TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 学员各技术模块当前评分（0=不会 / 1=初步建立 / 2=基本掌握 / 3=稳定应用 / 4=实战应用 / 5=灵活运用）
CREATE TABLE IF NOT EXISTS student_module_scores (
  student_id        TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  module_code       TEXT NOT NULL,
  score             INTEGER NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 5),
  practice_count    INTEGER NOT NULL DEFAULT 0,
  last_practiced_at TEXT,
  note              TEXT,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (student_id, module_code)
);
CREATE INDEX IF NOT EXISTS idx_sms_student ON student_module_scores(student_id);

-- 零道具 6 维球场体能测评（爆发力 / 反应 / 移动 / 平衡 / 柔韧 / 耐力，区分性别与年龄段）
CREATE TABLE IF NOT EXISTS student_fitness_reports (
  id                  TEXT PRIMARY KEY,
  student_id          TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  test_date           TEXT NOT NULL,
  gender              TEXT NOT NULL,
  age_group           TEXT NOT NULL,
  raw_json            TEXT NOT NULL,
  dimensions_json     TEXT NOT NULL,
  total_index         REAL,
  weak_dims_json      TEXT NOT NULL,
  training_hints_json TEXT NOT NULL,
  safety_notes_json   TEXT NOT NULL,
  note                TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sfr_student_date ON student_fitness_reports(student_id, test_date DESC, created_at DESC);

-- 学员评分报告历史快照（建档时自动生成 + 每次课后自动生成，不受未来大纲改动影响）
CREATE TABLE IF NOT EXISTS student_report_snapshots (
  id                 TEXT PRIMARY KEY,
  student_id         TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  trigger_type       TEXT NOT NULL CHECK (trigger_type IN ('baseline','lesson_review','fitness_update','manual')),
  plan_id            TEXT,
  plan_lesson_id     TEXT,
  curriculum_version TEXT NOT NULL,
  overall_score      REAL NOT NULL,
  categories_json    TEXT NOT NULL,
  modules_json       TEXT NOT NULL,
  fitness_json       TEXT,
  summary_note       TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_srs_student_created ON student_report_snapshots(student_id, created_at DESC);

-- 教学计划（支持 1v1 私教与 2-6 人小班：全班一套共同计划，课后各自独立打分）
CREATE TABLE IF NOT EXISTS training_plans (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  package_type       TEXT NOT NULL DEFAULT 'solo' CHECK (package_type IN ('solo','small','large')),
  total_lessons      INTEGER NOT NULL CHECK (total_lessons BETWEEN 1 AND 200),
  used_lessons       INTEGER NOT NULL DEFAULT 0,
  default_minutes    INTEGER NOT NULL DEFAULT 60 CHECK (default_minutes BETWEEN 30 AND 180),
  track_mode         TEXT NOT NULL DEFAULT 'basic',
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','paused')),
  curriculum_version TEXT NOT NULL,
  note               TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  deleted_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_tp_status ON training_plans(status, deleted_at);

CREATE TABLE IF NOT EXISTS training_plan_students (
  plan_id      TEXT NOT NULL REFERENCES training_plans(id) ON DELETE CASCADE,
  student_id   TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  used_lessons INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (plan_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_tps_student ON training_plan_students(student_id);

-- 教学计划中的每一节课（未上课次可随时调序/加节/替换/删改；已上完锁定快照）
CREATE TABLE IF NOT EXISTS training_plan_lessons (
  id                         TEXT PRIMARY KEY,
  plan_id                    TEXT NOT NULL REFERENCES training_plans(id) ON DELETE CASCADE,
  seq                        INTEGER NOT NULL,
  module_code                TEXT NOT NULL,
  secondary_module_code      TEXT,
  module_snapshot_json       TEXT NOT NULL,
  planned_date               TEXT,
  minutes                    INTEGER NOT NULL DEFAULT 60,
  is_remedial                INTEGER NOT NULL DEFAULT 0,
  status                     TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','completed','skipped')),
  lesson_plan_snapshot_json  TEXT,
  coach_note                 TEXT,
  completed_at               TEXT,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tpl_plan_seq ON training_plan_lessons(plan_id, seq);
CREATE INDEX IF NOT EXISTS idx_tpl_date_status ON training_plan_lessons(planned_date, status);

-- 课后独立点评记录（一节课对应本班每个学员一条记录；缺席不改分、不扣个人课时）
CREATE TABLE IF NOT EXISTS training_lesson_reviews (
  id                 TEXT PRIMARY KEY,
  plan_lesson_id     TEXT NOT NULL REFERENCES training_plan_lessons(id) ON DELETE CASCADE,
  plan_id            TEXT NOT NULL,
  student_id         TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  attend             TEXT NOT NULL DEFAULT 'present' CHECK (attend IN ('present','absent')),
  module_scores_json TEXT NOT NULL,
  rpe                INTEGER CHECK (rpe IS NULL OR (rpe BETWEEN 1 AND 10)),
  homework           TEXT,
  feedback           TEXT,
  report_snapshot_id TEXT,
  created_at         TEXT NOT NULL,
  UNIQUE(plan_lesson_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_tlr_student ON training_lesson_reviews(student_id);
