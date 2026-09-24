import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {embeddedDatabase} from '../scripts/embedded.js';
import {demoAuth,demoConfig,seedDemo,terms} from '../scripts/fixtures.js';
import {buildApp} from '../src/app.js';
import {getMarket} from '../src/markets/service.js';
import {hydrateOutcomeMedia} from '../src/markets/media.js';
import type {Database} from '../src/platform/database.js';
import {migrate} from '../src/platform/migrations.js';

let db:Database,app:FastifyInstance,key=0;
const auth=(name:string)=>({authorization:`Bearer demo.${name}`,'idempotency-key':`market-media-${++key}`});

beforeAll(async()=>{db=await embeddedDatabase();await migrate(db);await seedDemo(db);app=await buildApp(db,demoConfig,demoAuth);});
afterAll(async()=>{await app.close();await db.close();});

describe('market outcome media',()=>{
  it('requires a completed creator-owned image and blocks deletion while referenced',async()=>{
    const checksum='b'.repeat(64);
    const created=await app.inject({method:'POST',url:'/v1/admin/market-media-uploads',headers:auth('creator'),
      payload:{mime_type:'image/webp',byte_size:4096,width:512,height:512,checksum}});
    expect(created.statusCode,created.body).toBe(201);const mediaId=created.json<{id:string}>().id;
    const completed=await app.inject({method:'POST',url:`/v1/admin/market-media-uploads/${mediaId}/complete`,
      headers:auth('creator'),payload:{byte_size:4096,width:512,height:512,checksum}});
    expect(completed.statusCode,completed.body).toBe(200);

    const policy=terms();policy.outcomes[0]={...policy.outcomes[0]!,image_media_id:mediaId,image_alt:'Yes outcome symbol'};
    const foreign=await app.inject({method:'POST',url:'/v1/admin/markets',headers:auth('other_creator'),payload:{terms:policy}});
    expect(foreign.statusCode,foreign.body).toBe(422);expect(foreign.json().code).toBe('INVALID_MARKET_MEDIA');
    const draft=await app.inject({method:'POST',url:'/v1/admin/markets',headers:auth('creator'),payload:{terms:policy}});
    expect(draft.statusCode,draft.body).toBe(201);expect(draft.json().terms.outcomes[0]).toMatchObject({
      image_media_id:mediaId,image_alt:'Yes outcome symbol'});

    const market=await getMarket(db,draft.json<{id:string}>().id);
    const hydrated=await hydrateOutcomeMedia(db,[market],'afridict-test');
    expect(hydrated.get(market.id)?.outcomes[0]?.image_url).toMatch(
      /^https:\/\/res\.cloudinary\.com\/afridict-test\/image\/upload\/f_auto,q_auto\/[0-9a-f-]+$/);
    const removed=await app.inject({method:'DELETE',url:`/v1/admin/market-media-uploads/${mediaId}`,
      headers:auth('creator'),payload:{reason:'Replace the image'}});
    expect(removed.statusCode,removed.body).toBe(409);expect(removed.json().code).toBe('MEDIA_IN_USE');
  });
});
