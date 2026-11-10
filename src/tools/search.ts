import { z } from 'zod';
import { buildWebSearchPayload, webSearchByAkSk, webSearchByApiKey } from '../lib/index.js';

/** 鉴权二选一：搜索 API Key（feedcoopapi 网关）或火山 AK/SK（V4 签名 mercury 网关） */
function resolveSearchAuth(): { mode: 'api-key'; apiKey: string } | { mode: 'ak-sk'; ak: string; sk: string } {
  const apiKey = process.env.ASK_ECHO_SEARCH_INFINITY_API_KEY;
  if (apiKey?.trim()) return { mode: 'api-key', apiKey: apiKey.trim() };
  const ak = process.env.VOLCENGINE_ACCESS_KEY;
  const sk = process.env.VOLCENGINE_SECRET_KEY;
  if (ak?.trim() && sk?.trim()) return { mode: 'ak-sk', ak: ak.trim(), sk: sk.trim() };
  throw new Error('缺少搜索鉴权配置，请设置环境变量 ASK_ECHO_SEARCH_INFINITY_API_KEY，或同时设置 VOLCENGINE_ACCESS_KEY / VOLCENGINE_SECRET_KEY');
}

export const webSearchTool = {
  name: 'askecho_web_search',
  description:
    '火山引擎联网搜索（豆包搜索，服务 volc_torchlight_api，Action WebSearch）。支持网页与图片搜索，可按时间/站点/行业过滤、返回正文。' +
    '鉴权二选一：ASK_ECHO_SEARCH_INFINITY_API_KEY 或 VOLCENGINE_ACCESS_KEY + VOLCENGINE_SECRET_KEY。',
  inputSchema: {
    query: z.string().min(1).max(100).describe('搜索 query，1~100 个字符'),
    count: z.number().int().optional().describe('返回条数，web 默认 10（最多 50），image 默认 5（最多 5）'),
    search_type: z.enum(['web', 'image']).optional().describe('搜索类型，默认 web'),
    time_range: z.string().optional().describe('时间范围，OneDay/OneWeek/OneMonth/OneYear 或 YYYY-MM-DD..YYYY-MM-DD，仅 web'),
    auth_level: z.union([z.literal(0), z.literal(1)]).optional().describe('权威等级过滤，1 = 非常权威，仅 web'),
    need_content: z.boolean().optional().describe('是否返回网页正文，仅 web'),
    need_url: z.boolean().optional().describe('是否返回网页 URL，仅 web'),
    sites: z.array(z.string()).optional().describe('仅搜索指定站点，最多 20 个，仅 web'),
    block_hosts: z.array(z.string()).optional().describe('排除指定站点，最多 5 个，仅 web'),
    industry: z.enum(['finance', 'game', 'gov']).optional().describe('行业搜索，仅 web'),
    query_rewrite: z.boolean().optional().describe('是否启用查询改写'),
    content_formats: z.enum(['text', 'markdown']).optional().describe('网页正文格式，仅 web'),
  },
  handler: async (args: {
    query: string;
    count?: number;
    search_type?: 'web' | 'image';
    time_range?: string;
    auth_level?: 0 | 1;
    need_content?: boolean;
    need_url?: boolean;
    sites?: string[];
    block_hosts?: string[];
    industry?: 'finance' | 'game' | 'gov';
    query_rewrite?: boolean;
    content_formats?: 'text' | 'markdown';
  }) => {
    const payload = buildWebSearchPayload({
      query: args.query,
      count: args.count,
      searchType: args.search_type,
      timeRange: args.time_range,
      authLevel: args.auth_level,
      needContent: args.need_content,
      needUrl: args.need_url,
      sites: args.sites,
      blockHosts: args.block_hosts,
      industry: args.industry,
      queryRewrite: args.query_rewrite,
      contentFormats: args.content_formats,
    });

    const auth = resolveSearchAuth();
    const body =
      auth.mode === 'api-key'
        ? await webSearchByApiKey(auth.apiKey, payload)
        : await webSearchByAkSk({ accessKeyId: auth.ak, secretAccessKey: auth.sk }, payload);

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
    };
  },
};
