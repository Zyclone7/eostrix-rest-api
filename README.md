# Secure Express + TypeScript CRUD API

A production-shaped REST API: Express 5, TypeScript (strict), Prisma 7, and Neon
Postgres, with JWT authentication and two roles — `ADMIN` and `USER`.

`Post` is the example CRUD resource. It exists to demonstrate the ownership
model: a `USER` manages only their own posts, an `ADMIN` manages everyone's.

---

## Quick start

```bash
npm install
cp .env.example .env          # then fill in DATABASE_URL and the JWT secrets
npm run db:check              # verifies both connection strings before you migrate
npm run prisma:migrate        # creates the tables on Neon
npm run db:seed               # creates the first admin + a demo user
npm run dev                   # http://localhost:4000/api/v1
```

Generate the two JWT secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

### DATABASE_URL and DIRECT_URL

Neon gives you **two ways to reach the same database**, and this project uses
both, for different jobs.

| | `DATABASE_URL` | `DIRECT_URL` |
| --- | --- | --- |
| Hostname | `ep-xxx**-pooler**.region.aws.neon.tech` | `ep-xxx.region.aws.neon.tech` |
| Goes through | PgBouncer (a connection pooler) | Postgres itself |
| Used by | the running server, every API request | `prisma migrate`, `db push`, `studio` |
| Read in | `src/config/prisma.ts` (the driver adapter) | `prisma.config.ts` |
| Concurrent connections | Thousands, cheaply | Few — Neon caps direct connections |

**Why two.** Postgres allocates a process per connection, so a serverless or
autoscaled app can exhaust it quickly. PgBouncer sits in front and multiplexes
many client connections onto a few real ones, which is exactly what a
long-running API wants.

But PgBouncer in transaction mode cannot hold a **session-level advisory
lock** — and that is precisely what `prisma migrate` takes out to stop two
deploys migrating at once. Run a migration through the pooler and it hangs or
fails. Hence the second URL: migrations bypass the pooler and talk to Postgres
directly.

The rule of thumb: **pooled for many short queries, direct for one long
privileged operation.**

#### Getting them

1. Create a project at <https://console.neon.tech>.
2. Open **Connection Details** on the dashboard.
3. With the **Connection pooling** toggle **on**, copy the string into
   `DATABASE_URL`.
4. Turn the toggle **off**, copy that string into `DIRECT_URL`.
5. Keep `?sslmode=require` on both — Neon refuses plaintext connections.

The two strings are identical except for `-pooler` in the hostname. If yours
differ in any other way, you copied from two different branches or roles.

```dotenv
# .env  — note the -pooler suffix on the first host only
DATABASE_URL="postgresql://neondb_owner:npg_XXXX@ep-cool-fog-12345678-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require"
DIRECT_URL="postgresql://neondb_owner:npg_XXXX@ep-cool-fog-12345678.us-east-2.aws.neon.tech/neondb?sslmode=require"
```

#### Reading the URL

```
postgresql://neondb_owner:npg_XXXX@ep-cool-fog-12345678-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require
└────┬───┘   └─────┬────┘ └───┬──┘ └──────────────────────┬───────────────────────────┘ └──┬─┘ └──────┬─────┘
  scheme        role      password                      host                            database    options
```

#### Check them before doing anything else

```bash
npm run db:check
```

It validates the shape of both URLs, connects to each, and reports what
answered — including whether advisory locks work, which is the real test of
whether a URL can run migrations. It never prints your credentials. Typical
mistakes it names outright:

| Symptom | Cause |
| --- | --- |
| `Still the example value` | `.env` is untouched — paste your real strings |
| `This is the POOLED host` in `DIRECT_URL` | The `-pooler` toggle was left on |
| `password authentication failed` | Wrong role or password; reset it in the console |
| `Advisory locks unavailable` on `DIRECT_URL` | You pasted a pooled URL |
| `ENOTFOUND` | Typo in the host, or the project was deleted |
| Password rejected but looks right | It contains `@ : / ? #` and needs percent-encoding |

#### If you only have one URL

Set `DATABASE_URL` alone and leave `DIRECT_URL` empty. `prisma.config.ts` falls
back to `DATABASE_URL` for migrations. That is fine for **local or self-hosted**
Postgres, where there is no pooler. On Neon it will fail the moment you migrate,
because the fallback would be the pooled URL.

#### Elsewhere

- **CI** — `.github/workflows/ci.yml` points both at the `postgres:16` service
  container. No pooler is involved, so both are the same string.
- **Production** — set them as environment variables in your host's dashboard
  (Render, Railway, Fly, Vercel). Never commit `.env`; it is gitignored.
  `DIRECT_URL` is only needed wherever migrations run, which is usually a
  release step rather than the running app.

### Verify it works

```bash
npm test        # 249 Jest tests, no database needed
npm run smoke   # boots the app: headers, 404s, validation, auth guards
npm run e2e     # against the real database: the full CRUD + RBAC matrix
```

---

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Watch-mode server (`tsx`) |
| `npm run build` / `npm start` | Compile to `dist/` and run it |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:check` | Diagnose DATABASE_URL and DIRECT_URL (no credentials printed) |
| `npm run prisma:migrate` | Create/apply a migration in development |
| `npm run prisma:deploy` | Apply migrations in production |
| `npm run prisma:studio` | Browse the data |
| `npm run db:seed` | Idempotent seed (first admin + demo data) |
| `npm test` | Jest unit + integration suite (no database) |
| `npm run test:watch` / `test:coverage` | Watch mode / coverage report |
| `npm run smoke` / `npm run e2e` | HTTP smoke test / database-backed end-to-end |
| `npm run audit:prod` | Fails on high advisories in the shipped tree |

---

## Project layout

```
prisma/
  schema.prisma        Models: User, Post, Book, RefreshToken + the Role enum
  seed.ts              Idempotent seed
prisma.config.ts       Prisma 7 config (migration URL, seed command)
scripts/
  smoke.ts             HTTP-layer checks, no DB required
  e2e.ts               Full authorisation matrix against a real DB
  audit-prod.js        Advisory gate for the production dependency tree
  db-check.ts          Connection-string diagnostics
tests/
  setup-env.ts         Environment for the test process
  helpers/             Prisma client mock
  unit/                Utils, middleware and services (Prisma mocked)
  integration/         The real app via supertest (Prisma mocked)
.github/workflows/
  ci.yml               Test matrix, Postgres end-to-end job, audit
src/
  app.ts               Middleware pipeline (security, parsing, routes)
  server.ts            Bootstrap + graceful shutdown
  routes.ts            /health and module mounting
  config/              env validation, logger, Prisma client
  middlewares/         authenticate, authorize, validate, rateLimiter, errorHandler
  utils/               ApiError, jwt, password, pagination
  modules/
    auth/              register, login, refresh, logout, change-password
    users/             admin user management + self-service profile
    departments/       organisational units and their membership
    posts/             the ownership-scoped CRUD resource
```

Each module is `schema` (Zod) → `routes` → `controller` → `service`. Controllers
only translate HTTP; **all authorisation decisions live in the service layer**,
so a rule cannot be bypassed by reaching a service from a different route.

---

## The role model

| | Anonymous | `USER` | `ADMIN` |
| --- | --- | --- | --- |
| Read published posts | ✅ | ✅ | ✅ |
| Read unpublished posts | ❌ | own only | ✅ all |
| Create a post | ❌ | ✅ | ✅ |
| Edit / delete a post | ❌ | own only | ✅ any |
| List / read published books | ❌ | ✅ | ✅ |
| Read unpublished books | ❌ | ❌ | ✅ |
| Upload / edit / delete a book | ❌ | ❌ | ✅ |
| Update own profile | ❌ | ✅ | ✅ |
| List / read users | ❌ | ❌ | ✅ |
| Create / edit / delete users | ❌ | ❌ | ✅ |
| Change a role or deactivate | ❌ | ❌ | ✅ |
| Read the department directory | ❌ | ✅ | ✅ |
| Create / edit / delete a department | ❌ | ❌ | ✅ |
| See a department roster | ❌ | ❌ | ✅ |
| Place a user in a department | ❌ | ❌ | ✅ |

Two details worth knowing:

- **Roles are never accepted from the client on the paths that matter.**
  `POST /auth/register` and `PATCH /users/me` have no `role` field in their Zod
  schemas, and Zod strips unknown keys — so `{"role":"ADMIN"}` in a signup body
  is silently discarded rather than honoured. Only `POST /users` and
  `PATCH /users/:id`, both admin-gated, can set a role.
- **Departments are an admin decision, not a self-service one.** Like `role`,
  `departmentId` is absent from `PATCH /users/me`, so a user cannot move
  themselves into another department by editing their own profile.
- **A hidden post returns 404, not 403.** Answering 403 would confirm that the
  id exists, which is itself a disclosure.

---

## API

Base URL: `/api/v1`. Send the access token as `Authorization: Bearer <token>`.

### Auth

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| `POST` | `/auth/register` | Public | Always creates a `USER` |
| `POST` | `/auth/login` | Public | Returns an access + refresh pair |
| `POST` | `/auth/refresh` | Public | Rotates the refresh token |
| `POST` | `/auth/logout` | Public | Revokes the presented refresh token |
| `POST` | `/auth/logout-all` | Authenticated | Kills every session |
| `GET` | `/auth/me` | Authenticated | Current profile |
| `PATCH` | `/auth/change-password` | Authenticated | Revokes other sessions |

### Users

| Method | Path | Access |
| --- | --- | --- |
| `PATCH` | `/users/me` | Authenticated (name, email only) |
| `GET` | `/users` | **Admin** — paginated, `?role=`, `?isActive=`, `?search=`, `?departmentId=`, `?unassigned=true` |
| `POST` | `/users` | **Admin** — may set `role`, `isActive` and `departmentId` |
| `GET` | `/users/:id` | **Admin** |
| `PATCH` | `/users/:id` | **Admin** |
| `DELETE` | `/users/:id` | **Admin** |

Every user payload carries its placement as `departmentId` plus a nested
`department` of `{ id, name, code }`, or `null` when the account is unplaced.

### Departments

An organisational unit — IT, Accounting, Economics — that users are placed in.
A user belongs to at most one. The directory is readable by any signed-in user
so a client can render a picker; membership is admin territory.

| Method | Path | Access |
| --- | --- | --- |
| `GET` | `/departments` | Authenticated — `?page=`, `?limit=`, `?search=`, `?isActive=`, `?sortBy=` |
| `GET` | `/departments/:id` | Authenticated — includes `_count.users` |
| `POST` | `/departments` | **Admin** — `name` and `code` are both unique |
| `PATCH` | `/departments/:id` | **Admin** |
| `DELETE` | `/departments/:id` | **Admin** — 409 while it still has members |
| `GET` | `/departments/:id/members` | **Admin** — the roster, same filters as `/users` |
| `POST` | `/departments/:id/members` | **Admin** — bulk assign `{ "userIds": [...] }` |
| `DELETE` | `/departments/:id/members/:userId` | **Admin** — leaves the account unplaced |

Three rules the service enforces:

- **The code is case-folded.** `it` and `IT` are the same department, because
  the schema uppercases before it validates — the same trick `emailSchema` uses
  for addresses, so the uniqueness check and the stored value always agree.
- **A department with members cannot be deleted.** The foreign key is
  `onDelete: Restrict`, and the service turns that into a 409 naming the number
  of members to reassign first, rather than a raw database error.
- **An inactive department takes no new members.** Retiring one keeps its
  history and its current roster, but every placement path refuses it.

### Posts

| Method | Path | Access |
| --- | --- | --- |
| `GET` | `/posts` | Public — `?page=`, `?limit=`, `?search=`, `?published=`, `?mine=true` |
| `GET` | `/posts/:id` | Public for published; owner/admin for drafts |
| `POST` | `/posts` | Authenticated |
| `PATCH` | `/posts/:id` | Owner or admin |
| `DELETE` | `/posts/:id` | Owner or admin |

### Books (EPUB library)

Uploading is admin-only; every signed-in user can list, read and download.
Nothing here is public — unlike posts, the whole module sits behind
`authenticate`.

| Method | Path | Access |
| --- | --- | --- |
| `GET` | `/books` | Authenticated — `?page=`, `?limit=`, `?search=`, `?published=`, `?sortBy=` |
| `GET` | `/books/:id` | Authenticated — published only, unless admin |
| `GET` | `/books/:id/file` | Authenticated — streams the EPUB; `?download=true` for an attachment |
| `POST` | `/books` | **Admin** — `multipart/form-data`, file field `file` |
| `PATCH` | `/books/:id` | **Admin** — metadata only |
| `DELETE` | `/books/:id` | **Admin** — removes the row and the file |

Uploading, as a form post:

```bash
curl -X POST http://localhost:4000/api/v1/books   -H "Authorization: Bearer $ADMIN_TOKEN"   -F "title=Moby Dick"   -F "author=Herman Melville"   -F "published=true"   -F "file=@moby-dick.epub;type=application/epub+zip"
```

What the upload path enforces:

- **The role gate runs before multer**, so a `USER`'s upload is refused on the
  headers rather than after megabytes have been buffered.
- **The bytes decide, not the filename.** `Content-Type` and the `.epub`
  extension are both attacker-controlled, so the file is only accepted if it
  really is an OCF container: a ZIP whose first entry is an uncompressed
  `mimetype` holding `application/epub+zip` (`src/modules/books/epub.ts`).
- **Nothing is written until it has been validated** — the file is buffered in
  memory, capped at `EPUB_MAX_BYTES` (a too-large upload is a 413).
- **The stored name is a server-generated UUID**, never the uploaded filename,
  so a crafted name cannot traverse out of the upload directory. `originalName`
  is kept for the download only, stripped of control characters.
- **SHA-256 is unique across the library**, so re-uploading the same file is a
  409 rather than a second copy.
- **The blob is written before the row and removed if the insert fails**: an
  orphaned file is sweepable, a row pointing at nothing is a broken download.

Files live on local disk under `UPLOAD_DIR` (`./uploads/epubs`). That directory
is the whole storage contract — `src/utils/fileStorage.ts` is the only module
that knows where bytes physically live, so moving the library to S3/R2 means
reimplementing four functions. On an ephemeral container filesystem, point
`UPLOAD_DIR` at a mounted volume or the files vanish on the next deploy.

### Response shape

Success:

```json
{ "success": true, "data": { "post": { "id": "…" } } }
```

Lists add pagination metadata:

```json
{ "success": true, "data": [], "meta": { "page": 1, "limit": 20, "total": 42, "totalPages": 3, "hasNextPage": true, "hasPreviousPage": false } }
```

Errors are uniform, and 500s never carry internals:

```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Validation failed", "details": [{ "field": "email", "message": "A valid email address is required" }] } }
```

---

## Security notes

**Passwords** are bcrypt hashes (cost 12, configurable). The column is excluded
from every `select` used by a response, so a hash cannot leak through a
serialisation mistake. Login answers identically for an unknown email and a
wrong password, and burns a decoy bcrypt comparison in the unknown-email case so
timing does not reveal which addresses are registered.

**Tokens.** Access tokens are short-lived (15m) and carry `sub` + `role`, signed
with issuer/audience claims. The `type` claim is checked so a refresh token can
never be presented where an access token is expected. Refresh tokens are
long-lived (7d), stored **as SHA-256 digests** so a database dump cannot be
replayed, and are **rotated on every use**. Presenting an already-rotated token
means it leaked, so every session for that user is revoked.

**Instant revocation.** `authenticate` reads the user row on each request, so
deactivation, deletion, a role change, a password change and "log out
everywhere" all take effect immediately instead of lingering until the access
token expires. The role is read from the database rather than trusted from the
token, so a demotion cannot be outrun by a token minted before it. The cost is
one indexed primary-key lookup per request.

**Refresh cookie.** Browsers receive the refresh token as an `httpOnly`,
`sameSite=strict`, path-scoped cookie (`secure` in production), keeping it out of
reach of XSS. It is also returned in the body for native clients with no cookie
jar.

**Input.** Every route validates params, query and body with Zod, and handlers
use the parsed output — so values are coerced, bounded and whitelisted. Unknown
keys are stripped, which is what stops mass assignment. Duplicated query
parameters (`?limit=5&limit=100`) are collapsed to a single value before
validation — deliberately *not* via `hpp`, which is silently inert on Express 5
because `req.query` is a getter it cannot rewrite. Prisma parameterises all SQL.

**Transport and abuse.** `helmet` (CSP, HSTS, `no-referrer`, no
`x-powered-by`), a strict origin allowlist for CORS, a 100 kb body cap, and four
rate limiters: global, auth (10 per 15 min, keyed by IP **and** email so one
attacker cannot lock out a shared NAT), registration, and writes.

**Errors.** Only `ApiError` instances reach the client with their own message.
Everything else — including Prisma and driver errors — collapses to a generic
500, with the real error logged server-side. The logger redacts
`authorization`, `cookie` and every password/token field.

**Guard rails.** The last active administrator cannot be deleted or demoted, and
an admin cannot delete, deactivate or demote their own account — so the system
cannot be locked out of its own admin surface.

### Before going to production

- Set `NODE_ENV=production`, fresh 48-byte secrets, and a real `CORS_ORIGINS`.
- Change the seeded admin password — the seed refuses to run in production with
  the default.
- `app.set('trust proxy', 1)` is already on for production; set the hop count to
  match your actual proxy depth.
- Terminate TLS in front of the app (the `secure` cookie flag assumes HTTPS).
- Add email verification and a password-reset flow — both are out of scope here.
- Prune expired rows from `refresh_tokens` on a schedule; `expiresAt` is indexed
  for exactly that.

### Known advisories

`npm audit` reports 4 high advisories, all inside the **`prisma` CLI's own
dependency tree** (`@prisma/config`, `deepmerge-ts`, `mysql2` — which this
project does not use). The CLI is a `devDependency` and is never deployed.

They still show up under `npm audit --omit=dev`, because `@prisma/client`
declares the CLI as an *optional peer dependency*, which keeps it in npm's
production graph. `npm run audit:prod` accounts for exactly those four packages
and fails on anything else — see [Continuous integration](#continuous-integration).

---

## Testing

Three layers, deliberately separated by what they need to run:

| Suite | Command | Needs a database | Covers |
| --- | --- | --- | --- |
| Unit | `npm test` | No — Prisma is mocked | Utils, middleware, service authorisation logic |
| Integration | `npm test` | No — Prisma is mocked | The real Express app via supertest: middleware order, headers, CORS, cookies, status codes |
| End-to-end | `npm run e2e` | **Yes** | The full CRUD + RBAC matrix against real Postgres |

249 tests, ~91% statement and ~84% branch coverage; `jest.config.js` fails the
run below 85/75/78/85 so coverage cannot quietly rot.

The split matters: the unit and integration suites run anywhere, instantly,
with no Postgres and no network, which is what makes them worth running on
every save. `tests/setup-env.ts` **assigns** rather than defaults the
environment, so a developer's real `.env` — including a live Neon URL — can
never leak into a test run.

Most of the assertions are about the boundaries rather than the happy path:
that self-registration cannot grant `ADMIN`, that a `USER` cannot read another
user's draft or edit their post, that a rotated refresh token cannot be
replayed, that a role change invalidates tokens already issued, that the last
administrator cannot be demoted, and that a 500 never carries a stack, a SQL
fragment or a database hostname.

```bash
npm test                  # everything
npm run test:watch        # watch mode
npm run test:coverage     # coverage report
npx jest post.service     # one file
```

---

## Continuous integration

`.github/workflows/ci.yml` runs three jobs on every push and pull request:

**`test`** — on Node 20, 22 and 24 (Prisma 7 requires `^20.19 || ^22.12 || >=24`).
`npm ci` (which also fails if `package-lock.json` has drifted) → `prisma validate`
→ typecheck of *both* `src` and `tests` → Jest with coverage → `npm run build` →
`npm run smoke`. The smoke step runs with no database on purpose: booting the
app and serving 404s, validation errors and auth rejections must not require one.

**`e2e`** — brings up a `postgres:16` service container, creates the schema,
seeds it and runs the full end-to-end suite. It stands in for Neon; the
application code is identical against either, only the connection string
differs. If `prisma/migrations/` is committed the job applies those migrations,
which also proves they replay cleanly onto an empty database; until then it
falls back to `prisma db push`.

**`audit`** — gates the shipped dependency tree via `npm run audit:prod`, and
prints a full advisory report without blocking.

Typechecking the tests is not ceremony — it has already caught two errors that
`ts-jest` transpiled straight past, since ts-jest does not typecheck.

### A note on the audit job

Plain `npm audit --omit=dev` is unusable as a gate here: `@prisma/client`
declares the `prisma` CLI as an *optional peer dependency*, so npm keeps the
CLI and everything beneath it in the production graph even though it is a
devDependency that is never deployed. A gate that fails on every run teaches
people to ignore it. `scripts/audit-prod.js` therefore lists those four
packages with a written reason and fails on anything else at high or critical
severity — and tells you when an entry has become stale and can be dropped.

---
line one
