/**
 * Secret detection patterns for tuck
 *
 * This module defines regex patterns for detecting various types of secrets
 * including API keys, tokens, private keys, and credentials.
 */

export type SecretSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface SecretPattern {
  id: string;
  name: string;
  pattern: RegExp;
  severity: SecretSeverity;
  description: string;
  placeholder: string;
}

// ============================================================================
// Cloud Provider Patterns
// ============================================================================

export const CLOUD_PROVIDER_PATTERNS: SecretPattern[] = [
  {
    id: 'aws-access-key',
    name: 'AWS Access Key ID',
    pattern: /\b(AKIA[0-9A-Z]{16})\b/g,
    severity: 'critical',
    description: 'AWS Access Key ID',
    placeholder: 'AWS_ACCESS_KEY_ID',
  },
  {
    id: 'aws-secret-key',
    name: 'AWS Secret Access Key',
    // AWS secret keys are 40 characters, base64-ish
    // Look for context clues (assignment to aws_secret, etc.)
    pattern: /(?:aws_secret_access_key|aws_secret|secret_access_key)\s*[=:]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi,
    severity: 'critical',
    description: 'AWS Secret Access Key',
    placeholder: 'AWS_SECRET_ACCESS_KEY',
  },
  {
    id: 'aws-session-token',
    name: 'AWS Session Token',
    pattern: /(?:aws_session_token)\s*[=:]\s*['"]?([A-Za-z0-9/+=]{100,1000})['"]?/gi,
    severity: 'critical',
    description: 'AWS Session Token',
    placeholder: 'AWS_SESSION_TOKEN',
  },
  {
    id: 'gcp-api-key',
    name: 'Google Cloud API Key',
    pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/g,
    severity: 'critical',
    description: 'Google Cloud API Key',
    placeholder: 'GCP_API_KEY',
  },
  {
    id: 'gcp-service-account',
    name: 'GCP Service Account',
    // Detects the private_key field in service account JSON
    pattern: /-----BEGIN PRIVATE KEY-----[A-Za-z0-9+/=\s]+-----END PRIVATE KEY-----/g,
    severity: 'critical',
    description: 'GCP Service Account Private Key',
    placeholder: 'GCP_SERVICE_ACCOUNT_KEY',
  },
  {
    id: 'azure-subscription-key',
    name: 'Azure Subscription Key',
    pattern: /\b([a-f0-9]{32})\b/g,
    severity: 'medium', // Lower severity due to high false positive rate
    description: 'Azure Subscription Key (possible)',
    placeholder: 'AZURE_SUBSCRIPTION_KEY',
  },
  {
    id: 'digitalocean-token',
    name: 'DigitalOcean Token',
    pattern: /\b(dop_v1_[a-f0-9]{64})\b/g,
    severity: 'critical',
    description: 'DigitalOcean Personal Access Token',
    placeholder: 'DIGITALOCEAN_TOKEN',
  },
  {
    id: 'digitalocean-oauth',
    name: 'DigitalOcean OAuth Token',
    pattern: /\b(doo_v1_[a-f0-9]{64})\b/g,
    severity: 'critical',
    description: 'DigitalOcean OAuth Token',
    placeholder: 'DIGITALOCEAN_OAUTH_TOKEN',
  },
  {
    id: 'digitalocean-refresh',
    name: 'DigitalOcean Refresh Token',
    pattern: /\b(dor_v1_[a-f0-9]{64})\b/g,
    severity: 'critical',
    description: 'DigitalOcean Refresh Token',
    placeholder: 'DIGITALOCEAN_REFRESH_TOKEN',
  },
];

// ============================================================================
// API Token Patterns
// ============================================================================

export const API_TOKEN_PATTERNS: SecretPattern[] = [
  // GitHub
  {
    id: 'github-pat',
    name: 'GitHub Personal Access Token',
    pattern: /\b(ghp_[A-Za-z0-9]{36,255})\b/g,
    severity: 'critical',
    description: 'GitHub Personal Access Token',
    placeholder: 'GITHUB_TOKEN',
  },
  {
    id: 'github-oauth',
    name: 'GitHub OAuth Token',
    pattern: /\b(gho_[A-Za-z0-9]{36,255})\b/g,
    severity: 'critical',
    description: 'GitHub OAuth Access Token',
    placeholder: 'GITHUB_OAUTH_TOKEN',
  },
  {
    id: 'github-user-to-server',
    name: 'GitHub User-to-Server Token',
    pattern: /\b(ghu_[A-Za-z0-9]{36,255})\b/g,
    severity: 'critical',
    description: 'GitHub User-to-Server Token',
    placeholder: 'GITHUB_USER_TOKEN',
  },
  {
    id: 'github-server-to-server',
    name: 'GitHub Server-to-Server Token',
    pattern: /\b(ghs_[A-Za-z0-9]{36,255})\b/g,
    severity: 'critical',
    description: 'GitHub Server-to-Server Token',
    placeholder: 'GITHUB_SERVER_TOKEN',
  },
  {
    id: 'github-refresh',
    name: 'GitHub Refresh Token',
    pattern: /\b(ghr_[A-Za-z0-9]{36,255})\b/g,
    severity: 'critical',
    description: 'GitHub Refresh Token',
    placeholder: 'GITHUB_REFRESH_TOKEN',
  },
  {
    id: 'github-fine-grained',
    name: 'GitHub Fine-Grained PAT',
    pattern: /\b(github_pat_[A-Za-z0-9_]{22,255})\b/g,
    severity: 'critical',
    description: 'GitHub Fine-Grained Personal Access Token',
    placeholder: 'GITHUB_FINE_GRAINED_TOKEN',
  },

  // OpenAI
  {
    id: 'openai-api-key',
    name: 'OpenAI API Key',
    pattern: /\b(sk-[A-Za-z0-9]{20,256}T3BlbkFJ[A-Za-z0-9]{20,256})\b/g,
    severity: 'critical',
    description: 'OpenAI API Key (legacy format)',
    placeholder: 'OPENAI_API_KEY',
  },
  {
    id: 'openai-api-key-new',
    name: 'OpenAI API Key (new format)',
    pattern: /\b(sk-proj-[A-Za-z0-9_-]{80,256})\b/g,
    severity: 'critical',
    description: 'OpenAI API Key (project format)',
    placeholder: 'OPENAI_API_KEY',
  },
  {
    id: 'openai-api-key-org',
    name: 'OpenAI Organization Key',
    pattern: /\b(sk-[A-Za-z0-9]{48,256})\b/g,
    severity: 'critical',
    description: 'OpenAI API Key',
    placeholder: 'OPENAI_API_KEY',
  },

  // Anthropic
  {
    id: 'anthropic-api-key',
    name: 'Anthropic API Key',
    pattern: /\b(sk-ant-api[a-zA-Z0-9_-]{90,256})\b/g,
    severity: 'critical',
    description: 'Anthropic API Key',
    placeholder: 'ANTHROPIC_API_KEY',
  },

  // Slack
  {
    id: 'slack-bot-token',
    name: 'Slack Bot Token',
    pattern: /\b(xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*)\b/g,
    severity: 'critical',
    description: 'Slack Bot Token',
    placeholder: 'SLACK_BOT_TOKEN',
  },
  {
    id: 'slack-user-token',
    name: 'Slack User Token',
    pattern: /\b(xoxp-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*)\b/g,
    severity: 'critical',
    description: 'Slack User Token',
    placeholder: 'SLACK_USER_TOKEN',
  },
  {
    id: 'slack-app-token',
    name: 'Slack App Token',
    pattern: /\b(xapp-[0-9]+-[A-Z0-9]+-[0-9]+-[a-z0-9]+)\b/gi,
    severity: 'critical',
    description: 'Slack App-Level Token',
    placeholder: 'SLACK_APP_TOKEN',
  },
  {
    id: 'slack-webhook',
    name: 'Slack Webhook URL',
    pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[a-zA-Z0-9]+/g,
    severity: 'high',
    description: 'Slack Incoming Webhook URL',
    placeholder: 'SLACK_WEBHOOK_URL',
  },

  // Stripe
  {
    id: 'stripe-live-secret',
    name: 'Stripe Live Secret Key',
    pattern: /\b(sk_live_[0-9a-zA-Z]{24,256})\b/g,
    severity: 'critical',
    description: 'Stripe Live Secret Key',
    placeholder: 'STRIPE_SECRET_KEY',
  },
  {
    id: 'stripe-live-publishable',
    name: 'Stripe Live Publishable Key',
    pattern: /\b(pk_live_[0-9a-zA-Z]{24,256})\b/g,
    severity: 'high',
    description: 'Stripe Live Publishable Key',
    placeholder: 'STRIPE_PUBLISHABLE_KEY',
  },
  {
    id: 'stripe-test-secret',
    name: 'Stripe Test Secret Key',
    pattern: /\b(sk_test_[0-9a-zA-Z]{24,256})\b/g,
    severity: 'medium',
    description: 'Stripe Test Secret Key',
    placeholder: 'STRIPE_TEST_SECRET_KEY',
  },
  {
    id: 'stripe-restricted',
    name: 'Stripe Restricted Key',
    pattern: /\b(rk_live_[0-9a-zA-Z]{24,256})\b/g,
    severity: 'critical',
    description: 'Stripe Restricted API Key',
    placeholder: 'STRIPE_RESTRICTED_KEY',
  },

  // Twilio
  {
    id: 'twilio-api-key',
    name: 'Twilio API Key',
    pattern: /\b(SK[0-9a-fA-F]{32})\b/g,
    severity: 'critical',
    description: 'Twilio API Key',
    placeholder: 'TWILIO_API_KEY',
  },
  {
    id: 'twilio-account-sid',
    name: 'Twilio Account SID',
    pattern: /\b(AC[0-9a-fA-F]{32})\b/g,
    severity: 'high',
    description: 'Twilio Account SID',
    placeholder: 'TWILIO_ACCOUNT_SID',
  },

  // SendGrid
  {
    id: 'sendgrid-api-key',
    name: 'SendGrid API Key',
    pattern: /\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b/g,
    severity: 'critical',
    description: 'SendGrid API Key',
    placeholder: 'SENDGRID_API_KEY',
  },

  // Mailchimp
  {
    id: 'mailchimp-api-key',
    name: 'Mailchimp API Key',
    pattern: /\b([a-f0-9]{32}-us[0-9]{1,2})\b/g,
    severity: 'critical',
    description: 'Mailchimp API Key',
    placeholder: 'MAILCHIMP_API_KEY',
  },

  // npm
  {
    id: 'npm-access-token',
    name: 'npm Access Token',
    pattern: /\b(npm_[A-Za-z0-9]{36})\b/g,
    severity: 'critical',
    description: 'npm Access Token',
    placeholder: 'NPM_TOKEN',
  },

  // PyPI
  {
    id: 'pypi-api-token',
    name: 'PyPI API Token',
    pattern: /\b(pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,256})\b/g,
    severity: 'critical',
    description: 'PyPI API Token',
    placeholder: 'PYPI_TOKEN',
  },

  // Discord
  {
    id: 'discord-bot-token',
    name: 'Discord Bot Token',
    pattern: /\b([MN][A-Za-z\d]{23,256}\.[\w-]{6}\.[\w-]{27})\b/g,
    severity: 'critical',
    description: 'Discord Bot Token',
    placeholder: 'DISCORD_BOT_TOKEN',
  },
  {
    id: 'discord-webhook',
    name: 'Discord Webhook URL',
    pattern: /https:\/\/discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/g,
    severity: 'high',
    description: 'Discord Webhook URL',
    placeholder: 'DISCORD_WEBHOOK_URL',
  },

  // Telegram
  {
    id: 'telegram-bot-token',
    name: 'Telegram Bot Token',
    pattern: /\b([0-9]{8,10}:[A-Za-z0-9_-]{35})\b/g,
    severity: 'critical',
    description: 'Telegram Bot API Token',
    placeholder: 'TELEGRAM_BOT_TOKEN',
  },

  // Heroku
  {
    id: 'heroku-api-key',
    name: 'Heroku API Key',
    pattern: /\b([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b/g,
    severity: 'high',
    description: 'Heroku API Key (UUID format)',
    placeholder: 'HEROKU_API_KEY',
  },

  // Datadog
  {
    id: 'datadog-api-key',
    name: 'Datadog API Key',
    pattern: /\b([a-f0-9]{32})\b/g,
    severity: 'medium', // Lower due to false positives
    description: 'Datadog API Key (possible)',
    placeholder: 'DATADOG_API_KEY',
  },

  // CircleCI
  {
    id: 'circleci-token',
    name: 'CircleCI Personal Token',
    pattern: /\b(circle-token-[a-f0-9]{40})\b/g,
    severity: 'critical',
    description: 'CircleCI Personal API Token',
    placeholder: 'CIRCLECI_TOKEN',
  },

  // Travis CI
  {
    id: 'travis-token',
    name: 'Travis CI Token',
    pattern: /\b([a-zA-Z0-9]{22})\b/g,
    severity: 'medium', // Lower due to false positives
    description: 'Travis CI Access Token (possible)',
    placeholder: 'TRAVIS_TOKEN',
  },

  // Firebase
  {
    id: 'firebase-api-key',
    name: 'Firebase API Key',
    pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/g,
    severity: 'high',
    description: 'Firebase/Google API Key',
    placeholder: 'FIREBASE_API_KEY',
  },

  // Supabase
  {
    id: 'supabase-anon-key',
    name: 'Supabase Anon Key',
    pattern: /\b(eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
    severity: 'high',
    description: 'Supabase Anonymous Key (JWT)',
    placeholder: 'SUPABASE_ANON_KEY',
  },

  // Vercel
  {
    id: 'vercel-token',
    name: 'Vercel Token',
    pattern: /\b([A-Za-z0-9]{24})\b/g,
    severity: 'medium', // Lower due to false positives
    description: 'Vercel Access Token (possible)',
    placeholder: 'VERCEL_TOKEN',
  },

  // Netlify
  {
    id: 'netlify-token',
    name: 'Netlify Personal Access Token',
    pattern: /\b(nfp_[A-Za-z0-9]{40})\b/g,
    severity: 'critical',
    description: 'Netlify Personal Access Token',
    placeholder: 'NETLIFY_TOKEN',
  },
];

// ============================================================================
// Private Key Patterns
// ============================================================================

export const PRIVATE_KEY_PATTERNS: SecretPattern[] = [
  {
    id: 'rsa-private-key',
    name: 'RSA Private Key',
    // Security: Length limit to prevent ReDoS
    pattern: /-----BEGIN RSA PRIVATE KEY-----[\s\S]{1,10000}?-----END RSA PRIVATE KEY-----/g,
    severity: 'critical',
    description: 'RSA Private Key',
    placeholder: 'RSA_PRIVATE_KEY',
  },
  {
    id: 'openssh-private-key',
    name: 'OpenSSH Private Key',
    pattern: /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]{1,10000}?-----END OPENSSH PRIVATE KEY-----/g,
    severity: 'critical',
    description: 'OpenSSH Private Key',
    placeholder: 'SSH_PRIVATE_KEY',
  },
  {
    id: 'dsa-private-key',
    name: 'DSA Private Key',
    pattern: /-----BEGIN DSA PRIVATE KEY-----[\s\S]{1,10000}?-----END DSA PRIVATE KEY-----/g,
    severity: 'critical',
    description: 'DSA Private Key',
    placeholder: 'DSA_PRIVATE_KEY',
  },
  {
    id: 'ec-private-key',
    name: 'EC Private Key',
    pattern: /-----BEGIN EC PRIVATE KEY-----[\s\S]{1,10000}?-----END EC PRIVATE KEY-----/g,
    severity: 'critical',
    description: 'EC Private Key',
    placeholder: 'EC_PRIVATE_KEY',
  },
  {
    id: 'generic-private-key',
    name: 'Generic Private Key',
    pattern: /-----BEGIN PRIVATE KEY-----[\s\S]{1,10000}?-----END PRIVATE KEY-----/g,
    severity: 'critical',
    description: 'PKCS#8 Private Key',
    placeholder: 'PRIVATE_KEY',
  },
  {
    id: 'encrypted-private-key',
    name: 'Encrypted Private Key',
    pattern: /-----BEGIN ENCRYPTED PRIVATE KEY-----[\s\S]{1,10000}?-----END ENCRYPTED PRIVATE KEY-----/g,
    severity: 'high',
    description: 'Encrypted Private Key',
    placeholder: 'ENCRYPTED_PRIVATE_KEY',
  },
  {
    id: 'pgp-private-key',
    name: 'PGP Private Key',
    pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]{1,10000}?-----END PGP PRIVATE KEY BLOCK-----/g,
    severity: 'critical',
    description: 'PGP Private Key Block',
    placeholder: 'PGP_PRIVATE_KEY',
  },
  {
    id: 'putty-private-key',
    name: 'PuTTY Private Key',
    // Security: Length limit to prevent ReDoS
    pattern: /PuTTY-User-Key-File-[0-9]+:[\s\S]{1,5000}?Private-Lines:/g,
    severity: 'critical',
    description: 'PuTTY Private Key',
    placeholder: 'PUTTY_PRIVATE_KEY',
  },
];

// ============================================================================
// Generic Secret Patterns
// ============================================================================

export const GENERIC_PATTERNS: SecretPattern[] = [
  // Password assignments
  {
    id: 'password-assignment',
    name: 'Password Assignment',
    // Security: Upper bound to prevent ReDoS
    pattern: /(?:password|passwd|pwd|pass)\s*[=:]\s*['"]([^'"]{8,200})['"]?/gi,
    severity: 'high',
    description: 'Password assigned in configuration',
    placeholder: 'PASSWORD',
  },
  {
    id: 'password-url',
    name: 'Password in URL',
    // Security: Upper bounds to prevent ReDoS
    pattern: /:\/\/[^:]{1,100}:([^@]{8,200})@/g,
    severity: 'critical',
    description: 'Password embedded in URL',
    placeholder: 'URL_PASSWORD',
  },

  // API key assignments
  {
    id: 'api-key-assignment',
    name: 'API Key Assignment',
    pattern: /(?:api[_-]?key|apikey)\s*[=:]\s*(?:['"]([A-Za-z0-9_-]{16,256})['"]|([A-Za-z0-9_-]{16,256}))/gi,
    severity: 'high',
    description: 'API key assigned in configuration',
    placeholder: 'API_KEY',
  },

  // Token assignments
  {
    id: 'token-assignment',
    name: 'Token Assignment',
    pattern: /(?:token|auth[_-]?token|access[_-]?token|bearer[_-]?token)\s*[=:]\s*(?:['"]([A-Za-z0-9_.-]{20,256})['"]|([A-Za-z0-9_.-]{20,256}))/gi,
    severity: 'high',
    description: 'Token assigned in configuration',
    placeholder: 'TOKEN',
  },

  // Secret assignments
  {
    id: 'secret-assignment',
    name: 'Secret Assignment',
    pattern: /(?:secret|client[_-]?secret|app[_-]?secret|secret[_-]?key)\s*[=:]\s*(?:['"]([A-Za-z0-9_-]{16,256})['"]|([A-Za-z0-9_-]{16,256}))/gi,
    severity: 'high',
    description: 'Secret assigned in configuration',
    placeholder: 'SECRET',
  },

  // Bearer tokens
  {
    id: 'bearer-token',
    name: 'Bearer Token',
    pattern: /Bearer\s+([A-Za-z0-9_.-]{20,256})/g,
    severity: 'high',
    description: 'Bearer authentication token',
    placeholder: 'BEARER_TOKEN',
  },

  // Basic auth
  {
    id: 'basic-auth-header',
    name: 'Basic Auth Header',
    pattern: /Basic\s+([A-Za-z0-9+/=]{20,256})/g,
    severity: 'high',
    description: 'Base64 encoded credentials',
    placeholder: 'BASIC_AUTH',
  },

  // Database connection strings
  // Security: All patterns have length limits to prevent ReDoS
  {
    id: 'postgres-connection',
    name: 'PostgreSQL Connection String',
    pattern: /postgres(?:ql)?:\/\/[^:]{1,100}:[^@]{1,200}@[^\s'"]{1,500}/gi,
    severity: 'critical',
    description: 'PostgreSQL connection string with credentials',
    placeholder: 'DATABASE_URL',
  },
  {
    id: 'mysql-connection',
    name: 'MySQL Connection String',
    pattern: /mysql:\/\/[^:]{1,100}:[^@]{1,200}@[^\s'"]{1,500}/gi,
    severity: 'critical',
    description: 'MySQL connection string with credentials',
    placeholder: 'DATABASE_URL',
  },
  {
    id: 'mongodb-connection',
    name: 'MongoDB Connection String',
    pattern: /mongodb(?:\+srv)?:\/\/[^:]{1,100}:[^@]{1,200}@[^\s'"]{1,500}/gi,
    severity: 'critical',
    description: 'MongoDB connection string with credentials',
    placeholder: 'MONGODB_URI',
  },
  {
    id: 'redis-connection',
    name: 'Redis Connection String',
    pattern: /redis:\/\/[^:]{1,100}:[^@]{1,200}@[^\s'"]{1,500}/gi,
    severity: 'critical',
    description: 'Redis connection string with credentials',
    placeholder: 'REDIS_URL',
  },

  // JWT tokens (generic)
  {
    id: 'jwt-token',
    name: 'JWT Token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,256}\.[A-Za-z0-9_-]{10,256}\.[A-Za-z0-9_-]{10,256}\b/g,
    severity: 'high',
    description: 'JSON Web Token',
    placeholder: 'JWT_TOKEN',
  },

  // Private key content (partial detection)
  {
    id: 'base64-private-key',
    name: 'Base64 Private Key Content',
    pattern: /MII[A-Za-z0-9+/]{60,512}={0,2}/g,
    severity: 'high',
    description: 'Base64 encoded private key content',
    placeholder: 'PRIVATE_KEY_CONTENT',
  },

  // Encryption keys
  {
    id: 'encryption-key',
    name: 'Encryption Key',
    pattern: /(?:encryption[_-]?key|aes[_-]?key|crypto[_-]?key)\s*[=:]\s*['"]?([A-Fa-f0-9]{32,256})['"]?/gi,
    severity: 'critical',
    description: 'Encryption key',
    placeholder: 'ENCRYPTION_KEY',
  },

  // SSH passphrase
  {
    id: 'ssh-passphrase',
    name: 'SSH Passphrase',
    pattern: /(?:ssh[_-]?passphrase|key[_-]?passphrase)\s*[=:]\s*['"]([^'"]+)['"]?/gi,
    severity: 'critical',
    description: 'SSH key passphrase',
    placeholder: 'SSH_PASSPHRASE',
  },
];

// ============================================================================
// Combine All Patterns
// ============================================================================

export const ALL_SECRET_PATTERNS: SecretPattern[] = [
  ...CLOUD_PROVIDER_PATTERNS,
  ...API_TOKEN_PATTERNS,
  ...PRIVATE_KEY_PATTERNS,
  ...GENERIC_PATTERNS,
];

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get patterns by severity level
 */
export const getPatternsBySeverity = (severity: SecretSeverity): SecretPattern[] => {
  return ALL_SECRET_PATTERNS.filter((p) => p.severity === severity);
};

/**
 * Get pattern by ID
 */
export const getPatternById = (id: string): SecretPattern | undefined => {
  return ALL_SECRET_PATTERNS.find((p) => p.id === id);
};

/**
 * Get patterns above a minimum severity
 * (critical > high > medium > low)
 */
export const getPatternsAboveSeverity = (minSeverity: SecretSeverity): SecretPattern[] => {
  const severityOrder: Record<SecretSeverity, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  const minLevel = severityOrder[minSeverity];
  return ALL_SECRET_PATTERNS.filter((p) => severityOrder[p.severity] <= minLevel);
};

/**
 * Create a custom pattern
 */
export const createCustomPattern = (
  id: string,
  name: string,
  pattern: string,
  options?: {
    severity?: SecretSeverity;
    description?: string;
    placeholder?: string;
    flags?: string;
  }
): SecretPattern => {
  return {
    id: `custom-${id}`,
    name,
    pattern: new RegExp(pattern, options?.flags || 'g'),
    severity: options?.severity || 'high',
    description: options?.description || `Custom pattern: ${name}`,
    placeholder: options?.placeholder || id.toUpperCase().replace(/-/g, '_'),
  };
};

/**
 * Binary file extensions that should be skipped during scanning
 */
export const BINARY_EXTENSIONS = new Set([
  // Images
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.svg',
  '.tiff',
  '.tif',
  // Documents
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  // Archives
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.7z',
  '.rar',
  '.xz',
  // Binaries
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.o',
  '.a',
  // Fonts
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.eot',
  // Media
  '.mp3',
  '.mp4',
  '.wav',
  '.avi',
  '.mov',
  '.mkv',
  '.flac',
  // Database
  '.db',
  '.sqlite',
  '.sqlite3',
  // Other
  '.pyc',
  '.pyo',
  '.class',
  '.jar',
]);

/**
 * Check if a file should be skipped based on extension
 */
export const shouldSkipFile = (filepath: string): boolean => {
  const ext = filepath.slice(filepath.lastIndexOf('.')).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
};
