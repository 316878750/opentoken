import assert from 'node:assert/strict';
import test from 'node:test';
import { openAiCompletion, openAiStream, upstreamModel, UpstreamError } from '../lib/upstream.ts';
import { resolveLiveUpstream, resolveLiveUpstreams } from '../lib/upstream-config.mjs';

const request = { model:'openai-mini', messages:[{role:'user',content:'Reply with OK.'}], max_completion_tokens:16 };
const completion = {
  id:'chatcmpl-fixture',
  model:upstreamModel,
  choices:[{index:0,message:{role:'assistant',content:'OK'},finish_reason:'stop'}],
  usage:{prompt_tokens:14,completion_tokens:2,total_tokens:16,prompt_tokens_details:{cached_tokens:4}},
};
const reply = (status, data) => new Response(JSON.stringify(data),{status,headers:{'x-request-id':'provider-test-id'}});
const official = resolveLiveUpstream({ENABLE_OPENAI:'1',UPSTREAM_MODE:'official',OPENAI_API_KEY:'fixture-key'});

test('official streaming is opt-in and redacts a credential split across deltas',async () => {
  assert.equal(official.streaming,false);
  const provider = resolveLiveUpstream({ENABLE_OPENAI:'1',UPSTREAM_MODE:'official',OPENAI_API_KEY:'fixture-key',
    ENABLE_UPSTREAM_STREAMING:'1'});
  assert.equal(provider.streaming,true);
  const frame = (choices,usage=null) => 'data: '+JSON.stringify({id:'provider-completion',model:upstreamModel,
    object:'chat.completion.chunk',choices,usage})+'\n\n';
  const deltas = [];
  const result = await openAiStream(request,provider,delta=>deltas.push(delta),async (url,options) => {
    assert.equal(url,'https://api.openai.com/v1/chat/completions');
    assert.equal(options.redirect,'error');
    assert.deepEqual(JSON.parse(options.body).stream_options,{include_usage:true});
    assert.equal(JSON.parse(options.body).store,false);
    return new Response(frame([{index:0,delta:{content:'Echo: fix'},finish_reason:null}])+
      frame([{index:0,delta:{content:'ture-key; OK'},finish_reason:'stop'}])+
      frame([],completion.usage)+'data: [DONE]\n\n',
      {headers:{'content-type':'text/event-stream','x-request-id':'fixture-key'}});
  });
  assert.equal(deltas.map(delta=>delta.content).join(''),'Echo: [redacted]; OK');
  assert.equal(result.requestId,'provider-completion');
  assert.deepEqual(result.tokens,{input:14,cached:4,output:2});
});

test('official adapter fixes the host/model, uses non-streaming and extracts billed tokens',async () => {
  let calls = 0;
  const result = await openAiCompletion(request,official,async (url,options) => {
    calls++;
    assert.equal(url,'https://api.openai.com/v1/chat/completions');
    assert.equal(options.redirect,'error');
    const sent = JSON.parse(options.body);
    assert.equal(sent.model,upstreamModel);
    assert.equal(sent.stream,false);
    assert.equal(sent.store,false);
    assert.equal(sent.max_completion_tokens,16);
    return reply(200,completion);
  });
  assert.equal(calls,1);
  assert.deepEqual(result.tokens,{input:14,cached:4,output:2});
  assert.equal(result.requestId,'provider-test-id');
  assert.equal(result.choices[0].message.content,'OK');
});

test('known pre-execution rejections can release, while ambiguous outcomes need review',async () => {
  for (const [status,disposition] of [[429,'release'],[400,'release'],[503,'review'],[408,'review']]) {
    await assert.rejects(openAiCompletion(request,official,async ()=>reply(status,{private:'ignore'})),
      e=>e instanceof UpstreamError && e.disposition===disposition && e.requestId==='provider-test-id' && !e.message.includes('private'));
  }
  await assert.rejects(openAiCompletion(request,official,async ()=>{throw new Error('secret diagnostic');}),
    e=>e.disposition==='review' && !e.message.includes('secret'));
  await assert.rejects(openAiCompletion(request,official,async ()=>reply(200,{...completion,usage:undefined})),
    e=>e.disposition==='review');
  await assert.rejects(openAiCompletion(request,official,async ()=>reply(200,{...completion,usage:{
    ...completion.usage,prompt_tokens_details:{cached_tokens:100},
  }})),e=>e.disposition==='review');
});

const compatibleEnv = {
  ENABLE_OPENAI:'1', UPSTREAM_MODE:'compatible', COMPATIBLE_API_KEY:'fixture-third-party-key',
  OPENAI_BASE_URL:'https://provider.example/v1', OPENAI_MODEL:'vendor/text-model',
  UPSTREAM_INPUT_USD_PER_MTOK:'0.20', UPSTREAM_CACHED_USD_PER_MTOK:'0.04', UPSTREAM_OUTPUT_USD_PER_MTOK:'0.60',
};

test('additional models share only the configured compatible credentials and enforce unique routes', () => {
  const model = {alias:'value-chat',model:'vendor/value-model',inputUsdPerMtok:'0.2',cachedUsdPerMtok:'0.04',outputUsdPerMtok:'0.6',streaming:true};
  const resolve = entries => resolveLiveUpstreams({...compatibleEnv,UPSTREAM_ADDITIONAL_MODELS_JSON:JSON.stringify(entries)});
  const [primary,additional] = resolve([model]);
  assert.equal(additional.endpoint,primary.endpoint);
  assert.equal(additional.apiKey,primary.apiKey);
  assert.equal(additional.responseModel,model.model);
  assert.equal(additional.streaming,false);
  assert.throws(()=>resolve([{...model,endpoint:'https://other.example/v1'}]),/Invalid additional/);
  assert.throws(()=>resolve([model,model]),/Duplicate or reserved/);
  assert.throws(()=>resolve([{...model,alias:'mock-text'}]),/Duplicate or reserved/);
  assert.throws(()=>resolve([{...model,groups:[{code:'pilot',name:'Different',multiplierBps:10000}]}]),/inconsistent pricing group/);
});

test('compatible credentials require an explicit HTTPS destination and never fall back to OpenAI', () => {
  assert.equal(resolveLiveUpstream({...compatibleEnv,ENABLE_OPENAI:'0'}),null);
  assert.throws(()=>resolveLiveUpstream({...compatibleEnv,UPSTREAM_MODE:''}),/UPSTREAM_MODE/);
  assert.throws(()=>resolveLiveUpstream({...compatibleEnv,COMPATIBLE_API_KEY:'',OPENAI_API_KEY:'not-for-this-service'}),/COMPATIBLE_API_KEY/);
  assert.throws(()=>resolveLiveUpstream({...compatibleEnv,UPSTREAM_MODE:'official',OPENAI_BASE_URL:''}),/OPENAI_API_KEY/);
  assert.throws(()=>resolveLiveUpstream({...compatibleEnv,OPENAI_BASE_URL:''}),/OPENAI_BASE_URL/);
  for (const endpoint of ['http://provider.example/v1','https://a:b@provider.example/v1','https://provider.example/v1?key=test']) {
    assert.throws(()=>resolveLiveUpstream({...compatibleEnv,OPENAI_BASE_URL:endpoint}),/OPENAI_BASE_URL/);
  }
  assert.throws(()=>resolveLiveUpstream({...compatibleEnv,UPSTREAM_INPUT_USD_PER_MTOK:''}),/UPSTREAM_INPUT/);
  assert.equal(resolveLiveUpstream(compatibleEnv).endpoint,'https://provider.example/v1/chat/completions');
  assert.equal(resolveLiveUpstream(compatibleEnv).inputMicros,'200000');
});

test('compatible request omits provider-specific options and records an alternate usage shape',async () => {
  const provider = resolveLiveUpstream(compatibleEnv);
  let calls = 0;
  const result = await openAiCompletion(request,provider,async (url,options)=>{
    calls++;
    assert.equal(url,'https://provider.example/v1/chat/completions');
    assert.equal(options.headers.Authorization,'Bearer '+compatibleEnv.COMPATIBLE_API_KEY);
    assert.equal(options.redirect,'error');
    const sent = JSON.parse(options.body);
    assert.deepEqual(sent,{model:'vendor/text-model',messages:request.messages,max_tokens:16,stream:false});
    return new Response(JSON.stringify({...completion,id:'provider-completion-id',model:'vendor/text-model',
      choices:[{index:0,message:{role:'assistant',content:'Echo: '+provider.apiKey},finish_reason:'stop'}],
      usage:{prompt_tokens:14,prompt_cache_hit_tokens:4,completion_tokens:2}}),
      {status:200,headers:{'x-request-id':provider.apiKey}});
  });
  assert.equal(calls,1);
  assert.deepEqual(result.tokens,{input:14,cached:4,output:2});
  assert.equal(result.requestId,'provider-completion-id');
  assert.equal(result.choices[0].message.content,'Echo: [redacted]');
});

test('compatible responses need evidence for different cache prices and cannot assume 429 means unbilled',async () => {
  const provider = resolveLiveUpstream(compatibleEnv);
  await assert.rejects(openAiCompletion(request,provider,async ()=>reply(429,{})),e=>e.disposition==='review');
  const successful = {...completion,model:provider.model,usage:{prompt_tokens:14,completion_tokens:2}};
  await assert.rejects(openAiCompletion(request,provider,async ()=>reply(200,successful)),e=>e.disposition==='review');
  const result = await openAiCompletion(request,provider,async ()=>reply(200,{
    ...successful,usage:{...successful.usage,prompt_cache_miss_tokens:14},
  }));
  assert.equal(result.tokens.cached,0);
});
