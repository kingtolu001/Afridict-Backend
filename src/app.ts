import Fastify, { LogController, type FastifyRequest, type FastifySchema } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import type { Config } from './platform/config.js';
import type { Database, Sql } from './platform/database.js';
import { AppError, requireCondition } from './platform/errors.js';
import { createErrorReporter } from './platform/error-reporting.js';
import { loggingConfiguration } from './platform/logging.js';
import { command, hash, record } from './platform/commands.js';
import { findAccount, hasRole, oidcAuthenticator, publicAccount, type Account, type Authenticator, type Principal } from './identity/auth.js';
import { schemas, AccountSchema, EligibilitySchema, ErrorSchema, IdParams, IdempotencyHeaders,
  Terms, MarketSchema, ProposalSchema, ReviewSchema, ReviewCommand, VersionCommand, ListQuery,
  Reason, EvidenceRef, EligibilityReviewSchema, CapabilitiesSchema, AuthenticationConfigurationSchema,
  RegistrationProfileSchema,ContactVerificationSchema,IdentityStatusSchema,IdentitySessionSchema,
  PublicProfileSchema,OnboardingStatusSchema,UsernameAvailabilitySchema,ProfileMediaUploadSchema,
  Country, UUID, Timestamp, Uint, object, text, type MarketTerms } from './contracts.js';
import { approvedTemplate, approvedReferences, createDraft, editDraft, getMarket, mayReadDraft, publicMarket, publish, reviewMarket,
  submitDraft, type MarketRow } from './markets/service.js';
import { validateTerms } from './markets/domain.js';
import { financialSchemas, FinancialAssetSchema, BalanceSchema, DepositSchema, WithdrawalSchema,
  ReconciliationSchema, StatementSchema, SmartAccountSchema,FiatWalletSchema,BankSchema,ResolvedBankAccountSchema,
  FiatDepositSchema,AdminNgnPayoutSchema,TokenAssetSchema,AdminCryptoWithdrawalSchema,ConversionInventoryFundingSchema,
  ConversionQuoteSchema,ConversionRateSchema } from './funding/contracts.js';
import { applyPartnerDeposit, createDepositIntent, createWithdrawal, cancelWithdrawal, finalizeDeposit,
  finalizeWithdrawal, markWithdrawalUncertain, publicDeposit, publicWithdrawal, submitWithdrawal,
  type PartnerVerifier } from './funding/service.js';
import { walletBalances } from './financial/ledger.js';
import { reconcile } from './financial/reconciliation.js';
import { accountAssurance, evaluateCapabilities } from './identity/capabilities.js';
import { registerProfile } from './identity/registration.js';
import { CloudinaryProfileMediaStorage, completeMediaUpload, createMediaUpload, getPublicProfile, onboardingStatus, savePublicProfile, syntheticProfileMediaStorage, usernameAvailability, type MediaKind, type MediaType } from './identity/profile.js';
import { checkContactCode,sendContactCode,type ContactDependencies } from './identity/contact.js';
import { applyPersonaEvent,createIdentitySession,verifyPersonaSignature,type PersonaDependencies } from './identity/persona.js';
import type { FiatDependencies } from './funding/swervpay.js';
import {approveNgnPayout,completeNgnPayout,createFiatDeposit,getFiatDeposit,listNgnPayouts,requestNgnWithdrawal} from './funding/fiat.js';
import {approveCryptoWithdrawal,createCryptoWithdrawal,listCryptoReviews,listCryptoWithdrawals,publicTokenAsset,
  recordCryptoSubmission,type TokenAssetRow} from './funding/crypto.js';
import {createConversionQuote,executeConversionQuote,fundConversionInventory,getConversionQuote,
  publishConversionRate} from './funding/conversion.js';
import {BookSchema,FillSchema,MarketCollateralPolicySchema,MarketCollateralSchema,MarketEventSchema,OrderSchema,PositionSchema,TradingStateSchema,tradingSchemas} from './trading/contracts.js';
import {activateClob,cancelOrder,haltClob,listFills,listOrders,listPositions,marketCollateral,marketCollateralPolicy,
  marketEvents,orderBook,submitOrder} from './trading/service.js';
import {ResolutionBallotSchema,ResolutionCaseSchema,ResolutionCloseSchema,ResolutionEvidenceSchema,
  ResolutionResultSchema,RedemptionBatchSchema,RedemptionSchema,resolutionSchemas} from './resolution/contracts.js';
import {archiveEvidence,ballotResolution,challengeResolution,closeResolutionBook,finalizeResolution,
  getResolution,listMyRedemptions,listResolutionEvidence,proposeResolution,redeemBatch} from './resolution/service.js';
import type {ResolutionResult} from './resolution/model.js';
import {SettlementBatchSchema,SettlementClaimSchema,SettlementRefreshSchema,settlementSchemas} from './settlement/contracts.js';
import {getSettlementBatch,listMySettlementClaims,prepareSettlementBatch,refreshSettlementBatch,
  submitSettlementBatch,type SettlementDependencies} from './settlement/service.js';
import {AmmFundingSchema,AmmPoolSchema,AmmQuoteSchema,AmmReferenceSchema,liquiditySchemas} from './liquidity/contracts.js';
import {activateAmm,createAmmQuote,executeAmmQuote,fundAmm,listAmmQuotes,recordAmmReference} from './liquidity/amm-service.js';
import {RfqEntitySchema,RfqFillSchema,RfqMembershipSchema,RfqQuoteSchema,RfqRequestSchema,rfqSchemas} from './liquidity/rfq-contracts.js';
import {acceptRfqQuote,addRfqMember,approveRfqEntity,cancelRfqRequest,createRfqEntity,createRfqQuote,
  createRfqRequest,listRfqEntities,listRfqFills,listRfqMembers,listRfqQuotes,listRfqRequests} from './liquidity/rfq-service.js';
import {RealtimeTicketSchema,realtimeSchemas} from './realtime/contracts.js';
import {createRealtimeTicket} from './realtime/service.js';
import {registerRealtimeSocket,type RealtimeOptions} from './realtime/socket.js';

type Request = FastifyRequest;
type Context = { sql: Sql; actor: Account; principal: Principal; request: Request };
type Work = (context: Context) => Promise<{ status: number; body: unknown }>;
const errorResponses: Record<number, TSchema> = Object.fromEntries([400,401,403,404,409,413,415,422,429,500,502,503]
  .map(code => [code, Type.Ref(ErrorSchema)]));
function contract(id: string, tag: string, summary: string, description: string, response: TSchema,
  options: { body?: TSchema; params?: TSchema; querystring?: TSchema; headers?: TSchema; status?: number; public?: boolean; roles?: string[]; command?: boolean } = {}): FastifySchema {
  return { operationId: id, tags: [tag], summary, description,
    security: options.public ? [] : [{ bearerAuth: [] }],
    ...(options.roles ? { 'x-required-roles': options.roles } : {}),
    ...(options.command ? { headers: IdempotencyHeaders } : options.headers ? {headers:options.headers} : {}),
    ...(options.body ? { body: options.body } : {}), ...(options.params ? { params: options.params } : {}),
    ...(options.querystring ? { querystring: options.querystring } : {}),
    response: { [options.status ?? 200]: response, ...errorResponses } } as FastifySchema;
}

export async function buildApp(db: Database, cfg: Config, authOverride?: Authenticator, partnerVerifier?: PartnerVerifier,
  contactDependencies?:ContactDependencies,personaDependencies?:PersonaDependencies,fiatDependencies?:FiatDependencies,
  resolutionClock:()=>Date=()=>new Date(),settlementDependencies?:SettlementDependencies,realtimeOptions?:RealtimeOptions) {
  if (cfg.environment === 'production' && (cfg.authMode !== 'oidc' || authOverride)) throw new Error('Production requires the configured OIDC verifier');
  if (cfg.environment === 'production' && cfg.financialMode !== 'disabled') throw new Error('Financial activation requires approved adapters and governance');
  const auth = authOverride ?? oidcAuthenticator(cfg);
  const profileMediaStorage = cfg.cloudinary ? new CloudinaryProfileMediaStorage(cfg.cloudinary) : syntheticProfileMediaStorage;
  const errorReporter = createErrorReporter(cfg);
  const app = Fastify({ logger: loggingConfiguration(cfg.logger),
    logController: new LogController({ disableRequestLogging: true }), requestIdHeader: false, genReqId: () => `req_${randomUUID()}`,
    bodyLimit: 32768, requestTimeout: 15000, connectionTimeout: 10000,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array', allErrors: false } } });
  await app.register(helmet);
  await app.register(cors, { origin: cfg.corsOrigins, credentials: false, allowedHeaders: ['Authorization','Content-Type','Idempotency-Key'],
    exposedHeaders: ['X-Request-Id','Retry-After'], methods: ['GET','POST','PUT','OPTIONS'] });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute', global: true,
    errorResponseBuilder: req => ({ code: 'RATE_LIMITED', message: 'Request limit exceeded. Retry after the indicated delay.', request_id: req.id }) });
  await app.register(websocket,{options:{maxPayload:4096}});
  await app.register(swagger, { openapi: { openapi: '3.1.1',
    info: { title: 'Afridict Backend API', version: '0.5.0', description: 'Financial and prediction-market infrastructure API. Collateralized matching, governed resolution, redemption and Robinhood Chain settlement preparation operate only in the isolated synthetic testnet workflow. Real-money trading, mainnet settlement and production outcome finality remain disabled pending approved deployments, adapters and governance.' },
    servers: [{ url: 'http://127.0.0.1:3000', description: 'Local development only; not a production address' }],
    tags: ['System','Identity','Compliance','Markets','Governance','Proposals','Audit','Funding','Portfolio','Finance','Synthetic','Trading','Liquidity','Resolution','Settlement'].map(name => ({ name, description: `${name} operations` })),
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT',
      description: 'OIDC access token verified against configured issuer, audience and JWKS. Roles come from server-owned account records. Demo mode accepts only synthetic demo.<persona> selectors; those never work in production.' } } },
  }, refResolver: { buildLocalReference: json => String(json.$id) } });
  for (const schema of [...schemas,...financialSchemas,...tradingSchemas,...resolutionSchemas,...settlementSchemas,
    ...liquiditySchemas,...rfqSchemas,...realtimeSchemas]) app.addSchema(schema);
  if (cfg.docs) await app.register(swaggerUi, { routePrefix: '/docs', staticCSP: true });
  app.addHook('onRequest', async (request, reply) => { reply.header('X-Request-Id', request.id); reply.header('Cache-Control', 'no-store'); });
  app.addHook('preParsing',async(request,_reply,payload)=>{
    if(request.url.split('?')[0]!=='/v1/webhooks/persona')return payload;
    const chunks:Buffer[]=[];let size=0;
    const tee=new Transform({transform(chunk,_encoding,done){const value=Buffer.from(chunk);size+=value.length;
      if(size>32768)return done(new Error('Persona webhook exceeds body limit'));chunks.push(value);done(null,value);},
    flush(done){(request as Request&{rawBody?:Buffer}).rawBody=Buffer.concat(chunks);done();}});
    return payload.pipe(tee);
  });
  app.addHook('onResponse', async (request, reply) => {
    // Never log URL queries, payloads, provider subjects, credentials or evidence.
    request.log.info({ request_id: request.id, operation: request.routeOptions.schema?.operationId,
      status: reply.statusCode, elapsed_ms: reply.elapsedTime }, 'request completed');
  });
  app.setErrorHandler((error, request, reply) => {
    let status = 500, code = 'INTERNAL_ERROR', message = 'The request could not be completed.';
    const failure = error as { validation?: unknown; statusCode?: number; code?: string };
    if (error instanceof AppError) ({ statusCode: status, code, message } = error);
    else if (failure.validation || failure.statusCode === 400 || failure.statusCode === 413) {
      status = failure.statusCode === 413 ? 413 : 400; code = 'VALIDATION_FAILED'; message = 'The request does not satisfy the operation schema.';
    } else if (failure.statusCode === 415) { status = 415; code = 'UNSUPPORTED_MEDIA_TYPE'; message = 'Use application/json for request bodies.'; }
    else if (failure.statusCode === 429) { status = 429; code = 'RATE_LIMITED'; message = 'Request limit exceeded.'; }
    else if (['40001','40P01','55P03','57014','ECONNREFUSED','ECONNRESET','ETIMEDOUT','57P01','08006'].includes(failure.code ?? '')) {
      status = 503; code = 'DEPENDENCY_UNAVAILABLE'; message = 'The operation is temporarily unavailable. Retry commands with the same idempotency key.';
    }
    if (status >= 500) {
      request.log.error({ request_id: request.id, operation: request.routeOptions.schema?.operationId, code }, 'request failed');
      errorReporter.capture(error, { requestId: request.id, operation: request.routeOptions.schema?.operationId, code });
    }
    if (status === 401) reply.header('WWW-Authenticate', 'Bearer');
    if (status === 503) reply.header('Retry-After', '2');
    return reply.code(status).send({ code, message, request_id: request.id });
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ code: 'NOT_FOUND', message: 'Route not found.', request_id: request.id }));
  app.addHook('onClose', async () => { await errorReporter.flush(2000); });
  const principal = async (request: Request) => {
    const header = request.headers.authorization;
    requireCondition(header, 401, 'UNAUTHENTICATED', 'A valid bearer access token is required.');
    requireCondition(header.startsWith('Bearer ') && header.length <= 8192, 401, 'UNAUTHENTICATED', 'A valid bearer access token is required.');
    return auth.verify(header.slice(7));
  };
  const authenticated = async (request: Request, roles: string[] = []) => {
    const p = await principal(request); const a = await findAccount(db, p);
    if (roles.length) hasRole(a, ...roles); return { p, a };
  };
  const run = (roles: string[], work: Work) => async (request: Request, reply: import('fastify').FastifyReply) => {
    const p = await principal(request);
    let actor: Account;
    const result = await command(db, hash({ issuer: p.issuer, subject: p.subject }), String(request.headers['idempotency-key']),
      { operation: request.routeOptions.schema?.operationId, params: request.params, body: request.body ?? null },
      async sql => { actor = await findAccount(sql, p, true); if (roles.length) hasRole(actor, ...roles); },
      sql => work({ sql, actor, principal: p, request }));
    return reply.code(result.status).send(result.body);
  };
  const id = (req: Request) => (req.params as { id: string }).id;

  app.post('/v1/realtime/tickets',{schema:contract('createRealtimeTicket','Trading','Create a one-use realtime ticket',
    'Exchanges the caller bearer-authenticated session for a random one-use WebSocket credential. The server stores only its SHA-256 digest; the ticket expires after 60 seconds and must be sent in the first WebSocket message.',
    Type.Ref(RealtimeTicketSchema),{status:201})},async(request,reply)=>{
      const {a}=await authenticated(request);
      return reply.code(201).send(await db.transaction(sql=>createRealtimeTicket(sql,a.id)));
    });
  registerRealtimeSocket(app,db,realtimeOptions);

  app.get('/health/live', { schema: contract('getLiveness','System','Check process liveness','Returns process liveness; does not prove database, partner or chain readiness.', object({ status: Type.Literal('ok') }), { public: true }) }, async () => ({ status: 'ok' }));
  app.get('/health/ready', { schema: contract('getReadiness','System','Check database readiness','Checks connectivity and that the governance schema exists. This is not a production financial-readiness assertion.', object({ status: Type.Literal('ready') }), { public: true }) }, async () => {
    await db.query('SELECT id FROM accounts LIMIT 1'); return { status: 'ready' };
  });
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  app.get('/v1/auth/configuration',{schema:contract('getAuthenticationConfiguration','Identity','Discover available sign-in methods',
    'Returns public OIDC client configuration only. Password credentials, Google authorization codes, client secrets and account linking remain with the selected identity provider. Methods remain disabled until that provider is configured.',Type.Ref(AuthenticationConfigurationSchema),{public:true})},async()=>({
    methods:(['password','google'] as const).map(id=>({id,enabled:cfg.authMethods.includes(id)})),
    oidc:{authorization_url:cfg.authorizationUrl??null,client_id:cfg.oidcClientId??null,audience:cfg.audience??null,
      scopes:['openid','email','profile'],pkce:'S256' as const},
    registration_available:cfg.authMethods.includes('password'),account_linking:'verified_provider_subject' as const,
  }));

  app.post('/v1/onboarding', { schema: contract('onboardAccount','Identity','Create an account from verified identity',
    'Creates only the user role and pending eligibility. The provider subject comes from the verified token, never the body. No wallet or KYC approval is implied. Repeat onboarding with the same jurisdiction returns the account; changing jurisdiction requires a future governed workflow.', Type.Ref(AccountSchema),
    { command: true, body: object({ jurisdiction: Country }) }) }, async (request, reply) => {
    const p = await principal(request); const jurisdiction = (request.body as { jurisdiction: string }).jurisdiction;
    const result = await command(db, hash({ issuer: p.issuer, subject: p.subject }), String(request.headers['idempotency-key']),
      { operation: 'onboardAccount', body: request.body }, async () => {}, async sql => {
        const inserted = await sql.query<Account>(`INSERT INTO accounts(id,issuer,subject,jurisdiction) VALUES ($1,$2,$3,$4)
          ON CONFLICT (issuer,subject) DO NOTHING RETURNING *`, [randomUUID(), p.issuer, p.subject, jurisdiction]);
        const a = await findAccount(sql, p, true);
        requireCondition(a.jurisdiction === jurisdiction, 409, 'JURISDICTION_CONFLICT', 'The account already has a different jurisdiction.');
        if (inserted.rows.length) {
          await sql.query("INSERT INTO eligibility(account_id,status,policy_version) VALUES ($1,'pending','unreviewed')", [a.id]);
          await record(sql, { actor: a.id, authority: 'authenticated_identity', action: 'account.onboarded', resource: a.id,
            request: request.id, reason: 'Self-service onboarding', after: publicAccount(a) });
        }
        return { status: 200, body: publicAccount(a) };
      });
    return reply.code(result.status).send(result.body);
  });
  app.get('/v1/me', { schema: contract('getCurrentAccount','Identity','Get the current account','Returns the caller account and server-assigned roles; provider subject and raw identity evidence are excluded.', Type.Ref(AccountSchema)) }, async req => publicAccount((await authenticated(req)).a));
  app.post('/v1/registration/profile',{schema:contract('registerAccountProfile','Identity','Complete the Afridict registration profile',
    'Call after the configured identity provider authenticates an email/password or Google account. Afridict stores names, normalized contact destinations and server-timestamped policy acceptance; it never receives the password or Google client secret. Contact ownership is verified separately.',Type.Ref(RegistrationProfileSchema),
    {command:true,status:201,body:object({first_name:text('Given name.',100),last_name:text('Family name.',100),
      email:Type.String({format:'email',maxLength:254}),phone_number:Type.String({minLength:8,maxLength:32}),
      terms_version:text('Terms version presented to the user.',100),privacy_version:text('Privacy version presented to the user.',100),accepted:Type.Literal(true)})})},
  run([],async({sql,actor,request})=>{
    const body=request.body as {first_name:string;last_name:string;email:string;phone_number:string;terms_version:string;privacy_version:string};
    const profile=await registerProfile(sql,actor,{...body,accepted_at:new Date().toISOString()});
    await record(sql,{actor:actor.id,authority:'account_owner',action:'registration.profile_completed',resource:actor.id,
      request:request.id,reason:'Accepted versioned registration policies',after:{terms_version:profile.terms_version,
        privacy_version:profile.privacy_version,accepted_at:profile.accepted_at}});
    return {status:201,body:profile};
  }));
  app.get('/v1/me/onboarding-status',{schema:contract('getOnboardingStatus','Identity','Get onboarding status','Returns server-owned completion signals for the authenticated account.',Type.Ref(OnboardingStatusSchema))},async req=>{
    const {a}=await authenticated(req); return onboardingStatus(db,a);
  });
  app.get('/v1/usernames/:username/availability',{schema:contract('getUsernameAvailability','Identity','Check username availability','Normalizes the candidate username and reports whether it is currently unclaimed.',Type.Ref(UsernameAvailabilitySchema),{public:true,params:object({username:Type.String({minLength:3,maxLength:30})})})},async req=>{
    return usernameAvailability(db,(req.params as {username:string}).username);
  });
  app.get('/v1/me/public-profile',{schema:contract('getPublicProfile','Identity','Get the current public profile','Returns only account-owned public profile fields and opaque media identifiers.',Type.Ref(PublicProfileSchema))},async req=>{
    const {a}=await authenticated(req); return getPublicProfile(db,a.id);
  });
  app.put('/v1/me/public-profile',{schema:contract('updatePublicProfile','Identity','Update the current public profile','Updates the account-owned public profile. Referenced media must be completed uploads owned by the account.',Type.Ref(PublicProfileSchema),{command:true,body:object({username:Type.String({minLength:3,maxLength:30}),display_name:Type.Optional(Type.Union([text('Public display name.',100),Type.Null()])),bio:Type.Optional(Type.Union([Type.String({maxLength:500}),Type.Null()])),avatar_media_id:Type.Optional(Type.Union([UUID,Type.Null()])),cover_media_id:Type.Optional(Type.Union([UUID,Type.Null()]))})})},run([],async({sql,actor,request})=>{
    const before=await getPublicProfile(sql,actor.id).catch(()=>null); const profile=await savePublicProfile(sql,actor,request.body as {username:string;display_name?:string|null;bio?:string|null;avatar_media_id?:string|null;cover_media_id?:string|null});
    await record(sql,{actor:actor.id,authority:'account_owner',action:'public_profile.updated',resource:actor.id,request:request.id,reason:'Account owner updated public profile',before,after:profile}); return {status:200,body:profile};
  }));
  app.post('/v1/me/profile-media-uploads',{schema:contract('createProfileMediaUpload','Identity','Create a profile media upload','Returns a signed upload URL from the configured media provider.',Type.Ref(ProfileMediaUploadSchema),{command:true,status:201,body:object({kind:Type.String({enum:['avatar','cover']}),mime_type:Type.String({enum:['image/jpeg','image/png','image/webp']}),byte_size:Type.Integer({minimum:1,maximum:10485760}),width:Type.Integer({minimum:32,maximum:10000}),height:Type.Integer({minimum:32,maximum:10000}),checksum:Type.String({pattern:'^[a-f0-9]{64}$'})})})},run([],async({sql,actor,request})=>({status:201,body:await createMediaUpload(sql,actor,profileMediaStorage,request.body as {kind:MediaKind;mime_type:MediaType;byte_size:number;width:number;height:number;checksum:string})})));
  app.post('/v1/me/profile-media-uploads/:id/complete',{schema:contract('completeProfileMediaUpload','Identity','Complete a profile media upload','Validates the uploaded object metadata through the configured storage provider and marks it usable by the account.',Type.Ref(ProfileMediaUploadSchema),{command:true,params:IdParams,body:object({checksum:Type.String({pattern:'^[a-f0-9]{64}$'}),byte_size:Type.Integer({minimum:1,maximum:10485760}),width:Type.Integer({minimum:32,maximum:10000}),height:Type.Integer({minimum:32,maximum:10000})})})},run([],async({sql,actor,request})=>({status:200,body:await completeMediaUpload(sql,actor,profileMediaStorage,id(request),request.body as {checksum:string;byte_size:number;width:number;height:number})})));
  const contactUnavailable=()=>requireCondition(contactDependencies,503,'CONTACT_PROVIDER_UNAVAILABLE','Contact verification is not configured.');
  for(const channel of ['email','phone'] as const) {
    app.post(`/v1/auth/${channel}/send-code`,{schema:contract(`send${channel==='email'?'Email':'Phone'}VerificationCode`,'Identity',
      `Send a ${channel} verification code`,`Uses the saved registration ${channel} through the configured verification provider. Enforces a 60-second resend cooldown and rolling account, destination and IP limits. A timeout is recorded as delivery_uncertain because it does not prove provider rejection.`,
      Type.Ref(ContactVerificationSchema),{command:true,status:202,body:object({})})},run([],async({sql,actor,request})=>{
        contactUnavailable(); const result=await sendContactCode(sql,contactDependencies!,{accountId:actor.id,channel,ip:request.ip,requestId:request.id});
        if(!result.ok)return {status:503,body:{code:'CONTACT_PROVIDER_UNAVAILABLE',message:'Verification delivery is uncertain. Wait before retrying with a new idempotency key.',request_id:request.id}};
        return {status:202,body:result.verification};
      }));
    app.post(`/v1/auth/${channel}/verify-code`,{schema:contract(`verify${channel==='email'?'Email':'Phone'}Code`,'Identity',
      `Verify a ${channel} code`,`Checks the code through the provider without storing or logging it. Five local attempts are allowed per verification, with rolling account, destination and IP abuse limits.`,
      Type.Ref(ContactVerificationSchema),{command:true,body:object({code:Type.String({pattern:'^[0-9]{4,10}$'})})})},run([],async({sql,actor,request})=>{
        contactUnavailable(); const result=await checkContactCode(sql,contactDependencies!,{accountId:actor.id,channel,
          code:(request.body as {code:string}).code,ip:request.ip,requestId:request.id});
        if(!result.ok)return {status:503,body:{code:'CONTACT_PROVIDER_UNAVAILABLE',message:'Verification result is uncertain. Retry with the same idempotency key.',request_id:request.id}};
        return {status:200,body:result.verification};
      }));
  }
  app.get('/v1/kyc/status',{schema:contract('getIdentityVerificationStatus','Identity','Get normalized identity status',
    'Returns Afridict state only. It never exposes Persona payloads, document data, or internal evidence.',Type.Ref(IdentityStatusSchema))},async req=>{
    const {a}=await authenticated(req);const row=(await db.query<{identity_status:string;identity_updated_at:Date}>(
      'SELECT identity_status,identity_updated_at FROM account_assurance WHERE account_id=$1',[a.id])).rows[0];
    const inquiry=(await db.query<{id:string}>('SELECT id FROM identity_inquiries WHERE account_id=$1 ORDER BY created_at DESC LIMIT 1',[a.id])).rows[0];
    return {state:row?.identity_status??'NOT_STARTED',inquiry_id:inquiry?.id??null,updated_at:new Date(row?.identity_updated_at??a.created_at).toISOString()};
  });
  app.post('/v1/kyc/session',{schema:contract('createIdentityVerificationSession','Identity','Create a Persona identity session',
    'Requires verified email and phone. The provider call uses the command idempotency key. The returned client token belongs only to this authenticated account and must not be logged.',
    Type.Ref(IdentitySessionSchema),{command:true,status:201,body:object({})})},run([],async({sql,actor,request})=>{
      requireCondition(personaDependencies,503,'IDENTITY_PROVIDER_UNAVAILABLE','Identity verification is not configured.');
      return {status:201,body:await createIdentitySession(sql,personaDependencies.provider,{accountId:actor.id,
        idempotencyKey:String(request.headers['idempotency-key']),requestId:request.id})};
    }));
  const PersonaEventSchema=object({data:object({id:Type.String({minLength:1,maxLength:200}),type:Type.Literal('event'),attributes:object({
    name:Type.String({enum:['inquiry.created','inquiry.started','inquiry.completed','inquiry.failed','inquiry.expired','inquiry.approved','inquiry.marked-for-review','inquiry.declined']}),
    'created-at':Timestamp,payload:object({data:object({id:Type.String({minLength:1,maxLength:200}),type:Type.Literal('inquiry'),
      attributes:object({status:Type.String({enum:['created','pending','completed','failed','expired','approved','needs_review','needs review','declined']}),'reference-id':UUID})})})})})});
  app.post('/v1/webhooks/persona',{schema:contract('receivePersonaIdentityEvent','Identity','Receive an authenticated Persona event',
    'Verifies Persona-Signature against the exact raw request body, deduplicates event IDs, rejects conflicting replay, and applies only events newer than the inquiry current provider timestamp.',
    object({accepted:Type.Literal(true),applied:Type.Boolean()}),{public:true,status:202,headers:Type.Object({'persona-signature':Type.String({minLength:10,maxLength:512})},{additionalProperties:true}),body:PersonaEventSchema})},async(request,reply)=>{
      requireCondition(personaDependencies,503,'IDENTITY_PROVIDER_UNAVAILABLE','Identity verification is not configured.');
      const raw=(request as Request&{rawBody?:Buffer}).rawBody,signature=String(request.headers['persona-signature']??'');
      requireCondition(raw&&verifyPersonaSignature(raw,signature,personaDependencies.webhookSecrets),401,'INVALID_PERSONA_SIGNATURE','A valid Persona webhook signature is required.');
      const body=request.body as {data:{id:string;attributes:{name:string;'created-at':string;payload:{data:{id:string;attributes:{status:string;'reference-id':string}}}}}};
      const result=await db.transaction(sql=>applyPersonaEvent(sql,{eventId:body.data.id,name:body.data.attributes.name,
        occurredAt:body.data.attributes['created-at'],providerReference:body.data.attributes.payload.data.id,
        accountReference:body.data.attributes.payload.data.attributes['reference-id'],status:body.data.attributes.payload.data.attributes.status},raw,request.id));
      return reply.code(202).send(result);
    });
  app.get('/v1/me/capabilities', { schema: contract('getCurrentCapabilities','Identity','Get current action capabilities',
    'Returns normalized server-owned decisions and unmet requirements. Production money and trading commands must call this policy before activation; current financial commands remain isolated synthetic operations. Actions fail closed until provider, jurisdiction, risk and production gates are approved.', Type.Ref(CapabilitiesSchema)) }, async req => {
    const {a}=await authenticated(req); return evaluateCapabilities(await accountAssurance(db,a));
  });
  app.get('/v1/session', { schema: contract('getSession','Identity','Inspect the authenticated session','Returns token expiry and session/recovery ownership. Sign-in, MFA, refresh, logout and recovery are owned by the configured OIDC provider; this API does not store refresh tokens. Account restrictions are checked on each request.', object({ account_id: UUID, expires_at: Timestamp, authentication: Type.String({ enum: ['oidc','synthetic_demo'] }), recovery: Type.Literal('identity_provider') })) }, async req => {
    const { a, p } = await authenticated(req); return { account_id: a.id, expires_at: p.expiresAt,
      authentication: cfg.authMode === 'demo' ? 'synthetic_demo' : 'oidc', recovery: 'identity_provider' };
  });
  app.get('/v1/eligibility', { schema: contract('getEligibility','Identity','Get current eligibility','Returns the governed eligibility decision. Trading remains disabled in this release even when eligibility is approved. Missing review defaults to pending.', Type.Ref(EligibilitySchema)) }, async req => {
    const { a } = await authenticated(req);
    const row = (await db.query<{ status: string; policy_version: string; updated_at: Date }>('SELECT * FROM eligibility WHERE account_id=$1', [a.id])).rows[0];
    return { account_id: a.id, status: row?.status ?? 'pending', policy_version: row?.policy_version ?? 'unreviewed',
      updated_at: new Date(row?.updated_at ?? a.created_at).toISOString(), trading_enabled: false,
      reason_codes: row?.status === 'eligible' ? ['TRADING_NOT_ACTIVATED'] : ['ELIGIBILITY_NOT_APPROVED','TRADING_NOT_ACTIVATED'] };
  });

  app.post('/v1/admin/accounts/:id/eligibility-reviews', { schema: contract('proposeEligibility','Compliance','Propose an eligibility decision',
    'Requires compliance_officer. Creates a pending change with evidence reference and reason. It does not grant eligibility until a different compliance actor approves. Raw KYC data is forbidden.', Type.Ref(EligibilityReviewSchema),
    { params: IdParams, command: true, status: 201, roles: ['compliance_officer'], body: object({ decision: Type.String({ enum: ['eligible','restricted'] }), policy_version: text('Approved policy registry reference.',100), evidence_ref: EvidenceRef, reason: Reason }) }) },
  run(['compliance_officer'], async ({ sql, actor, request }) => {
    const b = request.body as { decision: string; policy_version: string; evidence_ref: string; reason: string };
    requireCondition((await sql.query('SELECT id FROM accounts WHERE id=$1', [id(request)])).rows.length, 404, 'NOT_FOUND', 'Account not found.');
    requireCondition(actor.id !== id(request), 403, 'SEPARATION_OF_DUTIES', 'You cannot propose your own eligibility decision.');
    const row = (await sql.query(`INSERT INTO eligibility_reviews(id,account_id,proposer_id,decision,policy_version,evidence_ref,reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,account_id,decision,policy_version,status,created_at`,
      [randomUUID(), id(request), actor.id, b.decision, b.policy_version, b.evidence_ref, b.reason])).rows[0]!;
    await record(sql, { actor: actor.id, authority: 'compliance_officer', action: 'eligibility.proposed', resource: String(row.id),
      request: request.id, reason: b.reason, evidence: b.evidence_ref, after: row });
    return { status: 201, body: row };
  }));
  app.post('/v1/admin/eligibility-reviews/:id/decision', { schema: contract('decideEligibility','Compliance','Approve or reject an eligibility proposal',
    'Requires a compliance_officer distinct from both proposer and target account. The immutable audit records both actors. Eligibility does not activate trading or approve a jurisdiction.', Type.Ref(EligibilityReviewSchema),
    { params: IdParams, command: true, roles: ['compliance_officer'], body: object({ decision: Type.String({ enum: ['approved','rejected'] }), reason: Reason }) }) },
  run(['compliance_officer'], async ({ sql, actor, request }) => {
    const b = request.body as { decision: string; reason: string };
    const before = (await sql.query<{ id: string; account_id: string; proposer_id: string; decision: string; policy_version: string; evidence_ref: string; status: string }>('SELECT * FROM eligibility_reviews WHERE id=$1 FOR UPDATE', [id(request)])).rows[0];
    requireCondition(before, 404, 'NOT_FOUND', 'Eligibility proposal not found.');
    requireCondition(actor.id !== before.proposer_id && actor.id !== before.account_id, 403, 'SEPARATION_OF_DUTIES', 'A different compliance actor must decide this proposal.');
    requireCondition(before.status === 'pending', 409, 'VERSION_OR_STATE_CONFLICT', 'This proposal has already been decided.');
    if (b.decision === 'approved') await sql.query(`UPDATE eligibility SET status=$2,policy_version=$3,evidence_ref=$4,updated_at=now() WHERE account_id=$1`,
      [before.account_id, before.decision, before.policy_version, before.evidence_ref]);
    const row = (await sql.query(`UPDATE eligibility_reviews SET status=$2,approver_id=$3 WHERE id=$1
      RETURNING id,account_id,decision,policy_version,status,created_at`, [before.id, b.decision, actor.id])).rows[0]!;
    await record(sql, { actor: actor.id, authority: 'compliance_officer', action: 'eligibility.decided', resource: before.id,
      request: request.id, reason: b.reason, evidence: before.evidence_ref, before: { status: before.status, proposer_id: before.proposer_id }, after: row, result: b.decision });
    return { status: 200, body: row };
  }));

  const syntheticFinance=()=>requireCondition(cfg.financialMode==='synthetic',503,'FINANCIAL_INTEGRATION_PENDING',
    'Funding and withdrawal integrations are not active.');
  app.get('/v1/smart-account',{schema:contract('getSmartAccount','Portfolio','Read your embedded smart-account status',
    'Returns public address and workflow status for the caller only. Recovery remains owned by the configured identity provider; no session keys or recovery data are returned.',
    Type.Ref(SmartAccountSchema))},async req=>{
    const {a}=await authenticated(req);
    const row=(await db.query<{chain_id:string;address:string;status:string}>('SELECT chain_id::text,address,status FROM smart_accounts WHERE owner_id=$1',[a.id])).rows[0];
    requireCondition(row,404,'SMART_ACCOUNT_NOT_PROVISIONED','No smart account has been provisioned.');
    return {...row,recovery:'identity_provider',financial_mode:cfg.financialMode};
  });
  app.get('/v1/financial-assets',{schema:contract('listFinancialAssets','Funding','List configured collateral assets',
    'Shows configured asset units. funding_enabled and withdrawal_enabled are true only in the isolated synthetic demo; an approved real asset and partner are not configured.',
    object({items:Type.Array(Type.Ref(FinancialAssetSchema))}))},async req=>{
    await authenticated(req);
    const rows=(await db.query<{code:string;scale:number;synthetic:boolean}>('SELECT code,scale,synthetic FROM financial_assets WHERE approved=true ORDER BY code')).rows;
    return {items:rows.map(row=>({...row,funding_enabled:cfg.financialMode==='synthetic'&&row.synthetic,
      withdrawal_enabled:cfg.financialMode==='synthetic'&&row.synthetic}))};
  });
  app.post('/v1/webhooks/funding/:partnerId',{schema:contract('receiveFundingPartnerEvent','Funding','Receive a signed funding-partner event',
    'Verifies the partner signature over event ID, timestamp and canonical payload before changing state. Duplicate identical events produce one effect. This endpoint records partner confirmation only; it never credits available collateral. The adapter is unavailable until explicitly configured.',
    object({accepted:Type.Literal(true)}),{public:true,status:202,
      params:object({partnerId:Type.String({pattern:'^[a-z0-9][a-z0-9_-]{1,63}$'})}),
      headers:Type.Object({'x-partner-event-id':Type.String({minLength:1,maxLength:128,pattern:'^[A-Za-z0-9._:-]+$'}),
        'x-partner-timestamp':Type.String({pattern:'^[0-9]{10}$'}),
        'x-partner-signature':Type.String({pattern:'^sha256=[a-f0-9]{64}$'})},{additionalProperties:true}),
      body:object({event_type:Type.Literal('deposit.confirmed'),occurred_at:Timestamp,intent_id:UUID,
        partner_reference:Type.String({minLength:1,maxLength:200}),asset:Type.String({pattern:'^[A-Z0-9_]{2,32}$'}),amount_minor:Uint})})},
    async(request,reply)=>{
      requireCondition(partnerVerifier,503,'PARTNER_ADAPTER_UNAVAILABLE','The funding partner adapter is not configured.');
      const params=request.params as {partnerId:string},headers=request.headers as Record<string,string>,body=request.body as {
        event_type:'deposit.confirmed';occurred_at:string;intent_id:string;partner_reference:string;asset:string;amount_minor:string};
      const eventId=headers['x-partner-event-id']!,timestamp=headers['x-partner-timestamp']!,signature=headers['x-partner-signature']!;
      requireCondition(await partnerVerifier.verify({partnerId:params.partnerId,eventId,timestamp,signature,payload:body}),
        401,'INVALID_PARTNER_SIGNATURE','A valid partner signature is required.');
      await db.transaction(sql=>applyPartnerDeposit(sql,{partnerId:params.partnerId,eventId,occurredAt:body.occurred_at,
        intentId:body.intent_id,reference:body.partner_reference,asset:body.asset,amount:body.amount_minor},request.id));
      return reply.code(202).send({accepted:true});
    });
  app.get('/v1/balances',{schema:contract('listCollateralBalances','Portfolio','Read available and reserved collateral',
    'Off-chain ledger projection. Pending partner deposits do not create spendable collateral. spendable is false because trading is not active.',
    object({items:Type.Array(Type.Ref(BalanceSchema))}))},async req=>{
    const {a}=await authenticated(req); return {items:(await walletBalances(db,a.id)).map(balance=>({...balance,spendable:false}))};
  });
  app.get('/v1/wallets',{schema:contract('listFiatWallets','Portfolio','Read the NGN wallet projection',
    'Returns the NGN ledger in integer kobo, including a zero balance. Rail flags remain false until provider and governance approval. Crypto stablecoin balances are contract-specific assets and are never represented as generic USD.',
    object({items:Type.Array(Type.Ref(FiatWalletSchema),{minItems:1,maxItems:1})}))},async req=>{
    const {a}=await authenticated(req);
    const rows=(await db.query<{currency:'NGN'|'USD';scale:2;available_minor:string;reserved_minor:string;withdrawal_pending_minor:string;
      funding_enabled:boolean;withdrawal_enabled:boolean}>(`SELECT f.code AS currency,f.scale,
      COALESCE(sum(CASE WHEN la.bucket='user_available' THEN le.credit-le.debit ELSE 0 END),0)::text AS available_minor,
      COALESCE(sum(CASE WHEN la.bucket='user_reserved' THEN le.credit-le.debit ELSE 0 END),0)::text AS reserved_minor,
      COALESCE(sum(CASE WHEN la.bucket='user_withdrawal_pending' THEN le.credit-le.debit ELSE 0 END),0)::text AS withdrawal_pending_minor,
      COALESCE(r.approved AND r.collections_enabled,false) AS funding_enabled,
      COALESCE(r.approved AND r.payouts_enabled,false) AS withdrawal_enabled
      FROM financial_assets f LEFT JOIN ledger_accounts la ON la.asset_code=f.code AND la.owner_id=$1
      LEFT JOIN ledger_entries le ON le.account_id=la.id LEFT JOIN fiat_rail_registry r ON r.asset_code=f.code AND r.provider='swervpay'
      WHERE f.code='NGN' AND f.approved=true GROUP BY f.code,f.scale,r.approved,r.collections_enabled,r.payouts_enabled`,[a.id])).rows;
    return {items:rows};
  });
  app.get('/v1/fiat/banks',{schema:contract('listFiatBanks','Funding','List banks currently reported by the fiat provider',
    'Returns live sandbox-provider reference data when configured. Availability does not mean payouts are commercially or operationally approved.',
    object({items:Type.Array(Type.Ref(BankSchema))}))},async req=>{
    await authenticated(req);requireCondition(fiatDependencies,503,'FIAT_PROVIDER_UNAVAILABLE','The fiat provider sandbox is not configured.');
    return {items:await fiatDependencies.provider.listBanks()};
  });
  app.post('/v1/fiat/bank-accounts/resolve',{config:{rateLimit:{max:10,timeWindow:'1 minute'}},schema:contract(
    'resolveFiatBankAccount','Funding','Resolve an NGN bank account with the configured provider',
    'Requires a verified Afridict identity. The response is returned only to the authenticated caller with no-store caching and is not persisted or included in audit events.',
    Type.Ref(ResolvedBankAccountSchema),{body:object({bank_code:Type.String({pattern:'^[0-9]{3,10}$'}),account_number:Type.String({pattern:'^[0-9]{10}$'})})})},async req=>{
      const {a}=await authenticated(req);requireCondition(fiatDependencies,503,'FIAT_PROVIDER_UNAVAILABLE','The fiat provider sandbox is not configured.');
      const assurance=await accountAssurance(db,a);requireCondition(assurance.identityStatus==='VERIFIED',403,'IDENTITY_VERIFICATION_REQUIRED','Verified identity is required for bank account resolution.');
      const body=req.body as {bank_code:string;account_number:string},resolved=await fiatDependencies.provider.resolveAccount({bankCode:body.bank_code,accountNumber:body.account_number});
      requireCondition(resolved.bankCode===body.bank_code&&resolved.accountNumber===body.account_number,502,'FIAT_PROVIDER_RESPONSE_MISMATCH','The provider returned a different bank account.');
      return {account_name:resolved.accountName,account_number:resolved.accountNumber,bank_code:resolved.bankCode,bank_name:resolved.bankName};
    });
  app.post('/v1/fiat/deposit-intents',{schema:contract('createFiatDepositIntent','Funding','Request NGN deposit instructions',
    'Commits a local NGN intent of at least 20,000 kobo (NGN 200) and queues provider work. A 202 response does not contain payment instructions and proves no provider account was created. Poll the returned resource; only instructions_available may be shown as payable. instruction_uncertain requires operator reconciliation.',
    Type.Ref(FiatDepositSchema),{command:true,status:202,body:object({currency:Type.Literal('NGN'),target_minor:Type.String({
      pattern:'^(?:[2-9][0-9]{4}|[1-9][0-9]{5,})$',description:'Requested amount in kobo; minimum 20,000 (NGN 200).',examples:['20000']})})})},
  run([],async({sql,actor,request})=>{
    requireCondition(fiatDependencies,503,'FIAT_PROVIDER_UNAVAILABLE','The fiat provider sandbox is not configured.');
    const assurance=await accountAssurance(sql,actor);requireCondition(assurance.identityStatus==='VERIFIED'&&assurance.fundingEligible,
      403,'FUNDING_ELIGIBILITY_REQUIRED','Verified identity and approved funding eligibility are required.');
    const body=request.body as {currency:'NGN';target_minor:string};
    return {status:202,body:await createFiatDeposit(sql,{owner:actor.id,currency:body.currency,targetMinor:body.target_minor},request.id)};
  }));
  app.get('/v1/fiat/deposit-intents/:id',{schema:contract('getFiatDepositIntent','Funding','Read a fiat deposit instruction workflow',
    'Only the owner may read the workflow. Poll while pending. Never pay an instruction that is null, expired, uncertain, or outside this authenticated response.',
    Type.Ref(FiatDepositSchema),{params:IdParams})},async req=>{
      const {a}=await authenticated(req);return getFiatDeposit(db,a.id,id(req));
    });
  app.post('/v1/fiat/payouts',{schema:contract('requestFiatPayout','Funding','Request an administrator-reviewed NGN payout',
    'Requires verified identity, funding eligibility, approved NGN rail and available NGN. Swervpay resolves the bank account, the full amount is reserved, and encrypted payout details enter the finance queue. This request does not send money.',
    Type.Ref(WithdrawalSchema),{command:true,status:202,body:object({amount_minor:Uint,bank_code:Type.String({pattern:'^[0-9]{3,10}$'}),
      account_number:Type.String({pattern:'^[0-9]{10}$'}),narration:text('Statement narration. Do not include sensitive personal data.',80)})})},async(request,reply)=>{
      const {a}=await authenticated(request);requireCondition(fiatDependencies,503,'FIAT_PROVIDER_UNAVAILABLE','The fiat provider sandbox is not configured.');
      const assurance=await accountAssurance(db,a);requireCondition(assurance.identityStatus==='VERIFIED'&&assurance.fundingEligible,
        403,'FUNDING_ELIGIBILITY_REQUIRED','Verified identity and approved funding eligibility are required.');
      const body=request.body as {amount_minor:string;bank_code:string;account_number:string;narration:string};
      const result=await requestNgnWithdrawal(db,fiatDependencies.provider,fiatDependencies.dataHashKey,fiatDependencies.dataEncryptionKey,
        fiatDependencies.keyVersion,a.id,String(request.headers['idempotency-key']),{amountMinor:body.amount_minor,bankCode:body.bank_code,
          accountNumber:body.account_number,narration:body.narration},request.id);
      return reply.code(202).send(result);
    });
  app.get('/v1/admin/fiat/payouts',{schema:contract('listNgnPayoutReviews','Finance','List NGN payouts for finance review',
    'Finance-only queue. Decrypts bank details for the authorized administrator response; values remain excluded from logs and audit payloads.',
    object({items:Type.Array(Type.Ref(AdminNgnPayoutSchema))}),{roles:['finance_operator'],querystring:object({state:Type.Optional(Type.String({
      enum:['reserved','submitting','submitted','uncertain','finalized','cancelled','exception'],default:'reserved'}))})})},async request=>{
      await authenticated(request,['finance_operator']);requireCondition(fiatDependencies,503,'FIAT_PROVIDER_UNAVAILABLE','The fiat provider sandbox is not configured.');
      return {items:await listNgnPayouts(db,fiatDependencies.dataEncryptionKey,(request.query as {state?:string}).state??'reserved')};
    });
  app.post('/v1/admin/fiat/payouts/:id/approve',{schema:contract('approveNgnPayout','Finance','Approve and submit one NGN payout',
    'A finance administrator decision triggers one Swervpay payout attempt. Successful submission records the provider reference. Timeout or ambiguous response returns uncertain and keeps the full NGN amount reserved for reconciliation.',
    Type.Ref(WithdrawalSchema),{params:IdParams,command:true,status:202,roles:['finance_operator'],body:object({reason:Reason})})},async(request,reply)=>{
      const {a}=await authenticated(request,['finance_operator']);requireCondition(fiatDependencies,503,'FIAT_PROVIDER_UNAVAILABLE','The fiat provider sandbox is not configured.');
      const result=await approveNgnPayout(db,fiatDependencies.provider,fiatDependencies.dataEncryptionKey,a.id,
        String(request.headers['idempotency-key']),id(request),(request.body as {reason:string}).reason,request.id);
      return reply.code(202).send(result);
    });
  app.post('/v1/admin/fiat/payouts/:id/complete',{schema:contract('completeNgnPayout','Finance','Confirm a Swervpay payout from the provider dashboard',
    'After the finance administrator verifies success in Swervpay, records the unique provider reference, consumes the held reservation, and posts the balanced NGN withdrawal journal. This action never retries a payout.',
    Type.Ref(WithdrawalSchema),{params:IdParams,command:true,roles:['finance_operator'],body:object({provider_reference:Type.String({minLength:1,maxLength:200,
      pattern:'^[A-Za-z0-9._:-]+$'}),reason:Reason})})},run(['finance_operator'],async({sql,actor,request})=>{const body=request.body as {provider_reference:string;reason:string};
      return {status:200,body:await completeNgnPayout(sql,id(request),actor.id,body.provider_reference,body.reason,request.id)};
    }));
  app.get('/v1/crypto-assets',{schema:contract('listCryptoAssets','Funding','List approved crypto withdrawal assets',
    'Returns the exact network, token contract, decimals, and asset code. An empty list means no crypto asset is approved; a token symbol alone is never sufficient.',
    object({items:Type.Array(Type.Ref(TokenAssetSchema))}))},async request=>{
      await authenticated(request);const rows=(await db.query<TokenAssetRow>(`SELECT asset_code,symbol,chain_id::text,contract_address,decimals
        FROM token_asset_registry WHERE approved=true ORDER BY asset_code`)).rows;return {items:rows.map(publicTokenAsset)};
    });
  app.post('/v1/crypto/withdrawals',{schema:contract('requestCryptoWithdrawal','Funding','Request a manual BEP-20 withdrawal',
    'Validates the destination and approved token identity, then reserves the full token amount for finance review. No blockchain transaction is sent by this request.',
    Type.Ref(WithdrawalSchema),{command:true,status:202,body:object({asset:Type.String({pattern:'^[A-Z0-9_]{2,32}$'}),amount_minor:Uint,
      wallet_address:Type.String({pattern:'^0x[a-fA-F0-9]{40}$'})})})},run([],async({sql,actor,request})=>{
      const assurance=await accountAssurance(sql,actor);requireCondition(assurance.identityStatus==='VERIFIED'&&assurance.fundingEligible,
        403,'FUNDING_ELIGIBILITY_REQUIRED','Verified identity and approved funding eligibility are required.');
      const body=request.body as {asset:string;amount_minor:string;wallet_address:string};return {status:202,
        body:await createCryptoWithdrawal(sql,{owner:actor.id,asset:body.asset,amount:body.amount_minor,destination:body.wallet_address},request.id)};
    }));
  app.get('/v1/crypto/withdrawals',{schema:contract('listCryptoWithdrawals','Funding','List your crypto withdrawal requests',
    'Returns the caller\'s requests and manual-processing state. Submitted means a finance administrator recorded a transaction hash; it does not mean the transfer is finalized.',
    object({items:Type.Array(Type.Ref(WithdrawalSchema))}))},async request=>{const {a}=await authenticated(request);return {items:await listCryptoWithdrawals(db,a.id)};});
  app.get('/v1/admin/crypto/withdrawals',{schema:contract('listCryptoWithdrawalReviews','Finance','List crypto withdrawals for finance review',
    'Finance-only queue containing exact token contract, chain, destination, amount, approval actor, and submission hash.',
    object({items:Type.Array(Type.Ref(AdminCryptoWithdrawalSchema))}),{roles:['finance_operator'],querystring:object({state:Type.Optional(Type.String({
      enum:['reserved','approved','submitted','uncertain','finalized','exception'],default:'reserved'}))})})},async request=>{
      await authenticated(request,['finance_operator']);return {items:await listCryptoReviews(db,(request.query as {state?:string}).state??'reserved')};
    });
  app.post('/v1/admin/crypto/withdrawals/:id/approve',{schema:contract('approveCryptoWithdrawal','Finance','Approve a manual crypto withdrawal',
    'Records the finance administrator decision. The administrator may then send the exact token, amount, network, and destination from the company wallet.',
    Type.Ref(WithdrawalSchema),{params:IdParams,command:true,roles:['finance_operator'],body:object({reason:Reason})})},run(['finance_operator'],async({sql,actor,request})=>({status:200,
      body:await approveCryptoWithdrawal(sql,id(request),actor.id,(request.body as {reason:string}).reason,request.id)})));
  app.post('/v1/admin/crypto/withdrawals/:id/submission',{schema:contract('recordCryptoWithdrawalSubmission','Finance','Record the company-wallet transaction hash',
    'Allowed only after approval. Records submission evidence but does not finalize or consume the reserved balance; later independent chain verification must confirm token contract, recipient, amount, and finality.',
    Type.Ref(WithdrawalSchema),{params:IdParams,command:true,roles:['finance_operator'],body:object({transaction_hash:Type.String({pattern:'^0x[a-fA-F0-9]{64}$'})})})},
  run(['finance_operator'],async({sql,actor,request})=>({status:200,body:await recordCryptoSubmission(sql,id(request),actor.id,
    (request.body as {transaction_hash:string}).transaction_hash,request.id)})));
  app.post('/v1/admin/wallet-conversion/rates',{schema:contract('publishWalletConversionRate','Finance','Publish an expiring NGN/USDT rate snapshot',
    'Stores an append-only rational rate and fee approved by finance. SwervPay FX may inform source_ref, but this endpoint does not claim that SwervPay executes the conversion. Both assets must already be approved.',
    Type.Ref(ConversionRateSchema),{status:201,command:true,roles:['finance_operator'],body:object({
      source_asset:Type.String({pattern:'^(NGN|USDT_BSC)$'}),destination_asset:Type.String({pattern:'^(NGN|USDT_BSC)$'}),
      rate_numerator:Uint,rate_denominator:Uint,fee_bps:Type.Integer({minimum:0,maximum:1000}),minimum_source_minor:Uint,
      source_ref:text('Approved rate source or provider quote reference.',300),expires_at:Timestamp,reason:Reason})})},
  run(['finance_operator'],async({sql,actor,request})=>{const body=request.body as {source_asset:string;destination_asset:string;
    rate_numerator:string;rate_denominator:string;fee_bps:number;minimum_source_minor:string;source_ref:string;expires_at:string;reason:string};
    return {status:201,body:await publishConversionRate(sql,actor.id,{sourceAsset:body.source_asset,destinationAsset:body.destination_asset,
      rateNumerator:body.rate_numerator,rateDenominator:body.rate_denominator,feeBps:body.fee_bps,
      minimumSourceMinor:body.minimum_source_minor,sourceRef:body.source_ref,expiresAt:new Date(body.expires_at),reason:body.reason},request.id)};
  }));
  app.post('/v1/admin/wallet-conversion/inventory',{schema:contract('fundWalletConversionInventory','Finance','Recognize safeguarded conversion inventory',
    'Posts one balanced journal after finance verifies that the exact asset is externally safeguarded. This is an audited accounting action and does not initiate a bank or blockchain transfer.',
    Type.Ref(ConversionInventoryFundingSchema),{status:201,command:true,roles:['finance_operator'],body:object({
      asset:Type.String({pattern:'^(NGN|USDT_BSC)$'}),amount_minor:Uint,evidence_ref:text('Reconciliation or custody evidence reference.',300),reason:Reason})})},
  run(['finance_operator'],async({sql,actor,request})=>{const body=request.body as {asset:string;amount_minor:string;evidence_ref:string;reason:string};
    return {status:201,body:await fundConversionInventory(sql,actor.id,{asset:body.asset,amountMinor:body.amount_minor,
      evidenceRef:body.evidence_ref,reason:body.reason},request.id)};
  }));
  app.post('/v1/wallet-conversion/quotes',{schema:contract('createWalletConversionQuote','Portfolio','Quote an NGN/USDT wallet conversion',
    'Returns immutable exact-unit terms for 30 seconds. The quote does not reserve funds or guarantee treasury inventory; acceptance performs both checks atomically.',
    Type.Ref(ConversionQuoteSchema),{status:201,command:true,body:object({source_asset:Type.String({pattern:'^(NGN|USDT_BSC)$'}),
      destination_asset:Type.String({pattern:'^(NGN|USDT_BSC)$'}),source_amount_minor:Uint})})},
  run([],async({sql,actor,request})=>{const assurance=await accountAssurance(sql,actor);
    requireCondition(assurance.identityStatus==='VERIFIED'&&assurance.fundingEligible,403,'FUNDING_ELIGIBILITY_REQUIRED',
      'Verified identity and approved funding eligibility are required.');
    const body=request.body as {source_asset:string;destination_asset:string;source_amount_minor:string};return {status:201,
      body:await createConversionQuote(sql,actor.id,{sourceAsset:body.source_asset,destinationAsset:body.destination_asset,
        sourceAmountMinor:body.source_amount_minor})};
  }));
  app.get('/v1/wallet-conversion/quotes/:id',{schema:contract('getWalletConversionQuote','Portfolio','Read your wallet conversion quote',
    'Returns the immutable quoted terms and execution state. Expiry is determined from expires_at even while state remains quoted.',
    Type.Ref(ConversionQuoteSchema),{params:IdParams})},async request=>{const {a}=await authenticated(request);
      return getConversionQuote(db,a.id,id(request));
    });
  app.post('/v1/wallet-conversion/quotes/:id/accept',{schema:contract('acceptWalletConversionQuote','Portfolio','Accept a wallet conversion quote',
    'Locks both customer wallets and both treasury inventories in deterministic order, verifies expiry and balances, then records two balanced single-asset journals linked by one immutable trade ID.',
    Type.Ref(ConversionQuoteSchema),{params:IdParams,command:true,body:object({})})},run([],async({sql,actor,request})=>{
      const assurance=await accountAssurance(sql,actor);requireCondition(assurance.identityStatus==='VERIFIED'&&assurance.fundingEligible,
        403,'FUNDING_ELIGIBILITY_REQUIRED','Verified identity and approved funding eligibility are required.');
      return {status:200,body:await executeConversionQuote(sql,actor.id,id(request),request.id)};
    }));
  app.post('/v1/deposit-intents',{schema:contract('createDepositIntent','Funding','Create a synthetic deposit intent',
    'Available only in the loopback synthetic demo. Returns no payment instructions or quote. Partner confirmation alone cannot credit available collateral. A future approved partner adapter and finalized chain observation are required.',
    Type.Ref(DepositSchema),{command:true,status:201,body:object({asset:Type.String({pattern:'^[A-Z0-9_]{2,32}$'}),
      target_minor:Uint,rail:text('Configured rail identifier, synthetic in this environment.',80)})})},
  run([],async({sql,actor,request})=>{
    syntheticFinance(); const body=request.body as {asset:string;target_minor:string;rail:string};
    return {status:201,body:await createDepositIntent(sql,{owner:actor.id,asset:body.asset,target:body.target_minor,rail:body.rail},request.id)};
  }));
  app.get('/v1/deposit-intents',{schema:contract('listDepositIntents','Funding','List your deposit workflows',
    'Pages use stable opaque ID ordering. Partner confirmed is pending, not a balance credit. Use the state to show progress, exception and retry guidance.',
    object({items:Type.Array(Type.Ref(DepositSchema)),next_cursor:Type.Union([Type.String(),Type.Null()])}),
    {querystring:object({limit:Type.Optional(Type.Integer({minimum:1,maximum:100,default:20})),cursor:Type.Optional(UUID)})})},async req=>{
    const {a}=await authenticated(req),q=req.query as {limit?:number;cursor?:string},limit=q.limit??20;
    const rows=(await db.query<Parameters<typeof publicDeposit>[0]>(`SELECT * FROM deposit_intents WHERE owner_id=$1 AND ($2::uuid IS NULL OR id<$2::uuid)
      ORDER BY id DESC LIMIT $3`,[a.id,q.cursor??null,limit+1])).rows;
    const page=rows.slice(0,limit);
    return {items:page.map(publicDeposit),next_cursor:rows.length>limit?page.at(-1)!.id:null};
  });
  app.get('/v1/deposit-intents/:id',{schema:contract('getDepositIntent','Funding','Read your deposit workflow',
    'The state is authoritative for this service workflow only; it does not prove external partner or chain finality.',
    Type.Ref(DepositSchema),{params:IdParams})},async req=>{
    const {a}=await authenticated(req),row=(await db.query<Parameters<typeof publicDeposit>[0]>('SELECT * FROM deposit_intents WHERE id=$1 AND owner_id=$2',[id(req),a.id])).rows[0];
    requireCondition(row,404,'NOT_FOUND','Deposit intent not found.'); return publicDeposit(row);
  });
  app.post('/v1/withdrawals',{schema:contract('requestWithdrawal','Funding','Reserve collateral for a synthetic withdrawal',
    'Only the synthetic demo can create this reservation. Requires approved eligibility and finalized available collateral. No external transfer is submitted. The reservation shares the same account/asset lock as CLOB, AMM and RFQ.',
    Type.Ref(WithdrawalSchema),{command:true,status:201,body:object({asset:Type.String({pattern:'^[A-Z0-9_]{2,32}$'}),
      amount_minor:Uint,destination_ref:EvidenceRef,rail:text('Configured withdrawal rail, synthetic in this environment.',80)})})},
  run([],async({sql,actor,request})=>{
    syntheticFinance(); const b=request.body as {asset:string;amount_minor:string;destination_ref:string;rail:string};
    return {status:201,body:await createWithdrawal(sql,{owner:actor.id,asset:b.asset,amount:b.amount_minor,
      destination:b.destination_ref,rail:b.rail},request.id)};
  }));
  app.get('/v1/withdrawals',{schema:contract('listWithdrawals','Funding','List your withdrawal workflows',
    'Pages use stable opaque ID ordering and return only your reservations and terminal states. Submitted or uncertain withdrawals remain held until independent finality or recovery is established.',
    object({items:Type.Array(Type.Ref(WithdrawalSchema)),next_cursor:Type.Union([Type.String(),Type.Null()])}),
    {querystring:object({limit:Type.Optional(Type.Integer({minimum:1,maximum:100,default:20})),cursor:Type.Optional(UUID)})})},async req=>{
    const {a}=await authenticated(req),q=req.query as {limit?:number;cursor?:string},limit=q.limit??20;
    const rows=(await db.query<Parameters<typeof publicWithdrawal>[0]>(`SELECT * FROM withdrawals WHERE owner_id=$1 AND ($2::uuid IS NULL OR id<$2::uuid)
      ORDER BY id DESC LIMIT $3`,[a.id,q.cursor??null,limit+1])).rows;
    const page=rows.slice(0,limit);
    return {items:page.map(publicWithdrawal),next_cursor:rows.length>limit?page.at(-1)!.id:null};
  });
  app.get('/v1/withdrawals/:id',{schema:contract('getWithdrawal','Funding','Read your withdrawal workflow',
    'Only the owner can read this workflow. An unknown or other-account ID returns not found.',Type.Ref(WithdrawalSchema),{params:IdParams})},async req=>{
    const {a}=await authenticated(req),row=(await db.query<Parameters<typeof publicWithdrawal>[0]>('SELECT * FROM withdrawals WHERE id=$1 AND owner_id=$2',[id(req),a.id])).rows[0];
    requireCondition(row,404,'NOT_FOUND','Withdrawal not found.'); return publicWithdrawal(row);
  });
  app.post('/v1/withdrawals/:id/cancel',{schema:contract('cancelWithdrawal','Funding','Cancel an unsubmitted synthetic withdrawal',
    'Only a reserved withdrawal with no external submission may be cancelled. Unknown submission status must remain reserved; never release collateral on a timeout alone.',
    Type.Ref(WithdrawalSchema),{params:IdParams,command:true,body:object({reason:Reason})})},
  run([],async({sql,actor,request})=>{
    syntheticFinance(); return {status:200,body:await cancelWithdrawal(sql,actor.id,id(request),request.id)};
  }));
  app.get('/v1/statements',{schema:contract('listStatementEntries','Portfolio','Read your financial journal entries',
    'Append-only entries for your own ledger accounts, ordered by journal creation time then entry ID. Exact signed direction and amount are returned; another user\'s entries are never exposed.',
    object({items:Type.Array(Type.Ref(StatementSchema))}),
    {querystring:object({limit:Type.Optional(Type.Integer({minimum:1,maximum:100,default:20}))})})},async req=>{
    const {a}=await authenticated(req),limit=(req.query as {limit?:number}).limit??20;
    const rows=(await db.query<{id:string;effect_id:string;kind:string;reference_id:string;asset:string;bucket:string;
      direction:string;amount_minor:string;created_at:Date}>(`SELECT e.id,j.effect_id,j.kind,j.reference_id,a.asset_code AS asset,a.bucket,
      CASE WHEN (a.normal_side='credit' AND e.credit>0) OR (a.normal_side='debit' AND e.debit>0)
        THEN 'increase' ELSE 'decrease' END AS direction,
      GREATEST(e.debit,e.credit)::text AS amount_minor,j.created_at FROM ledger_entries e
      JOIN ledger_accounts a ON a.id=e.account_id JOIN ledger_journals j ON j.id=e.journal_id
      WHERE a.owner_id=$1 ORDER BY j.created_at DESC,e.id DESC LIMIT $2`,[a.id,limit])).rows;
    return {items:rows.map(row=>({...row,created_at:new Date(row.created_at).toISOString()}))};
  });
  app.post('/v1/admin/reconciliation-runs',{schema:contract('runFinancialReconciliation','Finance','Compare recorded ledger, partner and chain observations',
    'Finance-only. Creates owned exceptions for mismatches. This compares stored records; independent partner statements and chain scanning are still required before real-money activation.',
    Type.Ref(ReconciliationSchema),{command:true,roles:['finance_operator'],status:201,
      body:object({asset:Type.String({pattern:'^[A-Z0-9_]{2,32}$'})})})},
  run(['finance_operator'],async({sql,actor,request})=>{
    const asset=(request.body as {asset:string}).asset;
    return {status:201,body:await reconcile(sql,asset,actor.id,request.id)};
  }));
  app.post('/v1/admin/synthetic/deposits/:id/partner-confirm',{schema:contract('simulatePartnerDepositConfirmation','Synthetic','Simulate a matching partner deposit event',
    'Loopback demo only. Generates a synthetic verified-partner event for frontend workflow testing. This operation is unavailable in production and is not a payment integration.',
    Type.Ref(DepositSchema),{params:IdParams,command:true,roles:['finance_operator'],body:object({asset:Type.String(),amount_minor:Uint})})},
  run(['finance_operator'],async({sql,actor,request})=>{
    syntheticFinance(); const b=request.body as {asset:string;amount_minor:string},event=randomUUID();
    await applyPartnerDeposit(sql,{partnerId:'synthetic-demo',eventId:event,occurredAt:new Date().toISOString(),
      intentId:id(request),reference:`demo:${event}`,asset:b.asset,amount:b.amount_minor},request.id);
    const row=(await sql.query<Parameters<typeof publicDeposit>[0]>('SELECT * FROM deposit_intents WHERE id=$1',[id(request)])).rows[0]!;
    await record(sql,{actor:actor.id,authority:'synthetic_finance_operator',action:'deposit.synthetic_partner_event',resource:id(request),
      request:request.id,reason:'Frontend demonstration only',after:{state:row.state}});
    return {status:200,body:publicDeposit(row)};
  }));
  app.post('/v1/admin/synthetic/deposits/:id/finalize',{schema:contract('simulateFinalizedDeposit','Synthetic','Simulate a finalized matching chain deposit',
    'Loopback demo only. Adds a synthetic chain observation under the demo finality policy and posts the balanced ledger journal. Unavailable in production.',
    Type.Ref(DepositSchema),{params:IdParams,command:true,roles:['finance_operator'],body:object({})})},
  run(['finance_operator'],async({sql,actor,request})=>{
    syntheticFinance();
    const row=(await sql.query<{owner_id:string;asset_code:string;partner_minor:string}>('SELECT * FROM deposit_intents WHERE id=$1',[id(request)])).rows[0];
    requireCondition(row,404,'NOT_FOUND','Deposit intent not found.');
    const wallet=(await sql.query<{chain_id:string;address:string}>('SELECT * FROM smart_accounts WHERE owner_id=$1',[row.owner_id])).rows[0]!;
    const digest=(suffix:string)=>`0x${createHash('sha256').update(`${id(request)}:${suffix}`).digest('hex')}`;
    return {status:200,body:await finalizeDeposit(sql,{intentId:id(request),chainId:Number(wallet.chain_id),blockNumber:'1',
      blockHash:digest('block'),transactionHash:digest('transaction'),logIndex:0,accountAddress:wallet.address,
      asset:row.asset_code,amount:row.partner_minor,finalityPolicyRef:'demo:finality-v1'},actor.id,request.id)};
  }));
  app.post('/v1/admin/synthetic/withdrawals/:id/submit',{schema:contract('simulateWithdrawalSubmission','Synthetic','Simulate withdrawal submission',
    'Loopback demo only. Marks a reserved withdrawal as submitted without moving funds. A real adapter would supply its stable provider reference.',
    Type.Ref(WithdrawalSchema),{params:IdParams,command:true,roles:['finance_operator'],body:object({})})},
  run(['finance_operator'],async({sql,actor,request})=>{
    syntheticFinance(); return {status:200,body:await submitWithdrawal(sql,id(request),`demo:${id(request)}`,actor.id,request.id)};
  }));
  app.post('/v1/admin/synthetic/withdrawals/:id/uncertain',{schema:contract('simulateUncertainWithdrawal','Synthetic','Simulate an unknown withdrawal result',
    'Loopback demo only. Keeps all collateral reserved while showing the frontend an external timeout or ambiguous response.',
    Type.Ref(WithdrawalSchema),{params:IdParams,command:true,roles:['finance_operator'],body:object({})})},
  run(['finance_operator'],async({sql,actor,request})=>{
    syntheticFinance(); return {status:200,body:await markWithdrawalUncertain(sql,id(request),actor.id,request.id)};
  }));
  app.post('/v1/admin/synthetic/withdrawals/:id/finalize',{schema:contract('simulateFinalizedWithdrawal','Synthetic','Simulate finalized withdrawal settlement',
    'Loopback demo only. Consumes the held reservation and reduces recorded escrow after a synthetic finality observation.',
    Type.Ref(WithdrawalSchema),{params:IdParams,command:true,roles:['finance_operator'],body:object({})})},
  run(['finance_operator'],async({sql,actor,request})=>{
    syntheticFinance();
    const row=(await sql.query<{owner_id:string}>('SELECT owner_id FROM withdrawals WHERE id=$1',[id(request)])).rows[0];
    requireCondition(row,404,'NOT_FOUND','Withdrawal not found.');
    const wallet=(await sql.query<{chain_id:string;address:string}>('SELECT * FROM smart_accounts WHERE owner_id=$1',[row.owner_id])).rows[0]!;
    const digest=(suffix:string)=>`0x${createHash('sha256').update(`${id(request)}:${suffix}`).digest('hex')}`;
    return {status:200,body:await finalizeWithdrawal(sql,{withdrawalId:id(request),chainId:Number(wallet.chain_id),
      blockNumber:'2',blockHash:digest('block'),transactionHash:digest('transaction'),logIndex:0,
      accountAddress:wallet.address,finalityPolicyRef:'demo:finality-v1'},actor.id,request.id)};
  }));

  const syntheticTrading=()=>requireCondition(cfg.environment!=='production' && cfg.authMode==='demo' &&
    cfg.financialMode==='synthetic',403,'TRADING_NOT_ACTIVE','Trading is available only in the isolated synthetic demo.');
  const bookParams=object({id:UUID,outcome:Type.String({pattern:'^[a-z][a-z0-9_]{0,31}$'})});
  app.post('/v1/admin/rfq/entities',{schema:contract('createRfqEntity','Liquidity','Create an institutional RFQ entity',
    'Creates a pending entity with an exact per-market exposure limit. A different compliance officer must approve it.',
    Type.Ref(RfqEntitySchema),{command:true,status:201,roles:['compliance_officer'],body:object({
      legal_name:Type.String({minLength:2,maxLength:160}),exposure_limit_minor:Uint})})},
  run(['compliance_officer'],async({sql,actor,request})=>{syntheticTrading();const body=request.body as {
    legal_name:string;exposure_limit_minor:string};return {status:201,body:await createRfqEntity(sql,actor,
      body.legal_name,body.exposure_limit_minor,request.id)};}));
  app.get('/v1/admin/rfq/entities',{schema:contract('listRfqEntities','Liquidity','List institutional RFQ entities',
    'Compliance-only onboarding view with approval state and exact per-market exposure limits.',
    object({items:Type.Array(Type.Ref(RfqEntitySchema))}),{roles:['compliance_officer']})},async request=>{
      await authenticated(request,['compliance_officer']);return listRfqEntities(db);});
  app.post('/v1/admin/rfq/entities/:id/approve',{schema:contract('approveRfqEntity','Liquidity',
    'Approve an institutional RFQ entity','Activates a pending entity under maker-checker separation.',
    Type.Ref(RfqEntitySchema),{params:IdParams,command:true,roles:['compliance_officer'],body:object({})})},
  run(['compliance_officer'],async({sql,actor,request})=>{syntheticTrading();return {status:200,
    body:await approveRfqEntity(sql,actor,id(request),request.id)};}));
  app.post('/v1/admin/rfq/entities/:id/members',{schema:contract('addRfqEntityMember','Liquidity',
    'Authorize an institutional RFQ account','Requester members create and accept RFQs. Dealer members submit Ed25519-signed quotes using the approved SPKI key.',
    Type.Ref(RfqMembershipSchema),{params:IdParams,command:true,status:201,roles:['compliance_officer'],body:object({
      account_id:UUID,role:Type.String({enum:['requester','dealer']}),
      signing_public_key:Type.Optional(Type.String({minLength:40,maxLength:2048}))})})},
  run(['compliance_officer'],async({sql,actor,request})=>{syntheticTrading();const body=request.body as {
    account_id:string;role:'requester'|'dealer';signing_public_key?:string};return {status:201,
      body:await addRfqMember(sql,actor,id(request),body.account_id,body.role,body.signing_public_key,request.id)};}));
  app.get('/v1/admin/rfq/entities/:id/members',{schema:contract('listRfqEntityMembers','Liquidity',
    'List authorized RFQ entity accounts','Compliance-only membership view. Public keys are withheld; dealer key fingerprints remain available for verification.',
    object({items:Type.Array(Type.Ref(RfqMembershipSchema))}),{params:IdParams,roles:['compliance_officer']})},async request=>{
      await authenticated(request,['compliance_officer']);return listRfqMembers(db,id(request));});
  app.post('/v1/markets/:id/rfqs',{schema:contract('createInstitutionalRfq','Liquidity','Create an institutional RFQ',
    'Requires an active requester membership and verified trading eligibility. Quantity counts against the entity per-market exposure limit.',
    Type.Ref(RfqRequestSchema),{params:IdParams,command:true,status:201,body:object({entity_id:UUID,
      outcome_id:Type.String({pattern:'^[a-z][a-z0-9_]{0,31}$'}),side:Type.String({enum:['buy','sell']}),
      quantity:Uint,expires_at:Timestamp})})},run([],async({sql,actor,request})=>{syntheticTrading();const body=request.body as {
      entity_id:string;outcome_id:string;side:'buy'|'sell';quantity:string;expires_at:string};return {status:201,
      body:await createRfqRequest(sql,actor,{entityId:body.entity_id,marketId:id(request),outcomeId:body.outcome_id,
        side:body.side,quantity:body.quantity,expiresAt:new Date(body.expires_at)},request.id)};}));
  app.get('/v1/markets/:id/rfqs',{schema:contract('listInstitutionalRfqs','Liquidity','List visible institutional RFQs',
    'Requester members see their requests. Active dealers see unexpired open requests. Customer identities are omitted.',
    object({items:Type.Array(Type.Ref(RfqRequestSchema))}),{params:IdParams})},async request=>{const {a}=await authenticated(request);
      return listRfqRequests(db,a,id(request));});
  app.get('/v1/markets/:id/rfq-fills',{schema:contract('listMyInstitutionalRfqFills','Liquidity',
    'List institutional RFQ executions','Returns immutable executions where the caller represented either institutional counterparty. Counterparty account identities are omitted.',
    object({items:Type.Array(Type.Ref(RfqFillSchema))}),{params:IdParams})},async request=>{const {a}=await authenticated(request);
      return listRfqFills(db,a,id(request));});
  app.post('/v1/rfqs/:id/quotes',{schema:contract('createInstitutionalRfqQuote','Liquidity','Submit a signed RFQ quote',
    'Requires an active dealer membership. Sign the no-whitespace UTF-8 JSON with Ed25519 using properties in this exact order: version, request_id, price, expires_at, nonce. Version is numeric 1; all other values are strings. Price is canonical and expires_at is normalized RFC 3339 UTC.',
    Type.Ref(RfqQuoteSchema),{params:IdParams,command:true,status:201,body:object({dealer_entity_id:UUID,price:Uint,
      expires_at:Timestamp,nonce:Type.String({minLength:8,maxLength:128,pattern:'^[A-Za-z0-9_-]+$'}),
      signature:Type.String({minLength:40,maxLength:2048})})})},run([],async({sql,actor,request})=>{syntheticTrading();const body=request.body as {
      dealer_entity_id:string;price:string;expires_at:string;nonce:string;signature:string};return {status:201,
      body:await createRfqQuote(sql,actor,{entityId:body.dealer_entity_id,requestId:id(request),price:body.price,
        expiresAt:new Date(body.expires_at),nonce:body.nonce,signature:body.signature},request.id)};}));
  app.get('/v1/rfqs/:id/quotes',{schema:contract('listInstitutionalRfqQuotes','Liquidity','List visible RFQ quotes',
    'The requester sees all quotes for its request. A dealer sees only its own quote.',
    object({items:Type.Array(Type.Ref(RfqQuoteSchema))}),{params:IdParams})},async request=>{const {a}=await authenticated(request);
      return listRfqQuotes(db,a,id(request));});
  const rfqQuoteParams=object({id:UUID,quote:UUID});
  app.post('/v1/rfqs/:id/quotes/:quote/accept',{schema:contract('acceptInstitutionalRfqQuote','Liquidity',
    'Accept an RFQ quote atomically','Rechecks both institutions, both accounts, market state, expiry and exposure limits; then reserves both counterparties, posts one balanced execution, records a position and rejects competing quotes.',
    Type.Ref(RfqFillSchema),{params:rfqQuoteParams,command:true,body:object({})})},run([],async({sql,actor,request})=>{
      syntheticTrading();const params=request.params as {id:string;quote:string};return {status:200,
        body:await acceptRfqQuote(sql,actor,params.id,params.quote,request.id)};}));
  app.post('/v1/rfqs/:id/cancel',{schema:contract('cancelInstitutionalRfq','Liquidity','Cancel an open RFQ request',
    'Requester-only terminal cancellation. Open dealer quotes become rejected.',Type.Ref(RfqRequestSchema),
    {params:IdParams,command:true,body:object({})})},run([],async({sql,actor,request})=>{syntheticTrading();return {status:200,
      body:await cancelRfqRequest(sql,actor,id(request),request.id)};}));
  app.post('/v1/admin/markets/:id/amm/:outcome/activate',{schema:contract('activateSyntheticAmm','Liquidity',
    'Activate a bounded AMM pool','Synthetic only. Copies the governed market asset, contract unit and immutable liquidity limits into a per-outcome pool. Activation does not fund the treasury.',Type.Ref(AmmPoolSchema),
    {params:bookParams,command:true,roles:['market_approver'],body:object({impact_bps:Type.Integer({minimum:0,maximum:10000})})})},run(['market_approver'],async({sql,actor,request})=>{
      syntheticTrading();const p=request.params as {id:string;outcome:string},b=request.body as {impact_bps:number};
      return {status:200,body:await activateAmm(sql,actor,p.id,p.outcome,b.impact_bps)};
    }));
  app.post('/v1/admin/markets/:id/amm/:outcome/funding',{schema:contract('fundSyntheticAmm','Liquidity',
    'Fund a bounded AMM treasury','Synthetic finance-only operation. Posts balanced custody and liquidity-reserve entries and cannot exceed the published subsidy limit.',Type.Ref(AmmFundingSchema),
    {params:bookParams,command:true,roles:['finance_operator'],body:object({amount_minor:Uint})})},
    run(['finance_operator'],async({sql,actor,request})=>{syntheticTrading();const p=request.params as {id:string;outcome:string};
      return {status:200,body:await fundAmm(sql,actor,p.id,p.outcome,(request.body as {amount_minor:string}).amount_minor,request.id)};
    }));
  app.post('/v1/admin/markets/:id/amm/:outcome/reference-prices',{schema:contract('recordSyntheticAmmReference','Liquidity',
    'Record an approved AMM reference price','Appends a time-bounded server-owned reference. Clients cannot set the reference used by quote creation.',Type.Ref(AmmReferenceSchema),
    {params:bookParams,command:true,status:201,roles:['market_approver'],body:object({price:Uint,observed_at:Timestamp,
      expires_at:Timestamp,source_ref:EvidenceRef})})},run(['market_approver'],async({sql,actor,request})=>{
      syntheticTrading();const p=request.params as {id:string;outcome:string},b=request.body as {price:string;observed_at:string;expires_at:string;source_ref:string};
      return {status:201,body:await recordAmmReference(sql,actor,{marketId:p.id,outcomeId:p.outcome,price:b.price,
        observedAt:new Date(b.observed_at),expiresAt:new Date(b.expires_at),sourceRef:b.source_ref})};
    }));
  app.post('/v1/markets/:id/amm/:outcome/quotes',{schema:contract('createSyntheticAmmQuote','Liquidity',
    'Create an expiring AMM quote','Uses the latest fresh approved reference and current pool exposure. The quote expires within 15 seconds and reserves no funds until execution.',Type.Ref(AmmQuoteSchema),
    {params:bookParams,command:true,status:201,body:object({side:Type.String({enum:['buy','sell']}),quantity:Uint,limit_price:Uint})})},
    run([],async({sql,actor,request})=>{syntheticTrading();const p=request.params as {id:string;outcome:string},
      b=request.body as {side:'buy'|'sell';quantity:string;limit_price:string};return {status:201,
        body:await createAmmQuote(sql,actor,{marketId:p.id,outcomeId:p.outcome,side:b.side,quantity:b.quantity,limitPrice:b.limit_price})};
    }));
  app.post('/v1/amm/quotes/:id/execute',{schema:contract('executeSyntheticAmmQuote','Liquidity',
    'Execute an AMM quote atomically','Locks the quote and pool, reserves user collateral, consumes treasury collateral, posts one balanced execution and makes the quote terminal.',Type.Ref(AmmQuoteSchema),
    {params:IdParams,command:true,body:object({})})},run([],async({sql,actor,request})=>{syntheticTrading();return {status:200,
      body:await executeAmmQuote(sql,actor,id(request),request.id)};}));
  app.get('/v1/markets/:id/amm/quotes',{schema:contract('listMySyntheticAmmQuotes','Liquidity',
    'List your AMM quotes','Returns the caller latest 100 quote states for this market.',object({items:Type.Array(Type.Ref(AmmQuoteSchema))}),{params:IdParams})},
    async request=>{const {a}=await authenticated(request);return listAmmQuotes(db,a.id,id(request));});
  app.post('/v1/admin/markets/:id/trading/activate',{schema:contract('activateSyntheticClob','Trading',
    'Activate the governed synthetic order book','Derives the asset and contract payout unit from the approved binding named by the published policy. The request cannot select a different wallet. A halted book cannot be reopened.',
    Type.Ref(TradingStateSchema),{params:IdParams,command:true,roles:['market_approver'],body:object({})})},
    run(['market_approver'],async({sql,actor,request})=>{
      syntheticTrading();const result=await activateClob(sql,actor,id(request),request.id);
      return {status:200,body:result};
    }));
  app.get('/v1/markets/:id/collateral',{schema:contract('getMarketCollateral','Trading','Read the required market wallet',
    'Returns the governed asset, precision, contract payout unit, probability price scale, trading state and caller balances. conversion_sources lists funded caller wallets with a current direct rate into the required asset.',
    Type.Ref(MarketCollateralSchema),{params:IdParams})},async request=>{const {a}=await authenticated(request);
      return marketCollateral(db,a.id,id(request));
    });
  app.get('/v1/markets/:id/collateral-policy',{schema:contract('getMarketCollateralPolicy','Markets','Read market collateral terms',
    'Public exact-unit identity for the governed collateral asset, one-share payout and probability price scale. Contains no customer balance.',
    Type.Ref(MarketCollateralPolicySchema),{params:IdParams,public:true})},request=>marketCollateralPolicy(db,id(request)));
  app.post('/v1/admin/markets/:id/trading/halt',{schema:contract('haltSyntheticClob','Trading',
    'Halt the synthetic order book','Halts admissions immediately. Existing orders can still be cancelled; reopening requires a future governed recovery workflow.',
    Type.Ref(TradingStateSchema),{params:IdParams,command:true,roles:['market_approver'],body:object({})})},
    run(['market_approver'],async({sql,actor,request})=>{
      syntheticTrading();return {status:200,body:await haltClob(sql,actor,id(request),request.id)};
    }));
  app.get('/v1/markets/:id/book/:outcome',{schema:contract('getSyntheticOrderBook','Trading',
    'Read an aggregated outcome order book','Public, sequenced price levels. Retain the snapshot sequence, then fetch subsequent market events; refetch a snapshot if an event window was missed. A published market starts halted.',
    Type.Ref(BookSchema),{params:bookParams,public:true})},async req=>{
    const p=req.params as {id:string;outcome:string};return db.transaction(sql=>orderBook(sql,p.id,p.outcome));
  });
  app.get('/v1/markets/:id/trading/events',{schema:contract('listSyntheticMarketEvents','Trading',
    'Resume sequenced market events','Append-only cursor for orders, fills, cancellation, halts, resolution and redemption batches. The feed excludes customer identities. Continue with next_sequence while has_more is true; refetch the book if your client lost its cursor.',
    object({market_id:UUID,items:Type.Array(Type.Ref(MarketEventSchema)),next_sequence:Uint,has_more:Type.Boolean()}),
    {params:IdParams,public:true,querystring:object({after:Type.Optional(Uint)})})},
    async req=>marketEvents(db,id(req),(req.query as {after?:string}).after??'0'));
  app.post('/v1/markets/:id/orders',{schema:contract('submitSyntheticLimitOrder','Trading',
    'Submit a fully collateralized limit order','Synthetic demo only. One integer share pays the market contract_unit_minor in its governed asset; probability prices use a separate 1,000,000 scale. The engine automatically reserves the market asset and never substitutes another wallet. Both sides reserve worst-case collateral plus additive per-share fees. Reuse the original idempotency key after a timeout.',
    object({order:Type.Ref(OrderSchema),fills:Type.Array(Type.Ref(FillSchema))}),{params:IdParams,command:true,status:201,
      body:object({outcome_id:Type.String({pattern:'^[a-z][a-z0-9_]{0,31}$'}),
        side:Type.String({enum:['buy','sell']}),limit_price:Uint,quantity:Uint},
      {examples:[{outcome_id:'yes',side:'buy',limit_price:'550000',quantity:'2'}]})})},
    run([],async({sql,actor,request})=>{
      syntheticTrading();const result=await submitOrder(sql,actor,id(request),request.body as {
        outcome_id:string;side:'buy'|'sell';limit_price:string;quantity:string},request.id);
      return {status:201,body:result};
    }));
  app.get('/v1/markets/:id/orders',{schema:contract('listMySyntheticOrders','Trading',
    'Read your market orders','Returns your latest 100 limit orders including remaining quantity and terminal state.',
    object({items:Type.Array(Type.Ref(OrderSchema))}),{params:IdParams})},async req=>{
    const {a}=await authenticated(req);return listOrders(db,a.id,id(req));
  });
  app.get('/v1/markets/:id/fills',{schema:contract('listMySyntheticFills','Trading',
    'Read your market executions','Returns your latest 100 immutable fills; other customers\' identities are excluded.',
    object({items:Type.Array(Type.Ref(FillSchema))}),{params:IdParams})},async req=>{
    const {a}=await authenticated(req);return listFills(db,a.id,id(req));
  });
  app.get('/v1/markets/:id/positions',{schema:contract('listMySyntheticPositions','Trading',
    'Read your unsettled outcome positions','Derived from immutable unredeemed fills. Buy positions claim the selected outcome; sell positions claim its complement. Settled fills leave this view and appear in your redemption history.',
    object({items:Type.Array(Type.Ref(PositionSchema))}),{params:IdParams})},async req=>{
    const {a}=await authenticated(req);return listPositions(db,a.id,id(req));
  });
  app.post('/v1/markets/:id/orders/:orderId/cancel',{schema:contract('cancelSyntheticOrder','Trading',
    'Cancel remaining order quantity','Atomically fences matching and releases only the unfilled reservation. Partially filled contracts stay in market escrow pending governed resolution. Cancellation remains available after a trading halt.',
    Type.Ref(OrderSchema),{params:object({id:UUID,orderId:UUID}),command:true,body:object({})})},
    run([],async({sql,actor,request})=>{
      syntheticTrading();const params=request.params as {id:string;orderId:string};
      const order=await cancelOrder(sql,actor,params.id,params.orderId,request.id);
      return {status:200,body:order};
    }));
  app.post('/v1/admin/markets/:id/resolution/close-book',{schema:contract('closeResolutionBook','Resolution',
    'Close unmatched orders after cutoff','Synthetic only. Halts trading and releases up to 100 unmatched order reservations per call. Repeat with a new idempotency key until remaining is zero; matching is fenced by the market lock.',
    Type.Ref(ResolutionCloseSchema),{params:IdParams,command:true,roles:['market_approver'],body:object({})})},
    run(['market_approver'],async({sql,actor,request})=>{syntheticTrading();return {status:200,
      body:await closeResolutionBook(sql,actor,id(request),resolutionClock(),request.id)};}));
  app.post('/v1/admin/markets/:id/resolution/evidence',{schema:contract('archiveResolutionEvidence','Resolution',
    'Record archived source evidence','Synthetic only. The source must be in the immutable published hierarchy and remain approved. Store only an opaque external archive reference and supplied SHA-256 digest; Afridict does not fetch or verify artifact bytes.',
    Type.Ref(ResolutionEvidenceSchema),{params:IdParams,command:true,status:201,roles:['resolution_proposer'],
      body:object({source_name:Type.String({minLength:1,maxLength:150}),
        source_uri:Type.String({format:'uri',pattern:'^https://',maxLength:2048}),
        artifact_ref:Type.String({pattern:'^archive:[A-Za-z0-9._/-]{1,190}$',maxLength:198}),
        document_sha256:Type.String({pattern:'^[a-f0-9]{64}$'}),
        observed_at:Timestamp})})},run(['resolution_proposer'],async({sql,actor,request})=>{
      syntheticTrading();return {status:201,body:await archiveEvidence(sql,actor,id(request),request.body as {
        source_name:string;source_uri:string;artifact_ref:string;document_sha256:string;observed_at:string},
        resolutionClock(),request.id)};
    }));
  app.get('/v1/markets/:id/resolution/evidence',{schema:contract('listResolutionEvidence','Resolution',
    'List archived evidence references','Returns up to 100 immutable evidence references without raw source documents or customer data.',
    object({items:Type.Array(Type.Ref(ResolutionEvidenceSchema))}),{params:IdParams,public:true})},
    async req=>listResolutionEvidence(db,id(req)));
  app.post('/v1/admin/markets/:id/resolution/proposal',{schema:contract('proposeMarketResolution','Resolution',
    'Propose a bonded market result','Requires an independent resolution proposer, a closed book with no unmatched orders, the published event time, cited archived evidence and an approved synthetic bond/payout policy. The bond is reserved from finalized collateral.',
    Type.Ref(ResolutionCaseSchema),{params:IdParams,command:true,status:201,roles:['resolution_proposer'],
      body:object({result:Type.Ref(ResolutionResultSchema),evidence_id:UUID,reason:Reason})})},
    run(['resolution_proposer'],async({sql,actor,request})=>{
      syntheticTrading();const b=request.body as {result:ResolutionResult;evidence_id:string;reason:string};
      return {status:201,body:await proposeResolution(sql,actor,id(request),b.result,b.evidence_id,b.reason,
        resolutionClock(),request.id)};
    }));
  app.post('/v1/admin/markets/:id/resolution/challenge',{schema:contract('challengeMarketResolution','Resolution',
    'Challenge a proposed result','A different bonded proposer can submit a competing result or evidence before the published challenge deadline. One challenge is accepted per case.',
    Type.Ref(ResolutionCaseSchema),{params:IdParams,command:true,roles:['resolution_proposer'],
      body:object({result:Type.Ref(ResolutionResultSchema),evidence_id:UUID,reason:Reason})})},
    run(['resolution_proposer'],async({sql,actor,request})=>{
      syntheticTrading();const b=request.body as {result:ResolutionResult;evidence_id:string;reason:string};
      return {status:200,body:await challengeResolution(sql,actor,id(request),b.result,b.evidence_id,b.reason,
        resolutionClock(),request.id)};
    }));
  app.post('/v1/admin/markets/:id/resolution/ballots',{schema:contract('adjudicateMarketResolution','Resolution',
    'Record an independent adjudicator ballot','One immutable ballot per distinct reviewer citing archived evidence from this market. Proposal and challenge participants and the creator cannot vote. Recusals count toward the published panel size but not the approval threshold.',
    Type.Ref(ResolutionBallotSchema),{params:IdParams,command:true,status:201,roles:['resolution_reviewer'],
      body:object({decision:Type.String({enum:['proposal','challenge','recuse']}),reason:Reason,
        evidence_id:UUID})})},run(['resolution_reviewer'],async({sql,actor,request})=>{
      syntheticTrading();const b=request.body as {decision:'proposal'|'challenge'|'recuse';reason:string;evidence_id:string};
      return {status:201,body:await ballotResolution(sql,actor,id(request),b.decision,b.reason,b.evidence_id,
        resolutionClock(),request.id)};
    }));
  app.post('/v1/admin/markets/:id/resolution/finalize',{schema:contract('finalizeMarketResolution','Resolution',
    'Finalize the adjudicated result','Requires a complete independent panel, one candidate meeting the published quorum, the full challenge window plus timelock, and an independent finalizer. The result and hash become immutable; proposal and challenge bonds are returned. No winner is credited until redemption.',
    Type.Ref(ResolutionCaseSchema),{params:IdParams,command:true,roles:['resolution_finalizer'],
      body:object({reason:Reason})})},run(['resolution_finalizer'],async({sql,actor,request})=>{
      syntheticTrading();return {status:200,body:await finalizeResolution(sql,actor,id(request),
        (request.body as {reason:string}).reason,resolutionClock(),request.id)};
    }));
  app.post('/v1/admin/markets/:id/resolution/redeem-batch',{schema:contract('redeemFinalizedMarketBatch','Resolution',
    'Settle finalized claims from market escrow','Synthetic only. Settles up to 100 unredeemed fills in one transaction. Every fill has a unique journal effect and immutable redemption record. Repeat with a new idempotency key until remaining is zero. Suspended owners are still credited to their restricted accounts.',
    Type.Ref(RedemptionBatchSchema),{params:IdParams,command:true,roles:['finance_operator'],body:object({})})},
    run(['finance_operator'],async({sql,actor,request})=>{syntheticTrading();return {status:200,
      body:await redeemBatch(sql,actor,id(request),request.id)};}));
  app.get('/v1/markets/:id/resolution',{schema:contract('getMarketResolution','Resolution',
    'Read proposal, challenge and finalized result','Returns null before a case exists. The final result and hash are immutable; a final result alone does not mean all fills have been redeemed.',
    Type.Union([Type.Ref(ResolutionCaseSchema),Type.Null()]),{params:IdParams,public:true})},
    async req=>getResolution(db,id(req)));
  app.get('/v1/markets/:id/redemptions',{schema:contract('listMyMarketRedemptions','Resolution',
    'Read your settled claims','Returns your latest 100 settled fills and the exact amount credited from market escrow. Zero payouts remain visible as a settled record.',
    object({items:Type.Array(Type.Ref(RedemptionSchema))}),{params:IdParams})},async req=>{
      const {a}=await authenticated(req);return listMyRedemptions(db,id(req),a.id);
    });
  const settlementAvailable=()=>requireCondition(settlementDependencies,503,'CHAIN_SETTLEMENT_UNAVAILABLE',
    'Robinhood Chain settlement dependencies are not configured.');
  app.post('/v1/admin/markets/:id/settlement-batches',{schema:contract('prepareMarketSettlementBatch','Settlement',
    'Prepare an immutable chain claim batch','Synthetic testnet only. Converts up to 100 unbatched positive redemption payouts into deterministic SHA-256 Merkle claims for active Robinhood Chain smart accounts. The exact commitBatch calldata and manifest hash are persisted before signing.',
    Type.Ref(SettlementBatchSchema),{params:IdParams,command:true,status:201,roles:['finance_operator'],body:object({})})},
    run(['finance_operator'],async({sql,actor,request})=>{syntheticTrading();return {status:201,
      body:await prepareSettlementBatch(sql,actor,id(request),request.id)};}));
  app.get('/v1/admin/settlement-batches/:id',{schema:contract('getSettlementBatch','Settlement',
    'Inspect a chain settlement batch','Finance operators and auditors can inspect the public manifest identity, lifecycle and current submission. Claim proofs and unrelated customer identities are excluded.',
    Type.Ref(SettlementBatchSchema),{params:IdParams,roles:['finance_operator','auditor']})},async req=>{
      await authenticated(req,['finance_operator','auditor']);return getSettlementBatch(db,id(req));
    });
  app.post('/v1/admin/settlement-batches/:id/submit',{schema:contract('submitSettlementBatch','Settlement',
    'Submit exact settlement calldata','Testnet only. Sends the persisted calldata through the configured idempotent signer. A timeout becomes uncertain; it never means the transaction failed and must be reconciled before any replacement. A replacement is allowed only after the prior attempt is proven reverted or reorged.',
    Type.Ref(SettlementBatchSchema),{params:IdParams,command:true,status:202,roles:['finance_operator'],body:object({})})},
    run(['finance_operator'],async({sql,actor,request})=>{syntheticTrading();settlementAvailable();return {status:202,
      body:await submitSettlementBatch(sql,actor,id(request),request.id,settlementDependencies!)};}));
  app.post('/v1/admin/settlement-batches/:id/refresh',{schema:contract('refreshSettlementBatch','Settlement',
    'Verify chain receipt and finality','Testnet only. Independent RPC observers must agree on transaction, block, exact calldata, target contract and approved runtime code hash. Finalized requires the approved confirmation depth; divergence or a reverted receipt opens an exception.',
    Type.Ref(SettlementRefreshSchema),{params:IdParams,command:true,roles:['finance_operator'],body:object({})})},
    run(['finance_operator'],async({sql,actor,request})=>{syntheticTrading();settlementAvailable();return {status:200,
      body:await refreshSettlementBatch(sql,actor,id(request),request.id,settlementDependencies!)};}));
  app.get('/v1/markets/:id/settlement-claims',{schema:contract('listMySettlementClaims','Settlement',
    'Read your chain claim proofs','Returns only claims owned by the authenticated account. claim_ready becomes true after independent RPC quorum and the approved confirmation depth verify the batch commitment.',
    object({items:Type.Array(Type.Ref(SettlementClaimSchema))}),{params:IdParams})},async req=>{
      const {a}=await authenticated(req);return listMySettlementClaims(db,a.id,id(req));
    });
  app.get('/v1/market-templates', { schema: contract('listMarketTemplates','Markets','List approved market templates','Returns only approved registry entries. Production starts with no approved templates; the demo seeds explicitly synthetic templates. Template approval is an operational governance decision.', object({ items: Type.Array(object({ id: Type.String(), version: Type.Integer(), market_type: Type.String({ enum: ['binary','categorical','scalar'] }) })) }), { public: true }) }, async () => ({ items: (await db.query('SELECT id,version,market_type FROM market_templates WHERE approved=true ORDER BY id,version')).rows }));
  app.get('/v1/admin/evidence-sources', { schema: contract('listApprovedEvidenceSources','Governance','List approved evidence sources','Market creators and reviewers select primary and fallback sources from this registry. The URLs are references only and are not fetched by this API.', object({ items: Type.Array(object({ name: Type.String(), uri: Type.String() })) }),
    { roles: ['market_creator','market_approver','legal_reviewer','integrity_reviewer','resolution_reviewer','auditor'] }) }, async req => {
    await authenticated(req,['market_creator','market_approver','legal_reviewer','integrity_reviewer','resolution_reviewer','auditor']);
    return { items: (await db.query('SELECT name,uri FROM evidence_sources WHERE approved=true ORDER BY name,uri LIMIT 1000')).rows };
  });
  app.get('/v1/admin/policy-registry', { schema: contract('listApprovedPolicyReferences','Governance','List approved policy references','Market creators and reviewers select approved eligibility, payout, adjudication, bond and collateral references. Evidence and approval records are access-controlled outside this endpoint.', object({ items: Type.Array(object({ kind: Type.String(), policy_ref: Type.String() })) }),
    { roles: ['market_creator','market_approver','legal_reviewer','integrity_reviewer','resolution_reviewer','auditor'] }) }, async req => {
    await authenticated(req,['market_creator','market_approver','legal_reviewer','integrity_reviewer','resolution_reviewer','auditor']);
    return { items: (await db.query('SELECT kind,policy_ref FROM policy_registry WHERE approved=true ORDER BY kind,policy_ref LIMIT 1000')).rows };
  });
  app.get('/v1/admin/markets', { schema: contract('listMarketDrafts','Governance','List markets awaiting operations','Creators see their own markets. Reviewers and auditors see all markets. Optional state filters apply; UUID cursor ordering is stable but state changes may change later pages. Fetch a fresh first page after a review.', object({ items: Type.Array(Type.Ref(MarketSchema)), next_cursor: Type.Union([Type.String(),Type.Null()]) }),
    { roles: ['market_creator','market_approver','legal_reviewer','integrity_reviewer','resolution_reviewer','auditor'],
      querystring: object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })), cursor: Type.Optional(UUID), state: Type.Optional(Type.String({ enum: ['draft','review','rejected','scheduled'] })) }) }) }, async req => {
    const { a } = await authenticated(req,['market_creator','market_approver','legal_reviewer','integrity_reviewer','resolution_reviewer','auditor']);
    const q = req.query as { limit?: number; cursor?: string; state?: string }; const limit = q.limit ?? 20;
    const canReview = a.roles.some(r => ['market_approver','legal_reviewer','integrity_reviewer','resolution_reviewer','auditor'].includes(r));
    const rows = (await db.query<MarketRow>(`SELECT * FROM markets WHERE ($1::uuid IS NULL OR id>$1::uuid)
      AND ($2::text IS NULL OR state=$2) AND ($3::boolean OR creator_id=$4::uuid) ORDER BY id LIMIT $5`,
      [q.cursor ?? null, q.state ?? null, canReview, a.id, limit + 1])).rows;
    const page = rows.slice(0, limit);
    return { items: page.map(publicMarket), next_cursor: rows.length > limit ? page.at(-1)!.id : null };
  });
  app.post('/v1/admin/markets', { schema: contract('createMarketDraft','Governance','Create a governed market draft','Requires market_creator. Validates structure, dates, bounded limits, approved sources, registered policies and template approval. The draft is private and cannot be published by its creator. source_proposal_id must refer to a submitted proposal with exactly matching terms.', Type.Ref(MarketSchema),
    { command: true, roles: ['market_creator'], status: 201, body: object({ terms: Type.Ref(Terms), source_proposal_id: Type.Optional(UUID) }) }) }, run(['market_creator'], async ({ sql, actor, request }) => {
      const b = request.body as { terms: MarketTerms; source_proposal_id?: string };
      return { status: 201, body: await createDraft(sql, actor, b.terms, request.id, b.source_proposal_id) };
    }));
  app.get('/v1/admin/markets/:id', { schema: contract('getMarketDraft','Governance','Inspect a market draft','Available to its creator or scoped product/legal/integrity/resolution reviewers and auditors. Public callers cannot discover draft metadata.', Type.Ref(MarketSchema), { params: IdParams }) }, async req => {
    const { a } = await authenticated(req); const m = await getMarket(db, id(req)); mayReadDraft(a, m); return publicMarket(m);
  });
  app.put('/v1/admin/markets/:id', { schema: contract('reviseMarketDraft','Governance','Revise draft or rejected market terms','Only the creator may revise an unpublished draft or rejected version. expected_version prevents lost updates. Revision increments the version and requires a fresh complete review.', Type.Ref(MarketSchema),
    { command: true, params: IdParams, roles: ['market_creator'], body: object({ expected_version: Type.Integer({ minimum: 1 }), terms: Type.Ref(Terms), reason: Reason }) }) }, run(['market_creator'], async ({ sql, actor, request }) => {
      const b = request.body as { expected_version: number; terms: MarketTerms; reason: string };
      return { status: 200, body: await editDraft(sql, actor, id(request), b.expected_version, b.terms, b.reason, request.id) };
    }));
  app.post('/v1/admin/markets/:id/submit', { schema: contract('submitMarketDraft','Governance','Submit a draft for review','Only the creator may submit the current draft version. This freezes editing until rejection; reviewers approve the same policy hash.', Type.Ref(MarketSchema),
    { command: true, params: IdParams, roles: ['market_creator'], body: VersionCommand }) }, run(['market_creator'], async ({ sql, actor, request }) => {
      const b = request.body as Static<typeof VersionCommand>; return { status: 200, body: await submitDraft(sql, actor, id(request), b.expected_version, b.reason, request.id) };
    }));
  app.post('/v1/admin/markets/:id/reviews', { schema: contract('reviewMarket','Governance','Record an independent policy review','Product requires market_approver; legal requires legal_reviewer; integrity requires integrity_reviewer; resolution requires resolution_reviewer. Creator and original proposer are excluded. One immutable decision per review type per policy version. Rejection returns the draft for revision.', Type.Ref(ReviewSchema),
    { command: true, params: IdParams, status: 201, roles: ['market_approver','legal_reviewer','integrity_reviewer','resolution_reviewer'], body: ReviewCommand }) }, run(['market_approver','legal_reviewer','integrity_reviewer','resolution_reviewer'], async ({ sql, actor, request }) =>
      ({ status: 201, body: await reviewMarket(sql, actor, id(request), request.body as Static<typeof ReviewCommand>, request.id) })));
  app.post('/v1/admin/markets/:id/publish', { schema: contract('publishMarket','Governance','Publish reviewed market metadata','Requires market_approver, independent of creator and original proposer. All four reviews must approve this version and policy hash. Every country/category must allow publication. Publishes scheduled metadata only; no chain transaction or trading activation occurs. Published terms cannot be edited.', Type.Ref(MarketSchema),
    { command: true, params: IdParams, roles: ['market_approver'], body: VersionCommand }) }, run(['market_approver'], async ({ sql, actor, request }) => {
      const b = request.body as Static<typeof VersionCommand>; return { status: 200, body: await publish(sql, actor, id(request), b.expected_version, b.reason, request.id) };
    }));

  app.get('/v1/markets', { schema: contract('listMarkets','Markets','Browse published markets','Only published metadata is returned. Filter by country, category or structure. Opaque cursors bind filters and a publication-time snapshot; records sort by UUID ascending. Retain identical filters when following a cursor. limit may change. Newly published markets appear on a fresh first page.', object({ items: Type.Array(Type.Ref(MarketSchema)), next_cursor: Type.Union([Type.String(),Type.Null()]) }), { public: true, querystring: ListQuery }) }, async req => {
    const q = req.query as Static<typeof ListQuery>; const filters = { market_type: q.market_type ?? null, category: q.category ?? null, jurisdiction: q.jurisdiction ?? null };
    let after: string | null = null, snapshot = new Date().toISOString();
    if (q.cursor) {
      try {
        const c = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as { after: string; snapshot: string; filter: string };
        requireCondition(typeof c.after === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(c.after) &&
          typeof c.snapshot === 'string' && Number.isFinite(Date.parse(c.snapshot)) && c.filter === hash(filters), 400, 'INVALID_CURSOR', 'Cursor does not match this query.');
        after = c.after; snapshot = new Date(c.snapshot).toISOString();
      } catch { throw new AppError(400, 'INVALID_CURSOR', 'Use a cursor returned by this endpoint with the same filters.'); }
    }
    const limit = q.limit ?? 20;
    const rows = (await db.query<MarketRow>(`SELECT * FROM markets WHERE published_at IS NOT NULL AND published_at <= $1
      AND ($2::uuid IS NULL OR id > $2::uuid) AND ($3::text IS NULL OR terms->>'market_type'=$3)
      AND ($4::text IS NULL OR terms->>'category'=$4) AND ($5::text IS NULL OR (terms->'jurisdictions') ? $5)
      ORDER BY id LIMIT $6`, [snapshot, after, filters.market_type, filters.category, filters.jurisdiction, limit + 1])).rows;
    const items = rows.slice(0, limit); const last = items.at(-1);
    return { items: items.map(publicMarket), next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ after: last.id, snapshot, filter: hash(filters) })).toString('base64url') : null };
  });
  app.get('/v1/markets/:id', { schema: contract('getMarket','Markets','Read published market terms','Returns immutable published terms, policy hash and scheduling metadata. Drafts are indistinguishable from nonexistent markets. A listed market is not a claim of tradability.', Type.Ref(MarketSchema), { public: true, params: IdParams }) }, async req => {
    const m = await getMarket(db, id(req)); requireCondition(m.published_at, 404, 'NOT_FOUND', 'Market not found.'); return publicMarket(m);
  });
  app.get('/v1/markets/:id/evidence', { schema: contract('getMarketEvidencePolicy','Markets','Read published evidence requirements','Returns the published source hierarchy and resolution policy. Evidence collection and finalization are later capabilities; no evidence artifacts are fabricated.', object({ market_id: UUID, policy_hash: Type.String(), collection_status: Type.Literal('not_collected'), resolution: Terms.properties.resolution }), { public: true, params: IdParams }) }, async req => {
    const m = await getMarket(db, id(req)); requireCondition(m.published_at, 404, 'NOT_FOUND', 'Market not found.');
    return { market_id: m.id, policy_hash: m.policy_hash, collection_status: 'not_collected', resolution: m.terms.resolution };
  });

  app.post('/v1/market-proposals', { schema: contract('submitMarketProposal','Proposals','Submit an external market proposal','Requires the approved market_proposer role. Proposal submission never publishes a market or grants operator privileges. It enters the same internal draft and review process.', Type.Ref(ProposalSchema),
    { command: true, roles: ['market_proposer'], status: 201, body: object({ terms: Type.Ref(Terms) }) }) }, run(['market_proposer'], async ({ sql, actor, request }) => {
      const { terms } = request.body as { terms: MarketTerms }; validateTerms(terms); await approvedTemplate(sql, terms); await approvedReferences(sql, terms);
      const row = (await sql.query('INSERT INTO market_proposals(id,proposer_id,terms) VALUES ($1,$2,$3) RETURNING id,status,terms,created_at',
        [randomUUID(), actor.id, JSON.stringify(terms)])).rows[0]!;
      await record(sql, { actor: actor.id, authority: 'market_proposer', action: 'market.proposed', resource: String(row.id),
        request: request.id, reason: 'External market proposal', after: row }); return { status: 201, body: row };
    }));
  app.get('/v1/market-proposals/:id', { schema: contract('getMarketProposal','Proposals','Inspect a market proposal','Only the proposer, market creators, market approvers and auditors may inspect a proposal. Other callers receive not found.', Type.Ref(ProposalSchema), { params: IdParams }) }, async req => {
    const { a } = await authenticated(req); const row = (await db.query<{ proposer_id: string } & Record<string, unknown>>('SELECT * FROM market_proposals WHERE id=$1', [id(req)])).rows[0];
    requireCondition(row && (row.proposer_id === a.id || a.roles.some(r => ['market_creator','market_approver','auditor'].includes(r))), 404, 'NOT_FOUND', 'Proposal not found.'); return row;
  });
  app.post('/v1/admin/market-proposals/:id/reject', { schema: contract('rejectMarketProposal','Proposals','Reject an external proposal with an audited reason','Requires market_approver and a different person from the proposer. Rejection is terminal for this proposal; a new submission receives a new identifier. It cannot mutate an adopted or published market.', Type.Ref(ProposalSchema),
    { roles: ['market_approver'], params: IdParams, body: object({ reason: Reason, evidence_ref: EvidenceRef }), command: true }) },
  run(['market_approver'], async ({ sql, actor, request }) => {
    const b = request.body as { reason: string; evidence_ref: string };
    const before = (await sql.query<{ id: string; proposer_id: string; status: string; terms: MarketTerms; created_at: Date }>(
      'SELECT * FROM market_proposals WHERE id=$1 FOR UPDATE', [id(request)])).rows[0];
    requireCondition(before, 404, 'NOT_FOUND', 'Proposal not found.');
    requireCondition(before.proposer_id !== actor.id, 403, 'SEPARATION_OF_DUTIES', 'The proposer cannot reject their own submission.');
    requireCondition(before.status === 'submitted', 409, 'VERSION_OR_STATE_CONFLICT', 'Only a submitted proposal may be rejected.');
    const after = (await sql.query<{ id: string; status: string; terms: MarketTerms; created_at: Date }>(
      "UPDATE market_proposals SET status='rejected' WHERE id=$1 RETURNING id,status,terms,created_at", [before.id])).rows[0]!;
    await record(sql, { actor: actor.id, authority: 'market_approver', action: 'market_proposal.rejected',
      resource: before.id, request: request.id, reason: b.reason, evidence: b.evidence_ref,
      before: { status: before.status }, after: { status: after.status }, result: 'rejected' });
    return { status: 200, body: after };
  }));
  app.get('/v1/market-proposals', { schema: contract('listMarketProposals','Proposals','List governed market proposals','Proposers see only their own submissions; market creators, approvers and auditors see all. Pages sort by opaque UUID and may change when proposal status changes.', object({ items: Type.Array(Type.Ref(ProposalSchema)), next_cursor: Type.Union([Type.String(),Type.Null()]) }),
    { roles: ['market_proposer','market_creator','market_approver','auditor'],
      querystring: object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })), cursor: Type.Optional(UUID), status: Type.Optional(Type.String({ enum: ['submitted','accepted','rejected'] })) }) }) }, async req => {
    const { a } = await authenticated(req,['market_proposer','market_creator','market_approver','auditor']);
    const q = req.query as { limit?: number; cursor?: string; status?: string }; const limit = q.limit ?? 20;
    const canReview = a.roles.some(r => ['market_creator','market_approver','auditor'].includes(r));
    const rows = (await db.query<{ id: string }>(`SELECT id,status,terms,created_at FROM market_proposals
      WHERE ($1::uuid IS NULL OR id>$1::uuid) AND ($2::text IS NULL OR status=$2)
      AND ($3::boolean OR proposer_id=$4::uuid) ORDER BY id LIMIT $5`,
      [q.cursor ?? null, q.status ?? null, canReview, a.id, limit + 1])).rows;
    const page = rows.slice(0, limit);
    return { items: page, next_cursor: rows.length > limit ? page.at(-1)!.id : null };
  });
  app.get('/v1/admin/audit-events', { schema: contract('listAuditEvents','Audit','Inspect attributable governance events','Requires auditor. Returns a bounded newest-first audit page without raw identity evidence or financial secrets. Use the opaque cursor unchanged to continue.', object({ items: Type.Array(object({ id: UUID, actor_id: Type.String(), authority: Type.String(), action: Type.String(), resource_id: Type.String(), request_id: Type.String(), reason: Type.String(), evidence_ref: Type.Union([Type.String(),Type.Null()]), result: Type.String(), created_at: Timestamp })), next_cursor: Type.Union([Type.String(),Type.Null()]) }),
    { roles: ['auditor'], querystring: object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })), cursor: Type.Optional(Type.String({ maxLength: 1024 })) }) }) }, async req => {
    await authenticated(req, ['auditor']); const q = req.query as { limit?: number; cursor?: string }; const limit = q.limit ?? 20;
    let beforeTime: string | null = null, beforeId: string | null = null;
    if (q.cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as { time: string; id: string };
        requireCondition(Number.isFinite(Date.parse(parsed.time)) && /^[0-9a-f-]{36}$/.test(parsed.id), 400, 'INVALID_CURSOR', 'Use a cursor returned by this endpoint.');
        beforeTime = parsed.time; beforeId = parsed.id;
      } catch { throw new AppError(400, 'INVALID_CURSOR', 'Use a cursor returned by this endpoint.'); }
    }
    const rows = (await db.query<{ id: string; created_at: Date }>(`SELECT id,actor_id,authority,action,resource_id,request_id,reason,evidence_ref,result,created_at
      FROM audit_events WHERE ($1::timestamptz IS NULL OR (created_at,id) < ($1::timestamptz,$2::uuid))
      ORDER BY created_at DESC,id DESC LIMIT $3`, [beforeTime, beforeId, limit + 1])).rows;
    const page = rows.slice(0, limit), last = page.at(-1);
    return { items: page, next_cursor: rows.length > limit && last ?
      Buffer.from(JSON.stringify({ time: new Date(last.created_at).toISOString(), id: last.id })).toString('base64url') : null };
  });
  await app.ready();
  return app;
}
