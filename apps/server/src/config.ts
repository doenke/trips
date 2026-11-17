import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');
const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const Schema = z.object({
  PUBLIC_URL: z
    .string()
    .url()
    .default('http://localhost:41873')
    .transform((v) => v.replace(/\/+$/, '')),
  PORT: z.coerce.number().int().positive().default(41873),
  HOST: z.string().default('0.0.0.0'),
  DATA_DIR: z.string().default('./data'),
  WEB_DIST: optional,
  APP_VERSION: z.string().default('dev'),
  TRUSTED_PROXY: bool,
  SESSION_KEY: z.string().min(16, 'SESSION_KEY fehlt oder ist zu kurz (openssl rand -base64 32)'),

  OIDC_ISSUER: optional,
  OIDC_CLIENT_ID: optional,
  OIDC_CLIENT_SECRET: optional,
  OIDC_SCOPES: z.string().default('openid profile email groups'),
  OIDC_ADMIN_GROUP: z.string().default('admins'),
  OIDC_PROVIDER_NAME: z.string().default('Kanonenwiese SSO'),
  AVATAR_HOSTS: optional,
  DEV_LOGIN: bool,

  IMAP_HOST: optional,
  IMAP_PORT: z.coerce.number().int().positive().default(993),
  IMAP_SECURE: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  IMAP_USER: optional,
  IMAP_PASSWORD: optional,
  IMAP_MAILBOX: z.string().default('INBOX'),
  IMAP_DONE_MAILBOX: optional,
  IMAP_POLL_MINUTES: z.coerce.number().positive().default(5),
  IMAP_IDLE: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  // Reject mail whose DMARC check (Authentication-Results of the receiving server) failed.
  MAIL_REQUIRE_DMARC_PASS: bool,
  IMPORT_ADDRESS: optional,

  SMTP_HOST: optional,
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  SMTP_USER: optional,
  SMTP_PASSWORD: optional,
  SMTP_FROM: optional,

  ANTHROPIC_API_KEY: optional,
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  TRIP_MATCH_DAYS: z.coerce.number().int().min(0).default(5),

  AIRTRAIL_URL: optional,
});

export type Config = z.infer<typeof Schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Konfiguration unvollständig:\n${msg}`);
  }
  return parsed.data;
}

/** Test/dev helper: a full config from a few overrides. */
export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({ SESSION_KEY: 'test-session-key-0123456789abcdef', PUBLIC_URL: 'https://trips.example.org', ...overrides });
}
