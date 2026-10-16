/**
 * Knex CLI 配置文件
 *
 * 供 `npm run migrate` 等命令使用(CLI 不认 ESM 里的实例,需要单独导出)。
 */
import 'dotenv/config';

export default {
  client: 'mysql2',
  connection: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number.parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'wechat_server',
    charset: 'utf8mb4',
    timezone: '+08:00',
    dateStrings: ['DATE', 'DATETIME'],
  },
  pool: { min: 0, max: 5 },
  migrations: {
    directory: './migrations',
    tableName: 'knex_migrations',
  },
};
