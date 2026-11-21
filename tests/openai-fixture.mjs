// Loaded only by the integration runner. No test process sends external requests.
const originalFetch = globalThis.fetch;
const checkouts = new Map();
const subscriptionReads = new Map();

function stripeFixture(url,options) {
  if (new Headers(options.headers).get('authorization')!=='Bearer sk_test_fixture' || options.redirect!=='error') {
    throw new Error('Unexpected sandbox credentials or redirect policy');
  }
  const reply = data => new Response(JSON.stringify(data),{headers:{'content-type':'application/json','request-id':'req_fixture'}});
  const path = url.pathname;
  if (path==='/v1/prices/price_fixture_credit') return reply({
    id:'price_fixture_credit',object:'price',livemode:false,active:true,currency:'usd',type:'one_time',unit_amount:500,
  });
  if (path==='/v1/prices/price_fixture_monthly') return reply({
    id:'price_fixture_monthly',object:'price',livemode:false,active:true,currency:'usd',type:'recurring',unit_amount:1000,
    recurring:{interval:'month',interval_count:1},
  });
  if (path==='/v1/prices/price_fixture_credit_20') return reply({
    id:'price_fixture_credit_20',object:'price',livemode:false,active:true,currency:'usd',type:'one_time',unit_amount:2000,
  });
  if (path==='/v1/checkout/sessions' && options.method==='POST') {
    const form = new URLSearchParams(String(options.body));
    const order = form.get('client_reference_id');
    const mode = form.get('mode');
    const price = form.get('line_items[0][price]');
    if (!order || new Headers(options.headers).get('idempotency-key')!=='opentoken-checkout-'+order ||
      form.get('metadata[opentoken_order]')!==order || form.get('metadata[opentoken_price]')!==price ||
      form.get((mode==='subscription'?'subscription_data':'payment_intent_data')+'[metadata][opentoken_order]')!==order) {
      throw new Error('Unexpected Stripe Checkout parameters');
    }
    const id = 'cs_test_'+order.replaceAll('-','');
    const session = {id,object:'checkout.session',livemode:false,client_reference_id:order,mode,status:'open',
      amount_total:mode==='subscription'?1000:price==='price_fixture_credit_20'?2000:500,currency:'usd',payment_status:'unpaid',
      url:'https://checkout.stripe.com/c/pay/'+id,metadata:{opentoken_order:order,opentoken_price:price}};
    checkouts.set(id,session);
    return reply(session);
  }
  if (path==='/v1/checkout/sessions' && options.method==='GET') {
    if (!url.searchParams.has('created[gte]') || !url.searchParams.has('created[lte]')) throw new Error('Stripe recovery must use a bounded creation window');
    return reply({object:'list',has_more:false,data:[...checkouts.values()].map(checkout=>
      checkout.mode==='subscription' ? {...checkout,status:'complete'} : checkout)});
  }
  if (path.startsWith('/v1/checkout/sessions/')) {
    const checkout = checkouts.get(path.split('/').pop());
    return reply(checkout?.mode==='subscription' ? {...checkout,status:'complete'} : checkout);
  }
  if (path.startsWith('/v1/subscriptions/')) {
    const id = path.split('/').pop();
    const checkout = checkouts.get('cs_test_'+id.slice(4));
    if (!checkout || checkout.mode!=='subscription') throw new Error('Unexpected Stripe subscription lookup');
    const reads = subscriptionReads.get(id) ?? 0;
    subscriptionReads.set(id,reads+1);
    return reply({id,object:'subscription',livemode:false,customer:'cus_fixture',status:['active','active','past_due','canceled'][Math.min(reads,3)],
      metadata:checkout.metadata,items:{data:[{price:{id:checkout.metadata.opentoken_price},
        current_period_end:Math.floor(Date.now()/1000)+(reads===0 ? 3_600 : 7_200)}]}});
  }
  if (path==='/v1/billing_portal/sessions' && options.method==='POST') {
    const form = new URLSearchParams(String(options.body));
    if (form.get('customer')!=='cus_fixture' || form.get('configuration')!=='bpc_fixture') throw new Error('Unexpected Stripe portal customer or configuration');
    return reply({id:'bps_fixture',object:'billing_portal.session',livemode:false,url:'https://billing.stripe.com/p/session/fixture'});
  }
  if (path==='/v1/billing_portal/configurations/bpc_fixture') return reply({
    id:'bpc_fixture',object:'billing_portal.configuration',livemode:false,active:true,
    features:{subscription_cancel:{enabled:true,mode:'at_period_end'}},
  });
  if (path.startsWith('/v1/refunds/re_fixture_')) {
    const id=path.split('/').pop();
    const asUuid=hex=>hex.replace(/^(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})$/,'$1-$2-$3-$4-$5');
    const [order,request,state]=id.slice('re_fixture_'.length).split('_').map(asUuid);
    return reply({id,object:'refund',currency:'usd',payment_intent:'pi_'+order,amount:200,status:state,
      metadata:{opentoken_order:order,opentoken_refund:request}});
  }
  throw new Error('Unexpected Stripe fixture request');
}

globalThis.fetch = async (input,options) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin==='http://127.0.0.1' || url.origin.startsWith('http://127.0.0.1:')) return originalFetch(input,options);
  if (url.origin==='https://api.stripe.com') return stripeFixture(url,options);
  if (url.href==='https://managed-provider.example/v1/chat/completions') {
    const model = JSON.parse(options.body).model;
    const auth = new Headers(options.headers).get('authorization');
    if (options.redirect!=='error' || !['Bearer test-provider-blue','Bearer test-provider-green','Bearer test-provider-bad'].includes(auth)) {
      throw new Error('Unexpected managed channel credentials or redirect policy');
    }
    if (auth==='Bearer test-provider-bad') return new Response('denied',{status:401});
    if (model==='vendor/timeout') return new Response(new ReadableStream({start(controller) {
      controller.error(new DOMException('fixture timeout','TimeoutError'));
    }}));
    if (!['vendor/managed','vendor/no-cache'].includes(model)) return new Response('not found',{status:404});
    await new Promise(resolve=>setTimeout(resolve,650));
    const content = auth.endsWith('blue') ? 'blue' : 'green';
    const body = JSON.parse(options.body);
    const usage = {prompt_tokens:14,completion_tokens:2,...(model==='vendor/no-cache'?{}:{prompt_tokens_details:{cached_tokens:4}})};
    if (body.stream) {
      const frame = (choices,extra)=>'data: '+JSON.stringify({id:'managed-sse',model,object:'chat.completion.chunk',choices,...extra})+'\n\n';
      return new Response(frame([{index:0,delta:{content},finish_reason:'stop'}])+frame([],{usage})+'data: [DONE]\n\n',
        {headers:{'content-type':'text/event-stream'}});
    }
    return Response.json({model,choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage});
  }
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
