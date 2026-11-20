import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const origin = 'https://opentoken-pilot.onrender.com';
const outputDirectory = new URL('../.demo-data/', import.meta.url);
const latestResult = new URL('pilot-health-scheduled.json', outputDirectory);
const temporaryResult = new URL(`pilot-health-${process.pid}.tmp`, outputDirectory);
const startedAt = new Date().toISOString();

async function probe(path, timeout, responseCheck) {
  try {
    const response = await fetch(origin + path, {redirect:'error', signal:AbortSignal.timeout(timeout)});
    return await responseCheck(response) ? response.status : null;
  } catch {
    return null;
  }
}

let health, login;
for (let attempt = 1; attempt <= 2; attempt++) {
  [health, login] = await Promise.all([
    probe('/api/health', 75_000, async response => response.status===200 && (await response.json()).status==='ok'),
    probe('/login', 75_000, async response => response.status===200 && (await response.text()).includes('OpenToken')),
  ]);
  if (health===200 && login===200) break;
  if (attempt===1) await delay(25_000);
}

const passed = health===200 && login===200;
const previous = await readFile(latestResult,'utf8').then(JSON.parse).catch(() => null);
const failureSince = passed ? null : (
  previous?.passed===false && typeof previous.failureSince==='string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(previous.failureSince)
    ? previous.failureSince : startedAt
);
const result = {startedAt, finishedAt:new Date().toISOString(), passed, health, login, failureSince};
await mkdir(outputDirectory, {recursive:true});
await writeFile(temporaryResult, JSON.stringify(result, null, 2)+'\n');
await rename(temporaryResult, latestResult);
console.log(JSON.stringify(result));
if (!passed) process.exitCode = 1;
