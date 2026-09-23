import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import type { Database } from '../platform/database.js';
import { AppError } from '../platform/errors.js';
import { listPositions, marketEvents, orderBook } from '../trading/service.js';
import { consumeRealtimeTicket } from './service.js';

type Subscription={marketId:string;assetCode:string;after:string;outcomes:string[]};
type ClientMessage={type?:unknown;ticket?:unknown;market_id?:unknown;asset_code?:unknown;after?:unknown;outcomes?:unknown};
export interface RealtimeOptions { pollIntervalMs?:number; authenticationTimeoutMs?:number; maxBufferedBytes?:number }

const send=(socket:WebSocket,message:unknown)=>socket.send(JSON.stringify(message));
const fail=(socket:WebSocket,code:string,message:string,closeCode?:number)=>{
  if(socket.readyState===socket.OPEN)send(socket,{type:'error',code,message});
  if(closeCode&&socket.readyState<socket.CLOSING)socket.close(closeCode,message.slice(0,100));
};
const text=(data:unknown)=>typeof data==='string'?data:Buffer.isBuffer(data)?data.toString('utf8'):'';

export function registerRealtimeSocket(app:FastifyInstance,db:Database,options:RealtimeOptions={}) {
  const pollInterval=options.pollIntervalMs??500;
  const authenticationTimeout=options.authenticationTimeoutMs??5_000;
  const maxBuffered=options.maxBufferedBytes??1_048_576;
  app.get('/v1/realtime',{websocket:true,schema:{hide:true}},(socket:WebSocket)=>{
    let accountId:string|undefined,subscription:Subscription|undefined,working=false;
    const authTimer=setTimeout(()=>fail(socket,'AUTHENTICATION_TIMEOUT','Authenticate with a one-use ticket.',4401),authenticationTimeout);
    const snapshots=async()=>{
      for(const outcome of subscription!.outcomes)
        send(socket,{type:'book_snapshot',snapshot:await db.transaction(sql=>orderBook(sql,subscription!.marketId,outcome,
          subscription!.assetCode))});
      send(socket,{type:'position_snapshot',market_id:subscription!.marketId,asset_code:subscription!.assetCode,
        sequence:subscription!.after,...(await listPositions(db,accountId!,subscription!.marketId,subscription!.assetCode))});
    };
    const publish=async()=>{
      if(!accountId||!subscription||working||socket.readyState!==socket.OPEN)return;
      if(socket.bufferedAmount>maxBuffered){fail(socket,'SLOW_CONSUMER','Reconnect from the last applied sequence.',4408);return;}
      working=true;
      try{
        const page=await marketEvents(db,subscription.marketId,subscription.after,subscription.assetCode);
        if(page.items.length){
          for(const event of page.items)send(socket,{type:'market_event',market_id:subscription.marketId,
            asset_code:subscription.assetCode,event});
          subscription.after=page.next_sequence;
          await snapshots();
          if(page.has_more)queueMicrotask(()=>void publish());
        }
      }catch(error){
        const known=error instanceof AppError;
        fail(socket,known?error.code:'REALTIME_UNAVAILABLE',known?error.message:'The realtime feed is temporarily unavailable.',known?4404:1011);
      }finally{working=false;}
    };
    const interval=setInterval(()=>void publish(),pollInterval);
    socket.on('message',(raw:unknown)=>{
      void (async()=>{
        let message:ClientMessage;
        try{message=JSON.parse(text(raw));}catch{fail(socket,'INVALID_MESSAGE','Send a valid JSON protocol message.');return;}
        if(!accountId){
          if(message.type!=='authenticate'||typeof message.ticket!=='string'){
            fail(socket,'AUTHENTICATION_REQUIRED','Authenticate before subscribing.',4401);return;
          }
          try{accountId=await consumeRealtimeTicket(db,message.ticket);clearTimeout(authTimer);
            send(socket,{type:'authenticated'});
          }catch(error){const known=error instanceof AppError;fail(socket,known?error.code:'REALTIME_UNAVAILABLE',
            known?error.message:'The realtime feed is temporarily unavailable.',known?4401:1011);}
          return;
        }
        if(message.type==='ping'){send(socket,{type:'pong'});return;}
        if(message.type!=='subscribe'||typeof message.market_id!=='string'||
          (message.asset_code!==undefined&&typeof message.asset_code!=='string')||
          typeof message.after!=='string'||!/^\d+$/.test(message.after)||
          !Array.isArray(message.outcomes)||message.outcomes.some(value=>typeof value!=='string')||message.outcomes.length>20){
          fail(socket,'INVALID_SUBSCRIPTION','Provide market_id, decimal after cursor, and up to 20 outcomes.');return;
        }
        const outcomes=[...new Set(message.outcomes as string[])];
        try{
          for(const outcome of outcomes)await db.transaction(sql=>orderBook(sql,message.market_id as string,outcome,
            message.asset_code as string|undefined));
          const initial=await marketEvents(db,message.market_id,message.after,message.asset_code as string|undefined);
          subscription={marketId:message.market_id,assetCode:initial.asset_code,after:message.after,outcomes};
          send(socket,{type:'subscribed',market_id:subscription.marketId,asset_code:subscription.assetCode,
            after:subscription.after,outcomes});
          if(initial.items.length)await publish();else await snapshots();
        }catch(error){const known=error instanceof AppError;fail(socket,known?error.code:'REALTIME_UNAVAILABLE',
          known?error.message:'The realtime feed is temporarily unavailable.',known?undefined:1011);}
      })();
    });
    socket.on('close',()=>{clearTimeout(authTimer);clearInterval(interval);});
    socket.on('error',()=>{clearTimeout(authTimer);clearInterval(interval);});
  });
}
