import { createHash, createHmac } from 'node:crypto';

const SHA256_HEX = (data: string) => createHash('sha256').update(data).digest('hex');
const HMAC_SHA256_HEX = (key: Buffer | string, data: string) =>
  createHmac('sha256', key).update(data).digest('hex');
const HMAC_SHA256_RAW = (key: Buffer | string, data: string) =>
  createHmac('sha256', key).update(data).digest();

/** RFC3986 编码（火山签名要求，空格编码为 %20 而非 +） */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export interface SignOptions {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** 已序列化的 body（GET 时为空字符串） */
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
}

/**
 * 火山引擎 Signature V4 签名。
 * 返回需要附加到请求的 header（Authorization / X-Date / X-Content-Sha256）。
 */
export function signRequest(opts: SignOptions): Record<string, string> {
  const xDate = opts.headers['X-Date'] ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const date = xDate.slice(0, 10);
  const payloadHash = SHA256_HEX(opts.body);
  const headers: Record<string, string> = {
    ...opts.headers,
    'X-Date': xDate,
    'X-Content-Sha256': payloadHash,
  };

  // 1. Canonical Request
  const sortedHeaders = Object.keys(headers)
    .map((k) => [k.toLowerCase(), String(headers[k]).trim()] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const canonicalHeaders = sortedHeaders.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = sortedHeaders.map(([k]) => k).join(';');

  const canonicalQuery = Object.entries(opts.query)
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [
    opts.method.toUpperCase(),
    opts.path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  // 2. String to Sign
  const credentialScope = `${date}/${opts.region}/${opts.service}/request`;
  const stringToSign = [
    'HMAC-SHA256',
    xDate,
    credentialScope,
    SHA256_HEX(canonicalRequest),
  ].join('\n');

  // 3. Signature
  let signingKey = HMAC_SHA256_RAW(opts.secretAccessKey, date);
  for (const part of [opts.region, opts.service, 'request']) {
    signingKey = HMAC_SHA256_RAW(signingKey, part);
  }
  const signature = HMAC_SHA256_HEX(signingKey, stringToSign);

  const authorization =
    `HMAC-SHA256 Credential=${opts.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { 'X-Date': xDate, 'X-Content-Sha256': payloadHash, Authorization: authorization };
}
