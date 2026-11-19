import { setTimeout as delay } from 'node:timers/promises';
import * as z from 'zod';

export const upstreamModel = 'gpt-5.4-mini-2026-03-17';
export const openAiAlias = 'openai-mini';
export const mockModel = 'mock-text';

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
  model: z.literal(upstreamModel),
  choices: z.array(z.object({
    index: z.int().nonnegative(), finish_reason: z.string(),
    message: z.object({ role:z.literal('assistant'), content:z.string().nullable(), refusal:z.string().nullish() }),
  })).length(1),
  usage: z.object({
    prompt_tokens: z.int().nonnegative(),
    completion_tokens: z.int().nonnegative(),
    prompt_tokens_details: z.object({ cached_tokens: z.int().nonnegative().optional() }).nullish(),
  }),
});

export async function openAiCompletion(
  input: CompletionInput, apiKey: string, fetcher: typeof fetch = fetch,
): Promise<Completion> {
  let response: Response;
  try {
    response = await fetcher('https://api.openai.com/v1/chat/completions',{
      method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},
      body:JSON.stringify({model:upstreamModel,messages:input.messages,max_completion_tokens:input.max_completion_tokens,
        reasoning_effort:'none',service_tier:'default',stream:false,store:false}),
      redirect:'error',signal:AbortSignal.timeout(25000),
    });
  } catch {
    throw new UpstreamError('review',null);
  }
  const header = response.headers.get('x-request-id');
  const requestId = header && /^[\w-]{1,128}$/.test(header) ? header : null;
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new UpstreamError([400,401,403,404,422,429].includes(response.status) ? 'release' : 'review',requestId);
  }
  const parsed = responseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new UpstreamError('review',requestId);
  const usage = parsed.data.usage;
  const tokens = {input:usage.prompt_tokens,cached:usage.prompt_tokens_details?.cached_tokens ?? 0,output:usage.completion_tokens};
  if (tokens.cached>tokens.input || tokens.output>input.max_completion_tokens) throw new UpstreamError('review',requestId);
  return {choices:parsed.data.choices,tokens,requestId};
}

export async function mockCompletion(input: CompletionInput): Promise<Completion> {
  await delay(Math.min(30_000,Math.max(1_000,Number(process.env.DEMO_DELAY_MS) || 12_000)));
  return {
    tokens:{input:375,cached:0,output:Math.min(48,input.max_completion_tokens)},requestId:null,
    choices:[{index:0,message:{role:'assistant',content:'本地模拟调用已完成。'},finish_reason:'stop'}],
  };
}

export function liveKey() {
  return process.env.ENABLE_OPENAI==='1' ? process.env.OPENAI_API_KEY?.trim() || null : null;
}
