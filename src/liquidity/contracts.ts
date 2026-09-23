import { Type } from '@sinclair/typebox';
import { Timestamp, UUID, Uint, object } from '../contracts.js';

export const AmmPoolSchema=object({market_id:UUID,outcome_id:Type.String(),asset_code:Type.String(),
  contract_unit_minor:Uint,status:Type.String({enum:['open','halted']}),inventory_limit:Uint,subsidy_limit:Uint,loss_limit:Uint,
  max_slippage_bps:Type.Integer(),impact_bps:Type.Integer(),fee_bps:Type.Integer(),shares_committed:Uint,
  subsidy_committed:Uint,worst_case_loss_committed:Uint,funded_minor:Uint},{$id:'AmmPool'});
export const AmmFundingSchema=object({market_id:UUID,outcome_id:Type.String(),asset_code:Type.String(),funded_minor:Uint},{$id:'AmmFunding'});
export const AmmReferenceSchema=object({id:UUID,market_id:UUID,outcome_id:Type.String(),asset_code:Type.String(),price:Uint,
  observed_at:Timestamp,expires_at:Timestamp,source_ref:Type.String()},{$id:'AmmReferencePrice'});
export const AmmQuoteSchema=object({id:UUID,market_id:UUID,asset_code:Type.String(),contract_unit_minor:Uint,
  outcome_id:Type.String(),side:Type.String({enum:['buy','sell']}),
  quantity:Uint,reference_price_id:UUID,price:Uint,user_collateral:Uint,amm_collateral:Uint,fee:Uint,user_total:Uint,
  expires_at:Timestamp,state:Type.String({enum:['quoted','executed','expired']}),created_at:Timestamp,
  executed_at:Type.Union([Timestamp,Type.Null()])},{$id:'AmmQuote'});
export const liquiditySchemas=[AmmPoolSchema,AmmFundingSchema,AmmReferenceSchema,AmmQuoteSchema];
