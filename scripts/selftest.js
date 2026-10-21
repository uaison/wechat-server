/**
 * 自测脚本:验证加密与微信消息加解密逻辑
 * 用法: node scripts/selftest.js
 *
 * 不依赖数据库,纯逻辑验证。
 */
process.env.ENCRYPT_KEY = process.env.ENCRYPT_KEY || '0000000000000000000000000000000000000000000000000000000000000001';

const { encrypt, decrypt, isEncrypted } = await import('../src/utils/crypto.js');
const { makeSignature, checkSignature, encryptMessage, decryptMessage } =
  await import('../src/utils/wx-crypto.js');

let passed = 0;
let failed = 0;

function assert(name, cond) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}`);
  }
}

console.log('\n[1] 敏感字段加解密 (AES-256-GCM)');
{
  const plain = 'b1a2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'; // 典型 AppSecret
  const enc = encrypt(plain);
  assert('密文带版本前缀 v1:', isEncrypted(enc));
  assert('密文与明文不同', enc !== plain);
  assert('解密可还原', decrypt(enc) === plain);

  const enc2 = encrypt(plain);
  assert('同一明文两次加密结果不同(随机 IV)', enc !== enc2);
  assert('第二次也能正确解密', decrypt(enc2) === plain);

  assert('null 入参返回 null', encrypt(null) === null);
  assert('空串返回 null', encrypt('') === null);

  // 篡改检测
  const parts = enc.split(':');
  const tamperedData = Buffer.from(parts[3], 'hex');
  tamperedData[0] ^= 0xff;
  const tampered = [parts[0], parts[1], parts[2], tamperedData.toString('hex')].join(':');
  let tamperCaught = false;
  try {
    decrypt(tampered);
  } catch {
    tamperCaught = true;
  }
  assert('篡改密文可被 GCM 校验发现', tamperCaught);

  const unicode = '中文测试-emoji😀-密钥';
  assert('支持中文与 emoji', decrypt(encrypt(unicode)) === unicode);
}

console.log('\n[2] 微信签名校验 (SHA1)');
{
  const token = 'myToken123';
  const timestamp = '1700000000';
  const nonce = 'abc123';

  const sig = makeSignature(token, timestamp, nonce);
  assert('签名为 40 位 hex', /^[0-9a-f]{40}$/.test(sig));
  assert('正确签名校验通过', checkSignature(token, timestamp, nonce, sig));
  assert('错误签名校验不通过', !checkSignature(token, timestamp, nonce, 'f'.repeat(40)));
  assert('参数变化则签名变化', makeSignature(token, '1700000001', nonce) !== sig);

  // 一致性:与官方文档示例算法对照(字典序排序后拼接)
  const t2 = 'timestamp', n2 = 'nonce', tok2 = 'token';
  const arr = [tok2, t2, n2].sort().join('');
  const crypto = await import('node:crypto');
  const expected = crypto.createHash('sha1').update(arr).digest('hex');
  assert('与手工实现的排序拼接结果一致', makeSignature(tok2, t2, n2) === expected);
}

console.log('\n[3] 微信消息加解密 (AES-256-CBC)');
{
  const encodingAesKey = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'; // 43 位
  const appid = 'wx1234567890abcdef';
  const xml = `<xml><ToUserName><![CDATA[gh_xxx]]></ToUserName><FromUserName><![CDATA[o_user]]></FromUserName><Content><![CDATA[你好]]></Content></xml>`;

  const encrypted = encryptMessage(xml, encodingAesKey, appid);
  assert('加密结果为 Base64 非空串', typeof encrypted === 'string' && encrypted.length > 0);

  const { message, appid: gotAppid } = decryptMessage(encrypted, encodingAesKey, appid);
  assert('解密还原明文 XML', message === xml);
  assert('解密还原 appid', gotAppid === appid);

  // appid 不匹配应报错(防串号)
  let mismatchCaught = false;
  try {
    decryptMessage(encrypted, encodingAesKey, 'wx_wrong_appid');
  } catch {
    mismatchCaught = true;
  }
  assert('appid 不匹配时拒绝解密', mismatchCaught);

  // 长文本(涉及多轮 PKCS7 填充)
  const longXml = `<xml><Content><![CDATA[${'测试'.repeat(200)}]]></Content></xml>`;
  const encLong = encryptMessage(longXml, encodingAesKey, appid);
  assert('长文本加密解密一致', decryptMessage(encLong, encodingAesKey, appid).message === longXml);

  // 非法 AESKey
  let keyErrCaught = false;
  try {
    encryptMessage(xml, 'tooShort', appid);
  } catch {
    keyErrCaught = true;
  }
  assert('非法 EncodingAESKey 长度时报错', keyErrCaught);
}

console.log('\n[4] 原始体签名(模拟回调验签)');
{
  const token = 'callbackToken';
  const timestamp = '1700000123';
  const nonce = 'nonceval';
  // 模拟微信推送的原始 XML(含换行与空格)
  const rawBody = '<?xml version="1.0"?>\n<xml>\n  <Encrypt><![CDATA[abc123]]></Encrypt>\n</xml>';
  const encryptField = rawBody.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/s)[1];
  const msgSig = makeSignature(token, timestamp, nonce, encryptField);
  assert('密文模式签名可校验', checkSignature(token, timestamp, nonce, msgSig, encryptField));
  assert('提取 Encrypt 字段正确', encryptField === 'abc123');
}

console.log('\n' + '='.repeat(46));
console.log(`测试结果: 通过 ${passed} 项, 失败 ${failed} 项`);
console.log('='.repeat(46) + '\n');

process.exit(failed === 0 ? 0 : 1);
