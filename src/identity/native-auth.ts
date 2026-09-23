import { createHash, randomBytes, randomUUID, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import type { Database, Sql } from '../platform/database.js';
import { AppError, requireCondition } from '../platform/errors.js';
import { record } from '../platform/commands.js';
import { normalizeEmail, normalizePhone, type ContactVerificationProvider } from './providers.js';
import { registerProfile, type RegistrationProfile } from './registration.js';
import type { Account, Authenticator } from './auth.js';
import type { CountryCode } from 'libphonenumber-js/max';
import {grantSandboxAccess} from './sandbox.js';

const issuer = 'afridict:native';
const keyLength = 32;
const sessionSeconds = 24 * 60 * 60;
const passwordOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const fakeSalt = Buffer.alloc(16, 91).toString('base64');
let fakeHash: Promise<string> | undefined;

type Credential = { account_id:string; email:string; password_salt:string; password_hash:string; failed_attempts:number; locked_until:Date|null };
export type NativeRegistration = RegistrationProfile & { jurisdiction:string; password:string };

const digest = (token:string) => createHash('sha256').update(token).digest('hex');
async function derive(password:string,salt:string) {
  const value=await new Promise<Buffer>((resolve,reject)=>nodeScrypt(password,Buffer.from(salt,'base64'),keyLength,passwordOptions,
    (error,key)=>error?reject(error):resolve(key)));
  return value.toString('base64');
}
function validatePassword(password:string) {
  requireCondition(password.length>=12&&password.length<=128,400,'WEAK_PASSWORD','Use a password containing at least 12 characters.');
  requireCondition(/[a-z]/.test(password)&&/[A-Z]/.test(password)&&/[0-9]/.test(password),400,'WEAK_PASSWORD','Use upper-case, lower-case and numeric characters.');
}
async function passwordRecord(password:string) {
  validatePassword(password);
  const salt=randomBytes(16).toString('base64');
  return {salt,hash:await derive(password,salt)};
}
async function matches(password:string,row?:Credential) {
  const expected=row?.password_hash??(await (fakeHash??=derive('Afridict constant timing password',fakeSalt)));
  const actual=await derive(password,row?.password_salt??fakeSalt);
  return timingSafeEqual(Buffer.from(actual,'base64'),Buffer.from(expected,'base64'));
}
export async function issueNativeSession(sql:Sql,accountId:string) {
  const token=randomBytes(32).toString('base64url');
  const expires=new Date(Date.now()+sessionSeconds*1000);
  await sql.query('INSERT INTO auth_sessions(id,account_id,token_hash,expires_at) VALUES ($1,$2,$3,$4)',
    [randomUUID(),accountId,digest(token),expires]);
  return {access_token:token,token_type:'Bearer' as const,expires_in:sessionSeconds};
}

export function nativeAuthenticator(db:Database):Authenticator {
  return {async verify(token) {
    requireCondition(/^[A-Za-z0-9_-]{43}$/.test(token),401,'UNAUTHENTICATED','A valid access token is required.');
    const row=(await db.query<{account_id:string;expires_at:Date}>(`SELECT account_id,expires_at FROM auth_sessions
      WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()`,[digest(token)])).rows[0];
    requireCondition(row,401,'UNAUTHENTICATED','A valid access token is required.');
    return {issuer,subject:row.account_id,expiresAt:new Date(row.expires_at).toISOString()};
  }};
}

export async function registerNativeAccount(db:Database,input:NativeRegistration,requestId:string,emailVerificationRequired=false,
  sandboxAccess=false) {
  const email=normalizeEmail(input.email); validatePassword(input.password);
  let phone:string;
  try { phone=normalizePhone(input.phone_number,input.jurisdiction as CountryCode); }
  catch { throw new AppError(400,'INVALID_PHONE_NUMBER','Supply a valid phone number in international format.'); }
  const credential=await passwordRecord(input.password);
  return db.transaction(async sql=>{
    const collision=(await sql.query('SELECT 1 FROM auth_credentials WHERE email=$1',[email])).rows[0];
    requireCondition(!collision,409,'ACCOUNT_ALREADY_EXISTS','An account already exists for this email address.');
    const id=randomUUID();
    const account=(await sql.query<Account>(`INSERT INTO accounts(id,issuer,subject,jurisdiction) VALUES ($1,$2,$3,$4) RETURNING *`,
      [id,issuer,id,input.jurisdiction])).rows[0]!;
    await sql.query(`INSERT INTO eligibility(account_id,status,policy_version) VALUES ($1,'pending','unassigned')`,[id]);
    await sql.query(`INSERT INTO auth_credentials(account_id,email,password_salt,password_hash) VALUES ($1,$2,$3,$4)`,
      [id,email,credential.salt,credential.hash]);
    await registerProfile(sql,account,{...input,email,phone_number:phone});
    if(!emailVerificationRequired) await sql.query('UPDATE account_assurance SET email_verified_at=now() WHERE account_id=$1',[id]);
    if(sandboxAccess)await grantSandboxAccess(sql,id);
    await record(sql,{actor:id,authority:'account_owner',action:'account.registered',resource:id,request:requestId,
      reason:'Native email and password registration completed'});
    return {session:await issueNativeSession(sql,id),account};
  });
}

export async function loginNativeAccount(db:Database,emailInput:string,password:string,requestId:string) {
  const email=normalizeEmail(emailInput);
  const result=await db.transaction(async sql=>{
    const row=(await sql.query<Credential>(`SELECT * FROM auth_credentials WHERE email=$1 FOR UPDATE`,[email])).rows[0];
    const valid=await matches(password,row);
    if(!row||row.locked_until&&new Date(row.locked_until)>new Date()||!valid) {
      if(row) await sql.query(`UPDATE auth_credentials SET failed_attempts=failed_attempts+1,
        locked_until=CASE WHEN failed_attempts+1>=5 THEN now()+interval '15 minutes' ELSE locked_until END WHERE account_id=$1`,[row.account_id]);
      return null;
    }
    await sql.query('UPDATE auth_credentials SET failed_attempts=0,locked_until=NULL WHERE account_id=$1',[row.account_id]);
    await record(sql,{actor:row.account_id,authority:'account_owner',action:'session.created',resource:row.account_id,
      request:requestId,reason:'Native password authentication succeeded'});
    return issueNativeSession(sql,row.account_id);
  });
  if(!result) throw new AppError(401,'INVALID_CREDENTIALS','The email or password is incorrect.');
  return result;
}

export async function revokeNativeSession(sql:Sql,token:string,accountId:string,requestId:string) {
  await sql.query('UPDATE auth_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE token_hash=$1 AND account_id=$2',[digest(token),accountId]);
  await record(sql,{actor:accountId,authority:'account_owner',action:'session.revoked',resource:accountId,request:requestId,reason:'Account signed out'});
}

export async function requestPasswordReset(db:Database,provider:ContactVerificationProvider|undefined,emailInput:string) {
  const email=normalizeEmail(emailInput);
  if(!provider) throw new AppError(503,'RECOVERY_UNAVAILABLE','Password recovery is temporarily unavailable.');
  const row=(await db.query<{account_id:string}>(`SELECT account_id FROM auth_credentials WHERE email=$1`,[email])).rows[0];
  if(!row) { await matches('Afridict reset timing password'); return; }
  const sent=await provider.send({channel:'email',destination:email});
  await db.query(`INSERT INTO password_reset_challenges(id,account_id,provider_reference,expires_at)
    VALUES ($1,$2,$3,now()+interval '10 minutes')`,[randomUUID(),row.account_id,sent.reference]);
}

export async function confirmPasswordReset(db:Database,provider:ContactVerificationProvider|undefined,input:{email:string;code:string;password:string}) {
  if(!provider) throw new AppError(503,'RECOVERY_UNAVAILABLE','Password recovery is temporarily unavailable.');
  const email=normalizeEmail(input.email); const replacement=await passwordRecord(input.password);
  const candidate=(await db.query<{id:string;account_id:string;expires_at:Date;attempts:number}>(`SELECT r.id,r.account_id,r.expires_at,r.attempts
      FROM password_reset_challenges r JOIN auth_credentials c ON c.account_id=r.account_id
      WHERE c.email=$1 AND r.consumed_at IS NULL ORDER BY r.created_at DESC LIMIT 1`,[email])).rows[0];
  requireCondition(candidate&&new Date(candidate.expires_at)>new Date()&&candidate.attempts<5,400,'INVALID_RECOVERY_CODE','The recovery code is invalid or expired.');
  const check=await provider.check({channel:'email',destination:email,code:input.code});
  const changed=await db.transaction(async sql=>{
    const row=(await sql.query<{id:string;account_id:string;expires_at:Date;attempts:number}>(`SELECT id,account_id,expires_at,attempts
      FROM password_reset_challenges WHERE id=$1 AND consumed_at IS NULL FOR UPDATE`,[candidate.id])).rows[0];
    if(!row||new Date(row.expires_at)<=new Date()||row.attempts>=5)return false;
    if(check!=='approved') {
      await sql.query('UPDATE password_reset_challenges SET attempts=attempts+1 WHERE id=$1',[row.id]);
      return false;
    }
    await sql.query('UPDATE password_reset_challenges SET consumed_at=now() WHERE id=$1',[row.id]);
    await sql.query(`UPDATE auth_credentials SET password_salt=$2,password_hash=$3,password_changed_at=now(),failed_attempts=0,locked_until=NULL WHERE account_id=$1`,
      [row.account_id,replacement.salt,replacement.hash]);
    await sql.query('UPDATE auth_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE account_id=$1',[row.account_id]);
    return true;
  });
  requireCondition(changed,400,'INVALID_RECOVERY_CODE','The recovery code is invalid or expired.');
}
