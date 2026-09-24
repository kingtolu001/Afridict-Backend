import { Type, type Static, type TSchema } from '@sinclair/typebox';

const object = <T extends Record<string, TSchema>>(properties: T, options = {}) => Type.Object(properties, { additionalProperties: false, ...options });
const text = (description: string, maxLength = 500) => Type.String({ minLength: 1, maxLength, description });
export const UUID = Type.String({ format: 'uuid', description: 'Opaque resource identifier.' });
export const Timestamp = Type.String({ format: 'date-time', description: 'RFC 3339 instant. Responses use UTC.' });
export const Uint = Type.String({ pattern: '^(0|[1-9][0-9]*)$', maxLength: 78,
  description: 'Exact unsigned integer string, bounded to uint256 by domain validation. Never convert financial values through JavaScript Number.' });
const signed = Type.String({ pattern: '^(0|-?[1-9][0-9]*)$', maxLength: 78 });
export const Country = Type.String({ pattern: '^[A-Z]{2}$', description: 'Country code. ZZ is reserved for the isolated synthetic demo.' });
export const Roles = ['user', 'market_creator', 'market_approver', 'legal_reviewer', 'integrity_reviewer',
  'resolution_reviewer', 'resolution_proposer', 'resolution_finalizer', 'compliance_officer',
  'market_proposer', 'auditor', 'finance_operator'] as const;
export const ErrorSchema = object({
  code: text('Stable error code; branch on this field, not message. Unknown codes must be handled safely.', 80),
  message: text('Safe explanation without provider payloads, identity evidence, or stack traces.'),
  request_id: text('Server-issued correlation identifier. Also returned in X-Request-Id.', 128),
}, { $id: 'ApiError', description: 'Error response. A network timeout does not imply that a command failed. Retry a command using its original idempotency key and body.' });
export const AccountSchema = object({ id: UUID, jurisdiction: Country,
  status: Type.Union([Type.Literal('active'), Type.Literal('suspended')]),
  roles: Type.Array(Type.String({ enum: [...Roles] })), created_at: Timestamp }, { $id: 'Account' });
export const EligibilitySchema = object({ account_id: UUID,
  status: Type.String({ enum: ['pending', 'eligible', 'restricted'] }), policy_version: text('Version of the applied eligibility policy.', 100),
  trading_enabled: Type.Boolean({ description: 'True only when this account is eligible and the configured financial environment permits trading.' }),
  reason_codes: Type.Array(Type.String()), updated_at: Timestamp }, { $id: 'Eligibility' });
const CapabilityDecisionSchema = object({ allowed: Type.Boolean(), requirements: Type.Array(Type.String({ enum:
  ['EMAIL_VERIFICATION','PHONE_VERIFICATION','IDENTITY_VERIFICATION','FUNDING_ELIGIBILITY','JURISDICTION_POLICY','RISK_REVIEW','CAPABILITY_NOT_ACTIVE'] })) });
export const CapabilitiesSchema = object({
  BROWSE: CapabilityDecisionSchema, TRADE: CapabilityDecisionSchema, DEPOSIT_NGN: CapabilityDecisionSchema,
  DEPOSIT_CRYPTO: CapabilityDecisionSchema, WITHDRAW_NGN: CapabilityDecisionSchema,
  WITHDRAW_CRYPTO: CapabilityDecisionSchema, USE_TRADING_API: CapabilityDecisionSchema,
}, { $id: 'Capabilities', description: 'Server-owned action decisions. The UI may explain requirements but must not use them to bypass backend enforcement.' });
export const AuthenticationConfigurationSchema=object({
  provider:Type.Literal('native'),
  methods:Type.Array(object({id:Type.String({enum:['password','google']}),enabled:Type.Boolean()})),
  registration_available:Type.Boolean(),account_linking:Type.Literal('authenticated_explicit'),email_verification_required:Type.Boolean(),
  password_policy:object({minimum_length:Type.Integer(),requires_uppercase:Type.Boolean(),requires_lowercase:Type.Boolean(),requires_number:Type.Boolean()}),
},{$id:'AuthenticationConfiguration',description:'Public native authentication capabilities. Passwords are hashed by Afridict and never returned or logged.'});
const NativeSessionFields={access_token:text('Opaque Afridict session token.',128),token_type:Type.Literal('Bearer'),
  expires_in:Type.Integer({minimum:60}),account:Type.Ref(AccountSchema)};
export const GoogleAuthorizationSchema=object({authorization_url:Type.String({format:'uri',pattern:'^https://accounts\\.google\\.com/'}),
  expires_in:Type.Integer({minimum:60,maximum:900})},{$id:'GoogleAuthorization',description:'Short-lived direct Google authorization request. The URL contains one-use state and PKCE protection.'});
export const GoogleLoginResultSchema=Type.Union([
  object({state:Type.Literal('authenticated'),...NativeSessionFields}),
  object({state:Type.Literal('link_required'),email:Type.String({format:'email',maxLength:254})}),
  object({state:Type.Literal('registration_required'),registration_token:text('One-use Google registration credential.',128),
    email:Type.String({format:'email',maxLength:254}),given_name:Type.Union([Type.String({maxLength:100}),Type.Null()]),
    family_name:Type.Union([Type.String({maxLength:100}),Type.Null()]),expires_in:Type.Integer({minimum:60,maximum:900})}),
],{$id:'GoogleLoginResult'});
export const GoogleAuthenticatedSessionSchema=object({state:Type.Literal('authenticated'),...NativeSessionFields},{$id:'GoogleAuthenticatedSession'});
export const GoogleLinkSchema=object({linked:Type.Literal(true),email:Type.String({format:'email',maxLength:254})},{$id:'GoogleLink'});
export const RegistrationProfileSchema=object({first_name:text('Given name.',100),last_name:text('Family name.',100),
  email:Type.String({format:'email',maxLength:254}),phone_number:Type.String({pattern:'^\\+[1-9][0-9]{7,14}$'}),
  terms_version:text('Accepted terms version.',100),privacy_version:text('Accepted privacy policy version.',100),accepted_at:Timestamp,
},{$id:'RegistrationProfile',description:'Account-owned registration profile. Passwords are accepted only by native authentication endpoints and stored as one-way scrypt hashes.'});
export const PublicProfileSchema=object({account_id:UUID,username:Type.Union([Type.String({pattern:'^[a-z0-9](?:[a-z0-9_]{1,28}[a-z0-9])?$'}),Type.Null()]),
  display_name:Type.Union([text('Public display name.',100),Type.Null()]),bio:Type.Union([Type.String({maxLength:500}),Type.Null()]),
  avatar_media_id:Type.Union([UUID,Type.Null()]),cover_media_id:Type.Union([UUID,Type.Null()]),
  avatar_url:Type.Union([Type.String({format:'uri',pattern:'^https://'}),Type.Null()]),cover_url:Type.Union([Type.String({format:'uri',pattern:'^https://'}),Type.Null()]),
  created_at:Type.Union([Timestamp,Type.Null()]),updated_at:Type.Union([Timestamp,Type.Null()])},{$id:'PublicProfile'});
export const OnboardingStatusSchema=object({account_id:UUID,registration_complete:Type.Boolean(),public_profile_complete:Type.Boolean(),username_set:Type.Boolean(),
  email_verified:Type.Boolean(),phone_verified:Type.Boolean(),identity_status:Type.String({enum:['NOT_STARTED','PENDING','IN_REVIEW','VERIFIED','FAILED','REQUIRES_RETRY']})},{$id:'OnboardingStatus'});
export const UsernameAvailabilitySchema=object({username:Type.String({pattern:'^[a-z0-9](?:[a-z0-9_]{1,28}[a-z0-9])?$'}),available:Type.Boolean()},{$id:'UsernameAvailability'});
export const ProfileMediaUploadSchema=object({id:UUID,kind:Type.String({enum:['avatar','cover']}),status:Type.String({enum:['pending','complete','rejected','deleted']}),
  created_at:Timestamp,completed_at:Type.Union([Timestamp,Type.Null()]),upload_url:Type.Optional(Type.String({format:'uri'}))},{$id:'ProfileMediaUpload'});
export const MarketMediaUploadSchema=object({id:UUID,status:Type.String({enum:['pending','complete','rejected','deleted']}),
  created_at:Timestamp,completed_at:Type.Union([Timestamp,Type.Null()]),upload_url:Type.Optional(Type.String({format:'uri'}))},
{$id:'MarketMediaUpload',description:'Market-creator-owned outcome image upload. Only completed uploads may be attached to a draft.'});
export const ContactVerificationSchema=object({id:UUID,channel:Type.String({enum:['email','phone']}),
  state:Type.String({enum:['pending','delivery_uncertain','approved','expired','failed']}),
  attempts_remaining:Type.Integer({minimum:0,maximum:5}),expires_at:Timestamp,resend_available_at:Timestamp,
},{$id:'ContactVerification',description:'Normalized contact possession workflow. OTP values and provider credentials are never persisted or returned.'});
const IdentityStateSchema=Type.String({enum:['NOT_STARTED','PENDING','IN_REVIEW','VERIFIED','FAILED','REQUIRES_RETRY']});
export const IdentityStatusSchema=object({state:IdentityStateSchema,inquiry_id:Type.Union([UUID,Type.Null()]),updated_at:Timestamp},
  {$id:'IdentityStatus',description:'Afridict-normalized identity state. Persona remains the external identity-document authority; raw documents are never returned.'});
export const IdentitySessionSchema=object({inquiry_id:UUID,state:Type.Literal('PENDING'),client_token:text('Short-lived Persona client token for the authenticated account only.',4096),
  expires_at:Type.Union([Timestamp,Type.Null()])},{$id:'IdentitySession'});
export const EvidenceSource = object({ name: text('Published source name.', 150),
  uri: Type.String({ format: 'uri', pattern: '^https://', maxLength: 2048, description: 'Evidence-source reference. This API never fetches supplied URLs.' }) });
const scalar = object({ lower: signed, upper: signed, decimals: Type.Integer({ minimum: 0, maximum: 18 }),
  unit: text('Unit for the scaled scalar observation.', 80) });
export const Terms = object({
  question: text('Precise public question. Do not include private or identifying information.'),
  market_type: Type.String({ enum: ['binary', 'categorical', 'scalar'] }),
  template_id: text('Approved template identifier.', 80), template_version: Type.Integer({ minimum: 1 }),
  outcomes: Type.Array(object({ id: Type.String({ pattern: '^[a-z][a-z0-9_]{0,31}$' }), label: text('Outcome label.', 100),
    image_media_id:Type.Optional(UUID),image_url:Type.Optional(Type.String({format:'uri',pattern:'^https://',readOnly:true,
      description:'Server-derived CDN URL for a completed outcome image. Clients cannot set this field.'})),
    image_alt:Type.Optional(text('Accessible description for the outcome image.',200)) }), { minItems: 2, maxItems: 32 }),
  scalar_range: Type.Optional(scalar),
  category: Type.String({ pattern: '^[a-z][a-z0-9_-]{0,63}$' }),
  jurisdictions: Type.Array(Country, { minItems: 1, maxItems: 54, uniqueItems: true }),
  open_at: Timestamp, trading_cutoff: Timestamp, expected_event_at: Timestamp, resolution_deadline: Timestamp,
  resolution: object({
    criteria: text('Deterministic observation and outcome-selection criteria.', 4000),
    timezone: text('IANA timezone used to interpret evidence.', 100),
    method: Type.String({ enum: ['automated_adapter', 'bonded_proposal'] }),
    primary_source: EvidenceSource, fallback_sources: Type.Array(EvidenceSource, { minItems: 1, maxItems: 5 }),
    correction_rule: text('Handling of revisions and corrected results.', 2000),
    cancellation_rule: text('Exact conditions for cancellation.', 2000),
    invalid_rule: text('Exact invalid-market conditions and reference to the approved payout policy.', 2000),
    challenge_window_seconds: Type.Integer({ minimum: 60, maximum: 2592000 }),
    timelock_seconds: Type.Integer({ minimum: 60, maximum: 2592000 }),
    panel_size: Type.Integer({ minimum: 3, maximum: 21 }),
    adjudication_threshold: Type.Integer({ minimum: 2, maximum: 21 }),
    adjudicator_policy_ref: text('Approved conflict, recusal, quorum and adjudication policy reference.', 200),
    bond_policy_ref: text('Approved proposal/challenge bond and slashing policy reference.', 200),
    payout_policy_ref: text('Approved payout policy including invalid outcomes and rounding.', 200),
  }),
  risk: object({ classification: Type.String({ enum: ['standard', 'elevated', 'high'] }),
    eligibility_policy_ref: text('Jurisdiction and participant eligibility policy reference.', 200),
    exposure_limit_minor: Uint, fee_bps: Type.Integer({ minimum: 0, maximum: 1000 }),
    settlement_asset_ref: text('Collateral registry reference; this API does not select or approve a token.', 200) }),
  liquidity: object({ clob: Type.Literal(true), amm_enabled: Type.Boolean(), rfq_enabled: Type.Boolean(),
    subsidy_limit_minor: Uint, inventory_limit_minor: Uint, loss_limit_minor: Uint,
    max_slippage_bps: Type.Integer({ minimum: 0, maximum: 10000 }) }),
}, { $id: 'MarketTerms', description: 'Versioned public market policy. Binary requires yes/no outcomes; scalar requires short/long and scalar_range; categorical requires unique outcomes. Publication fixes the complete policy hash. Only the synthetic demo may activate trading.' });
export type MarketTerms = Static<typeof Terms>;
export const MarketSchema = object({ id: UUID, state: Type.String({ enum: ['draft', 'review', 'rejected', 'scheduled'] }),
  version: Type.Integer({ minimum: 1 }), policy_hash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  terms: Type.Ref(Terms), created_at: Timestamp, updated_at: Timestamp,
  published_at: Type.Union([Timestamp, Type.Null()]), trading_enabled: Type.Boolean(),
}, { $id: 'Market', description: 'Market metadata. trading_enabled is true only when an open collateral book exists in the active financial environment.' });
const NullablePrice=Type.Union([Type.String({pattern:'^[1-9][0-9]{0,5}$'}),Type.Null()]);
const NullableUint=Type.Union([Uint,Type.Null()]);
export const MarketDiscoveryOutcomeSchema=object({outcome_id:Type.String({pattern:'^[a-z][a-z0-9_]{0,31}$'}),
  best_bid:NullablePrice,best_ask:NullablePrice,last_price:NullablePrice},{$id:'MarketDiscoveryOutcome'});
export const MarketDiscoverySchema=object({asset_code:Type.String({enum:['NGN','USDT_BSC']}),asset_scale:Type.Integer({minimum:0,maximum:36}),
  price_scale:Type.Literal('1000000'),outcomes:Type.Array(Type.Ref(MarketDiscoveryOutcomeSchema),{minItems:2,maxItems:32}),
  change_24h_bps:Type.Union([Type.String({pattern:'^-?(0|[1-9][0-9]*)$'}),Type.Null()]),volume_24h_minor:NullableUint,
  liquidity_minor:NullableUint,trades_24h:NullableUint},{$id:'MarketDiscovery',description:'Asset-specific market table projection. Volume is executed buyer plus seller collateral during the preceding 24 hours. Liquidity is collateral represented by currently open CLOB orders at their limit prices, excluding fees. Change compares the canonical first outcome latest price with its last execution at or before the 24-hour boundary.'});
export const MarketDiscoveryItemSchema=object({...MarketSchema.properties,
  featured_rank:Type.Union([Type.Integer({minimum:1,maximum:1000}),Type.Null()]),
  discovery:Type.Union([Type.Ref(MarketDiscoverySchema),Type.Null()])},{$id:'MarketDiscoveryItem'});
export const MarketFacetsSchema=object({categories:Type.Array(Type.String({pattern:'^[a-z][a-z0-9_-]{0,63}$'}),{uniqueItems:true}),
  market_types:Type.Array(Type.String({enum:['binary','categorical','scalar']}),{uniqueItems:true})},{$id:'MarketFacets'});
export const ProposalSchema = object({ id: UUID, status: Type.String({ enum: ['submitted', 'accepted', 'rejected'],
  description: 'accepted means an internal creator adopted the proposal into a draft. It does not mean the market is published or approved.' }),
  terms: Type.Ref(Terms), created_at: Timestamp }, { $id: 'MarketProposal' });
export const ReviewSchema = object({ id: UUID, market_id: UUID, market_version: Type.Integer(),
  review_type: Type.String({ enum: ['product', 'legal', 'integrity', 'resolution'] }),
  decision: Type.String({ enum: ['approved', 'rejected'] }), policy_hash: Type.String(), created_at: Timestamp,
}, { $id: 'MarketReview' });
export const EligibilityReviewSchema = object({ id: UUID, account_id: UUID,
  decision: Type.String({ enum: ['eligible', 'restricted'] }), policy_version: Type.String(),
  status: Type.String({ enum: ['pending', 'approved', 'rejected'] }), created_at: Timestamp,
}, { $id: 'EligibilityReview' });
export const Reason = text('Operational reason; do not include raw identity evidence or personal information.', 1000);
export const EvidenceRef = Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$', description: 'Opaque reference to access-controlled evidence. Never send raw KYC data.' });
export const VersionCommand = object({ expected_version: Type.Integer({ minimum: 1 }), reason: Reason });
export const ReviewCommand = object({ expected_version: Type.Integer({ minimum: 1 }),
  review_type: Type.String({ enum: ['product', 'legal', 'integrity', 'resolution'] }),
  decision: Type.String({ enum: ['approved', 'rejected'] }), reason: Reason, evidence_ref: EvidenceRef });
export const ListQuery = object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  cursor: Type.Optional(Type.String({ maxLength: 1024 })),
  asset_code:Type.Optional(Type.String({enum:['NGN','USDT_BSC']})),q:Type.Optional(Type.String({minLength:1,maxLength:100})),
  market_type: Type.Optional(Type.String({ enum: ['binary', 'categorical', 'scalar'] })),
  category: Type.Optional(Type.String({ pattern: '^[a-z][a-z0-9_-]{0,63}$' })),jurisdiction:Type.Optional(Country),
  status:Type.Optional(Type.String({enum:['open','upcoming','closed','resolving','resolved']})) });
export const IdParams = object({ id: UUID });
export const IdempotencyHeaders = Type.Object({ 'idempotency-key': Type.String({ minLength: 8, maxLength: 128,
  pattern: '^[A-Za-z0-9_-]+$', description: 'Unique per actor across all commands. Committed responses are retained indefinitely in this release. Same method, route, resource and canonical JSON body returns the original result; different content returns 409. Concurrent retries wait for the transaction or return 503; retry with the same key. Failed transactions may be retried. Authentication and authorization are rechecked on every retry.' }) }, { additionalProperties: true });
export const schemas = [ErrorSchema, AccountSchema, EligibilitySchema, CapabilitiesSchema, AuthenticationConfigurationSchema,
  GoogleAuthorizationSchema,GoogleLoginResultSchema,GoogleAuthenticatedSessionSchema,GoogleLinkSchema,
  RegistrationProfileSchema,PublicProfileSchema,OnboardingStatusSchema,UsernameAvailabilitySchema,ProfileMediaUploadSchema,MarketMediaUploadSchema,ContactVerificationSchema,IdentityStatusSchema,IdentitySessionSchema,
  Terms, MarketSchema,MarketDiscoveryOutcomeSchema,MarketDiscoverySchema,MarketDiscoveryItemSchema,MarketFacetsSchema,
  ProposalSchema, ReviewSchema, EligibilityReviewSchema];
export { object, text };
