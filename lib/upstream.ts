import { setTimeout as delay } from 'node:timers/promises';
import * as z from 'zod';
import { resolveLiveUpstream } from './upstream-config.mjs';

export { upstreamModel } from './upstream-config.mjs';
export const mockModel = 'mock-text';
type LiveUpstream = NonNullable<ReturnType<typeof resolveLiveUpstream>>;

export type CompletionInput = {
  model: string;
  messages: { role: string; content: string }[];
  max_completion_tokens: number;
};

type Completion = {
  tokens: { input: number; cached: number; output: number };
  choices: { index: number; message: { role: 'assistant'; content: string | null; refusal?: string | null }; finish_reason: string }[];
  requestId: string | null;
};

export class UpstreamError extends Error {
  readonly disposition: 'release' | 'review';
  readonly requestId: string | null;
  constructor(disposition: 'release' | 'review', requestId: string | null) {
    super(disposition === 'release' ? '上游拒绝了请求，未扣费。' : '上游结果未确认，费用待核对。');
    this.disposition = disposition;
    this.requestId = requestId;
  }
}

const responseSchema = z.object({
  id: z.string().optional(),
  model: z.string(),
  choices: z.array(z.object({
    index: z.int().nonnegative(), finish_reason: z.string(),
    message: z.object({ role:z.literal('assistant'), content:z.string().nullable(), refusal:z.string().nullish() }),
  })).length(1),
  usage: z.object({
    prompt_tokens: z.int().nonnegative(),
    completion_tokens: z.int().nonnegative(),
    prompt_cache_hit_tokens: z.int().nonnegative().optional(),
    prompt_cache_miss_tokens: z.int().nonnegative().optional(),
    prompt_tokens_details: z.object({ cached_tokens: z.int().nonnegative().optional() }).nullish(),
  }),
});

export async function openAiCompletion(
  input: CompletionInput, upstream: LiveUpstream, fetcher: typeof fetch = fetch,
): Promise<Completion> {
  let response: Response;
  try {
    response = await fetcher(upstream.endpoint,{
      method:'POST',headers:{Authorization:'Bearer '+upstream.apiKey,'Content-Type':'application/json'},
      body:JSON.stringify({model:upstream.model,messages:input.messages,[upstream.tokenField]:input.max_completion_tokens,
        stream:false,...(upstream.mode==='official' ? {reasoning_effort:'none',service_tier:'default',store:false} : {})}),
      redirect:'error',signal:AbortSignal.timeout(25000),
    });
  } catch {
    throw new UpstreamError('review',null);
  }
  const header = response.headers.get('x-request-id');
  const chosenId = (value?:string|null) => value && /^[\w.:-]{1,128}$/.test(value) && !value.includes(upstream.apiKey) ? value : null;
  const headerId = chosenId(header);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const confirmedRejection = upstream.mode==='official' && [400,401,403,404,422,429].includes(response.status);
    throw new UpstreamError(confirmedRejection ? 'release' : 'review',headerId);
  }
  const parsed = responseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new UpstreamError('review',headerId);
  const requestId = headerId ?? chosenId(parsed.data.id);
  if (parsed.data.model!==upstream.responseModel) throw new UpstreamError('review',requestId);
  const usage = parsed.data.usage;
  const cached = [usage.prompt_tokens_details?.cached_tokens,usage.prompt_cache_hit_tokens,
    usage.prompt_cache_miss_tokens===undefined ? undefined : usage.prompt_tokens-usage.prompt_cache_miss_tokens]
    .filter((count): count is number=>count!==undefined);
  if (new Set(cached).size>1 || (!cached.length && upstream.mode==='compatible' && upstream.cacheMicros!==upstream.inputMicros)) {
    throw new UpstreamError('review',requestId);
  }
  const tokens = {input:usage.prompt_tokens,cached:cached[0] ?? 0,output:usage.completion_tokens};
  if (tokens.cached<0 || tokens.cached>tokens.input || tokens.output>input.max_completion_tokens) throw new UpstreamError('review',requestId);
  const hideKey = (value: string|null|undefined) => value?.replaceAll(upstream.apiKey,'[redacted]') ?? value;
  const choices = parsed.data.choices.map(choice=>({...choice,finish_reason:hideKey(choice.finish_reason)!,message:{...choice.message,
    content:hideKey(choice.message.content) ?? null,refusal:hideKey(choice.message.refusal)}}));
  return {choices,tokens,requestId};
}

export async function mockCompletion(input: CompletionInput,onText?: (content:string) => void): Promise<Completion> {
  const chunks = ['本地模拟','调用已完成。'];
  const duration = Math.min(30_000,Math.max(1_000,Number(process.env.DEMO_DELAY_MS) || 12_000));
  if (onText) {
    for (const chunk of chunks) {
      await delay(duration/chunks.length);
      onText(chunk);
    }
  } else {
    await delay(duration);
  }
  return {
    tokens:{input:375,cached:0,output:Math.min(48,input.max_completion_tokens)},requestId:null,
    choices:[{index:0,message:{role:'assistant',content:chunks.join('')},finish_reason:'stop'}],
  };
}
