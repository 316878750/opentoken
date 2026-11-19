// Loaded only by the integration runner. No test process sends external requests.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input,options) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin==='http://127.0.0.1' || url.origin.startsWith('http://127.0.0.1:')) return originalFetch(input,options);
  if (url.href!=='https://provider.example/v1/chat/completions') throw new Error('Unexpected external request in integration test');
  const request = JSON.parse(options.body);
  await new Promise(resolve => setTimeout(resolve,1500));
  const headers = {'x-request-id':'fixture-provider-request','content-type':'application/json'};
  const reply = (status,body) => new Response(JSON.stringify(body),{status,headers});
  if (request.messages[0].content==='fixture rejection') return reply(429,{error:{}});
  if (request.messages[0].content==='fixture uncertain') return reply(503,{error:{}});
  return reply(200,{
    model:'vendor/text-model',
    choices:[{index:0,message:{role:'assistant',content:'OK'},finish_reason:'stop'}],
    usage:{prompt_tokens:14,completion_tokens:2,prompt_tokens_details:{cached_tokens:4}},
  });
};
