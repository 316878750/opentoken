import { isIP } from 'node:net';
import * as z from 'zod';
import { digest } from './data';

export const channelRoutingLock = 961020036;

const keyRef = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
const keyEnv = z.string().regex(/^CHANNEL_[A-Z0-9_]{1,70}$/).refine(name=>name!=='CHANNEL_CREDENTIALS_JSON');
const credentialSchema = z.record(keyRef,z.discriminatedUnion('type',[
  z.strictObject({type:z.literal('official'),env:keyEnv}),
  z.strictObject({type:z.literal('compatible'),env:keyEnv,baseUrl:z.url().max(500)}),
]));

function completionEndpoint(baseUrl:string) {
  const url = new URL(baseUrl);
  const host = url.hostname.replace(/\.$/,'');
  if (url.protocol!=='https:' || url.port || url.username || url.password || url.search || url.hash ||
      !host.includes('.') || host.endsWith('.localhost') || host.endsWith('.local') || isIP(host) ||
      host==='api.openai.com' || url.hostname!==host) throw new Error('Invalid approved channel destination');
  const path = url.pathname.replace(/\/+$/,'');
  url.pathname = path.endsWith('/chat/completions') ? path : path+'/chat/completions';
  return url.href;
}

export function channelCredentials() {
  let source:unknown;
  try { source = JSON.parse(process.env.CHANNEL_CREDENTIALS_JSON?.trim() || '{}'); }
  catch { throw new Error('Invalid channel credential registry'); }
  const registered = credentialSchema.safeParse(source);
  if (!registered.success) throw new Error('Invalid channel credential registry');
  const destinations = new Map<string,string>();
  return Object.entries(registered.data).map(([ref,entry])=>{
    const apiKey = process.env[entry.env]?.trim() || '';
    const endpoint = entry.type==='official' ? 'https://api.openai.com/v1/chat/completions' : completionEndpoint(entry.baseUrl);
    const registeredDestination = destinations.get(entry.env);
    if (registeredDestination && registeredDestination!==endpoint) throw new Error('A channel credential must have one destination');
    destinations.set(entry.env,endpoint);
    const fingerprint = apiKey ? digest('channel-credential',JSON.stringify([ref,entry.type,endpoint,apiKey])).toString('hex') : null;
    return {ref,type:entry.type,endpoint,apiKey,fingerprint};
  });
}

export type ChannelCredential = ReturnType<typeof channelCredentials>[number];
