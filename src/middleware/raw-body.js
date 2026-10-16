/**
 * 原始请求体捕获中间件 ★必须最先注册★
 *
 * 微信验签需要拿「未经解析的原始报文字节」计算 sha1,
 * 一旦 body 被解析器处理过,重新序列化会产生格式差异导致签名不一致。
 *
 * 这里手工收流而不是用 koa-bodyparser:因为我们不需要解析 XML,
 * 自己收集 Buffer 最直接,也避免额外依赖。
 */
export function rawBody() {
  return async (ctx, next) => {
    if (ctx.method === 'POST' || ctx.method === 'PUT') {
      ctx.request.rawBody = await readStream(ctx.req);
    }
    await next();
  };
}

/**
 * 把可读流读成字符串
 * @param {import('node:stream').Readable} stream
 * @returns {Promise<string>}
 */
function readStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}
