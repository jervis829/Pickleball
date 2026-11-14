-- Up: v4.1 双维入班评分（匹克球专项水平 A / 其他挥拍类迁移基础 B）
-- 幂等性由 schema_migrations 保证；仅在本版本首次应用时执行。
ALTER TABLE students ADD COLUMN pk_level    REAL;
ALTER TABLE students ADD COLUMN racket_base REAL;
