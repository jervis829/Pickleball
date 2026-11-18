-- Up: 课次技术点评分基础结构（不改变原48课次主线）
PRAGMA foreign_keys = ON;

ALTER TABLE sessions ADD COLUMN plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_plan_id ON sessions(plan_id);

CREATE TABLE IF NOT EXISTS skill_definitions (
  skill_key      TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  category       TEXT NOT NULL DEFAULT 'curriculum',
  description    TEXT,
  rubric_json    TEXT NOT NULL,
  rubric_version INTEGER NOT NULL DEFAULT 1 CHECK (rubric_version >= 1),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_skill_definitions_category ON skill_definitions(category);

CREATE TABLE IF NOT EXISTS lesson_skill_points (
  lesson_no          INTEGER NOT NULL CHECK (lesson_no BETWEEN 1 AND 48),
  unit_no            INTEGER NOT NULL CHECK (unit_no BETWEEN 1 AND 24),
  lesson_type        TEXT NOT NULL CHECK (lesson_type IN ('A','B')),
  skill_key          TEXT NOT NULL REFERENCES skill_definitions(skill_key),
  focus              TEXT,
  criterion          TEXT NOT NULL,
  source_field       TEXT NOT NULL DEFAULT 'kp',
  sort_order         INTEGER NOT NULL DEFAULT 0,
  rubric_override_json TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (lesson_no, skill_key)
);
CREATE INDEX IF NOT EXISTS idx_lesson_skill_points_skill ON lesson_skill_points(skill_key);
CREATE INDEX IF NOT EXISTS idx_lesson_skill_points_unit ON lesson_skill_points(unit_no, lesson_type);

CREATE TABLE IF NOT EXISTS plan_skill_points (
  id                   TEXT PRIMARY KEY,
  plan_id              TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  skill_key            TEXT NOT NULL REFERENCES skill_definitions(skill_key),
  lesson_no            INTEGER NOT NULL CHECK (lesson_no BETWEEN 1 AND 48),
  skill_name           TEXT NOT NULL,
  focus                TEXT,
  criterion            TEXT NOT NULL,
  rubric_snapshot_json TEXT NOT NULL,
  rubric_version       INTEGER NOT NULL DEFAULT 1,
  sort_order           INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  UNIQUE (plan_id, skill_key)
);
CREATE INDEX IF NOT EXISTS idx_plan_skill_points_plan ON plan_skill_points(plan_id, sort_order);

CREATE TABLE IF NOT EXISTS session_skill_scores (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  plan_skill_point_id   TEXT NOT NULL REFERENCES plan_skill_points(id),
  score                 INTEGER NOT NULL CHECK (score BETWEEN 0 AND 5),
  attempts              INTEGER CHECK (attempts IS NULL OR attempts >= 0),
  successes             INTEGER CHECK (successes IS NULL OR (successes >= 0 AND attempts IS NOT NULL AND successes <= attempts)),
  coach_note            TEXT,
  rubric_snapshot_json  TEXT NOT NULL,
  assessed_by           TEXT,
  assessed_at           TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  deleted_at            TEXT,
  UNIQUE (session_id, plan_skill_point_id)
);
CREATE INDEX IF NOT EXISTS idx_session_skill_scores_session ON session_skill_scores(session_id);
CREATE INDEX IF NOT EXISTS idx_session_skill_scores_point ON session_skill_scores(plan_skill_point_id);
CREATE INDEX IF NOT EXISTS idx_session_skill_scores_assessed_at ON session_skill_scores(assessed_at);

-- Down（人工回滚参考；SQLite 不支持在同一迁移中自动执行条件回滚）
-- DROP TABLE IF EXISTS session_skill_scores;
-- DROP TABLE IF EXISTS plan_skill_points;
-- DROP TABLE IF EXISTS lesson_skill_points;
-- DROP TABLE IF EXISTS skill_definitions;
-- DROP INDEX IF EXISTS idx_sessions_plan_id;
-- ALTER TABLE sessions DROP COLUMN plan_id;
