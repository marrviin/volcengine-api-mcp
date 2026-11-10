import { z } from 'zod';
import {
  buildObjectKey,
  detectFormat,
  renderTranscriptMd,
  resolveTosOptions,
  transcribeAudio,
  uploadToTos,
  type AsrModelVersion,
} from '../lib/index.js';

export const asrTranscribeTool = {
  name: 'auc_bigmodel_transcribe',
  description:
    '火山引擎语音技术-大模型录音文件识别（端点 openspeech.bytedance.com/api/v3/auc/bigmodel/submit + query）。' +
    '提交音频并轮询直到完成，返回全文、分句时间戳与说话人。音频源二选一：url（公网可访问）或 file_path（本地文件，自动上传 TOS 换取预签名地址，需 VOLC_TOS_* 配置）。需要环境变量 VOLC_ASR_API_KEY。',
  inputSchema: {
    url: z.string().optional().describe('音频公网 URL（与 file_path 二选一）'),
    file_path: z.string().optional().describe('本地音频文件路径（与 url 二选一；自动上传 TOS 生成预签名 URL）'),
    format: z
      .string()
      .optional()
      .describe('音频格式（wav/mp3/ogg/spx/amr/aac/m4a）；不传时从 url/file_path 扩展名推断'),
    language: z.string().optional().describe('语言，如 zh / en；不传自动检测'),
    model: z.enum(['2.0', '1.0']).optional().describe('模型版本，默认 2.0（1.0 为旧版）'),
    enable_speaker_info: z.boolean().optional().describe('是否区分说话人（说话人分离）'),
    enable_punc: z.boolean().optional().describe('是否加标点'),
    enable_itn: z.boolean().optional().describe('是否做数字规整（ITN）'),
    ssd_version: z.enum(['200', '300']).optional().describe('说话人分离模型：200 非会议(≤5人) / 300 长会议声纹'),
    timeout_seconds: z.number().int().positive().optional().describe('轮询超时（秒），默认 600'),
  },
  handler: async (args: {
    url?: string;
    file_path?: string;
    format?: string;
    language?: string;
    model?: '2.0' | '1.0';
    enable_speaker_info?: boolean;
    enable_punc?: boolean;
    enable_itn?: boolean;
    ssd_version?: '200' | '300';
    timeout_seconds?: number;
  }) => {
    if (!args.url && !args.file_path) {
      throw new Error('url 与 file_path 至少提供一个');
    }

    let audioUrl = args.url;
    let source = audioUrl ?? args.file_path!;
    if (args.file_path) {
      const tos = resolveTosOptions({ prefix: 'asr' });
      const key = buildObjectKey(tos.prefix, new Date().toISOString().slice(0, 10), args.file_path);
      const uploaded = await uploadToTos(tos, args.file_path, key);
      audioUrl = uploaded.url;
      source = args.file_path;
    }

    const format = args.format ?? detectFormat(source);
    if (!format) {
      throw new Error('无法从扩展名推断音频格式，请显式传 format（wav/mp3/ogg/spx/amr/aac/m4a）');
    }
    const apiKey = process.env.VOLC_ASR_API_KEY;
    if (!apiKey?.trim()) {
      throw new Error('缺少环境变量 VOLC_ASR_API_KEY（火山语音控制台的 X-Api-Key）');
    }

    const result = await transcribeAudio({
      apiKey: apiKey.trim(),
      url: audioUrl!,
      format,
      language: args.language,
      model: args.model as AsrModelVersion | undefined,
      enableSpeakerInfo: args.enable_speaker_info,
      enablePunc: args.enable_punc,
      enableItn: args.enable_itn,
      ssdVersion: args.ssd_version,
      timeoutMs: args.timeout_seconds ? args.timeout_seconds * 1000 : undefined,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              ok: true,
              task_id: result.taskId,
              audio_url: audioUrl,
              format,
              text: result.text,
              utterances_count: result.utterances.length,
            },
            null,
            2,
          ),
        },
        {
          type: 'text' as const,
          text: renderTranscriptMd(result.utterances),
        },
      ],
    };
  },
};
