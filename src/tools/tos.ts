import { z } from 'zod';
import { buildObjectKey, resolveTosOptions, uploadToTos } from '../lib/index.js';

export const tosPutObjectTool = {
  name: 'tos_object_put',
  description:
    '上传本地文件到火山引擎 TOS（API Action: PutObject，对应工具名 tos_object_put = 服务_资源_动作），bucket 保持私有，返回预签名下载 URL（默认 24h 有效）。' +
    '对象 key 默认为 <prefix>/<YYYY-MM-DD>/<文件名>。需要环境变量 VOLC_TOS_ACCESS_KEY / VOLC_TOS_SECRET_KEY / VOLC_TOS_BUCKET / VOLC_TOS_REGION。',
  inputSchema: {
    file_path: z.string().min(1).describe('要上传的本地文件路径（绝对路径）'),
    key: z.string().optional().describe('完整对象 key；不传则自动生成 <prefix>/<日期>/<文件名>'),
    prefix: z.string().optional().describe('key 前缀，默认取 VOLC_TOS_PREFIX，再默认 volcengine-api-mcp'),
    expires: z.number().int().positive().optional().describe('预签名 URL 有效期（秒），默认 86400（24h）'),
    content_type: z.string().optional().describe('覆盖 Content-Type（默认按扩展名推导，未知类型为 application/octet-stream）'),
    bucket: z.string().optional().describe('覆盖默认 bucket'),
    region: z.string().optional().describe('覆盖默认 region'),
    endpoint: z.string().optional().describe('覆盖默认 endpoint'),
  },
  handler: async (args: {
    file_path: string;
    key?: string;
    prefix?: string;
    expires?: number;
    content_type?: string;
    bucket?: string;
    region?: string;
    endpoint?: string;
  }) => {
    const opts = resolveTosOptions({ bucket: args.bucket, region: args.region, endpoint: args.endpoint, prefix: args.prefix });
    const key = args.key ?? buildObjectKey(opts.prefix, new Date().toISOString().slice(0, 10), args.file_path);

    const result = await uploadToTos(opts, args.file_path, key, args.expires, args.content_type);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              ok: true,
              bucket: result.bucket,
              key: result.key,
              bytes: result.bytes,
              url: result.url,
              url_expires_seconds: args.expires ?? 86_400,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};
