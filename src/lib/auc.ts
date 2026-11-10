/**
 * Doubao file-transcription ASR client (Volcano Engine speech). Submit an audio URL, poll until
 * done, and normalize the utterances (per-sentence text + start/end + optional speaker).
 * 抽自 content-forge clip 的 asr/doubao.ts，供 MCP 工具 auc_bigmodel_transcribe 使用。
 * 凭据来自环境变量 VOLC_ASR_API_KEY。
 *
 * API（docs.volcengine.com/docs/6561/1354831 与配套结果查询）：
 * - 提交  POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit
 * - 查询  POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/query
 * 状态码在响应头 X-Api-Status-Code：20000000 完成；20000001/20000002 处理中/排队中；
 * 20000003 无有效语音；其他为失败。查询需回传提交响应的 X-Tt-Logid。
 */

const SUBMIT_URL = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit';
const QUERY_URL = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/query';

const STATUS_OK = '20000000';
const STATUS_RUNNING = new Set(['20000001', '20000002']);
const STATUS_SILENCE = '20000003';

/** Resource id per model version: 2.0 is current, 1.0 is legacy */
const RESOURCE_IDS = { '2.0': 'volc.seedasr.auc', '1.0': 'volc.bigasr.auc' } as const;

export type AsrModelVersion = keyof typeof RESOURCE_IDS;

/** One normalized sentence with timing (and speaker when enabled) */
export interface Utterance {
  text: string;
  /** start time in ms from audio beginning */
  start: number;
  end: number;
  speaker?: number;
}

export interface TranscribeOptions {
  /** X-Api-Key from the Volcano speech console */
  apiKey: string;
  /** Publicly fetchable audio URL (pre-signed TOS URL for local files) */
  url: string;
  format: string;
  language?: string;
  model?: AsrModelVersion;
  enableSpeakerInfo?: boolean;
  /** Speaker-diarization model: 200 non-meeting (≤5 speakers) / 300 voiceprint long meetings */
  ssdVersion?: '200' | '300';
  ssdMode?: 0 | 1;
  enableItn?: boolean;
  enablePunc?: boolean;
  enableDdc?: boolean;
  vadSegment?: boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Cancellation for long polls (workflow stages abort through this) */
  signal?: AbortSignal;
  /** Progress hook (e.g. workflow run-log lines) */
  onLog?: (message: string) => void;
}

export interface TranscribeResult {
  taskId: string;
  /** Full plain text (joined utterances when the service omits it) */
  text: string;
  utterances: Utterance[];
  raw: Record<string, unknown>;
}

/** Infer audio format from a path/URL extension; null when unknown */
export function detectFormat(source: string): string | null {
  const ext = source.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase() ?? '';
  return ['wav', 'mp3', 'ogg', 'spx', 'amr', 'aac', 'm4a'].includes(ext) ? ext : null;
}

/** ms → mm:ss (or h:mm:ss beyond an hour) */
export function formatClock(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** Human-readable transcript: one line per utterance with [clock] and optional speaker */
export function renderTranscriptMd(utterances: Utterance[]): string {
  return utterances
    .map((u) => {
      const speaker = u.speaker !== undefined ? `（说话人 ${u.speaker}）` : '';
      return `**[${formatClock(u.start)} → ${formatClock(u.end)}]**${speaker} ${u.text}`;
    })
    .join('\n\n');
}

/** Normalize the raw utterances[] of the API result */
export function normalizeUtterances(raw: unknown): Utterance[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((u) => {
      const r = u as Record<string, unknown>;
      const out: Utterance = {
        text: String(r.text ?? '').trim(),
        start: Number(r.start_time ?? 0),
        end: Number(r.end_time ?? 0),
      };
      // 说话人字段随模型版本不同：1.0 顶层 speaker_id；2.0 在 additions.speaker（字符串）
      const additions = r.additions as Record<string, unknown> | undefined;
      const speaker = r.speaker_id ?? additions?.speaker;
      if (speaker !== undefined && speaker !== null && speaker !== '') {
        out.speaker = Number(speaker);
      }
      return out;
    })
    .filter((u) => u.text.length > 0);
}

/** POST with the common headers; retries network errors, throws on HTTP failure */
async function apiPost(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  retries = 3,
): Promise<Response> {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      return res;
    } catch (err) {
      if (signal?.aborted) throw err;
      if (i >= retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

function apiError(res: Response, what: string): string {
  const status = res.headers.get('X-Api-Status-Code') ?? '';
  const message = res.headers.get('X-Api-Message') ?? '';
  return `${what}失败：X-Api-Status-Code=${status || '缺失'}，X-Api-Message=${message || '无'}`;
}

/** Submit the task and return its id plus the X-Tt-Logid needed by the query calls */
async function submitTask(
  opts: TranscribeOptions,
  headers: Record<string, string>,
): Promise<{ taskId: string; logId: string }> {
  const requestId = crypto.randomUUID();
  const res = await apiPost(
    SUBMIT_URL,
    {
      user: { uid: 'volcengine-api-mcp' },
      audio: { url: opts.url, format: opts.format },
      request: {
        model_name: 'bigmodel',
        language: opts.language,
        show_utterances: true,
        enable_itn: opts.enableItn,
        enable_punc: opts.enablePunc,
        enable_ddc: opts.enableDdc,
        enable_speaker_info: opts.enableSpeakerInfo,
        ssd_version: opts.ssdVersion,
        ssd_mode: opts.ssdMode,
        vad_segment: opts.vadSegment,
      },
    },
    { ...headers, 'X-Api-Request-Id': requestId },
    opts.signal,
  ).catch((err: unknown) => {
    throw new Error(`提交转写任务失败：${err instanceof Error ? err.message : String(err)}`);
  });
  if (res.headers.get('X-Api-Status-Code') !== STATUS_OK) {
    throw new Error(apiError(res, '提交转写任务'));
  }
  return { taskId: requestId, logId: res.headers.get('X-Tt-Logid') ?? '' };
}

/** Poll the task until done; 20000003 (silence) resolves to an empty result */
async function pollTask(
  opts: TranscribeOptions,
  headers: Record<string, string>,
  taskId: string,
  logId: string,
): Promise<Record<string, unknown>> {
  const interval = opts.pollIntervalMs ?? 3000;
  const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
  const log = opts.onLog ?? (() => {});
  for (;;) {
    if (opts.signal?.aborted) throw new Error('已取消');
    if (Date.now() > deadline) {
      throw new Error(`转写超时（${Math.round((opts.timeoutMs ?? 600_000) / 1000)}s）：任务 ${taskId} 仍未完成`);
    }
    await new Promise((r) => setTimeout(r, interval));
    const res = await apiPost(
      QUERY_URL,
      {},
      { ...headers, 'X-Api-Request-Id': taskId, ...(logId ? { 'X-Tt-Logid': logId } : {}) },
      opts.signal,
    ).catch((err: unknown) => {
      throw new Error(`查询转写结果失败：${err instanceof Error ? err.message : String(err)}`);
    });
    const status = res.headers.get('X-Api-Status-Code') ?? '';
    if (status === STATUS_OK) return (await res.json()) as Record<string, unknown>;
    if (status === STATUS_SILENCE) return { result: {} }; // 无有效语音：空结果
    if (!STATUS_RUNNING.has(status)) throw new Error(apiError(res, '查询转写结果'));
    log(`[asr] 处理中（${status}）…`);
  }
}

/** Full submit → poll → normalize round-trip */
export async function transcribeAudio(opts: TranscribeOptions): Promise<TranscribeResult> {
  const baseHeaders = {
    'X-Api-Key': opts.apiKey,
    'X-Api-Resource-Id': RESOURCE_IDS[opts.model ?? '2.0'],
    'X-Api-Sequence': '-1',
  };
  const { taskId, logId } = await submitTask(opts, baseHeaders);
  opts.onLog?.(`[asr] 任务已提交 ${taskId}`);
  const raw = await pollTask(opts, baseHeaders, taskId, logId);
  const inner = (raw.result ?? {}) as Record<string, unknown>;
  const utterances = normalizeUtterances(inner.utterances);
  const text = String(inner.text ?? utterances.map((u) => u.text).join(''));
  return { taskId, text, utterances, raw };
}
