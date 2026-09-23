import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {Database,Sql} from '../platform/database.js';
import {AppError,requireCondition} from '../platform/errors.js';
import {record} from '../platform/commands.js';
import type {Account} from './auth.js';
import {publicAccount} from './auth.js';
import {issueNativeSession} from './native-auth.js';
import {normalizeEmail,normalizePhone} from './providers.js';
import {registerProfile} from './registration.js';
import type {CountryCode} from 'libphonenumber-js/max';
import {grantSandboxAccess} from './sandbox.js';

const authorizationEndpoint='https://accounts.google.com/o/oauth2/v2/auth';
const tokenEndpoint='https://oauth2.googleapis.com/token';
const userInfoEndpoint='https://www.googleapis.com/oauth2/v3/userinfo';
const challengeSeconds=10*60;
const registrationSeconds=15*60;
const issuer='afridict:native';

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const randomToken=()=>randomBytes(32).toString('base64url');
const challenge=(verifier:string)=>createHash('sha256').update(verifier).digest('base64url');

export interface GoogleIdentity {
  subject:string;email:string;emailVerified:boolean;emailAuthoritative:boolean;givenName?:string;familyName?:string;
}
export interface GoogleOAuthProvider {
  authorizationUrl(input:{state:string;codeChallenge:string}):string;
  exchange(input:{code:string;codeVerifier:string}):Promise<GoogleIdentity>;
}

type Fetch=typeof globalThis.fetch;
export class DirectGoogleOAuthProvider implements GoogleOAuthProvider {
  constructor(private readonly options:{clientId:string;clientSecret:string;redirectUri:string},
    private readonly request:Fetch=globalThis.fetch){}
  authorizationUrl(input:{state:string;codeChallenge:string}){
    const query=new URLSearchParams({client_id:this.options.clientId,redirect_uri:this.options.redirectUri,
      response_type:'code',scope:'email profile',state:input.state,code_challenge:input.codeChallenge,
      code_challenge_method:'S256',prompt:'select_account'});
    return `${authorizationEndpoint}?${query.toString()}`;
  }
  async exchange(input:{code:string;codeVerifier:string}){
    let tokenResponse:Response;
    try {tokenResponse=await this.request(tokenEndpoint,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({client_id:this.options.clientId,client_secret:this.options.clientSecret,
        code:input.code,code_verifier:input.codeVerifier,grant_type:'authorization_code',redirect_uri:this.options.redirectUri}),
      signal:AbortSignal.timeout(5000)});} catch {throw new AppError(503,'GOOGLE_AUTHENTICATION_UNAVAILABLE','Google authentication is temporarily unavailable.');}
    if(!tokenResponse.ok)throw new AppError(401,'GOOGLE_AUTHENTICATION_FAILED','Google could not verify this sign-in attempt.');
    let token:unknown;
    try {token=await tokenResponse.json();}catch{throw new AppError(502,'GOOGLE_RESPONSE_INVALID','Google returned an invalid authentication response.');}
    const tokenFields=token as {access_token?:unknown;token_type?:unknown};
    requireCondition(typeof tokenFields.access_token==='string'&&typeof tokenFields.token_type==='string'&&
      tokenFields.token_type.toLowerCase()==='bearer',502,'GOOGLE_RESPONSE_INVALID',
      'Google could not verify this sign-in attempt.');
    let identityResponse:Response;
    try {identityResponse=await this.request(userInfoEndpoint,{headers:{authorization:`Bearer ${tokenFields.access_token}`},
      signal:AbortSignal.timeout(5000)});} catch {throw new AppError(503,'GOOGLE_AUTHENTICATION_UNAVAILABLE','Google authentication is temporarily unavailable.');}
    if(!identityResponse.ok)throw new AppError(401,'GOOGLE_AUTHENTICATION_FAILED','Google could not verify this sign-in attempt.');
    let identityValue:unknown;
    try {identityValue=await identityResponse.json();}catch{throw new AppError(502,'GOOGLE_RESPONSE_INVALID','Google returned an invalid identity response.');}
    const identity=identityValue as {sub?:unknown;email?:unknown;email_verified?:unknown;given_name?:unknown;family_name?:unknown;hd?:unknown};
    requireCondition(typeof identity.sub==='string'&&identity.sub.length>0&&identity.sub.length<=255&&
      typeof identity.email==='string'&&identity.email_verified===true,401,'GOOGLE_EMAIL_NOT_VERIFIED',
      'Google must provide a verified email address.');
    let email:string;
    try {email=normalizeEmail(identity.email);}catch{throw new AppError(502,'GOOGLE_RESPONSE_INVALID','Google returned an invalid identity response.');}
    return {subject:identity.sub,email,emailVerified:true,emailAuthoritative:email.endsWith('@gmail.com')||
      typeof identity.hd==='string'&&identity.hd.length>0,
      givenName:typeof identity.given_name==='string'?identity.given_name.slice(0,100):undefined,
      familyName:typeof identity.family_name==='string'?identity.family_name.slice(0,100):undefined};
  }
}

interface ChallengeRow {id:string;intent:'login'|'link';account_id:string|null;code_verifier:string;expires_at:Date}

export async function beginGoogleAuthorization(sql:Sql,provider:GoogleOAuthProvider,intent:'login'|'link',accountId?:string){
  requireCondition((intent==='link')===Boolean(accountId),500,'GOOGLE_AUTHENTICATION_MISCONFIGURED','Google authentication is not configured correctly.');
  await sql.query("DELETE FROM google_auth_challenges WHERE expires_at<now()-interval '1 day'");
  const state=randomToken(),verifier=randomToken(),expires=new Date(Date.now()+challengeSeconds*1000);
  await sql.query(`INSERT INTO google_auth_challenges(id,state_hash,code_verifier,intent,account_id,expires_at)
    VALUES ($1,$2,$3,$4,$5,$6)`,[randomUUID(),digest(state),verifier,intent,accountId??null,expires]);
  return {authorization_url:provider.authorizationUrl({state,codeChallenge:challenge(verifier)}),expires_in:challengeSeconds};
}

async function consumeChallenge(db:Database,state:string,intent:'login'|'link',accountId?:string){
  requireCondition(/^[A-Za-z0-9_-]{43}$/.test(state),400,'INVALID_GOOGLE_AUTHORIZATION','The Google authorization attempt is invalid or expired.');
  const row=await db.transaction(async sql=>{
    const value=(await sql.query<ChallengeRow>(`SELECT id,intent,account_id,code_verifier,expires_at FROM google_auth_challenges
      WHERE state_hash=$1 AND consumed_at IS NULL FOR UPDATE`,[digest(state)])).rows[0];
    requireCondition(value&&value.intent===intent&&value.account_id===(accountId??null)&&new Date(value.expires_at)>new Date(),
      400,'INVALID_GOOGLE_AUTHORIZATION','The Google authorization attempt is invalid or expired.');
    await sql.query('UPDATE google_auth_challenges SET consumed_at=now() WHERE id=$1',[value.id]);
    return value;
  });
  return row.code_verifier;
}

async function activeAccount(sql:Sql,accountId:string){
  const account=(await sql.query<Account>('SELECT * FROM accounts WHERE id=$1 FOR SHARE',[accountId])).rows[0];
  requireCondition(account?.status==='active',403,'ACCOUNT_RESTRICTED','This account cannot sign in.');
  return account;
}

export async function loginWithGoogle(db:Database,provider:GoogleOAuthProvider,input:{code:string;state:string},requestId:string){
  const verifier=await consumeChallenge(db,input.state,'login');
  const identity=await provider.exchange({code:input.code,codeVerifier:verifier});
  return db.transaction(async sql=>{
    const linked=(await sql.query<{account_id:string}>('SELECT account_id FROM google_identities WHERE google_subject=$1 FOR SHARE',[identity.subject])).rows[0];
    if(linked){
      const account=await activeAccount(sql,linked.account_id);
      await record(sql,{actor:account.id,authority:'google_account',action:'session.created',resource:account.id,
        request:requestId,reason:'Direct Google authentication succeeded'});
      return {state:'authenticated' as const,...await issueNativeSession(sql,account.id),account:publicAccount(account)};
    }
    const existing=(await sql.query<{account_id:string}>('SELECT account_id FROM auth_credentials WHERE email=$1',[identity.email])).rows[0];
    if(existing)return {state:'link_required' as const,email:identity.email};
    const registrationToken=randomToken();
    await sql.query("DELETE FROM google_registration_tokens WHERE expires_at<now()-interval '1 day' OR consumed_at<now()-interval '1 day'");
    await sql.query(`INSERT INTO google_registration_tokens(id,token_hash,google_subject,email,email_authoritative,expires_at)
      VALUES ($1,$2,$3,$4,$5,now()+interval '15 minutes')`,[randomUUID(),digest(registrationToken),identity.subject,
      identity.email,identity.emailAuthoritative]);
    return {state:'registration_required' as const,registration_token:registrationToken,email:identity.email,
      given_name:identity.givenName??null,family_name:identity.familyName??null,expires_in:registrationSeconds};
  });
}

export async function linkGoogleAccount(db:Database,provider:GoogleOAuthProvider,account:Account,input:{code:string;state:string},requestId:string){
  const verifier=await consumeChallenge(db,input.state,'link',account.id);
  const identity=await provider.exchange({code:input.code,codeVerifier:verifier});
  return db.transaction(async sql=>{
    await activeAccount(sql,account.id);
    const subjectOwner=(await sql.query<{account_id:string}>('SELECT account_id FROM google_identities WHERE google_subject=$1 FOR SHARE',[identity.subject])).rows[0];
    requireCondition(!subjectOwner||subjectOwner.account_id===account.id,409,'GOOGLE_ACCOUNT_ALREADY_LINKED','This Google account is linked to another Afridict account.');
    const accountIdentity=(await sql.query<{google_subject:string}>('SELECT google_subject FROM google_identities WHERE account_id=$1 FOR SHARE',[account.id])).rows[0];
    requireCondition(!accountIdentity||accountIdentity.google_subject===identity.subject,409,'AFRIDICT_ACCOUNT_ALREADY_LINKED','This Afridict account already has a different Google account.');
    if(!accountIdentity)await sql.query('INSERT INTO google_identities(google_subject,account_id,email_at_link) VALUES ($1,$2,$3)',
      [identity.subject,account.id,identity.email]);
    await record(sql,{actor:account.id,authority:'account_owner',action:'google_account.linked',resource:account.id,
      request:requestId,reason:'Account owner completed direct Google authorization'});
    return {linked:true as const,email:identity.email};
  });
}

export async function registerGoogleAccount(db:Database,input:{registrationToken:string;jurisdiction:string;firstName:string;lastName:string;
  phoneNumber:string;termsVersion:string;privacyVersion:string},requestId:string,sandboxAccess=false){
  let phone:string;
  try {phone=normalizePhone(input.phoneNumber,input.jurisdiction as CountryCode);}catch{throw new AppError(400,'INVALID_PHONE_NUMBER','Supply a valid phone number in international format.');}
  return db.transaction(async sql=>{
    const pending=(await sql.query<{id:string;google_subject:string;email:string;email_authoritative:boolean;expires_at:Date}>(`SELECT id,google_subject,email,email_authoritative,expires_at
      FROM google_registration_tokens WHERE token_hash=$1 AND consumed_at IS NULL FOR UPDATE`,[digest(input.registrationToken)])).rows[0];
    requireCondition(pending&&new Date(pending.expires_at)>new Date(),400,'INVALID_GOOGLE_REGISTRATION','The Google registration attempt is invalid or expired.');
    const linked=(await sql.query('SELECT 1 FROM google_identities WHERE google_subject=$1',[pending.google_subject])).rows[0];
    requireCondition(!linked,409,'GOOGLE_ACCOUNT_ALREADY_LINKED','This Google account is already linked.');
    const contact=(await sql.query('SELECT 1 FROM account_profiles WHERE email=$1 OR phone_e164=$2',[pending.email,phone])).rows[0];
    requireCondition(!contact,409,'CONTACT_ALREADY_REGISTERED','This contact is already associated with another account. Sign in and link Google from account settings.');
    const id=randomUUID();
    const account=(await sql.query<Account>(`INSERT INTO accounts(id,issuer,subject,jurisdiction) VALUES ($1,$2,$3,$4) RETURNING *`,
      [id,issuer,id,input.jurisdiction])).rows[0]!;
    await sql.query(`INSERT INTO eligibility(account_id,status,policy_version) VALUES ($1,'pending','unassigned')`,[id]);
    await registerProfile(sql,account,{first_name:input.firstName,last_name:input.lastName,email:pending.email,phone_number:phone,
      terms_version:input.termsVersion,privacy_version:input.privacyVersion,accepted_at:new Date().toISOString()});
    if(pending.email_authoritative)await sql.query('UPDATE account_assurance SET email_verified_at=now() WHERE account_id=$1',[id]);
    if(sandboxAccess)await grantSandboxAccess(sql,id);
    await sql.query('INSERT INTO google_identities(google_subject,account_id,email_at_link) VALUES ($1,$2,$3)',
      [pending.google_subject,id,pending.email]);
    await sql.query('UPDATE google_registration_tokens SET consumed_at=now() WHERE id=$1',[pending.id]);
    await record(sql,{actor:id,authority:'google_account',action:'account.registered',resource:id,request:requestId,
      reason:'Direct Google registration completed'});
    return {state:'authenticated' as const,...await issueNativeSession(sql,id),account:publicAccount(account)};
  });
}
