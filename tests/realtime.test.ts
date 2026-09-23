import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { embeddedDatabase } from '../scripts/embedded.js';
import { demoAuth, demoConfig, seedDemo, terms } from '../scripts/fixtures.js';
import { buildApp } from '../src/app.js';
import type { Database } from '../src/platform/database.js';
import { migrate } from '../src/platform/migrations.js';
import { hash } from '../src/platform/commands.js';
import asyncapi from '../api/asyncapi.json' with {type:'json'};

let db:Database,app:FastifyInstance,marketId:string;
const auth={authorization:'Bearer demo.trader'};
const openSocket=()=>app.injectWS('/v1/realtime',{socket:{remoteAddress:'127.0.0.1'} as never});

function messages(socket:{on:(event:string,listener:(data:unknown)=>void)=>unknown}) {
  const queued:unknown[]=[];const waiting:Array<(value:unknown)=>void>=[];
  socket.on('message',data=>{const resolve=waiting.shift();if(resolve)resolve(data);else queued.push(data);});
  return async()=>{
    const raw=queued.length?queued.shift():await new Promise<unknown>((resolve,reject)=>{
      waiting.push(resolve);setTimeout(()=>reject(new Error('Timed out waiting for realtime message')),1_000);
    });
    return JSON.parse(Buffer.isBuffer(raw)?raw.toString('utf8'):String(raw)) as Record<string,unknown>;
  };
}

async function ticket(){
  const response=await app.inject({method:'POST',url:'/v1/realtime/tickets',headers:auth});
  expect(response.statusCode,response.body).toBe(201);
  return response.json().ticket as string;
}

beforeAll(async()=>{
  db=await embeddedDatabase();await migrate(db);const ids=await seedDemo(db);
  marketId=randomUUID();const policy=terms();
  await db.query(`INSERT INTO markets(id,creator_id,state,terms,policy_hash,published_at)
    VALUES ($1,$2,'scheduled',$3,$4,now())`,[marketId,ids.creator,JSON.stringify(policy),hash(policy)]);
  const book=(await db.query<{id:string}>(`INSERT INTO clob_markets(market_id,asset_code,status,next_sequence)
    VALUES ($1,'DEMO','halted',3) RETURNING id`,[marketId])).rows[0]!;
  await db.query(`INSERT INTO clob_events(book_id,market_id,sequence,event_type) VALUES
    ($1,$2,1,'activated'),($1,$2,2,'halted')`,[book.id,marketId]);
  app=await buildApp(db,demoConfig,demoAuth,undefined,undefined,undefined,undefined,()=>new Date(),undefined,
    {pollIntervalMs:10,authenticationTimeoutMs:500});
  await app.ready();
});
afterAll(async()=>{if(app)await app.close();if(db)await db.close();});

describe('recoverable realtime market feed',()=>{
  it('publishes an AsyncAPI recovery contract for frontend clients',()=>{
    expect(asyncapi.asyncapi).toBe('3.0.0');
    expect(asyncapi.channels.realtime.address).toBe('/v1/realtime');
    expect(asyncapi['x-recovery'].procedure).toHaveLength(5);
    expect(asyncapi.components.schemas.marketEvent.properties.event_type.enum)
      .toEqual(expect.arrayContaining(['fill','amm_execution','rfq_execution','resolution_finalized']));
  });

  it('requires HTTP authentication to issue a one-use ticket',async()=>{
    expect((await app.inject({method:'POST',url:'/v1/realtime/tickets'})).statusCode).toBe(401);
    const value=await ticket();expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored=(await db.query<{token_hash:Uint8Array}>('SELECT token_hash FROM realtime_tickets ORDER BY created_at DESC LIMIT 1')).rows[0]!;
    expect(Buffer.from(stored.token_hash).toString('utf8')).not.toContain(value);
  });

  it('authenticates once and delivers ordered events after the supplied cursor',async()=>{
    const value=await ticket();const socket=await openSocket();const next=messages(socket);
    socket.send(JSON.stringify({type:'authenticate',ticket:value}));
    expect(await next()).toEqual({type:'authenticated'});
    socket.send(JSON.stringify({type:'subscribe',market_id:marketId,after:'0',outcomes:['yes']}));
    expect(await next()).toMatchObject({type:'subscribed',market_id:marketId,asset_code:'DEMO',after:'0',outcomes:['yes']});
    expect(await next()).toMatchObject({type:'market_event',event:{sequence:'1',event_type:'activated'}});
    expect(await next()).toMatchObject({type:'market_event',event:{sequence:'2',event_type:'halted'}});
    expect(await next()).toMatchObject({type:'book_snapshot',snapshot:{market_id:marketId,outcome_id:'yes',sequence:'2'}});
    expect(await next()).toMatchObject({type:'position_snapshot',market_id:marketId,sequence:'2',items:[]});
    socket.close();

    const replay=await openSocket();const replayNext=messages(replay);
    replay.send(JSON.stringify({type:'authenticate',ticket:value}));
    expect(await replayNext()).toMatchObject({type:'error',code:'INVALID_REALTIME_TICKET'});
    replay.close();
  });

  it('resumes strictly after the last applied sequence and rejects a future cursor',async()=>{
    const socket=await openSocket();const next=messages(socket);
    socket.send(JSON.stringify({type:'authenticate',ticket:await ticket()}));await next();
    socket.send(JSON.stringify({type:'subscribe',market_id:marketId,after:'1',outcomes:[]}));
    await next();
    expect(await next()).toMatchObject({type:'market_event',event:{sequence:'2',event_type:'halted'}});
    socket.close();

    const invalid=await openSocket();const invalidNext=messages(invalid);
    invalid.send(JSON.stringify({type:'authenticate',ticket:await ticket()}));await invalidNext();
    invalid.send(JSON.stringify({type:'subscribe',market_id:marketId,after:'99',outcomes:[]}));
    expect(await invalidNext()).toMatchObject({type:'error',code:'CURSOR_AHEAD'});
    invalid.close();
  });
});
