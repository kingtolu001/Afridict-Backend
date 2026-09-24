import { Type } from '@sinclair/typebox';
import { UUID, Timestamp, Uint, object } from '../contracts.js';

const CollateralIdentity={asset_code:Type.String({pattern:'^[A-Z0-9_]{2,32}$'}),contract_unit_minor:Uint};
export const OrderSchema=object({id:UUID,market_id:UUID,...CollateralIdentity,outcome_id:Type.String(),
  side:Type.String({enum:['buy','sell']}),limit_price:Uint,quantity:Uint,remaining:Uint,
  state:Type.String({enum:['open','filled','cancelled']}),sequence:Uint,created_at:Timestamp,updated_at:Timestamp},
{$id:'ClobOrder',description:'Integer share limit order. contract_unit_minor defines one share payout in the governed market asset. Price uses a fixed 1,000,000 probability scale. Both sides require the selected asset before admission.'});
export const FillSchema=object({id:UUID,market_id:UUID,...CollateralIdentity,maker_order_id:UUID,taker_order_id:UUID,
  outcome_id:Type.String(),price:Uint,quantity:Uint,sequence:Uint,created_at:Timestamp},
{$id:'ClobFill',description:'Immutable execution at the resting order price. Each fill escrows both counterparties\' collateral and records per-share fees.'});
export const PositionSchema=object({market_id:UUID,...CollateralIdentity,outcome_id:Type.String(),side:Type.String({enum:['buy','sell']}),
  quantity:Uint,collateral_minor:Uint,fees_minor:Uint},
{$id:'ClobPosition',description:'Account-owned unsettled outcome exposure derived from immutable unredeemed fills. Buy claims the selected outcome and sell claims its complement. Collateral is escrowed until governed redemption.'});
const Level=object({price:Uint,quantity:Uint});
export const BookSchema=object({market_id:UUID,outcome_id:Type.String(),asset_code:Type.Union([Type.String({pattern:'^[A-Z0-9_]{2,32}$'}),Type.Null()]),
  asset_scale:Type.Union([Type.Integer({minimum:0,maximum:36}),Type.Null()]),
  contract_unit_minor:Type.Union([Uint,Type.Null()]),price_scale:Uint,status:Type.String({enum:['open','halted']}),
  sequence:Uint,bids:Type.Array(Level),asks:Type.Array(Level)},
{$id:'ClobBook',description:'Aggregate price levels; bids descend and asks ascend. The sequence is a consistent snapshot cursor for the append-only market event feed.'});
export const TradingStateSchema=object({market_id:UUID,asset_code:Type.String(),asset_scale:Type.Integer({minimum:0,maximum:36}),
  contract_unit_minor:Uint,price_scale:Uint,status:Type.String({enum:['open','halted']}),sequence:Uint},{$id:'ClobTradingState'});
export const MarketCollateralSchema=object({market_id:UUID,asset_code:Type.String(),asset_scale:Type.Integer({minimum:0,maximum:36}),
  contract_unit_minor:Uint,price_scale:Uint,trading_status:Type.String({enum:['open','halted']}),available_minor:Uint,
  reserved_minor:Uint,withdrawal_pending_minor:Uint,conversion_sources:Type.Array(Type.String({pattern:'^[A-Z0-9_]{2,32}$'}))},
  {$id:'MarketCollateral',description:'The governed market asset and the caller wallet projection. conversion_sources identifies funded caller wallets with a current direct rate into this asset.'});
export const MarketCollateralPolicySchema=object({market_id:UUID,asset_code:Type.String(),asset_scale:Type.Integer({minimum:0,maximum:36}),
  contract_unit_minor:Uint,price_scale:Uint,trading_status:Type.String({enum:['open','halted']})},
  {$id:'MarketCollateralPolicy',description:'Public exact-unit collateral identity. It contains no caller balance or private financial data.'});
export const MarketEventSchema=object({sequence:Uint,event_type:Type.String({enum:[
  'activated','halted','order_accepted','fill','order_cancelled','resolution_proposed',
  'resolution_challenged','resolution_finalized','redemption_batch','amm_execution','rfq_execution']}),
  order_id:Type.Union([UUID,Type.Null()]),fill_id:Type.Union([UUID,Type.Null()])},
{$id:'ClobMarketEvent'});
export const PublicCandleSchema=object({timestamp:Timestamp,open:Uint,high:Uint,low:Uint,close:Uint,
  volume:Uint,trade_count:Uint},{$id:'PublicMarketCandle',description:'UTC execution bucket. OHLC prices use the 1,000,000 probability scale; volume is executed whole-share quantity across CLOB, AMM and RFQ venues. Empty buckets are omitted.'});
export const PublicTradeSchema=object({execution_id:Type.String({pattern:'^[a-f0-9]{64}$'}),outcome_id:Type.String(),
  price:Uint,quantity:Uint,sequence:Uint,executed_at:Timestamp},{$id:'PublicMarketTrade',description:'Anonymized execution. No account, order, institution or counterparty identifier is exposed.'});
export const tradingSchemas=[OrderSchema,FillSchema,PositionSchema,BookSchema,TradingStateSchema,MarketCollateralSchema,
  MarketCollateralPolicySchema,MarketEventSchema,PublicCandleSchema,PublicTradeSchema];
