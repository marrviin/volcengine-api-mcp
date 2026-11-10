import { z } from 'zod';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  TTS_DEFAULT_RESOURCE_ID,
  TTS_DEFAULT_SAMPLE_RATE,
  TTS_DEFAULT_SPEAKER,
  unidirectionalTts,
  type TtsAudioFormat,
} from '../lib/index.js';

const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  pcm: 'audio/pcm',
  ogg_opus: 'audio/ogg',
  wav: 'audio/wav',
};

function resolveArkApiKey(): string {
  const key = process.env.ARK_API_KEY;
  if (!key?.trim() || !/^ark-[A-Za-z0-9-]+$/.test(key.trim())) {
    throw new Error('缺少有效的方舟 API Key(ark- 开头)，请配置环境变量 ARK_API_KEY');
  }
  return key.trim();
}

export const ttsUnidirectionalTool = {
  name: 'plan_tts_unidirectional',
  description:
    '火山豆包语音合成大模型-单向流式（端点 /api/v3/plan/tts/unidirectional，HTTP Chunked）。输入文本一次性合成音频，落盘并返回给 Agent。' +
    '默认音色 zh_female_vv_uranus_bigtts（豆包 2.0 通用女声），音色 ID 从控制台>音色库获取；复刻音色需 resource_id=seed-icl-2.0 并传 model。' +
    '需要环境变量 ARK_API_KEY。',
  inputSchema: {
    text: z.string().min(1).describe('待合成的文本'),
    output_path: z.string().min(1).describe('音频保存的绝对路径（扩展名与 format 一致，如 .mp3/.wav/.ogg/.pcm）'),
    speaker: z.string().optional().describe(`音色 ID，默认 ${TTS_DEFAULT_SPEAKER}`),
    resource_id: z.string().optional().describe(`模型版本资源，默认 ${TTS_DEFAULT_RESOURCE_ID}；声音复刻用 seed-icl-2.0`),
    model: z.string().optional().describe('复刻音色时需指定，如 seed-tts-2.0-standard'),
    format: z.enum(['mp3', 'pcm', 'ogg_opus', 'wav']).optional().describe('音频格式，默认 mp3'),
    sample_rate: z.number().int().optional().describe(`采样率 Hz，默认 ${TTS_DEFAULT_SAMPLE_RATE}；ogg_opus 仅支持 48000`),
    speech_rate: z.number().int().min(-50).max(100).optional().describe('语速 [-50,100]，100 = 2.0 倍速'),
    loudness_rate: z.number().int().min(-50).max(100).optional().describe('音量 [-50,100]，100 = 2.0 倍音量'),
    enable_subtitle: z.boolean().optional().describe('启用字幕（字级时间戳），仅中英文'),
    explicit_language: z.string().optional().describe('显式朗读语种，如 zh-cn / en / ja，不传自动检测'),
  },
  handler: async (args: {
    text: string;
    output_path: string;
    speaker?: string;
    resource_id?: string;
    model?: string;
    format?: 'mp3' | 'pcm' | 'ogg_opus' | 'wav';
    sample_rate?: number;
    speech_rate?: number;
    loudness_rate?: number;
    enable_subtitle?: boolean;
    explicit_language?: string;
  }) => {
    const result = await unidirectionalTts({
      apiKey: resolveArkApiKey(),
      text: args.text,
      speaker: args.speaker,
      resourceId: args.resource_id,
      model: args.model,
      format: args.format as TtsAudioFormat | undefined,
      sampleRate: args.sample_rate,
      speechRate: args.speech_rate,
      loudnessRate: args.loudness_rate,
      enableSubtitle: args.enable_subtitle,
      explicitLanguage: args.explicit_language,
    });

    const path = resolve(args.output_path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, result.audio);
    const bytes = statSync(path).size;
    if (bytes < 1024) {
      throw new Error(`落盘文件过小(${bytes}B),疑似异常响应`);
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              ok: true,
              output: path,
              format: result.format,
              sample_rate: result.sampleRate,
              bytes,
              text_words: result.usage?.text_words,
              sentence: result.sentence?.text,
            },
            null,
            2,
          ),
        },
        {
          type: 'audio' as const,
          data: result.audio.toString('base64'),
          mimeType: AUDIO_MIME[result.format] ?? 'audio/mpeg',
        },
      ],
    };
  },
};
