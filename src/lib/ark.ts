import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const API_URL = 'https://ark.cn-beijing.volces.com/api/plan/v3/images/generations';
const DOWNLOAD_TIMEOUT_MS = 120_000;
const GENERATE_TIMEOUT_MS = 180_000;
const MAX_REDIRECT_HOPS = 5;

export const ARK_DEFAULT_IMAGE_MODEL = 'doubao-seedream-5-0-pro-260628'; // 5.0 pro，文字渲染与细节明显优于 flash
export const ARK_DEFAULT_SIZE = '1728x2304'; // 2K @ 3:4，与豆包 App 参考图原生分辨率一致

export interface ArkImageOptions {
  apiKey: string;
  prompt: string;
  model?: string;
  /** 宽x高（如 1728x2304）或 1K/2K/4K */
  size?: string;
  /** 默认不加水印 */
  watermark?: boolean;
  seed?: number;
  /** png / jpeg */
  outputFormat?: string;
}

export interface ArkImageResult {
  url: string;
  model: string;
  size: string;
  outputFormat: string;
}

export function validateArkSize(size: string): string {
  if (/^(1K|2K|4K)$/i.test(size)) return size.toUpperCase();
  if (!/^\d{3,4}x\d{3,4}$/.test(size)) {
    throw new Error(`size 参数无效:${size}(应为 宽x高,如 1728x2304,或 1K/2K/4K)`);
  }
  const [w, h] = size.split('x').map(Number);
  if (w < 512 || h < 512 || w > 4096 || h > 4096) {
    throw new Error(`size 超出范围(512~4096):${size}`);
  }
  // 方舟接口要求图片面积 ≥ 921600 px（如 960x960），实测 512x512 会被 400 拒绝
  if (w * h < 921_600) {
    throw new Error(`size 面积过小(${w}x${h}=${w * h}px)，要求至少 921600px（如 960x960 / 1024x1024）`);
  }
  return size;
}

/** 调火山方舟（Agent Plan）生图接口，返回图片 URL。 */
export async function arkGenerateImage(opts: ArkImageOptions): Promise<ArkImageResult> {
  if (!opts.apiKey?.trim()) {
    throw new Error('未找到有效的方舟 API Key(ark- 开头)。请配置环境变量 ARK_API_KEY 或 ANTHROPIC_AUTH_TOKEN');
  }
  if (!opts.prompt?.trim()) {
    throw new Error('缺少 prompt');
  }

  const model = opts.model || ARK_DEFAULT_IMAGE_MODEL;
  const size = validateArkSize(opts.size || ARK_DEFAULT_SIZE);

  const body: Record<string, unknown> = {
    model,
    prompt: opts.prompt,
    size,
    watermark: opts.watermark === true, // 默认不加水印
    response_format: 'url',
    output_format: opts.outputFormat || 'png', // pro 支持 png/jpeg
  };
  if (opts.seed !== undefined) body.seed = opts.seed;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
  });

  const payload = (await res.json().catch(() => null)) as Record<string, any> | null;
  if (!res.ok || !payload) {
    throw new Error(`生图接口返回 ${res.status}:${JSON.stringify(payload ?? '响应不是 JSON')}`);
  }
  if (payload.error) {
    throw new Error(`生图接口报错:${JSON.stringify(payload.error)}`);
  }
  const item = payload.data?.[0];
  if (!item?.url) {
    throw new Error(`响应中没有图片 URL:${JSON.stringify(payload).slice(0, 500)}`);
  }

  return {
    url: item.url,
    model: payload.model ?? model,
    size: item.size ?? size,
    outputFormat: item.output_format ?? body.output_format,
  };
}

/** 下载图片并落盘。仅接受 https，重定向逐次校验，最多 5 跳。 */
export async function arkDownloadImage(url: string, output: string): Promise<{ path: string; bytes: number }> {
  let current = url;
  let buf: Buffer | undefined;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    const u = new URL(current);
    if (u.protocol !== 'https:') {
      throw new Error(`拒绝非 https 下载地址:${current.slice(0, 80)}`);
    }
    const dl = await fetch(current, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      redirect: 'manual',
    });
    if (dl.status >= 300 && dl.status < 400) {
      const location = dl.headers.get('location');
      if (!location) throw new Error(`重定向缺少 location(${dl.status})`);
      current = location;
      continue;
    }
    if (!dl.ok) throw new Error(`下载返回 ${dl.status}`);
    buf = Buffer.from(await dl.arrayBuffer());
    break;
  }
  if (!buf || buf.length === 0) throw new Error('下载内容为空');

  const path = resolve(output);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
  const bytes = statSync(path).size;
  if (bytes < 1024) {
    throw new Error(`落盘文件过小(${bytes}B),疑似异常响应`);
  }
  return { path, bytes };
}
