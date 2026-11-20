/**
 * @param {string | undefined} connectionString
 * @param {{application?:boolean, caBase64?:string}} [options]
 */
export function postgresConnectionOptions(connectionString,{application=false,caBase64=process.env.DATABASE_CA_BASE64}={}) {
  if (!connectionString) throw new Error('A PostgreSQL connection string is required');
  const url = new URL(connectionString);
  if (!['postgres:','postgresql:'].includes(url.protocol)) throw new Error('Use a PostgreSQL connection string');
  const query = [...url.searchParams];
  if (url.hash || query.length>1 || query.some(([key,value])=>key!=='sslmode' || value!=='verify-full')) {
    throw new Error('Use a plain PostgreSQL URI with at most one sslmode=verify-full');
  }
  if (['127.0.0.1','localhost'].includes(url.hostname)) return {connectionString};
  if (url.searchParams.get('sslmode')!=='verify-full') throw new Error('Use sslmode=verify-full for remote PostgreSQL');
  if (application && decodeURIComponent(url.username).split('.')[0]!=='opentoken_app') {
    throw new Error('Use the opentoken_app role for the application database');
  }
  if (!caBase64) return {connectionString};
  if (caBase64.length>32768 || !/^[A-Za-z0-9+/]+={0,2}$/.test(caBase64) || caBase64.length%4) {
    throw new Error('DATABASE_CA_BASE64 must contain a base64-encoded PEM certificate');
  }
  const ca = Buffer.from(caBase64,'base64').toString('utf8');
  if (!ca.trim().startsWith('-----BEGIN CERTIFICATE-----') || !ca.trim().endsWith('-----END CERTIFICATE-----')) {
    throw new Error('DATABASE_CA_BASE64 must contain a base64-encoded PEM certificate');
  }
  // node-postgres replaces a supplied SSL object when the URI contains sslmode.
  url.search = '';
  return {connectionString:url.href,ssl:{ca,rejectUnauthorized:true,servername:url.hostname}};
}
