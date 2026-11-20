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
  if (request.stream) {
    const scenario = request.messages[0].content;
    if (request.stream_options?.include_usage!==true || request.max_tokens!==16) throw new Error('Invalid upstream SSE options');
    const frame = (choices,usage=null) => 'data: '+JSON.stringify({id:'stream-completion',
      object:'chat.completion.chunk',model:'vendor/text-model',choices,usage})+'\r\n\r\n';
    const frames = [
      frame([{index:0,delta:scenario==='unsupported output' ? {tool_calls:[{index:0}]} : {content:'流式'},finish_reason:null}]),
      frame([{index:0,delta:{content:'输出'},finish_reason:'stop'}]),
      ...(scenario==='missing usage' ? [] : [frame([],{prompt_tokens:scenario==='over budget' ? 8193 : 14,
        completion_tokens:2,prompt_cache_hit_tokens:4})]),
      ...(scenario==='interrupted stream' ? [] : [scenario==='malformed terminator' ?
        'data: [DONE]\r\ndata\r\n\r\n' : 'data: [DONE]\r\n\r\n']),
    ];
    const bytes = new TextEncoder().encode(': keepalive\r\n\r\n'+frames.join(''));
    return new Response(new ReadableStream({start(controller) {
      // Split UTF-8 characters and CRLF delimiters across network chunks.
      for (let index=0;index<bytes.length;index+=7) controller.enqueue(bytes.slice(index,index+7));
      controller.close();
    }}),{headers:{...headers,'content-type':'text/event-stream; charset=utf-8'}});
  }
  return reply(200,{
    model:request.model,
    choices:[{index:0,message:{role:'assistant',content:'OK'},finish_reason:'stop'}],
    usage:{prompt_tokens:14,completion_tokens:2,prompt_tokens_details:{cached_tokens:4}},
  });
};
