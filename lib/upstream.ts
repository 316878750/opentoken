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

export type TextDelta = {content?:string;refusal?:string};

type Completion = {
  tokens: { input: number; cached: number; output: number };
  choices: { index: number; message: { role: 'assistant'; content: string | null; refusal?: string | null }; finish_reason: string }[];
  requestId: string | null;
};

export class UpstreamError extends Error {
  readonly disposition: 'release' | 'review';
  readonly requestId: string | null;
  readonly category: 'auth_failed' | 'model_unavailable' | 'timeout' | 'upstream_unavailable' | 'unverified';
  constructor(disposition: 'release' | 'review', requestId: string | null, category: UpstreamError['category'] = 'unverified') {
    super(disposition === 'release' ? '上游拒绝了请求，未扣费。' : '上游结果未确认，费用待核对。');
    this.disposition = disposition;
    this.requestId = requestId;
    this.category = category;
  }
}

const usageSchema = z.object({
  prompt_tokens: z.int().nonnegative(),
  completion_tokens: z.int().nonnegative(),
  prompt_cache_hit_tokens: z.int().nonnegative().optional(),
  prompt_cache_miss_tokens: z.int().nonnegative().optional(),
  prompt_tokens_details: z.object({ cached_tokens: z.int().nonnegative().optional() }).nullish(),
});

const responseSchema = z.object({
  id: z.string().optional(),
  model: z.string(),
  choices: z.array(z.object({
    index: z.int().nonnegative(), finish_reason: z.string(),
    message: z.object({ role:z.literal('assistant'), content:z.string().nullable(), refusal:z.string().nullish() }),
  })).length(1),
  usage: usageSchema,
});

function providerId(value:string|null|undefined,apiKey:string) {
  return value && /^[\w.:-]{1,128}$/.test(value) && !value.includes(apiKey) ? value : null;
}

function timedOut(error:unknown) {
  return error instanceof Error && (error.name==='TimeoutError' || error.name==='AbortError');
}

async function fetchCompletion(input:CompletionInput,upstream:LiveUpstream,stream:boolean,fetcher:typeof fetch) {
  let response: Response;
  try {
    response = await fetcher(upstream.endpoint,{
      method:'POST',headers:{Authorization:'Bearer '+upstream.apiKey,'Content-Type':'application/json'},
      body:JSON.stringify({model:upstream.model,messages:input.messages,[upstream.tokenField]:input.max_completion_tokens,
        stream,...(stream ? {stream_options:{include_usage:true}} : {}),
        ...(upstream.mode==='official' ? {reasoning_effort:'none',service_tier:'default',store:false} : {})}),
      redirect:'error',signal:AbortSignal.timeout(25000),
    });
  } catch (error) {
    throw new UpstreamError('review',null,timedOut(error) ? 'timeout' : 'upstream_unavailable');
  }
  const headerId = providerId(response.headers.get('x-request-id'),upstream.apiKey);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const confirmedRejection = upstream.mode==='official' && [400,401,403,404,422,429].includes(response.status);
    const category = [401,403].includes(response.status) ? 'auth_failed' : response.status===404 ? 'model_unavailable' : 'upstream_unavailable';
    throw new UpstreamError(confirmedRejection ? 'release' : 'review',headerId,category);
  }
  return {response,headerId};
}

function billedTokens(usage:z.infer<typeof usageSchema>,input:CompletionInput,upstream:LiveUpstream,requestId:string|null) {
  const cached = [usage.prompt_tokens_details?.cached_tokens,usage.prompt_cache_hit_tokens,
    usage.prompt_cache_miss_tokens===undefined ? undefined : usage.prompt_tokens-usage.prompt_cache_miss_tokens]
    .filter((count): count is number=>count!==undefined);
  if (new Set(cached).size>1 || (!cached.length && upstream.mode==='compatible' && upstream.cacheMicros!==upstream.inputMicros)) {
    throw new UpstreamError('review',requestId);
  }
  const tokens = {input:usage.prompt_tokens,cached:cached[0] ?? 0,output:usage.completion_tokens};
  if (tokens.cached<0 || tokens.cached>tokens.input || tokens.output>input.max_completion_tokens) throw new UpstreamError('review',requestId);
  return tokens;
}

export async function openAiCompletion(
  input: CompletionInput, upstream: LiveUpstream, fetcher: typeof fetch = fetch,
): Promise<Completion> {
  const {response,headerId} = await fetchCompletion(input,upstream,false,fetcher);
  const payload:unknown = await response.json().catch(error=>{
    if (timedOut(error)) throw new UpstreamError('review',headerId,'timeout');
    return null;
  });
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) throw new UpstreamError('review',headerId);
  const requestId = headerId ?? providerId(parsed.data.id,upstream.apiKey);
  if (parsed.data.model!==upstream.responseModel) throw new UpstreamError('review',requestId);
  const tokens = billedTokens(parsed.data.usage,input,upstream,requestId);
  const hideKey = (value: string|null|undefined) => value?.replaceAll(upstream.apiKey,'[redacted]') ?? value;
  const choices = parsed.data.choices.map(choice=>({...choice,finish_reason:hideKey(choice.finish_reason)!,message:{...choice.message,
    content:hideKey(choice.message.content) ?? null,refusal:hideKey(choice.message.refusal)}}));
  return {choices,tokens,requestId};
}

const streamFrame = z.object({
  id:z.string().min(1).max(128),
  model:z.string(),
  object:z.literal('chat.completion.chunk'),
  choices:z.array(z.object({
    index:z.literal(0),
    delta:z.object({role:z.literal('assistant').optional(),content:z.string().nullish(),refusal:z.string().nullish(),
      tool_calls:z.null().optional(),function_call:z.null().optional(),audio:z.null().optional()}),
    finish_reason:z.enum(['stop','length','content_filter']).nullish(),
  })).max(1),
  usage:usageSchema.extend({total_tokens:z.int().nonnegative().optional()}).nullish(),
});

async function* readSse(body:ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8',{fatal:true});
  let received = 0;
  let buffer = '';
  let pendingCr = false;
  try {
    for (;;) {
      const {value,done} = await reader.read();
      received += value?.byteLength ?? 0;
      if (received>1_048_576) throw new Error('Upstream stream limit');
      let text:string = (pendingCr ? '\r' : '')+decoder.decode(value,{stream:!done});
      pendingCr = !done && text.endsWith('\r');
      if (pendingCr) text = text.slice(0,-1);
      const start = Math.max(buffer.length-1,0);
      buffer += text.replace(/\r\n?/g,'\n');
      for (let end=buffer.indexOf('\n\n',start);end>=0;end=buffer.indexOf('\n\n')) {
        const lines = buffer.slice(0,end).split('\n');
        buffer = buffer.slice(end+2);
        const fields = lines.map(line => {
          const colon = line.indexOf(':');
          return colon<0 ? [line,''] : [line.slice(0,colon),line.slice(colon+1).replace(/^ /,'')];
        });
        const data = fields.filter(([name])=>name==='data').map(([,value])=>value).join('\n');
        if (!data) continue;
        const type = fields.filter(([name])=>name==='event').at(-1)?.[1];
        if (type && type!=='message') throw new Error('Unexpected upstream event');
        yield data;
      }
      if (done) return;
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Keep any trailing prefix of the credential until the next delta disambiguates it.
function redactDeltas(secret:string,emit:(text:string)=>void) {
  let pending = '';
  return {
    push(text:string) {
      const parts = (pending+text).split(secret);
      const tail = parts.pop()!;
      let keep = Math.min(tail.length,secret.length-1);
      while (keep>0 && !tail.endsWith(secret.slice(0,keep))) keep--;
      pending = tail.slice(tail.length-keep);
      const safe = [...parts,tail.slice(0,tail.length-keep)].join('[redacted]');
      if (safe) emit(safe);
    },
    flush() {
      if (pending) emit(pending);
    },
  };
}

export async function openAiStream(
  input:CompletionInput,upstream:LiveUpstream,emit:(delta:TextDelta)=>void,fetcher:typeof fetch=fetch,
):Promise<Completion> {
  const {response,headerId} = await fetchCompletion(input,upstream,true,fetcher);
  if (!response.body || !/^text\/event-stream(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
    void response.body?.cancel().catch(() => {});
    throw new UpstreamError('review',headerId);
  }
  let id:string|undefined;
  let requestId = headerId;
  let finishReason:string|undefined;
  let tokens:Completion['tokens']|undefined;
  const content = redactDeltas(upstream.apiKey,text=>emit({content:text}));
  const refusal = redactDeltas(upstream.apiKey,text=>emit({refusal:text}));
  try {
    for await (const data of readSse(response.body)) {
      if (data==='[DONE]') {
        if (!finishReason || !tokens) break;
        content.flush();
        refusal.flush();
        return {requestId,tokens,choices:[{index:0,message:{role:'assistant',content:null},finish_reason:finishReason}]};
      }
      const frame = streamFrame.parse(JSON.parse(data));
      if (frame.model!==upstream.responseModel || (id && id!==frame.id) || tokens) break;
      id ??= frame.id;
      requestId ??= providerId(id,upstream.apiKey);
      const [choice] = frame.choices;
      if (choice) {
        if (finishReason) break;
        finishReason = choice.finish_reason ?? undefined;
        // Some compatible providers include final usage in the same frame as the finish reason.
        if (frame.usage && (upstream.mode!=='compatible' || !finishReason)) break;
        if (choice.delta.content) content.push(choice.delta.content);
        if (choice.delta.refusal) refusal.push(choice.delta.refusal);
      }
      if (frame.usage) {
        if (!finishReason) break;
        tokens = billedTokens(frame.usage,input,upstream,requestId);
        if (frame.usage.total_tokens!==undefined && frame.usage.total_tokens!==tokens.input+tokens.output) break;
      } else if (!choice) {
        break;
      }
    }
  } catch (error) {
    throw new UpstreamError('review',requestId,timedOut(error) ? 'timeout' : 'unverified');
  }
  throw new UpstreamError('review',requestId);
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
