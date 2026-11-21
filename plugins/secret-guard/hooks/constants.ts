/** What a masked value is replaced with. A prefix or a name that says what it was stays in front of it. */
export const MASK = '•••'

/** The shell tools: their `command` is checked before it runs. */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell'])

/**
 * The rows of the conversation that are left as they are: what the person typed, and the queue's
 * record of it. Someone who writes a key into their own prompt means Claude to have it.
 */
export const UNTOUCHED_DOORS: ReadonlySet<string> = new Set(['prompt', 'queue'])

/** Text longer than this is passed on unread: it is a file's bytes, not something a person reads. */
export const MAX_SCANNED_CHARS = 5_000_000

/** A value that stands for a secret without being one: a variable, a command substitution, a placeholder. */
const REFERENCE = '(?![$`{<%])'

/**
 * A name that ends in `token` and is no secret: the place to continue a listing from
 * (`nextPageToken`, `continuation_token`, `sync-token`). Masked, a listing could not be followed.
 */
const NOT_A_PAGE_TOKEN = '(?![A-Za-z0-9_.-]*(?:page|next|continuation|cursor|sync)[_-]?token\\b)'

/** The characters a value takes in a link's query. Anything else (a bracket, a pipe) is code, not a link. */
const URL_VALUE = '[A-Za-z0-9._~%+/=-]'

/**
 * The characters of a value that only its variable's name gives away. A bracket, a dot or a backslash
 * means the text is code (`PASSWORD=hashlib.sha256(seed)`, the source of a pattern), which a person
 * and Claude have to read as it is.
 */
const NAMED_VALUE = '[A-Za-z0-9_+/=~@%!^#*-]'

/** A value that looks made by a machine: it has a letter and a digit. Words such as `postgres` or `changeme` do not. */
const mixed = (chars: string) => `(?=${chars}*\\d)(?=${chars}*[A-Za-z])`

/**
 * One shape a secret takes in text.
 *
 * Why it exists: a secret is recognized by its shape (a provider's prefix, a parameter's name, a
 * header), and each shape needs its own way to mask it so that what stays tells what it was. Used
 * by {@link maskSecrets} for tool results and by {@link findLiteralSecret} for shell commands.
 */
export type SecretRule = {
  /** What the value is, in the words a notice uses. */
  kind: string
  /** Finds every occurrence. Always global; its groups are what {@link SecretRule.replacement} keeps. */
  pattern: RegExp
  /** What takes the place of a match: `$1`, `$2` are the pattern's groups, the rest is literal. */
  replacement: string
  /** True for a shape certain enough to refuse a shell command that spells it out. */
  isBlocking: boolean
}

/**
 * The shapes, in the order they are applied: a later rule never matches what an earlier one left.
 *
 * Shapes that only suggest a secret by a name (`PASSWORD=`, `"token":`) ask for a value that looks
 * made by a machine, so a local `POSTGRES_PASSWORD=postgres` stays readable, and they never refuse
 * a command: `PGPASSWORD=app123 psql …` is an ordinary thing to run.
 */
export const SECRET_RULES: readonly SecretRule[] = [
  {
    kind: 'private key',
    pattern: /-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g,
    replacement: `-----BEGIN $1PRIVATE KEY-----${MASK}-----END $1PRIVATE KEY-----`,
    isBlocking: true,
  },
  {
    // The head of a key whose end was cut off (`head -5 id_rsa`)
    kind: 'private key',
    pattern: /-----BEGIN ([A-Z ]*)PRIVATE KEY-----[A-Za-z0-9+/=\s]{40,}/g,
    replacement: `-----BEGIN $1PRIVATE KEY-----${MASK}`,
    isBlocking: false,
  },
  {
    kind: 'bearer token',
    pattern: new RegExp(`\\b(Bearer|Authorization: *Basic) +${REFERENCE}(?=[A-Za-z0-9._~+/=-]*\\d)[A-Za-z0-9._~+/=-]{16,}`, 'g'),
    replacement: `$1 ${MASK}`,
    isBlocking: true,
  },
  {
    // Header and payload both begin with base64 `{"`
    kind: 'JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replacement: `eyJ${MASK}`,
    isBlocking: true,
  },
  {
    // Keys known by a prefix whose body is letters and digits alone: GitHub, npm, Hugging Face, Groq,
    // Replicate, Linear, Notion, Supabase, PostHog, Shopify, Stripe, Tavily, xAI, Perplexity, DigitalOcean
    kind: 'API key',
    pattern:
      /\b(gh[pousr]_|npm_|hf_|gsk_|r8_|lin_api_|ntn_|sbp_|phx_|shp(?:at|ss|ca|pa)_|whsec_|(?:sk|rk)_(?:live|test)_|tvly-(?:dev-)?|xai-|pplx-|dop_v1_)[A-Za-z0-9]{20,}/g,
    replacement: `$1${MASK}`,
    isBlocking: true,
  },
  {
    // Keys known by a prefix whose body also has `-` and `_`: OpenAI, Anthropic, GitHub fine-grained,
    // GitLab, Slack, 1Password service accounts, Sentry, Figma
    kind: 'API key',
    pattern:
      /\b(sk-(?:ant-|proj-|svcacct-)?|github_pat_|glpat-|xox[abeprs]-|ops_eyJ|sntry[su]_|figd_)(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g,
    replacement: `$1${MASK}`,
    isBlocking: true,
  },
  {
    // Keys whose prefix is short, so the whole shape is asked for: Google API keys, Google OAuth access
    // tokens, SendGrid keys (two parts), Resend keys (two parts)
    kind: 'API key',
    pattern:
      /\b(AIza(?=[0-9A-Za-z_-]{35})|ya29\.(?=[A-Za-z0-9._-]{30})|SG\.(?=[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16})|re_(?=[A-Za-z0-9]{6,}_[A-Za-z0-9]{16}))[A-Za-z0-9._-]{16,}/g,
    replacement: `$1${MASK}`,
    isBlocking: true,
  },
  {
    // An access key id is not the secret itself, so a command may name one; it is still masked in output
    kind: 'AWS access key id',
    pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: `$1${MASK}`,
    isBlocking: false,
  },
  {
    kind: 'webhook address',
    pattern: /(https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/|https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/)[A-Za-z0-9_-]{20,}/g,
    replacement: `$1${MASK}`,
    isBlocking: true,
  },
  {
    // `?signature=…`, `&access_token=…`, and the same under a service's own name (`?tavilyApiKey=…`)
    kind: 'token in a link',
    pattern: new RegExp(
      `([?&]${NOT_A_PAGE_TOKEN}[A-Za-z0-9_.-]*(?:signature|sig|token|api[_-]?key|secret|password|passwd|credentials?)=)${REFERENCE}${mixed(URL_VALUE)}${URL_VALUE}{16,}`,
      'gi',
    ),
    replacement: `$1${MASK}`,
    isBlocking: true,
  },
  {
    // `scheme://user:password@host`
    kind: 'password in a connection string',
    pattern: new RegExp(`(\\b[a-z][a-z0-9+.-]*:\\/\\/[^\\s:@/]+:)${REFERENCE}${mixed('[^\\s@/]')}[^\\s@/]{8,}(@)`, 'gi'),
    replacement: `$1${MASK}$2`,
    isBlocking: false,
  },
  {
    // `NAME=value` where the name says secret
    kind: 'secret in an environment variable',
    pattern: new RegExp(
      `\\b(?![A-Za-z0-9_]*(?:PAGE|NEXT|CONTINUATION|CURSOR|SYNC)_?TOKEN=)([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?))=(["']?)${REFERENCE}${mixed(NAMED_VALUE)}${NAMED_VALUE}{12,}\\2(?=$|[\\s;&|)\\]},])`,
      'gm',
    ),
    replacement: `$1=$2${MASK}$2`,
    isBlocking: false,
  },
  {
    // `"apiKey": "value"` in JSON, where the key says secret
    kind: 'secret in a JSON value',
    pattern: new RegExp(
      `("${NOT_A_PAGE_TOKEN}[A-Za-z0-9_.-]*(?:api[_-]?key|private[_-]?key|token|secret|password|passwd|credentials?)"\\s*:\\s*")${REFERENCE}${mixed('[^"\\s]')}[^"\\s]{12,}(")`,
      'gi',
    ),
    replacement: `$1${MASK}$2`,
    isBlocking: false,
  },
]
