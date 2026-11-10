export interface VolcengineCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface VolcengineApiRequest {
  /** 请求方法，默认 GET */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** API Action，如 DescribeInstances */
  action: string;
  /** API Version，如 2020-04-01 */
  version: string;
  /** 服务名（签名用），如 ecs / vpc / iam / vod */
  service: string;
  /** 服务 Host，如 ecs.cn-north-1.volcengineapi.com；缺省时由客户端按 service/region 推导 */
  host?: string;
  /** 区域，默认 cn-north-1 */
  region?: string;
  /** 业务参数；GET 时拼接为 query，POST 时作为 JSON body */
  params?: Record<string, unknown>;
  /** 额外 HTTP header（不要带签名相关 header） */
  headers?: Record<string, string>;
}

export interface VolcengineApiResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  body: T;
}

export class VolcengineApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | undefined,
    public readonly requestId: string | undefined,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'VolcengineApiError';
  }
}
