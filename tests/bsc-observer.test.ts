import {afterEach,describe,expect,it,vi} from 'vitest';
import {ViemBscDepositObserver} from '../src/funding/bsc-observer.js';

const transactionHash=`0x${'1'.repeat(64)}`,blockHash=`0x${'b'.repeat(64)}`,token='0x55d398326f99059ff775485246999027b3197955';
const recipient=`0x${'a'.repeat(40)}`,sender=`0x${'c'.repeat(40)}`;
const topic=(address:string)=>`0x${'0'.repeat(24)}${address.slice(2)}`;
const transferTopic='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const valueData=`0x${(2_000_000_000_000_000_000n).toString(16).padStart(64,'0')}`;

afterEach(()=>vi.unstubAllGlobals());

describe('Viem BSC deposit observer',()=>{
  it('decodes the exact finalized USDT Transfer log and counts confirmations',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>{
      const request=JSON.parse(String(init?.body)) as {id:number;method:string};let result:unknown;
      if(request.method==='eth_chainId')result='0x38';
      else if(request.method==='eth_blockNumber')result='0x6f';
      else if(request.method==='eth_getTransactionReceipt')result={blockHash,blockNumber:'0x64',contractAddress:null,
        cumulativeGasUsed:'0x5208',effectiveGasPrice:'0x1',from:sender,gasUsed:'0x5208',logs:[{address:token,
          blockHash,blockNumber:'0x64',data:valueData,logIndex:'0x0',removed:false,
          topics:[transferTopic,topic(sender),topic(recipient)],transactionHash,transactionIndex:'0x0'}],
        logsBloom:`0x${'0'.repeat(512)}`,status:'0x1',to:token,transactionHash,transactionIndex:'0x0',type:'0x2'};
      else throw new Error(`Unexpected RPC method ${request.method}`);
      return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}),{status:200,headers:{'content-type':'application/json'}});
    }));
    const observer=new ViemBscDepositObserver('https://bsc-rpc.example',12);
    await expect(observer.observe({chainId:'56',contractAddress:token,transactionHash,logIndex:0})).resolves.toEqual({
      state:'finalized',chainId:'56',contractAddress:token,recipient,amountMinor:'2000000000000000000',transactionHash,
      logIndex:0,blockNumber:'100',blockHash,confirmations:12,finalityPolicyRef:'bsc:chain-56:12-confirmations-v1',
    });
  });

  it('returns missing when the RPC has no receipt',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>{
      const request=JSON.parse(String(init?.body)) as {id:number;method:string};
      const result=request.method==='eth_chainId'?'0x38':null;
      return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}),{status:200,headers:{'content-type':'application/json'}});
    }));
    const observer=new ViemBscDepositObserver('https://bsc-rpc.example',12);
    await expect(observer.observe({chainId:'56',contractAddress:token,transactionHash,logIndex:0})).resolves.toEqual({
      state:'missing',chainId:'56',transactionHash,logIndex:0,finalityPolicyRef:'bsc:chain-56:12-confirmations-v1',
    });
  });
});
