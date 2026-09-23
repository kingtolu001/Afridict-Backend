import 'dotenv/config';

export interface Config {
  environment: 'development' | 'test' | 'production'; host: string; port: number;
  databaseUrl?: string; authMode: 'native' | 'demo'; corsOrigins: string[]; docs: boolean; logger: boolean;
  financialMode: 'disabled' | 'synthetic' | 'sandbox';
  authMethods: ('password'|'google')[]; emailVerificationRequired?: boolean;
  google?: {clientId:string;clientSecret:string;redirectUri:string};
  bsc?: {rpcUrl:string;minimumConfirmations:number};
  cloudinary?: { cloudName: string; apiKey: string; apiSecret: string };
  errorTrackingDsn?: string;
}
export function config(env = process.env): Config {
  const environment = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(environment)) throw new Error('Invalid NODE_ENV');
  const requestedAuthMode = env.AUTH_MODE ?? 'native';
  if (!['native','demo'].includes(requestedAuthMode)) throw new Error('Invalid AUTH_MODE');
  const authMode = requestedAuthMode;
  const host = env.HOST ?? (environment === 'production' ? '0.0.0.0' : '127.0.0.1');
  if (authMode === 'demo' && (environment === 'production' || !['127.0.0.1', '::1', 'localhost'].includes(host)))
    throw new Error('Demo authentication is restricted to local non-production use');
  const financialMode = env.FINANCIAL_MODE ?? 'disabled';
  if (!['disabled','synthetic','sandbox'].includes(financialMode)) throw new Error('Invalid FINANCIAL_MODE');
  if (financialMode === 'synthetic' && (environment === 'production' || authMode !== 'demo'))
    throw new Error('Synthetic finance is restricted to non-production demo authentication');
  if (financialMode === 'sandbox' && authMode !== 'native')
    throw new Error('Sandbox finance requires native authentication');
  const googleValues=[env.GOOGLE_CLIENT_ID,env.GOOGLE_CLIENT_SECRET,env.GOOGLE_REDIRECT_URI];
  if(googleValues.some(Boolean)&&!googleValues.every(Boolean))throw new Error('Google authentication requires client ID, client secret, and redirect URI');
  if(env.GOOGLE_REDIRECT_URI){const redirect=new URL(env.GOOGLE_REDIRECT_URI);
    if(!['https:','http:'].includes(redirect.protocol)||redirect.username||redirect.password||redirect.hash)
      throw new Error('GOOGLE_REDIRECT_URI must be an absolute HTTP URL without credentials or fragments');
    if(environment==='production'&&redirect.protocol!=='https:')throw new Error('Production Google redirect URI requires HTTPS');
  }
  const google=googleValues.every(Boolean)?{clientId:env.GOOGLE_CLIENT_ID!,clientSecret:env.GOOGLE_CLIENT_SECRET!,
    redirectUri:env.GOOGLE_REDIRECT_URI!}:undefined;
  if(env.BSC_MIN_CONFIRMATIONS&&!env.BSC_RPC_URL)throw new Error('BSC_MIN_CONFIRMATIONS requires BSC_RPC_URL');
  let bsc:Config['bsc'];
  if(env.BSC_RPC_URL){const rpc=new URL(env.BSC_RPC_URL),minimumConfirmations=Number(env.BSC_MIN_CONFIRMATIONS||'12');
    if(!['https:','http:'].includes(rpc.protocol)||rpc.username||rpc.password||rpc.hash)
      throw new Error('BSC_RPC_URL must be an absolute HTTP URL without embedded credentials or fragments');
    if(environment==='production'&&rpc.protocol!=='https:')throw new Error('Production BSC RPC requires HTTPS');
    if(!Number.isInteger(minimumConfirmations)||minimumConfirmations<1||minimumConfirmations>1000)
      throw new Error('BSC_MIN_CONFIRMATIONS must be an integer from 1 to 1000');
    bsc={rpcUrl:env.BSC_RPC_URL,minimumConfirmations};
  }
  const authMethods = authMode === 'native' ? google ? ['password','google'] : ['password'] : [];
  const port = Number(env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const corsOrigins = (env.CORS_ORIGINS ?? '').split(',').filter(Boolean);
  for (const origin of corsOrigins) {
    const parsed = new URL(origin);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin || origin === '*')
      throw new Error('CORS_ORIGINS must contain exact HTTP origins');
    if (environment === 'production' && parsed.protocol !== 'https:') throw new Error('Production CORS requires HTTPS');
  }
  if (env.ERROR_TRACKING_DSN && new URL(env.ERROR_TRACKING_DSN).protocol !== 'https:')
    throw new Error('ERROR_TRACKING_DSN must use HTTPS');
  const cloudinaryValues = [env.CLOUDINARY_CLOUD_NAME, env.CLOUDINARY_API_KEY, env.CLOUDINARY_API_SECRET];
  if (cloudinaryValues.some(Boolean) && cloudinaryValues.some(value => !value))
    throw new Error('Cloudinary configuration requires cloud name, API key, and API secret');
  return { environment: environment as Config['environment'], host, port, authMode: authMode as Config['authMode'],
    databaseUrl: env.DATABASE_URL,
    corsOrigins, docs: env.DOCS_ENABLED === 'true' || (environment !== 'production' && env.DOCS_ENABLED !== 'false'),
    logger: environment !== 'test', financialMode: financialMode as Config['financialMode'],
    authMethods:authMethods as Config['authMethods'],emailVerificationRequired:env.EMAIL_VERIFICATION_REQUIRED==='true',google,bsc,
    cloudinary: cloudinaryValues.every(Boolean) ? { cloudName: env.CLOUDINARY_CLOUD_NAME!, apiKey: env.CLOUDINARY_API_KEY!, apiSecret: env.CLOUDINARY_API_SECRET! } : undefined,
    errorTrackingDsn:env.ERROR_TRACKING_DSN };
}
