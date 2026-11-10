/**
 * 火山引擎联网搜索（豆包搜索 / WebSearch）。
 * 移植自 mcp-server/server/mcp_server_askecho_search_infinity（Python）。
 * 两条调用路径：
 * - API Key 模式: POST https://open.feedcoopapi.com/search_api/web_search（Bearer）
 * - AK/SK 模式:  POST https://mercury.volcengineapi.com/?Action=WebSearch&Version=2025-01-01（V4 签名）
 */

import { VolcengineClient } from './client.js';
import type { VolcengineCredentials } from './types.js';

/** API Key 模式网关 */
export const SEARCH_API_HOST = 'open.feedcoopapi.com';
/** AK/SK 模式（火山 mercury 网关） */
export const SEARCH_V4_HOST = 'mercury.volcengineapi.com';
export const SEARCH_V4_SERVICE = 'volc_torchlight_api';
export const SEARCH_V4_VERSION = '2025-01-01';
export const SEARCH_V4_REGION = 'cn-beijing';

const TIME_RANGE_SHORTCUTS = new Set(['OneDay', 'OneWeek', 'OneMonth', 'OneYear']);
const SUPPORTED_INDUSTRIES = new Set(['finance', 'game', 'gov']);
const SUPPORTED_CONTENT_FORMATS = new Set(['text', 'markdown']);

export interface WebSearchParams {
  query: string;
  count?: number;
  searchType?: 'web' | 'image';
  /** OneDay/OneWeek/OneMonth/OneYear 或 YYYY-MM-DD..YYYY-MM-DD */
  timeRange?: string;
  /** 权威等级过滤，0 默认 / 1 非常权威 */
  authLevel?: 0 | 1;
  needContent?: boolean;
  needUrl?: boolean;
  /** 仅搜索指定站点，最多 20 个 */
  sites?: string[];
  /** 排除指定站点，最多 5 个 */
  blockHosts?: string[];
  /** 行业搜索 finance / game / gov */
  industry?: 'finance' | 'game' | 'gov';
  queryRewrite?: boolean;
  /** 网页正文格式 text / markdown */
  contentFormats?: 'text' | 'markdown';
}

function validateTimeRange(timeRange?: string): string | undefined {
  if (!timeRange) return undefined;
  if (TIME_RANGE_SHORTCUTS.has(timeRange)) return timeRange;
  const match = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(timeRange);
  if (!match) {
    throw new Error('timeRange 需为 OneDay/OneWeek/OneMonth/OneYear，或日期区间 YYYY-MM-DD..YYYY-MM-DD');
  }
  const [startText, endText] = match.slice(1);
  const start = new Date(startText);
  const end = new Date(endText);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('timeRange 中的日期需为有效的 YYYY-MM-DD');
  }
  if (start > end) throw new Error('timeRange 的开始日期不能晚于结束日期');
  return timeRange;
}

function validateHostList(value: string[] | undefined, fieldName: string, maxCount: number): string | undefined {
  if (!value || value.length === 0) return undefined;
  const items = value.map((item) => item.trim()).filter((item) => item.length > 0);
  if (items.length === 0) throw new Error(`${fieldName} 需为非空域名列表`);
  if (items.length > maxCount) throw new Error(`${fieldName} 最多支持 ${maxCount} 个域名`);
  return items.join('|');
}

/** 参数校验并组装请求 payload（结构与官方 WebSearch 接口一致，大写字段名） */
export function buildWebSearchPayload(params: WebSearchParams): Record<string, unknown> {
  const query = (params.query ?? '').trim();
  if (!query) throw new Error('query 不能为空');
  if (query.length > 100) throw new Error('query 长度需为 1~100 个字符');

  const searchType = (params.searchType ?? 'web').toLowerCase() as 'web' | 'image';
  if (searchType !== 'web' && searchType !== 'image') {
    throw new Error('searchType 仅支持 web 或 image');
  }

  const count = params.count ?? (searchType === 'web' ? 10 : 5);
  if (count < 1) throw new Error('count 需大于等于 1');
  const maxCount = searchType === 'web' ? 50 : 5;
  if (count > maxCount) throw new Error(`${searchType} 类型最多返回 ${maxCount} 条`);

  const authLevel = params.authLevel ?? 0;
  if (authLevel !== 0 && authLevel !== 1) throw new Error('authLevel 仅支持 0 或 1');

  const industry = params.industry?.toLowerCase();
  if (industry && !SUPPORTED_INDUSTRIES.has(industry)) {
    throw new Error('industry 仅支持 finance、game 或 gov');
  }
  const contentFormats = params.contentFormats?.toLowerCase() as 'text' | 'markdown' | undefined;
  if (contentFormats && !SUPPORTED_CONTENT_FORMATS.has(contentFormats)) {
    throw new Error('contentFormats 仅支持 text 或 markdown');
  }

  const queryControl =
    params.queryRewrite !== undefined ? { QueryRewrite: params.queryRewrite } : undefined;

  if (searchType === 'image') {
    const webOnly: Array<[string, unknown]> = [
      ['timeRange', params.timeRange],
      ['authLevel', authLevel || undefined],
      ['needContent', params.needContent],
      ['needUrl', params.needUrl],
      ['sites', params.sites?.length ? params.sites : undefined],
      ['blockHosts', params.blockHosts?.length ? params.blockHosts : undefined],
      ['industry', industry],
      ['contentFormats', contentFormats],
    ];
    const unsupported = webOnly.filter(([, v]) => v !== undefined).map(([k]) => k);
    if (unsupported.length > 0) {
      throw new Error(`${unsupported.join(', ')} 仅支持 web 搜索`);
    }
    const payload: Record<string, unknown> = { Query: query, SearchType: searchType, Count: count };
    if (queryControl) payload.QueryControl = queryControl;
    return payload;
  }

  const filter: Record<string, unknown> = {};
  if (authLevel > 0) filter.AuthInfoLevel = authLevel;
  if (params.needContent !== undefined) filter.NeedContent = params.needContent;
  if (params.needUrl !== undefined) filter.NeedUrl = params.needUrl;
  const sites = validateHostList(params.sites, 'sites', 20);
  if (sites) filter.Sites = sites;
  const blockHosts = validateHostList(params.blockHosts, 'blockHosts', 5);
  if (blockHosts) filter.BlockHosts = blockHosts;
  if (industry) filter.Industry = industry;

  const payload: Record<string, unknown> = { Query: query, SearchType: searchType, Count: count };
  if (Object.keys(filter).length > 0) payload.Filter = filter;
  const timeRange = validateTimeRange(params.timeRange);
  if (timeRange) payload.TimeRange = timeRange;
  if (queryControl) payload.QueryControl = queryControl;
  if (contentFormats) payload.ContentFormats = contentFormats;
  return payload;
}

const REQUEST_TIMEOUT_MS = 30_000;

/** API Key 模式：feedcoopapi 网关，Bearer 鉴权 */
export async function webSearchByApiKey(apiKey: string, payload: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`https://${SEARCH_API_HOST}/search_api/web_search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-Traffic-Tag': 'volcengine-api-mcp_web_search',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`搜索接口返回 ${res.status}:${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** AK/SK 模式：mercury 网关，V4 签名（Action=WebSearch） */
export async function webSearchByAkSk(
  credentials: VolcengineCredentials,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const client = new VolcengineClient({
    credentials,
    region: SEARCH_V4_REGION,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  const res = await client.request({
    method: 'POST',
    service: SEARCH_V4_SERVICE,
    action: 'WebSearch',
    version: SEARCH_V4_VERSION,
    host: SEARCH_V4_HOST,
    params: payload,
    headers: { 'X-Traffic-Tag': 'volcengine-api-mcp_web_search' },
  });
  return res.body;
}
