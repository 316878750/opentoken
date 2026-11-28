import * as z from 'zod';
import { store } from './data';
import { Fault } from './gateway';
import { redeemAmountMicros } from './redeem-code.mjs';

const micros = z.string().regex(/^(0|[1-9]\d{0,18})$/).refine(value=>value.length<19 || (value.length===19 && value<='9223372036854775807'));
const values = z.strictObject({
  announcement:z.string().trim().max(1000).refine(text=>!text.includes('\0')),
  supportUrl:z.string().max(512).refine(value=>{
    if (!value) return true;
    try {
      return /^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[^\s?#\\]*)?$/.test(value) && Boolean(new URL(value).hostname);
    } catch { return false; }
  }),
  timeZone:z.string().max(80).regex(/^(UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/).refine(zone=>{
    try { new Intl.DateTimeFormat('en',{timeZone:zone}); return true; } catch { return false; }
  }),
  singleMicros:micros,dailyMicros:micros,
});
const version = z.int().nonnegative().max(2147483646);
const base = {expectedVersion:version,reason:z.string().trim().min(1).max(200).refine(text=>!text.includes('\0'))};
export const settingsChange = z.union([z.strictObject({...base,settings:values}),z.strictObject({...base,restoreVersion:version})]);
export const settingsPage = z.strictObject({before:z.string().regex(/^\d{1,10}$/).transform(Number).pipe(version).optional()});
export type SettingVersion = z.infer<typeof values> & {version:number};
export type SettingsRead = {current:SettingVersion;history?:SettingVersion[]};

function legacyLimits() {
  return [redeemAmountMicros(process.env.OPERATOR_REDEEM_SINGLE_USD)??'0',redeemAmountMicros(process.env.OPERATOR_REDEEM_DAILY_USD)??'0'];
}
export async function siteDisplay() {
  const {rows:[{display}]} = await store().db.query<{display:Pick<SettingVersion,'announcement'|'supportUrl'|'timeZone'>}>(
    'SELECT gateway.site_display() AS display');
  return display;
}
export async function readSettings(actor:string,before?:number) {
  const {rows:[{page}]} = await store().db.query<{page:SettingsRead|null}>(
    'SELECT gateway.admin_settings($1,$2,$3,$4) AS page',[actor,...legacyLimits(),before??null]);
  if (!page) throw new Fault(403,'settings_forbidden','当前角色无法查看系统设置。');
  return page;
}
export async function writeSettings(actor:string,change:z.infer<typeof settingsChange>,recent:boolean) {
  const {rows:[{saved}]} = await store().db.query<{saved:{result:string;version:number;requestId:string}}>(
    'SELECT gateway.write_settings($1,$2,$3,$4,$5,$6,$7,$8) AS saved',
    [actor,change.expectedVersion,'restoreVersion' in change?change.restoreVersion:null,
      'settings' in change?JSON.stringify(change.settings):null,change.reason,recent,...legacyLimits()]);
  if (saved.result==='ok') return {version:saved.version,requestId:saved.requestId};
  const errors:Record<string,[number,string]> = {forbidden:[403,'仅系统管理员可以变更设置。'],
    admin_recent_auth_required:[403,'请重新登录后再提交。'],version_conflict:[409,'设置版本已更新，请重新加载再编辑。'],
    invalid_settings:[400,'设置值或回退版本无效。']};
  const error = errors[saved.result];
  if (!error) throw new Error('Unknown settings result');
  throw new Fault(error[0],saved.result,error[1],saved.requestId);
}
