/**
 * 生成加密密钥
 *
 * 用法: npm run keygen
 * 输出 64 位十六进制字符串,写入 .env 的 ENCRYPT_KEY。
 */
import crypto from 'node:crypto';

const key = crypto.randomBytes(32).toString('hex');

console.log('\n已生成 32 字节加密密钥(ENCRYPT_KEY):\n');
console.log(`ENCRYPT_KEY=${key}\n`);
console.log('请将上面这行写入项目根目录的 .env 文件。');
console.log('⚠️  此密钥一旦丢失,已加密的数据将永久无法解密,请妥善备份。\n');
