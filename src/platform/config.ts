import 'dotenv/config';

export interface Config {
  environment: 'development' | 'test' | 'production'; host: string; port: number;
  databaseUrl?: string; authMode: 'native' | 'demo'; corsOrigins: string[]; docs: boolean; logger: boolean;
  financialMode: 'disabled' | 'synthetic';
  authMethods: ('password'|'google')[]; emailVerificationRequired?: boolean;
  cloudinary?: { cloudName: string; apiKey: string; apiSecret: string };
  errorTrackingDsn?: string;
}
export function config(env = process.env): Config {
  const environment = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(environment)) throw new Error('Invalid NODE_ENV');
  const requestedAuthMode = env.AUTH_MODE ?? 'native';
  if (!['native', 'oidc', 'demo'].includes(requestedAuthMode)) throw new Error('Invalid AUTH_MODE');
  // Existing deployments may still carry AUTH_MODE=oidc; native authentication supersedes that legacy value.
  const authMode = requestedAuthMode === 'demo' ? 'demo' : 'native';
  const host = env.HOST ?? (environment === 'production' ? '0.0.0.0' : '127.0.0.1');
  if (authMode === 'demo' && (environment === 'production' || !['127.0.0.1', '::1', 'localhost'].includes(host)))
    throw new Error('Demo authentication is restricted to local non-production use');
  const financialMode = env.FINANCIAL_MODE ?? 'disabled';
  if (!['disabled','synthetic'].includes(financialMode)) throw new Error('Invalid FINANCIAL_MODE');
  if (financialMode === 'synthetic' && (environment === 'production' || authMode !== 'demo'))
    throw new Error('Synthetic finance is restricted to non-production demo authentication');
  const authMethods = authMode === 'native' ? ['password'] : [];
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
    authMethods:authMethods as Config['authMethods'],emailVerificationRequired:env.EMAIL_VERIFICATION_REQUIRED==='true',
    cloudinary: cloudinaryValues.every(Boolean) ? { cloudName: env.CLOUDINARY_CLOUD_NAME!, apiKey: env.CLOUDINARY_API_KEY!, apiSecret: env.CLOUDINARY_API_SECRET! } : undefined,
    errorTrackingDsn:env.ERROR_TRACKING_DSN };
}
