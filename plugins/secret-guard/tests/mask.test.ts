import { describe, expect, test } from 'claude-code/testing'

import { describeFound, findLiteralSecret, maskSecrets } from '../hooks/mask'

// Fake credentials, assembled at run time so that secret scanners do not flag this public file.
// Each has the shape of the real thing.
const ANTHROPIC_KEY = ['sk', 'ant', 'api03', 'x'.repeat(32)].join('-')
const OPENAI_KEY = ['sk', 'proj', 'A1b2C3d4'.repeat(5)].join('-')
const GITHUB_TOKEN = ['ghp', 'y'.repeat(36)].join('_')
const SEARCH_KEY = ['tvly', 'dev', 'z'.repeat(32)].join('-')
const OPAQUE = ['k9f3a7c1', 'e5b2d8f6', 'a4c0'].join('')
const SIGNATURE = '0123456789abcdef'.repeat(4)
const BEARER = 'a1b2c3d4'.repeat(4)
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLXBhcnQ'].join('.')
// The first and last line of a private key file, each in two pieces: written whole in this file they
// would themselves be reported as a key by secret scanners
const KEY_BEGIN = ['-----BEGIN OPENSSH PRIVATE', 'KEY-----'].join(' ')
const KEY_END = ['-----END OPENSSH PRIVATE', 'KEY-----'].join(' ')
const PRIVATE_KEY = [KEY_BEGIN, 'b3BlbnNzaC1rZXktdjEAAAAA', 'QyNTUxOQAAACD0', KEY_END].join('\n')

describe('maskSecrets', () => {
  test('masks a key known by its prefix and keeps the prefix that tells what it was', () => {
    // Arrange
    const output = `OPENAI_API_KEY=${OPENAI_KEY}\nHOME=/home/dev`

    // Act
    const masked = maskSecrets(output)

    // Assert
    expect(masked.text).toBe('OPENAI_API_KEY=sk-proj-•••\nHOME=/home/dev')
    expect([...masked.found]).toEqual([['API key', 1]])
  })

  test('masks a key that a link carries under the service’s own parameter name', () => {
    // Arrange: what a process list shows of a server started with its key in the address
    const output = `npm exec mcp-remote https://mcp.search.test/mcp/?searchApiKey=${OPAQUE}`

    // Act
    const masked = maskSecrets(output)

    // Assert
    expect(masked.text).toBe('npm exec mcp-remote https://mcp.search.test/mcp/?searchApiKey=•••')
    expect([...masked.found]).toEqual([['token in a link', 1]])
  })

  test('masks a machine-made value assigned to a variable whose name says secret', () => {
    // Arrange
    const output = `SESSION_SECRET=${OPAQUE}\nPORT=3000`

    // Act
    const masked = maskSecrets(output)

    // Assert
    expect(masked.text).toBe('SESSION_SECRET=•••\nPORT=3000')
    expect([...masked.found]).toEqual([['secret in an environment variable', 1]])
  })

  test('leaves a local password that is a plain word readable', () => {
    // Arrange: the settings of a development database
    const output = 'POSTGRES_PASSWORD=postgres\nDATABASE_URL=postgres://app:app@localhost:5432/app'

    // Act
    const masked = maskSecrets(output)

    // Assert
    expect(masked.text).toBe('POSTGRES_PASSWORD=postgres\nDATABASE_URL=postgres://app:app@localhost:5432/app')
    expect(masked.found.size).toBe(0)
  })

  test('masks the password of a connection string and keeps the user and the host', () => {
    // Arrange
    const output = `postgres://app:${OPAQUE}@db.example.test:5432/app`

    // Act
    const masked = maskSecrets(output)

    // Assert
    expect(masked.text).toBe('postgres://app:•••@db.example.test:5432/app')
    expect([...masked.found]).toEqual([['password in a connection string', 1]])
  })

  test('masks a secret in a JSON value and leaves the settings beside it', () => {
    // Arrange
    const output = `{ "apiKey": "${OPAQUE}", "max_tokens": 4096, "model": "claude-opus-5-5" }`

    // Act
    const masked = maskSecrets(output)

    // Assert
    expect(masked.text).toBe('{ "apiKey": "•••", "max_tokens": 4096, "model": "claude-opus-5-5" }')
    expect([...masked.found]).toEqual([['secret in a JSON value', 1]])
  })

  test('masks a private key whole', () => {
    // Arrange
    const output = `$ cat ~/.ssh/id_ed25519\n${PRIVATE_KEY}\n`

    // Act
    const masked = maskSecrets(output)

    // Assert
    expect(masked.text).toBe(`$ cat ~/.ssh/id_ed25519\n${KEY_BEGIN}•••${KEY_END}\n`)
    expect([...masked.found]).toEqual([['private key', 1]])
  })

  test('masks a bearer token, a JSON Web Token and a signed link in one output', () => {
    // Arrange
    const output = [
      `> Authorization: Bearer ${BEARER}`,
      `set-cookie: session=${JWT}; HttpOnly`,
      `location: https://app.test/email/verify/1?expires=1795000000&signature=${SIGNATURE}`,
    ].join('\n')

    // Act
    const masked = maskSecrets(output)

    // Assert
    expect(masked.text).toBe(
      [
        '> Authorization: Bearer •••',
        'set-cookie: session=eyJ•••; HttpOnly',
        'location: https://app.test/email/verify/1?expires=1795000000&signature=•••',
      ].join('\n'),
    )
    expect([...masked.found]).toEqual([
      ['bearer token', 1],
      ['JSON Web Token', 1],
      ['token in a link', 1],
    ])
  })

  test('leaves commit hashes, ids, paths and words that only begin like a key unchanged', () => {
    // Arrange
    const output = [
      'commit 85c2a72f1e0b9d3c4a5b6c7d8e9f0a1b2c3d4e5f',
      'request 3f2b8c1e-7a4d-4e9b-9c6f-0d1a2b3c4d5e took 12ms',
      'task-1234567890123456789012 done; sk-learn installed',
      'GET https://app.test/items?page=2&sortkey=created_at&token=$TOKEN',
      'Bearer authentication is required',
    ].join('\n')

    // Act
    const masked = maskSecrets(output)

    // Assert
    expect(masked.text).toBe(output)
    expect(masked.found.size).toBe(0)
  })

  test('masks a text that was already masked no further', () => {
    // Arrange
    const once = maskSecrets(`ANTHROPIC_API_KEY=${ANTHROPIC_KEY} curl -H "Authorization: Bearer ${BEARER}"`).text

    // Act
    const twice = maskSecrets(once)

    // Assert
    expect(twice.text).toBe('ANTHROPIC_API_KEY=sk-ant-••• curl -H "Authorization: Bearer •••"')
    expect(twice.found.size).toBe(0)
  })

  test('leaves the token a listing continues from readable, in JSON, in a link and in a variable', () => {
    // Arrange: one page of an API's answer, the request for the next page, and a script's variable
    const output = [
      `{ "items": [], "nextPageToken": "${OPAQUE}" }`,
      `GET https://api.example.test/v1/items?pageSize=50&pageToken=${OPAQUE}`,
      `NEXT_PAGE_TOKEN=${OPAQUE}`,
    ].join('\n')

    // Act
    const masked = maskSecrets(output)

    // Assert
    expect(masked.text).toBe(output)
    expect(masked.found.size).toBe(0)
  })

  test('leaves code that assigns to a variable named like a secret readable', () => {
    // Arrange: lines of source files, as a read of them returns
    const output = [
      'PASSWORD=hashlib.sha256(seed1).hexdigest()',
      'const pattern = /(?:PAGE|NEXT)_?TOKEN=)([A-Za-z0-9_]*(?:TOKEN|SECRET))=/',
      "const output = 'POSTGRES_PASSWORD=postgres\\nDATABASE_URL=postgres://app:app@localhost:5432/app1'",
      'API_KEY=config.keys[0].value2',
    ].join('\n')

    // Act
    const masked = maskSecrets(output)

    // Assert
    expect(masked.text).toBe(output)
    expect(masked.found.size).toBe(0)
  })

  test('masks a quoted value in a shell assignment up to its closing quote', () => {
    // Arrange
    const output = `export API_TOKEN="${OPAQUE}"; ./deploy.sh`

    // Act
    const masked = maskSecrets(output)

    // Assert
    expect(masked.text).toBe('export API_TOKEN="•••"; ./deploy.sh')
    expect([...masked.found]).toEqual([['secret in an environment variable', 1]])
  })
})

describe('findLiteralSecret', () => {
  test('names an API key written into a command', () => {
    // Arrange
    const command = `git remote set-url origin https://${GITHUB_TOKEN}@github.com/acme/app.git`

    // Act
    const kind = findLiteralSecret(command)

    // Assert
    expect(kind).toBe('API key')
  })

  test('names the signature of a signed link written into a command', () => {
    // Arrange
    const command = `open 'https://app.test/email/verify/1/abc?expires=1795000000&signature=${SIGNATURE}'`

    // Act
    const kind = findLiteralSecret(command)

    // Assert
    expect(kind).toBe('token in a link')
  })

  test('names a bearer token written into a curl command', () => {
    // Arrange
    const command = `curl -H 'Authorization: Bearer ${BEARER}' https://api.test/me`

    // Act
    const kind = findLiteralSecret(command)

    // Assert
    expect(kind).toBe('bearer token')
  })

  test('finds nothing in a command that reads its secret from a password manager or a variable', () => {
    // Arrange
    const commands = [
      `K="$(op read 'op://Personal/item/credential')" && curl -H "Authorization: Bearer $K" https://api.test/me`,
      'curl -s "https://api.test/items?page=2&token=$TOKEN"',
      'curl -H "x-api-key: ${ANTHROPIC_API_KEY}" https://api.test/v1/messages',
    ]

    // Act
    const kinds = commands.map(findLiteralSecret)

    // Assert
    expect(kinds).toEqual([undefined, undefined, undefined])
  })

  test('finds nothing in a search for the shape of a key, a commit hash or a local database password', () => {
    // Arrange
    const commands = [
      "grep -rInE '(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,})' skills",
      'git show 85c2a72f1e0b9d3c4a5b6c7d8e9f0a1b2c3d4e5f --stat && php artisan test',
      'PGPASSWORD=app12345secret psql -h localhost -U app -c "select 1"',
      `grep -rl -- "${KEY_BEGIN}" ~/.ssh`,
    ]

    // Act
    const kinds = commands.map(findLiteralSecret)

    // Assert
    expect(kinds).toEqual([undefined, undefined, undefined, undefined])
  })

  test('finds nothing in a request for the next page of a listing, or in code that only looks like a query', () => {
    // Arrange
    const commands = [
      `curl "https://api.example.test/v1/items?pageSize=50&pageToken=${OPAQUE}"`,
      // The source of a pattern: `_?TOKEN=` there is an optional character, not the start of a query
      "sed -E 's/(PAGE|NEXT)_?TOKEN=)([A-Za-z0-9_]*(TOKEN|SECRET))=//' config.txt",
    ]

    // Act
    const kinds = commands.map(findLiteralSecret)

    // Assert
    expect(kinds).toEqual([undefined, undefined])
  })

  test('names a search key whose prefix it knows', () => {
    // Arrange
    const command = `curl "https://api.search.test/search?q=claude" -H "X-Key: ${SEARCH_KEY}"`

    // Act
    const kind = findLiteralSecret(command)

    // Assert
    expect(kind).toBe('API key')
  })
})

describe('describeFound', () => {
  test('says how many values of each kind were masked, never a value', () => {
    // Arrange
    const found = new Map([
      ['API key', 2],
      ['token in a link', 1],
      ['bearer token', 3],
    ])

    // Act
    const words = describeFound(found)

    // Assert
    expect(words).toBe('2 API keys, 1 token in a link and 3 bearer tokens')
  })
})
