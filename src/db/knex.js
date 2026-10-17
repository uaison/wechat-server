/**
 * Knex 数据库连接实例
 *
 * 单例导出,全项目复用同一个连接池。
 *
 * 测试支持:设置 DB_CLIENT=sqlite 可切换到 sqlite(better-sqlite3),
 * 供集成测试在无 MySQL 环境下运行;生产环境不设置即走 MySQL。
 */
import knexFactory from 'knex';
import { config } from '../config/index.js';

const useSqlite = process.env.DB_CLIENT === 'sqlite';

const baseConfig = useSqlite
  ? {
      client: 'better-sqlite3',
      connection: { filename: process.env.DB_FILE || ':memory:' },
      useNullAsDefault: true,
    }
  : {
      client: 'mysql2',
      connection: {
        host: config.db.host,
        port: config.db.port,
        user: config.db.user,
        password: config.db.password,
        database: config.db.database,
        charset: 'utf8mb4',
        // 微信昵称等可能含 emoji,必须 utf8mb4
        timezone: '+08:00',
        dateStrings: ['DATE', 'DATETIME'],
      },
    };

export const knex = knexFactory({
  ...baseConfig,
  pool: { min: config.db.poolMin, max: config.db.poolMax },
  migrations: {
    directory: config.migrationsDir,
    tableName: 'knex_migrations',
  },
});
