import { buildApp } from './app.js';
import { PersonaIdentityProvider,TwilioVerifyProvider } from './identity/providers.js';
import { SwervpayClient } from './funding/swervpay.js';
import { config } from './platform/config.js';
import { postgres } from './platform/database.js';

const cfg = config();
if (cfg.authMode === 'demo') throw new Error('Use npm run demo for the isolated synthetic environment');
if (!cfg.databaseUrl) throw new Error('DATABASE_URL is required');
const db = postgres(cfg.databaseUrl);
const contactValues=[process.env.TWILIO_VERIFY_SERVICE_SID,process.env.TWILIO_API_KEY_SID,
  process.env.TWILIO_API_KEY_SECRET,process.env.ABUSE_HASH_KEY];
if(contactValues.some(Boolean)&&!contactValues.every(Boolean)) throw new Error('Contact verification configuration is incomplete');
if(process.env.ABUSE_HASH_KEY&&process.env.ABUSE_HASH_KEY.length<32) throw new Error('ABUSE_HASH_KEY must contain at least 32 characters');
const contactDependencies=contactValues.every(Boolean)?{provider:new TwilioVerifyProvider({
  serviceSid:process.env.TWILIO_VERIFY_SERVICE_SID!,apiKeySid:process.env.TWILIO_API_KEY_SID!,
  apiKeySecret:process.env.TWILIO_API_KEY_SECRET!}),abuseHashKey:process.env.ABUSE_HASH_KEY!}:undefined;
const personaValues=[process.env.PERSONA_API_KEY,process.env.PERSONA_INQUIRY_TEMPLATE_ID,
  process.env.PERSONA_API_VERSION,process.env.PERSONA_WEBHOOK_SECRETS];
if(personaValues.some(Boolean)&&!personaValues.every(Boolean)) throw new Error('Persona identity verification configuration is incomplete');
const personaSecrets=process.env.PERSONA_WEBHOOK_SECRETS?.split(',').map(value=>value.trim()).filter(Boolean)??[];
if(personaSecrets.some(secret=>secret.length<32)) throw new Error('Each Persona webhook secret must contain at least 32 characters');
const personaDependencies=personaValues.every(Boolean)?{provider:new PersonaIdentityProvider({apiKey:process.env.PERSONA_API_KEY!,
  templateId:process.env.PERSONA_INQUIRY_TEMPLATE_ID!,version:process.env.PERSONA_API_VERSION!}),webhookSecrets:personaSecrets}:undefined;
const swervpayValues=[process.env.SWERVPAY_ENVIRONMENT,process.env.SWERVPAY_BUSINESS_ID,process.env.SWERVPAY_SECRET_KEY,
  process.env.SWERVPAY_DATA_HASH_KEY,process.env.SWERVPAY_DATA_ENCRYPTION_KEY];
if(swervpayValues.some(Boolean)&&!swervpayValues.every(Boolean))throw new Error('Swervpay sandbox configuration is incomplete');
if(process.env.SWERVPAY_ENVIRONMENT&&process.env.SWERVPAY_ENVIRONMENT!=='sandbox')
  throw new Error('Swervpay production activation requires commercial, finance and security approval');
if(process.env.SWERVPAY_DATA_HASH_KEY&&process.env.SWERVPAY_DATA_HASH_KEY.length<32)throw new Error('SWERVPAY_DATA_HASH_KEY must contain at least 32 characters');
const encryptionKey=process.env.SWERVPAY_DATA_ENCRYPTION_KEY?Buffer.from(process.env.SWERVPAY_DATA_ENCRYPTION_KEY,'base64'):undefined;
if(encryptionKey&&encryptionKey.length!==32)throw new Error('SWERVPAY_DATA_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
const fiatDependencies=swervpayValues.every(Boolean)?{provider:new SwervpayClient({businessId:process.env.SWERVPAY_BUSINESS_ID!,
  secretKey:process.env.SWERVPAY_SECRET_KEY!,baseUrl:'https://sandbox.swervpay.co/api/v1'}),environment:'sandbox' as const,
  dataHashKey:process.env.SWERVPAY_DATA_HASH_KEY!,dataEncryptionKey:encryptionKey!,keyVersion:'environment-v1'}:undefined;
const app = await buildApp(db,cfg,undefined,undefined,contactDependencies,personaDependencies,fiatDependencies);
try {
  await db.query('SELECT id FROM accounts LIMIT 1');
  if (cfg.environment === 'production') {
    const privileges = (await db.query<{ audit_update: boolean; audit_delete: boolean; registry_update: boolean;
      role_update: boolean; journal_update: boolean; journal_delete: boolean; journal_truncate: boolean;
      entry_update: boolean; entry_delete: boolean; entry_truncate: boolean; asset_update: boolean; wallet_update:boolean }>(`
      SELECT has_table_privilege(current_user,'audit_events','UPDATE') AS audit_update,
      has_table_privilege(current_user,'audit_events','DELETE') AS audit_delete,
      has_table_privilege(current_user,'policy_registry','UPDATE') AS registry_update,
      has_table_privilege(current_user,'accounts','UPDATE') AS role_update,
      has_table_privilege(current_user,'ledger_journals','UPDATE') AS journal_update,
      has_table_privilege(current_user,'ledger_journals','DELETE') AS journal_delete,
      has_table_privilege(current_user,'ledger_journals','TRUNCATE') AS journal_truncate,
      has_table_privilege(current_user,'ledger_entries','UPDATE') AS entry_update,
      has_table_privilege(current_user,'ledger_entries','DELETE') AS entry_delete,
      has_table_privilege(current_user,'ledger_entries','TRUNCATE') AS entry_truncate,
      has_table_privilege(current_user,'financial_assets','UPDATE') AS asset_update,
      has_table_privilege(current_user,'smart_accounts','UPDATE') AS wallet_update`)).rows[0];
    if (!privileges || Object.values(privileges).some(Boolean))
      throw new Error('Runtime database role has excessive privileges');
  }
  await app.listen({ host: cfg.host, port: cfg.port });
} catch (error) {
  app.log.error({ error }, 'Startup failed; verify database migration and service configuration.');
  await app.close(); await db.close(); process.exitCode = 1;
}
async function stop() { await app.close(); await db.close(); }
process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
