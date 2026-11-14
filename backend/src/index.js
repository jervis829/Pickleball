'use strict';
const config = require('./config');
const { migrate } = require('./db/migrate');
const { ensureAdmin } = require('./services/auth');
const { seed } = require('../../database/seeds/seed');
const { createServer } = require('./server');
const logger = require('./utils/logger');

try {
  const mig = migrate();
  const admin = ensureAdmin();
  const seeded = seed({ skipMigrate: true, skipAdmin: true });
  logger.info('bootstrap.migrate', { applied: mig.applied, curriculum_units: seeded.units, admin_created: Boolean(admin) });

  const server = createServer();
  server.listen(config.port, config.host, () => {
    console.log('\n  匹克球教学管理平台 · 已启动');
    console.log(`  访问地址   http://${config.host}:${config.port}`);
    console.log(`  数据库     ${config.dbFile}`);
    console.log(`  课程体系   ${seeded.units} 个教学单元 / ${seeded.units * 2} 课次`);
    console.log(`  管理员     ${config.adminUser}`);
    if (config.generatedPassword) {
      console.log('  首次密码   已随机生成，见 data/initial-admin.txt（登录后请立即修改并删除该文件）');
    }
    console.log('  停止服务   Ctrl+C\n');
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (err) {
  logger.error('bootstrap.failed', { message: err.message });
  console.error('启动失败：', err.message);
  process.exit(1);
}
