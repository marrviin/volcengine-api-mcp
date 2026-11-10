import { signRequest } from './signer.js';
import {
  VolcengineApiError,
  type VolcengineApiRequest,
  type VolcengineApiResponse,
  type VolcengineCredentials,
} from './types.js';

export interface VolcengineClientOptions {
  credentials: VolcengineCredentials;
  region?: string;
  timeoutMs?: number;
}

/** 常见服务的默认 Host（不在此表中的服务回退为 <service>.<region>.volcengineapi.com） */
export const SERVICE_HOSTS: Record<string, string> = {
  ecs: 'ecs.cn-north-1.volcengineapi.com',
  vpc: 'vpc.cn-north-1.volcengineapi.com',
  iam: 'iam.volcengineapi.com',
  vod: 'vod.volcengineapi.com',
  live: 'live.volcengineapi.com',
  tls: 'tls-cn-beijing.volces.com',
  ces: 'ces.cn-north-1.volcengineapi.com',
};

export class VolcengineClient {
  constructor(private readonly opts: VolcengineClientOptions) {}

  private resolveHost(service: string, host?: string, region?: string): string {
    if (host) return host;
    return SERVICE_HOSTS[service] ?? `${service}.${region ?? this.opts.region ?? 'cn-north-1'}.volcengineapi.com`;
  }

  async request<T = unknown>(req: VolcengineApiRequest): Promise<VolcengineApiResponse<T>> {
    const method = req.method ?? 'GET';
    const region = req.region ?? this.opts.region ?? 'cn-north-1';
    const service = req.service;
    const host = this.resolveHost(service, req.host, region);
    const credentials = this.opts.credentials;

    if (!credentials?.accessKeyId || !credentials?.secretAccessKey) {
      throw new VolcengineApiError(
        '缺少火山引擎 AK/SK，请通过环境变量 VOLCENGINE_ACCESS_KEY / VOLCENGINE_SECRET_KEY 配置',
        0,
        'MissingCredentials',
        undefined,
      );
    }

    const bodyStr =
      method === 'POST' || method === 'PUT'
        ? req.params
          ? JSON.stringify(req.params)
          : ''
        : '';

    const query =
      method === 'POST' || method === 'PUT'
        ? { Action: req.action, Version: req.version }
        : {
            Action: req.action,
            Version: req.version,
            ...flattenParams(req.params ?? {}),
          };

    const headers = {
      Host: host,
      'Content-Type': 'application/json',
      ...(bodyStr ? { 'Content-Length': String(Buffer.byteLength(bodyStr)) } : {}),
      ...(req.headers ?? {}),
    };

    const signed = signRequest({
      method,
      path: '/',
      query,
      headers,
      body: bodyStr,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      region,
      service,
    });

    const url = `https://${host}/?${new URLSearchParams(query)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 30_000);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { ...headers, ...signed },
        body: bodyStr || undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = text;
    }

    if (!res.ok) {
      const errObj = (parsed ?? {}) as Record<string, any>;
      const data = errObj.ResponseMetadata ?? errObj;
      throw new VolcengineApiError(
        `${req.action} 调用失败: ${data?.Error?.Message ?? data?.Message ?? res.statusText}`,
        res.status,
        data?.Error?.Code ?? data?.Code,
        data?.RequestId,
        parsed,
      );
    }

    return { status: res.status, headers: resHeaders, body: parsed as T };
  }
}

/**
 * 把嵌套参数展开成火山 API 需要的扁平 query（如 List.1.Name=a&List.1.Id=b）。
 */
export function flattenParams(params: Record<string, unknown>, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      Object.assign(result, flattenParams(Object.fromEntries(value.map((v, i) => [String(i + 1), v])), fullKey));
    } else if (typeof value === 'object') {
      Object.assign(result, flattenParams(value as Record<string, unknown>, fullKey));
    } else {
      result[fullKey] = String(value);
    }
  }
  return result;
}
