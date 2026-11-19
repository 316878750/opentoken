import assert from 'node:assert/strict';
import test from 'node:test';
import { openAiCompletion, upstreamModel, UpstreamError } from '../lib/upstream.ts';

const request = { model:'openai-mini', messages:[{role:'user',content:'Reply with OK.'}], max_completion_tokens:16 };
const completion = {
  id:'chatcmpl-fixture',
  model:upstreamModel,
  choices:[{index:0,message:{role:'assistant',content:'OK'},finish_reason:'stop'}],
  usage:{prompt_tokens:14,completion_tokens:2,total_tokens:16,prompt_tokens_details:{cached_tokens:4}},
};
const reply = (status, data) => new Response(JSON.stringify(data),{status,headers:{'x-request-id':'provider-test-id'}});

test('official adapter fixes the host/model, uses non-streaming and extracts billed tokens',async () => {
  let calls = 0;
  const result = await openAiCompletion(request,'fixture-upstream-key',async (url,options) => {
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
    await assert.rejects(openAiCompletion(request,'fixture',async ()=>reply(status,{private:'ignore'})),
      e=>e instanceof UpstreamError && e.disposition===disposition && e.requestId==='provider-test-id' && !e.message.includes('private'));
  }
  await assert.rejects(openAiCompletion(request,'fixture',async ()=>{throw new Error('secret diagnostic');}),
    e=>e.disposition==='review' && !e.message.includes('secret'));
  await assert.rejects(openAiCompletion(request,'fixture',async ()=>reply(200,{...completion,usage:undefined})),
    e=>e.disposition==='review');
  await assert.rejects(openAiCompletion(request,'fixture',async ()=>reply(200,{...completion,usage:{
    ...completion.usage,prompt_tokens_details:{cached_tokens:100},
  }})),e=>e.disposition==='review');
});
