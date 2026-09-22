import { Type } from '@sinclair/typebox';
import { UUID, Timestamp, Uint, object, text } from '../contracts.js';

export const FinancialAssetSchema=object({code:Type.String({pattern:'^[A-Z0-9_]{2,32}$'}),scale:Type.Integer({minimum:0,maximum:36}),
  synthetic:Type.Boolean(),funding_enabled:Type.Boolean(),withdrawal_enabled:Type.Boolean()},{$id:'FinancialAsset'});
export const BalanceSchema=object({asset:Type.String(),available_minor:Uint,reserved_minor:Uint,withdrawal_pending_minor:Uint,
  spendable:Type.Literal(false)},{$id:'CollateralBalance',description:'Exact off-chain balances. Real trading is not active. Pending partner or chain deposits never appear as available.'});
export const FiatWalletSchema=object({currency:Type.Literal('NGN'),scale:Type.Literal(2),available_minor:Uint,
  reserved_minor:Uint,withdrawal_pending_minor:Uint,funding_enabled:Type.Boolean(),withdrawal_enabled:Type.Boolean()},
  {$id:'FiatWallet',description:'NGN ledger projection in integer kobo. Crypto stablecoins use contract-specific assets rather than a generic USD balance.'});
export const BankSchema=object({code:Type.String({pattern:'^[0-9]{3,10}$'}),name:text('Provider-reported bank name.',120)},{$id:'FiatBank'});
export const ResolvedBankAccountSchema=object({account_name:text('Provider-confirmed account holder name. Returned only to the authenticated caller.',200),
  account_number:Type.String({pattern:'^[0-9]{10}$'}),bank_code:Type.String({pattern:'^[0-9]{3,10}$'}),bank_name:text('Provider-reported bank name.',120)},
  {$id:'ResolvedBankAccount',description:'Ephemeral provider resolution result. Afridict does not persist this response.'});
export const FiatDepositSchema=object({id:UUID,currency:Type.Literal('NGN'),target_minor:Uint,
  state:Type.String({enum:['instruction_pending','instruction_creating','instructions_available','instruction_uncertain']}),
  expires_at:Timestamp,created_at:Timestamp,updated_at:Timestamp,instructions:Type.Union([Type.Null(),object({account_name:text('Provider-issued beneficiary name.',200),
    account_number:Type.String({pattern:'^[0-9]{10}$'}),bank_code:Type.String({minLength:1,maxLength:20}),bank_name:text('Provider-issued bank name.',120),provider:Type.Literal('swervpay')})])},
  {$id:'FiatDepositIntent',description:'Durable fiat collection workflow. Only instructions_available may be displayed for payment. Uncertain creation requires reconciliation.'});
export const DepositSchema=object({id:UUID,asset:Type.String(),target_minor:Uint,
  state:Type.String({enum:['awaiting_partner','partner_confirmed','chain_observed','reconciled_available','expired','exception']}),
  expires_at:Timestamp,created_at:Timestamp,updated_at:Timestamp,
  funding_instructions_available:Type.Literal(false)},{$id:'DepositIntent',description:'Workflow status only. A real payment quote or beneficiary is unavailable until a reviewed partner adapter is activated.'});
export const WithdrawalSchema=object({id:UUID,asset:Type.String(),amount_minor:Uint,
  state:Type.String({enum:['reserved','approved','submitting','submitted','uncertain','finalized','cancelled','exception']}),
  destination_ref:text('Opaque destination saved for this owner; no raw bank or wallet details.',200),
  rail:Type.String(),created_at:Timestamp,updated_at:Timestamp},{$id:'Withdrawal'});
export const AdminNgnPayoutSchema=object({id:UUID,asset:Type.Literal('NGN'),amount_minor:Uint,
  state:Type.String({enum:['reserved','approved','submitting','submitted','uncertain','finalized','cancelled','exception']}),
  destination_ref:Type.String(),rail:Type.Literal('swervpay'),created_at:Timestamp,updated_at:Timestamp,
  bank:object({account_name:text('Swervpay-resolved account name.',200),account_number:Type.String({pattern:'^[0-9]{10}$'}),
    bank_code:Type.String({pattern:'^[0-9]{3,10}$'}),bank_name:text('Swervpay-resolved bank name.',120)}),narration:text('Payout narration.',80)},
  {$id:'AdminNgnPayout',description:'Finance-only payout review. Bank details are encrypted at rest and excluded from logs and public APIs.'});
export const TokenAssetSchema=object({code:Type.String({pattern:'^[A-Z0-9_]{2,32}$'}),symbol:Type.String({pattern:'^[A-Z0-9]{2,12}$'}),
  chain_id:Uint,contract_address:Type.String({pattern:'^0x[a-f0-9]{40}$'}),decimals:Type.Integer({minimum:0,maximum:36}),
  withdrawal_mode:Type.Literal('manual_finance_review')},{$id:'TokenAsset',description:'Approved token identity. Symbol, network, contract, and decimals must all match.'});
export const AdminCryptoWithdrawalSchema=object({id:UUID,asset:Type.String(),amount_minor:Uint,
  state:Type.String({enum:['reserved','approved','submitted','uncertain','finalized','exception']}),destination_ref:Type.String({pattern:'^0x[a-f0-9]{40}$'}),
  rail:Type.Literal('manual_bep20'),created_at:Timestamp,updated_at:Timestamp,symbol:Type.String(),chain_id:Uint,
  token_contract:Type.String({pattern:'^0x[a-f0-9]{40}$'}),approved_by:Type.Union([UUID,Type.Null()]),approved_at:Type.Union([Timestamp,Type.Null()]),
  transaction_hash:Type.Union([Type.String({pattern:'^0x[a-f0-9]{64}$'}),Type.Null()])},
  {$id:'AdminCryptoWithdrawal',description:'Finance review and manual company-wallet submission record. A transaction hash is evidence of submission, not final settlement.'});
export const ConversionRateSchema=object({id:UUID,source_asset:Type.String({pattern:'^(NGN|USDT_BSC)$'}),
  destination_asset:Type.String({pattern:'^(NGN|USDT_BSC)$'}),rate_numerator:Uint,rate_denominator:Uint,
  fee_bps:Type.Integer({minimum:0,maximum:1000}),minimum_source_minor:Uint,source_ref:text('Finance-approved rate evidence.',300),
  expires_at:Timestamp,created_at:Timestamp},{$id:'ConversionRate',description:'Append-only rational rate snapshot. destination minor units = floor((source minor units - fee) × numerator ÷ denominator).'});
export const ConversionQuoteSchema=object({id:UUID,source_asset:Type.String({pattern:'^(NGN|USDT_BSC)$'}),
  destination_asset:Type.String({pattern:'^(NGN|USDT_BSC)$'}),source_amount_minor:Uint,fee_minor:Uint,
  destination_amount_minor:Uint,rate_numerator:Uint,rate_denominator:Uint,state:Type.String({enum:['quoted','executed']}),
  expires_at:Timestamp,created_at:Timestamp,executed_at:Type.Union([Timestamp,Type.Null()]),trade_id:Type.Optional(UUID)},
  {$id:'ConversionQuote',description:'Immutable 30-second wallet conversion quote. Accepting it atomically moves both exact assets through ring-fenced treasury inventory.'});
export const ConversionInventoryFundingSchema=object({journal_id:UUID,asset:Type.String({pattern:'^(NGN|USDT_BSC)$'}),amount_minor:Uint},
  {$id:'ConversionInventoryFunding',description:'Audited recognition of externally safeguarded conversion inventory.'});
export const ReconciliationSchema=object({id:UUID,asset:Type.String(),status:Type.String({enum:['balanced','exceptions_opened']}),
  escrow_ledger_minor:Uint,chain_net_minor:Type.String({pattern:'^-?(0|[1-9][0-9]*)$'}),
  partner_deposits_minor:Uint,finalized_deposits_minor:Uint,user_claims_minor:Uint,
  market_collateral_minor:Uint,liquidity_reserve_minor:Uint,protocol_fee_minor:Uint,
  exceptions:Type.Array(Type.String()),created_at:Timestamp},
  {$id:'ReconciliationSnapshot',description:'Compares stored observations and ledger. It is not independent proof of partner or chain state.'});
export const StatementSchema=object({id:UUID,effect_id:Type.String(),kind:Type.String(),reference_id:Type.String(),
  asset:Type.String(),bucket:Type.String(),direction:Type.String({enum:['increase','decrease']}),
  amount_minor:Uint,created_at:Timestamp},{$id:'StatementEntry'});
export const SmartAccountSchema=object({chain_id:Uint,address:Type.String({pattern:'^0x[a-f0-9]{40}$'}),
  status:Type.String({enum:['provisioning','active','recovery_pending','suspended']}),
  recovery:Type.Literal('self_service'),financial_mode:Type.String({enum:['disabled','synthetic']})},
  {$id:'SmartAccount',description:'The caller own embedded account metadata. No session keys or recovery secrets are exposed.'});
export const financialSchemas=[FinancialAssetSchema,BalanceSchema,FiatWalletSchema,BankSchema,ResolvedBankAccountSchema,
  FiatDepositSchema,DepositSchema,WithdrawalSchema,AdminNgnPayoutSchema,TokenAssetSchema,AdminCryptoWithdrawalSchema,
  ConversionRateSchema,ConversionQuoteSchema,ConversionInventoryFundingSchema,ReconciliationSchema,StatementSchema,SmartAccountSchema];
