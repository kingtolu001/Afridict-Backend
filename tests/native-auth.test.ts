import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { embeddedDatabase } from '../scripts/embedded.js';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/platform/migrations.js';
import type { Database } from '../src/platform/database.js';
import type { Config } from '../src/platform/config.js';

const cfg:Config={environment:'test',host:'127.0.0.1',port:3000,authMode:'native',corsOrigins:[],docs:false,logger:false,
  financialMode:'disabled',authMethods:['password']};
let db:Database,app:FastifyInstance,token='';
const account={jurisdiction:'NG',first_name:'Ada',last_name:'Okafor',email:'ada.okafor@example.com',phone_number:'+2348031234567',
  password:'SecureNative2026',terms_version:'terms-2026-09-22',privacy_version:'privacy-2026-09-22',accepted:true};

beforeAll(async()=>{db=await embeddedDatabase();await migrate(db);app=await buildApp(db,cfg);});
afterAll(async()=>{await app.close();await db.close();});

describe('native account authentication',()=>{
  it('registers an account and returns an opaque usable session',async()=>{
    const response=await app.inject({method:'POST',url:'/v1/auth/register',payload:account});
    expect(response.statusCode,response.body).toBe(201);
    const body=response.json<{access_token:string;token_type:string}>(); token=body.access_token;
    expect(body.token_type).toBe('Bearer'); expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const me=await app.inject({method:'GET',url:'/v1/me',headers:{authorization:`Bearer ${token}`}});
    expect(me.statusCode,me.body).toBe(200); expect(me.json()).toMatchObject({jurisdiction:'NG',roles:['user']});
    const status=await app.inject({method:'GET',url:'/v1/me/onboarding-status',headers:{authorization:`Bearer ${token}`}});
    expect(status.json()).toMatchObject({email_verified:true});
    const details=await app.inject({method:'GET',url:'/v1/registration/profile',headers:{authorization:`Bearer ${token}`}});
    expect(details.json()).toMatchObject({first_name:'Ada',last_name:'Okafor',email:account.email});
  });
  it('rejects duplicate identities and weak passwords',async()=>{
    expect((await app.inject({method:'POST',url:'/v1/auth/register',payload:account})).json()).toMatchObject({code:'ACCOUNT_ALREADY_EXISTS'});
    const weak={...account,email:'weak@example.com',phone_number:'+2348031234568',password:'password1234'};
    expect((await app.inject({method:'POST',url:'/v1/auth/register',payload:weak})).json()).toMatchObject({code:'WEAK_PASSWORD'});
  });
  it('logs in, rejects a wrong password, and revokes logout immediately',async()=>{
    const denied=await app.inject({method:'POST',url:'/v1/auth/login',payload:{email:account.email,password:'WrongPassword2026'}});
    expect(denied.statusCode).toBe(401); expect(denied.json()).toMatchObject({code:'INVALID_CREDENTIALS'});
    const login=await app.inject({method:'POST',url:'/v1/auth/login',payload:{email:account.email,password:account.password}});
    expect(login.statusCode,login.body).toBe(200); const active=login.json<{access_token:string}>().access_token;
    expect((await app.inject({method:'POST',url:'/v1/auth/logout',headers:{authorization:`Bearer ${active}`}})).statusCode).toBe(200);
    expect((await app.inject({method:'GET',url:'/v1/me',headers:{authorization:`Bearer ${active}`}})).statusCode).toBe(401);
  });
});
