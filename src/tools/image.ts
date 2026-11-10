import { z } from 'zod';
import {
  ARK_DEFAULT_IMAGE_MODEL,
  ARK_DEFAULT_SIZE,
  arkDownloadImage,
  arkGenerateImage,
} from '../lib/index.js';

const ARK_DEFAULT_MODEL_HINT = ARK_DEFAULT_IMAGE_MODEL;

/** 方舟密钥必须显式配置 ARK_API_KEY；ANTHROPIC_* 等环境变量不一定是火山的，不做回退 */
export function resolveArkApiKey(): string {
  const key = process.env.ARK_API_KEY;
  if (!key?.trim() || !/^ark-[A-Za-z0-9-]+$/.test(key.trim())) {
    throw new Error('缺少有效的方舟 API Key(ark- 开头)，请配置环境变量 ARK_API_KEY');
  }
  return key.trim();
}

/** 输出格式跟随落盘扩展名（.png→png、.jpg/.jpeg→jpeg），未识别时默认 png；可用 format 参数覆盖 */
function deriveFormat(outputPath: string, format?: 'png' | 'jpeg'): string {
  if (format) return format;
  const ext = (outputPath.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  return ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : 'png';
}

export const generateImageTool = {
  name: 'plan_images_generations',
  description:
    '火山方舟图片生成（端点 /api/plan/v3/images/generations，Seedream 文生图）。输入 prompt 与保存路径，生成图片并落盘，同时把图片直接返回给 Agent 查看。' +
    `默认模型 ${ARK_DEFAULT_MODEL_HINT}，默认尺寸 ${ARK_DEFAULT_SIZE}（宽x高，或 1K/2K/4K）。`,
  inputSchema: {
    prompt: z.string().min(1).describe('生图提示词。图上要出现的文字用「」原样写进 prompt'),
    output_path: z.string().min(1).describe('图片保存的绝对路径（.png 或 .jpg，格式跟随扩展名）'),
    model: z.string().optional().describe(`模型 ID，默认 ${ARK_DEFAULT_MODEL_HINT}`),
    size: z.string().optional().describe('图片尺寸，宽x高如 2048x1152，或 1K/2K/4K，默认 1728x2304'),
    watermark: z.boolean().optional().describe('是否加水印，默认 false'),
    seed: z.number().int().optional().describe('随机种子，固定 seed 可复现同一张图'),
    format: z.enum(['png', 'jpeg']).optional().describe('覆盖输出格式（默认跟随 output_path 扩展名）'),
  },
  handler: async (args: {
    prompt: string;
    output_path: string;
    model?: string;
    size?: string;
    watermark?: boolean;
    seed?: number;
    format?: 'png' | 'jpeg';
  }) => {
    const apiKey = resolveArkApiKey();
    const outputFormat = deriveFormat(args.output_path, args.format);

    const result = await arkGenerateImage({
      apiKey,
      prompt: args.prompt,
      model: args.model,
      size: args.size,
      watermark: args.watermark,
      seed: args.seed,
      outputFormat,
    });
    const { path, bytes } = await arkDownloadImage(result.url, args.output_path);

    const mimeType = result.outputFormat === 'jpeg' ? 'image/jpeg' : 'image/png';
    const base64 = (await import('node:fs')).readFileSync(path).toString('base64');

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { ok: true, model: result.model, output: path, size: result.size, format: result.outputFormat, bytes },
            null,
            2,
          ),
        },
        { type: 'image' as const, data: base64, mimeType },
      ],
    };
  },
};
