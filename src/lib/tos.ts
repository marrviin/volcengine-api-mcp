/**
 * 火山引擎 TOS 上传：putObject + 预签名下载 URL（bucket 保持私有）。
 * 凭据来自 VOLC_TOS_* 环境变量。
 */
import fs from 'node:fs';
import path from 'node:path';
import { TosClient } from '@volcengine/tos-sdk';

/** 按扩展名映射 Content-Type（覆盖常见音视频/图片/文档类型） */
export const CONTENT_TYPES: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  spx: 'audio/ogg',
  amr: 'audio/amr',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  json: 'application/json',
  zip: 'application/zip',
};

export const TOS_ENV_NAMES: Record<string, string> = {
  accessKeyId: 'VOLC_TOS_ACCESS_KEY',
  accessKeySecret: 'VOLC_TOS_SECRET_KEY',
  bucket: 'VOLC_TOS_BUCKET',
  region: 'VOLC_TOS_REGION',
  endpoint: 'VOLC_TOS_ENDPOINT',
};

export interface TosOptions {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  region: string;
  endpoint?: string;
}

export interface TosResolveInput extends Partial<TosOptions> {
  prefix?: string;
}

/** 读取 VOLC_TOS_* 环境变量（可被显式参数覆盖）；配置不全时抛出缺失变量清单 */
export function resolveTosOptions(overrides?: TosResolveInput): TosOptions & { prefix: string } {
  const resolved = {
    accessKeyId: overrides?.accessKeyId ?? process.env.VOLC_TOS_ACCESS_KEY,
    accessKeySecret: overrides?.accessKeySecret ?? process.env.VOLC_TOS_SECRET_KEY,
    bucket: overrides?.bucket ?? process.env.VOLC_TOS_BUCKET,
    region: overrides?.region ?? process.env.VOLC_TOS_REGION,
    endpoint: overrides?.endpoint ?? process.env.VOLC_TOS_ENDPOINT,
  };
  const missing = (['accessKeyId', 'accessKeySecret', 'bucket', 'region'] as const)
    .filter((k) => !resolved[k])
    .map((k) => TOS_ENV_NAMES[k]);
  if (missing.length > 0) {
    throw new Error(`缺少 TOS 配置，请设置环境变量：${missing.join(', ')}`);
  }
  return {
    accessKeyId: resolved.accessKeyId!,
    accessKeySecret: resolved.accessKeySecret!,
    bucket: resolved.bucket!,
    region: resolved.region!,
    endpoint: resolved.endpoint,
    prefix: overrides?.prefix ?? process.env.VOLC_TOS_PREFIX ?? 'volcengine-api-mcp',
  };
}

/** Object key：<prefix>/<date>/<basename>（空格转连字符） */
export function buildObjectKey(prefix: string, date: string, filePath: string): string {
  const base = path.basename(filePath).replace(/\s+/g, '-');
  return `${prefix}/${date}/${base}`;
}

/**
 * 上传本地文件到 TOS 并返回预签名下载 URL。
 * expires 默认 24h（86400s）；contentType 不传时按扩展名推导。
 */
export async function uploadToTos(
  opts: TosOptions,
  filePath: string,
  key: string,
  expires = 86_400,
  contentType?: string,
): Promise<{ url: string; key: string; bytes: number; bucket: string }> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`本地文件不存在：${filePath}`);
  }
  const size = fs.statSync(filePath).size;
  const client = new TosClient({
    accessKeyId: opts.accessKeyId,
    accessKeySecret: opts.accessKeySecret,
    region: opts.region,
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
  });
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
  await client.putObject({
    bucket: opts.bucket,
    key,
    body: fs.createReadStream(filePath),
    contentLength: size,
    contentType: contentType ?? CONTENT_TYPES[ext] ?? 'application/octet-stream',
  });
  const url: string = client.getPreSignedUrl({ bucket: opts.bucket, key, method: 'GET', expires });
  return { url, key, bytes: size, bucket: opts.bucket };
}
