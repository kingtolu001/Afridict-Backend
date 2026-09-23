import { Type } from '@sinclair/typebox';
import { UUID,Timestamp,Uint,object } from '../contracts.js';

export const ResolutionResultSchema=Type.Union([
  object({kind:Type.Literal('outcome'),outcome_id:Type.String({pattern:'^[a-z][a-z0-9_]{0,31}$'})}),
  object({kind:Type.Literal('scalar'),observed_value:Type.String({pattern:'^(0|-?[1-9][0-9]*)$',maxLength:78})}),
  object({kind:Type.Literal('invalid')}),object({kind:Type.Literal('cancelled')}),
],{$id:'ResolutionResult',description:'Result under published policy. Scalar observations use the market\'s published units and bounds; invalid/cancelled refund recorded matched collateral.'});
export const ResolutionEvidenceSchema=object({id:UUID,market_id:UUID,source_name:Type.String(),
  source_uri:Type.String({format:'uri'}),artifact_ref:Type.String(),
  document_sha256:Type.String({pattern:'^[a-f0-9]{64}$'}),record_hash:Type.String({pattern:'^[a-f0-9]{64}$'}),
  observed_at:Timestamp,created_at:Timestamp},{$id:'ResolutionEvidence',
  description:'Append-only reference to an externally archived source artifact. The supplied document digest is an attestation; Afridict does not fetch or independently verify artifact bytes.'});
export const ResolutionCaseSchema=object({market_id:UUID,state:Type.String({enum:['proposed','challenged','finalized']}),
  proposal:Type.Ref(ResolutionResultSchema),proposal_evidence_id:UUID,proposed_at:Timestamp,
  challenge_deadline:Timestamp,timelock_until:Timestamp,
  challenge:Type.Union([Type.Ref(ResolutionResultSchema),Type.Null()]),
  challenge_evidence_id:Type.Union([UUID,Type.Null()]),
  final_result:Type.Union([Type.Ref(ResolutionResultSchema),Type.Null()]),
  final_result_hash:Type.Union([Type.String({pattern:'^[a-f0-9]{64}$'}),Type.Null()]),
  finalized_at:Type.Union([Timestamp,Type.Null()])},{$id:'ResolutionCase'});
export const ResolutionBallotSchema=object({id:UUID,market_id:UUID,
  decision:Type.String({enum:['proposal','challenge','recuse']}),created_at:Timestamp},
  {$id:'ResolutionBallot',description:'Immutable, attributable adjudicator vote. Identity and reasons remain in the restricted audit record.'});
export const ResolutionCloseSchema=object({market_id:UUID,status:Type.Literal('halted'),
  cancelled:Type.Integer({minimum:0}),remaining:Uint},{$id:'ResolutionBookClosure'});
export const RedemptionBatchSchema=object({market_id:UUID,fill_count:Type.Integer({minimum:0}),
  paid_by_asset:Type.Array(object({asset_code:Type.String(),amount_minor:Uint})),remaining:Uint},
  {$id:'ResolutionRedemptionBatch',description:'Exact redemption totals remain separated by collateral asset and are never arithmetically combined.'});
export const RedemptionSchema=object({fill_id:UUID,amount_minor:Uint,created_at:Timestamp},
  {$id:'ResolutionRedemption'});
export const resolutionSchemas=[ResolutionResultSchema,ResolutionEvidenceSchema,ResolutionCaseSchema,
  ResolutionBallotSchema,ResolutionCloseSchema,RedemptionBatchSchema,RedemptionSchema];
