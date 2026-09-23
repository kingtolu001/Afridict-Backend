import {TransactionReceiptNotFoundError,createPublicClient,decodeEventLog,erc20Abi,http,type Hash} from 'viem';
import {bsc} from 'viem/chains';
import {AppError,requireCondition} from '../platform/errors.js';
import type {CryptoDepositObserver,MissingTokenTransfer,VerifiedTokenTransfer} from './crypto-deposit.js';

export class ViemBscDepositObserver implements CryptoDepositObserver {
  private readonly client;
  private readonly policy:string;
  constructor(rpcUrl:string,private readonly minimumConfirmations:number){
    requireCondition(Number.isInteger(minimumConfirmations)&&minimumConfirmations>=1&&minimumConfirmations<=1000,500,
      'CHAIN_OBSERVER_MISCONFIGURED','BSC confirmation policy is invalid.');
    this.client=createPublicClient({chain:bsc,transport:http(rpcUrl,{timeout:5000,retryCount:1})});
    this.policy=`bsc:chain-56:${minimumConfirmations}-confirmations-v1`;
  }
  async observe(input:{chainId:string;contractAddress:string;transactionHash:string;logIndex:number}):Promise<VerifiedTokenTransfer|MissingTokenTransfer>{
    let actualChain:number;
    try{actualChain=await this.client.getChainId();}catch{throw new AppError(503,'CHAIN_OBSERVER_UNAVAILABLE','The BSC observer is temporarily unavailable.');}
    requireCondition(actualChain===56&&input.chainId==='56',502,'CHAIN_ID_MISMATCH','The configured observer is not connected to BNB Smart Chain.');
    let receipt;
    try{receipt=await this.client.getTransactionReceipt({hash:input.transactionHash as Hash});}
    catch(error){
      if(error instanceof TransactionReceiptNotFoundError)return {state:'missing',chainId:'56',transactionHash:input.transactionHash.toLowerCase(),
        logIndex:input.logIndex,finalityPolicyRef:this.policy};
      throw new AppError(503,'CHAIN_OBSERVER_UNAVAILABLE','The BSC observer is temporarily unavailable.');
    }
    const log=receipt.logs.find(candidate=>candidate.logIndex===input.logIndex&&
      candidate.address.toLowerCase()===input.contractAddress.toLowerCase());
    if(receipt.status!=='success'||!log)return {state:'missing',chainId:'56',transactionHash:input.transactionHash.toLowerCase(),
      logIndex:input.logIndex,finalityPolicyRef:this.policy};
    let decoded;
    try{decoded=decodeEventLog({abi:erc20Abi,eventName:'Transfer',data:log.data,topics:log.topics});}
    catch{return {state:'missing',chainId:'56',transactionHash:input.transactionHash.toLowerCase(),logIndex:input.logIndex,
      finalityPolicyRef:this.policy};}
    const args=decoded.args as {to?:string;value?:bigint};
    if(typeof args.to!=='string'||typeof args.value!=='bigint')return {state:'missing',chainId:'56',
      transactionHash:input.transactionHash.toLowerCase(),logIndex:input.logIndex,finalityPolicyRef:this.policy};
    let head:bigint;
    try{head=await this.client.getBlockNumber({cacheTime:0});}
    catch{throw new AppError(503,'CHAIN_OBSERVER_UNAVAILABLE','The BSC observer is temporarily unavailable.');}
    const count=head>=receipt.blockNumber?head-receipt.blockNumber+1n:0n;
    const confirmations=Number(count>BigInt(Number.MAX_SAFE_INTEGER)?BigInt(Number.MAX_SAFE_INTEGER):count);
    return {state:confirmations>=this.minimumConfirmations?'finalized':'confirming',chainId:'56',
      contractAddress:log.address.toLowerCase(),recipient:args.to.toLowerCase(),amountMinor:args.value.toString(),
      transactionHash:receipt.transactionHash.toLowerCase(),logIndex:input.logIndex,blockNumber:receipt.blockNumber.toString(),
      blockHash:receipt.blockHash.toLowerCase(),confirmations,finalityPolicyRef:this.policy};
  }
}
