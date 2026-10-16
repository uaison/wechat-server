/**
 * Knex 数据库连接实例
 *
 * 单例导出,全项目复用同一个连接池。
 */
import knexFactory from 'knex';
import { config } from '../config/index.js';

export const knex = knexFactory({
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
  pool: {
    min: config.db.poolMin,
    max: config.db.poolMax,
  },
  migrations: {
    directory: config.migrationsDir,
    tableName: 'knex_migrations',
  },
});
