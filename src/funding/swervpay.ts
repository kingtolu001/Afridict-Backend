import { integer } from '../financial/model.js';
import {timingSafeEqual} from 'node:crypto';

export type FiatCurrency='NGN';
export interface Bank {code:string;name:string}
export interface ResolvedBankAccount {accountName:string;accountNumber:string;bankCode:string;bankName:string}
export interface CollectionInstruction {id:string;reference:string;currency:FiatCurrency;accountName:string;
  accountNumber:string;bankCode:string;bankName:string;status:string}
export interface PayoutSubmission {id:string;reference:string}

export interface FiatRailProvider {
  listBanks():Promise<Bank[]>;
  resolveAccount(input:{bankCode:string;accountNumber:string}):Promise<ResolvedBankAccount>;
  createCollection(input:{currency:FiatCurrency;amountMinor:string;reference:string;merchantName:string;customerId?:string}):Promise<CollectionInstruction>;
  createPayout(input:{currency:'NGN';amountMinor:string;reference:string;bankCode:string;accountNumber:string;narration:string}):Promise<PayoutSubmission>;
  getPayout(id:string):Promise<{id:string;reference:string;status:string}>;
}
export type FiatDependencies={provider:FiatRailProvider;environment:'sandbox';businessId:string;webhookSecret:string;
  dataHashKey:string;dataEncryptionKey:Buffer;keyVersion:string};

type Fetch=typeof globalThis.fetch;
type Json=Record<string,unknown>;
const requiredString=(value:unknown,field:string)=>{if(typeof value!=='string'||!value)throw new Error(`SWERVPAY_INVALID_${field}`);return value;};
const providerAmount=(value:string)=>{const amount=integer(value);
  if(amount<=0n||amount>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('SWERVPAY_AMOUNT_OUT_OF_RANGE');
  return Number(`${amount/100n}.${(amount%100n).toString().padStart(2,'0')}`);};
export const swervpayMinorAmount=(value:number)=>{const scaled=value*100;
  if(!Number.isFinite(value)||value<=0||!Number.isSafeInteger(scaled))throw new Error('SWERVPAY_AMOUNT_OUT_OF_RANGE');
  return BigInt(scaled).toString();};
export const verifySwervpaySecret=(provided:string|undefined,expected:string)=>{
  if(!provided)return false;const left=Buffer.from(provided),right=Buffer.from(expected);
  return left.length===right.length&&timingSafeEqual(left,right);
};

export class SwervpayClient implements FiatRailProvider {
  private token?:{value:string;expiresAt:number};
  constructor(private readonly options:{businessId:string;secretKey:string;baseUrl:'https://api.swervpay.co/api/v1'|'https://sandbox.swervpay.co/api/v1';timeoutMs?:number},
    private readonly request:Fetch=globalThis.fetch) {
    if(!options.businessId||!options.secretKey)throw new Error('Invalid Swervpay credentials');
  }
  private async authenticate() {
    if(this.token&&this.token.expiresAt>Date.now()+60_000)return this.token.value;
    const response=await this.request(`${this.options.baseUrl}/auth`,{method:'POST',headers:{authorization:
      `Basic ${Buffer.from(`${this.options.businessId}:${this.options.secretKey}`).toString('base64')}`,'content-type':'application/json'},
    body:'{}',signal:AbortSignal.timeout(this.options.timeoutMs??5000)});
    if(!response.ok)throw new Error(`SWERVPAY_AUTH_${response.status}`);
    const body=await response.json() as Json,token=requiredString(body.access_token,'AUTH_RESPONSE');
    const expiresAt=typeof (body.token as Json|undefined)?.expires_at==='number'?(body.token as Json).expires_at as number:Date.now()+3_600_000;
    this.token={value:token,expiresAt};return token;
  }
  private async call(path:string,init:RequestInit={}) {
    const token=await this.authenticate();
    const response=await this.request(`${this.options.baseUrl}${path}`,{...init,headers:{authorization:`Bearer ${token}`,
      'content-type':'application/json',...init.headers},signal:AbortSignal.timeout(this.options.timeoutMs??5000)});
    if(!response.ok)throw new Error(`SWERVPAY_${response.status}`);
    return response.json() as Promise<unknown>;
  }
  async listBanks() {
    const body=await this.call('/banks');if(!Array.isArray(body))throw new Error('SWERVPAY_INVALID_BANKS_RESPONSE');
    return body.map((item:Json)=>({code:requiredString(item.code??item.bank_code,'BANK_CODE'),name:requiredString(item.name??item.bank_name,'BANK_NAME')}));
  }
  async resolveAccount(input:{bankCode:string;accountNumber:string}) {
    const body=await this.call('/resolve-account-number',{method:'POST',body:JSON.stringify({bank_code:input.bankCode,account_number:input.accountNumber})}) as Json;
    return {accountName:requiredString(body.account_name,'ACCOUNT_NAME'),accountNumber:requiredString(body.account_number,'ACCOUNT_NUMBER'),
      bankCode:requiredString(body.bank_code,'BANK_CODE'),bankName:requiredString(body.bank_name,'BANK_NAME')};
  }
  async createCollection(input:{currency:FiatCurrency;amountMinor:string;reference:string;merchantName:string;customerId?:string}) {
    const body=await this.call('/collections',{method:'POST',body:JSON.stringify({currency:input.currency,amount:providerAmount(input.amountMinor),
      reference:input.reference,merchant_name:input.merchantName,type:'ONE_TIME',...(input.customerId?{customer_id:input.customerId}:{})})}) as Json;
    return {id:requiredString(body.id,'COLLECTION_ID'),reference:requiredString(body.reference,'COLLECTION_REFERENCE'),currency:input.currency,
      accountName:requiredString(body.account_name,'ACCOUNT_NAME'),accountNumber:requiredString(body.account_number,'ACCOUNT_NUMBER'),
      bankCode:requiredString(body.bank_code,'BANK_CODE'),bankName:requiredString(body.bank_name,'BANK_NAME'),status:requiredString(body.status,'COLLECTION_STATUS')};
  }
  async createPayout(input:{currency:'NGN';amountMinor:string;reference:string;bankCode:string;accountNumber:string;narration:string}) {
    // Swervpay does not document payout idempotency. Callers must make this once,
    // retain an ambiguous outcome as uncertain, and reconcile before any retry.
    const body=await this.call('/payouts',{method:'POST',body:JSON.stringify({currency:input.currency,amount:providerAmount(input.amountMinor),
      reference:input.reference,bank_code:input.bankCode,account_number:input.accountNumber,narration:input.narration})}) as Json;
    return {id:requiredString(body.id,'PAYOUT_ID'),reference:requiredString(body.reference,'PAYOUT_REFERENCE')};
  }
  async getPayout(id:string) {
    const body=await this.call(`/payouts/${encodeURIComponent(id)}`) as Json;
    return {id:requiredString(body.id,'PAYOUT_ID'),reference:requiredString(body.reference,'PAYOUT_REFERENCE'),status:requiredString(body.status,'PAYOUT_STATUS')};
  }
}
