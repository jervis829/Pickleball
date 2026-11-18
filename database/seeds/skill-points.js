'use strict';
const { all, run, transaction } = require('../../backend/src/db/connection');

const RUBRIC = {
  "version": 1,
  "scale": "0-5",
  "anchors": [
    {
      "score": 0,
      "label": "无法完成",
      "description": "在安全、可执行的基础条件下尚不能完成该技术要求；若存在疼痛或安全风险，停止测试并记录原因。"
    },
    {
      "score": 1,
      "label": "需要持续协助",
      "description": "需要教练逐步提示或协助，动作/结果大部分时间未达到本项判据。"
    },
    {
      "score": 2,
      "label": "部分完成",
      "description": "在降低速度、难度或明确提示后能部分达到判据，表现仍不稳定。"
    },
    {
      "score": 3,
      "label": "基本达到",
      "description": "在本课标准练习条件下基本达到判据，仍会出现可识别的偏差。"
    },
    {
      "score": 4,
      "label": "稳定达到",
      "description": "在标准练习条件下稳定达到判据，偶有偏差且能自行调整。"
    },
    {
      "score": 5,
      "label": "灵活运用",
      "description": "能在不同来球、节奏或对抗情境中稳定达到判据，并作出合适运用。"
    }
  ],
  "note": "通用锚点；教练应结合该技术点的具体判据评分。不得把缺评当作0分。"
};

/**
 * Use the curriculum's authored key criteria as the source of truth.
 * Every criterion is mapped to both lesson A (new learning) and B (consolidation).
 */
function seedSkillPoints(units) {
  const now = new Date().toISOString();
  let pointCount = 0;
  transaction(() => {
    for (const unit of units) {
      const unitNo = Number(unit.u);
      const criteria = String(unit.kp || '').split('|').map(x => x.trim()).filter(Boolean);
      const focusA = String(unit.a || '').trim();
      const focusB = String(unit.b || '').trim();
      criteria.forEach((criterion, index) => {
        const skillKey = `u${String(unitNo).padStart(2, '0')}_kp${String(index + 1).padStart(2, '0')}`;
        run(`INSERT INTO skill_definitions
          (skill_key, name, category, description, rubric_json, rubric_version, created_at, updated_at, deleted_at)
          VALUES (?, ?, 'curriculum', ?, ?, 1, ?, ?, NULL)
          ON CONFLICT(skill_key) DO UPDATE SET name=excluded.name, description=excluded.description,
            rubric_json=excluded.rubric_json, rubric_version=1, updated_at=excluded.updated_at, deleted_at=NULL`,
          [skillKey, criterion.slice(0, 120), criterion, JSON.stringify(RUBRIC), now, now]);

        for (const [offset, lessonType, focus] of [[0, 'A', focusA], [1, 'B', focusB]]) {
          const lessonNo = (unitNo - 1) * 2 + offset + 1;
          run(`INSERT INTO lesson_skill_points
            (lesson_no, unit_no, lesson_type, skill_key, focus, criterion, source_field, sort_order, rubric_override_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'kp', ?, NULL, ?, ?)
            ON CONFLICT(lesson_no, skill_key) DO UPDATE SET lesson_type=excluded.lesson_type,
              focus=excluded.focus, criterion=excluded.criterion, sort_order=excluded.sort_order, updated_at=excluded.updated_at`,
            [lessonNo, unitNo, lessonType, skillKey, focus, criterion, index, now, now]);
          pointCount += 1;
        }
      });
    }
  });
  const lessons = all('SELECT COUNT(DISTINCT lesson_no) AS n FROM lesson_skill_points')[0]?.n || 0;
  return { lessons, pointCount };
}

module.exports = { seedSkillPoints, RUBRIC };
