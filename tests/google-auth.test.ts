import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {embeddedDatabase} from '../scripts/embedded.js';
import {buildApp} from '../src/app.js';
import {DirectGoogleOAuthProvider,type GoogleIdentity,type GoogleOAuthProvider} from '../src/identity/google-auth.js';
import type {Config} from '../src/platform/config.js';
import type {Database} from '../src/platform/database.js';
import {migrate} from '../src/platform/migrations.js';

const cfg:Config={environment:'test',host:'127.0.0.1',port:3000,authMode:'native',corsOrigins:[],docs:false,logger:false,
  financialMode:'disabled',authMethods:['password','google'],google:{clientId:'test-client',clientSecret:'test-secret',
    redirectUri:'http://127.0.0.1:5173/auth/google/callback'}};
const identities=new Map<string,GoogleIdentity>([
  ['new-user',{subject:'google-new-user',email:'new.google@gmail.com',emailVerified:true,emailAuthoritative:true,givenName:'Ngozi',familyName:'Okafor'}],
  ['native-owner',{subject:'google-native-owner',email:'native.owner@example.com',emailVerified:true,emailAuthoritative:false,givenName:'Ada',familyName:'Owner'}],
  ['external-user',{subject:'google-external-user',email:'external@example.com',emailVerified:true,emailAuthoritative:false}],
]);
const google:GoogleOAuthProvider={
  authorizationUrl({state,codeChallenge}){return `https://accounts.google.com/o/oauth2/v2/auth?state=${state}&code_challenge=${codeChallenge}`;},
  async exchange({code,codeVerifier}){expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);const identity=identities.get(code);
    if(!identity)throw new Error('unexpected test code');return identity;},
};
let db:Database,app:FastifyInstance;
const authorize=async(url:string,token?:string)=>{
  const response=await app.inject({method:'POST',url,headers:token?{authorization:`Bearer ${token}`}:{},payload:{}});
  expect(response.statusCode,response.body).toBe(201);const authorization=new URL(response.json<{authorization_url:string}>().authorization_url);
  expect(authorization.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return authorization.searchParams.get('state')!;
};

beforeAll(async()=>{db=await embeddedDatabase();await migrate(db);app=await buildApp(db,cfg,undefined,undefined,undefined,
  undefined,undefined,undefined,undefined,undefined,google);});
afterAll(async()=>{await app.close();await db.close();});

describe('direct Google authentication',()=>{
  it('registers a new verified Google identity and signs it in again',async()=>{
    const configuration=await app.inject({method:'GET',url:'/v1/auth/configuration'});
    expect(configuration.json()).toMatchObject({provider:'native',account_linking:'authenticated_explicit',
      methods:[{id:'password',enabled:true},{id:'google',enabled:true}]});
    const state=await authorize('/v1/auth/google/authorize');
    const exchanged=await app.inject({method:'POST',url:'/v1/auth/google/exchange',payload:{code:'new-user',state}});
    expect(exchanged.statusCode,exchanged.body).toBe(200);const pending=exchanged.json<{state:string;registration_token:string}>();
    expect(pending.state).toBe('registration_required');
    const registered=await app.inject({method:'POST',url:'/v1/auth/google/register',payload:{registration_token:pending.registration_token,
      jurisdiction:'NG',first_name:'Ngozi',last_name:'Okafor',phone_number:'+2348031234570',terms_version:'terms-1',
      privacy_version:'privacy-1',accepted:true}});
    expect(registered.statusCode,registered.body).toBe(201);expect(registered.json()).toMatchObject({state:'authenticated',token_type:'Bearer'});
    const accountId=registered.json<{account:{id:string}}>().account.id;
    const assurance=(await db.query<{verified:boolean}>('SELECT email_verified_at IS NOT NULL AS verified FROM account_assurance WHERE account_id=$1',[accountId])).rows[0];
    expect(assurance?.verified).toBe(true);
    const repeatState=await authorize('/v1/auth/google/authorize');
    const signedIn=await app.inject({method:'POST',url:'/v1/auth/google/exchange',payload:{code:'new-user',state:repeatState}});
    expect(signedIn.statusCode,signedIn.body).toBe(200);expect(signedIn.json()).toMatchObject({state:'authenticated',account:{id:accountId}});
    const replay=await app.inject({method:'POST',url:'/v1/auth/google/exchange',payload:{code:'new-user',state:repeatState}});
    expect(replay.statusCode).toBe(400);expect(replay.json()).toMatchObject({code:'INVALID_GOOGLE_AUTHORIZATION'});
  });

  it('requires an authenticated deliberate link when a native email already exists',async()=>{
    const native={jurisdiction:'NG',first_name:'Ada',last_name:'Owner',email:'native.owner@example.com',phone_number:'+2348031234571',
      password:'SecureNative2026',terms_version:'terms-1',privacy_version:'privacy-1',accepted:true};
    const registered=await app.inject({method:'POST',url:'/v1/auth/register',payload:native});
    expect(registered.statusCode,registered.body).toBe(201);const token=registered.json<{access_token:string}>().access_token;
    const loginState=await authorize('/v1/auth/google/authorize');
    const login=await app.inject({method:'POST',url:'/v1/auth/google/exchange',payload:{code:'native-owner',state:loginState}});
    expect(login.json()).toEqual({state:'link_required',email:native.email});
    const linkState=await authorize('/v1/me/auth/google/authorize',token);
    const linked=await app.inject({method:'POST',url:'/v1/me/auth/google/exchange',headers:{authorization:`Bearer ${token}`},
      payload:{code:'native-owner',state:linkState}});
    expect(linked.statusCode,linked.body).toBe(200);expect(linked.json()).toEqual({linked:true,email:native.email});
    const signedInState=await authorize('/v1/auth/google/authorize');
    const signedIn=await app.inject({method:'POST',url:'/v1/auth/google/exchange',payload:{code:'native-owner',state:signedInState}});
    expect(signedIn.statusCode,signedIn.body).toBe(200);expect(signedIn.json()).toMatchObject({state:'authenticated'});
  });

  it('requires Afridict email verification for a third-party Google account address',async()=>{
    const state=await authorize('/v1/auth/google/authorize');
    const exchanged=await app.inject({method:'POST',url:'/v1/auth/google/exchange',payload:{code:'external-user',state}});
    const token=exchanged.json<{registration_token:string}>().registration_token;
    const registered=await app.inject({method:'POST',url:'/v1/auth/google/register',payload:{registration_token:token,
      jurisdiction:'NG',first_name:'External',last_name:'User',phone_number:'+2348031234572',terms_version:'terms-1',
      privacy_version:'privacy-1',accepted:true}});
    expect(registered.statusCode,registered.body).toBe(201);const accountId=registered.json<{account:{id:string}}>().account.id;
    const assurance=(await db.query<{verified:boolean}>('SELECT email_verified_at IS NOT NULL AS verified FROM account_assurance WHERE account_id=$1',[accountId])).rows[0];
    expect(assurance?.verified).toBe(false);
  });
});

describe('Google OAuth transport',()=>{
  it('exchanges the code on the server and returns only verified identity fields',async()=>{
    const calls:Array<{url:string;init?:RequestInit}>=[];
    const request:typeof fetch=async(input,init)=>{const url=String(input);calls.push({url,init});
      if(url.includes('/token'))return new Response(JSON.stringify({access_token:'google-access',token_type:'Bearer'}),
        {status:200,headers:{'content-type':'application/json'}});
      return new Response(JSON.stringify({sub:'stable-google-subject',email:'VERIFIED@GMAIL.COM',email_verified:true,
        given_name:'Verified',family_name:'Person'}),{status:200,headers:{'content-type':'application/json'}});};
    const provider=new DirectGoogleOAuthProvider({clientId:'client',clientSecret:'secret',
      redirectUri:'https://app.example/auth/google/callback'},request);
    const url=new URL(provider.authorizationUrl({state:'s'.repeat(43),codeChallenge:'c'.repeat(43)}));
    expect(url.origin).toBe('https://accounts.google.com');expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');expect(url.searchParams.get('scope')).toBe('email profile');
    const identity=await provider.exchange({code:'authorization-code',codeVerifier:'v'.repeat(43)});
    expect(identity).toEqual({subject:'stable-google-subject',email:'verified@gmail.com',emailVerified:true,emailAuthoritative:true,
      givenName:'Verified',familyName:'Person'});
    expect(String(calls[0]?.init?.body)).toContain('client_secret=secret');
    expect(calls[1]?.init?.headers).toEqual({authorization:'Bearer google-access'});
  });

  it('rejects an identity without a Google-verified email',async()=>{
    const request:typeof fetch=async input=>String(input).includes('/token')
      ?new Response(JSON.stringify({access_token:'google-access',token_type:'Bearer'}),{status:200})
      :new Response(JSON.stringify({sub:'subject',email:'unverified@example.com',email_verified:false}),{status:200});
    const provider=new DirectGoogleOAuthProvider({clientId:'client',clientSecret:'secret',
      redirectUri:'https://app.example/auth/google/callback'},request);
    await expect(provider.exchange({code:'code',codeVerifier:'v'.repeat(43)})).rejects.toMatchObject({code:'GOOGLE_EMAIL_NOT_VERIFIED'});
  });

  it('does not treat a third-party Google account email as Afridict contact verification',async()=>{
    const request:typeof fetch=async input=>String(input).includes('/token')
      ?new Response(JSON.stringify({access_token:'google-access',token_type:'Bearer'}),{status:200})
      :new Response(JSON.stringify({sub:'subject',email:'person@example.com',email_verified:true}),{status:200});
    const provider=new DirectGoogleOAuthProvider({clientId:'client',clientSecret:'secret',
      redirectUri:'https://app.example/auth/google/callback'},request);
    await expect(provider.exchange({code:'code',codeVerifier:'v'.repeat(43)})).resolves.toMatchObject({
      email:'person@example.com',emailVerified:true,emailAuthoritative:false});
  });
});
