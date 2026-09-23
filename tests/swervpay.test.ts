import {describe,expect,it,vi} from 'vitest';
import {SwervpayClient} from '../src/funding/swervpay.js';

const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const credentials={businessId:'business_test',secretKey:['synthetic','secret','only'].join(':'),baseUrl:'https://sandbox.swervpay.co/api/v1' as const};

describe('Swervpay provider boundary',()=>{
  it('caches bearer authentication and maps bank resolution without logging credentials',async()=>{
    const request=vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({access_token:'synthetic_access',token:{expires_at:Date.now()+3_600_000}}))
      .mockResolvedValueOnce(json([{bank_code:'044',bank_name:'Example Bank'}]))
      .mockResolvedValueOnce(json({account_name:'Synthetic Recipient',account_number:'0000000000',bank_code:'044',bank_name:'Example Bank'}));
    const client=new SwervpayClient(credentials,request);
    expect(await client.listBanks()).toEqual([{code:'044',name:'Example Bank'}]);
    expect(await client.resolveAccount({bankCode:'044',accountNumber:'0000000000'})).toEqual({accountName:'Synthetic Recipient',
      accountNumber:'0000000000',bankCode:'044',bankName:'Example Bank'});
    expect(request).toHaveBeenCalledTimes(3);expect(request.mock.calls.filter(([url])=>String(url).endsWith('/auth'))).toHaveLength(1);
  });

  it('converts exact kobo amounts to provider naira and keeps stable references',async()=>{
    const request=vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({access_token:'synthetic_access',token:{expires_at:Date.now()+3_600_000}}))
      .mockResolvedValueOnce(json({id:'collection_test',reference:'deposit_test',account_name:'Synthetic Collection',account_number:'1111111111',
        bank_code:'999',bank_name:'Synthetic Bank',status:'active'}))
      .mockResolvedValueOnce(json({id:'payout_test',reference:'withdrawal_test',message:'accepted'}));
    const client=new SwervpayClient(credentials,request);
    expect((await client.createCollection({currency:'NGN',amountMinor:'125050',reference:'deposit_test',merchantName:'Afridict'})).id).toBe('collection_test');
    expect((await client.createPayout({currency:'NGN',amountMinor:'2500',reference:'withdrawal_test',bankCode:'999',
      accountNumber:'0000000000',narration:'Afridict withdrawal'})).id).toBe('payout_test');
    const collection=JSON.parse(String(request.mock.calls[1]![1]?.body)),payout=JSON.parse(String(request.mock.calls[2]![1]?.body));
    expect(collection).toMatchObject({currency:'NGN',amount:1250.5,reference:'deposit_test',type:'ONE_TIME'});
    expect(payout).toMatchObject({currency:'NGN',amount:25,reference:'withdrawal_test'});
  });

  it('does not retry an ambiguous payout response',async()=>{
    const request=vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({access_token:'synthetic_access',token:{expires_at:Date.now()+3_600_000}}))
      .mockRejectedValueOnce(new Error('connection closed'));
    const client=new SwervpayClient(credentials,request);
    await expect(client.createPayout({currency:'NGN',amountMinor:'100',reference:'withdrawal_uncertain',bankCode:'999',
      accountNumber:'0000000000',narration:'Afridict withdrawal'})).rejects.toThrow('connection closed');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('rejects values that cannot be represented exactly by the provider JSON contract',async()=>{
    const client=new SwervpayClient(credentials,vi.fn<typeof fetch>());
    await expect(client.createPayout({currency:'NGN',amountMinor:'9007199254740992',reference:'too_large',bankCode:'999',
      accountNumber:'0000000000',narration:'Afridict withdrawal'})).rejects.toThrow('SWERVPAY_AMOUNT_OUT_OF_RANGE');
  });
});
