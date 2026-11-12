/**
 * 豆包语音合成大模型 - 单向流式 HTTP 接口（HTTP Chunked）。
 * 文档: https://www.volcengine.com/docs/6561/1327536 （单向流式语音合成 HTTP）
 * - Agent Plan 网关: POST https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional（ark- 密钥）
 * - 语音控制台:     POST https://openspeech.bytedance.com/api/v3/tts/unidirectional（X-Api-Key）
 * 响应为流式 JSON 分片，每片 {code, message, data: base64音频, sentence?, usage?}，拼接 data 直到流结束。
 */

const PLAN_TTS_URL = 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional';
/** 语音控制台密钥使用的官方端点（Agent Plan 之外的接入方式，暂未暴露为工具参数） */
export const CONSOLE_TTS_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';

export const TTS_DEFAULT_SPEAKER = 'zh_male_liufei_uranus_bigtts'; // 流飞，男声
export const TTS_DEFAULT_RESOURCE_ID = 'seed-tts-2.0';
export const TTS_DEFAULT_SAMPLE_RATE = 24_000;

export type TtsAudioFormat = 'mp3' | 'pcm' | 'ogg_opus' | 'wav';

export interface TtsOptions {
  apiKey: string;
  text: string;
  speaker?: string;
  /** 模型版本资源：seed-tts-2.0 / seed-icl-2.0（复刻音色） */
  resourceId?: string;
  /** 复刻音色时需指定，如 seed-tts-2.0-standard */
  model?: string;
  format?: TtsAudioFormat;
  sampleRate?: number;
  /** 语速 [-50, 100]，100 = 2.0 倍速 */
  speechRate?: number;
  /** 音量 [-50, 100]，100 = 2.0 倍音量 */
  loudnessRate?: number;
  enableSubtitle?: boolean;
  /** 显式朗读语种，如 zh-cn / en / ja */
  explicitLanguage?: string;
  /** 覆盖默认端点 */
  endpoint?: string;
  timeoutMs?: number;
}

export interface TtsResult {
  audio: Buffer;
  format: TtsAudioFormat;
  sampleRate: number;
  /** 最后一个分片的句级信息（含字幕时间戳，enableSubtitle 开启时） */
  sentence?: { text: string; words?: Array<{ word: string; startTime: number; endTime: number; confidence?: number }> };
  usage?: { text_words?: number };
}

/** 从流式 buffer 中提取顶层 JSON 对象（兼容换行分隔与直接拼接两种分片方式） */
export function extractJsonObjects(buffer: string): { objects: unknown[]; rest: string } {
  const objects: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        objects.push(JSON.parse(buffer.slice(start, i + 1)));
        start = -1;
      }
    }
  }
  // 字符串未闭合/对象未闭合的部分留给下一次
  const rest = depth > 0 || inString ? buffer.slice(Math.max(start, 0)) : buffer.slice(buffer.length);
  return { objects, rest };
}

/** 提交单向流式合成并收集完整音频。 */
export async function unidirectionalTts(opts: TtsOptions): Promise<TtsResult> {
  if (!opts.apiKey?.trim()) {
    throw new Error('缺少 API Key，请配置环境变量 ARK_API_KEY');
  }
  if (!opts.text?.trim()) {
    throw new Error('缺少待合成文本 text');
  }

  const format = opts.format ?? 'mp3';
  const sampleRate = opts.sampleRate ?? TTS_DEFAULT_SAMPLE_RATE;
  const endpoint = opts.endpoint ?? PLAN_TTS_URL;

  const reqParams: Record<string, unknown> = {
    text: opts.text,
    speaker: opts.speaker ?? TTS_DEFAULT_SPEAKER,
    audio_params: {
      format,
      sample_rate: sampleRate,
      ...(opts.speechRate !== undefined ? { speech_rate: opts.speechRate } : {}),
      ...(opts.loudnessRate !== undefined ? { loudness_rate: opts.loudnessRate } : {}),
    },
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.enableSubtitle !== undefined ? { enable_subtitle: opts.enableSubtitle } : {}),
    ...(opts.explicitLanguage !== undefined ? { explicit_language: opts.explicitLanguage } : {}),
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Connection: 'keep-alive',
      'X-Api-Key': opts.apiKey.trim(),
      'X-Api-Resource-Id': opts.resourceId ?? TTS_DEFAULT_RESOURCE_ID,
      'X-Api-Request-Id': crypto.randomUUID(),
    },
    body: JSON.stringify({ req_params: reqParams }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`TTS 接口返回 ${res.status}:${text.slice(0, 300) || res.statusText}`);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  let sentence: TtsResult['sentence'];
  let usage: TtsResult['usage'];
  let pending = '';

  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    pending += decoder.decode(chunk as Uint8Array, { stream: true });
    const { objects, rest } = extractJsonObjects(pending);
    pending = rest;
    for (const obj of objects) {
      const msg = obj as { code?: number; message?: string; data?: string; sentence?: TtsResult['sentence']; usage?: TtsResult['usage'] };
      // 成功码：0 或 20000000（openspeech 通用成功状态，与语音识别一致；实测 plan 网关返回后者）
      if (typeof msg.code === 'number' && msg.code !== 0 && msg.code !== 20_000_000) {
        throw new Error(`TTS 合成失败：code=${msg.code}，message=${msg.message ?? '无'}`);
      }
      if (msg.sentence?.text) sentence = msg.sentence;
      if (msg.usage) usage = msg.usage;
      if (msg.data) {
        const audio = Buffer.from(msg.data, 'base64');
        chunks.push(audio);
        total += audio.length;
      }
    }
  }
  if (pending.trim()) {
    throw new Error(`TTS 响应存在未完成的 JSON 分片，疑似响应中断：${pending.slice(0, 120)}`);
  }
  if (total === 0) {
    throw new Error('TTS 响应中没有音频数据');
  }

  return { audio: Buffer.concat(chunks, total), format, sampleRate, sentence, usage };
}
