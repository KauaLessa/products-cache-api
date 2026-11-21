# Caching strategies

How the API applies each caching policy, and how it behaves when something fails.
For setup and usage, see the [README](../README.md).

## Architecture

```
routes → controller → strategy ─┬→ repository   (MongoDB, source of truth)
                                └→ cacheService (Redis / ElastiCache)
```

- **Controller** (`src/controllers/`) only deals with HTTP: status codes and the `X-Cache` header.
- **Strategy** (`src/strategies/`) decides the caching policy: when to read, write and invalidate.
  It is picked at startup by `CACHE_STRATEGY` (Strategy pattern); all strategies share the same
  interface (`getById`, `list`, `create`, `update`, `remove`).
- **cacheService** (`src/cache/`) holds what every strategy shares: JSON serialization, TTL, key
  prefix and the fallback when Redis is down (it never throws).
- **Repository** (`src/repositories/`) is the only layer that talks to MongoDB.

## `none` — baseline

Every operation goes straight to MongoDB (`X-Cache: BYPASS`), and no Redis client is created. It
measures the raw capacity of the API + database, which the cached strategies are compared against.

## `cache-aside` — lazy loading

### Single product

Key: `<prefix>product:<id>`, e.g. `products-api:product:42`.

**Read**

1. `GET` the key in Redis.
2. Found → `HIT`; MongoDB is not queried.
3. Not found → read MongoDB, `SET key value EX <ttl>` → `MISS`.
4. Redis unavailable → read MongoDB without touching the cache → `BYPASS`.

Missing products are not cached (no negative caching), so a product created later is never
hidden behind a cached "not found".

**Write (`PUT` / `DELETE`)**: write to MongoDB first, then `DEL` the key. The next read loads the
new value.

### Product lists

Each page is cached under `<prefix>products:list:v<generation>:p<page>:l<limit>`. A page combines
many products, so a write could change any page (a new product shifts the order and the total).
Instead of finding and deleting affected pages, the API uses a **generation counter**:

- `<prefix>products:list:gen` holds the current generation (no TTL);
- every write (`POST`, `PUT`, `DELETE`) runs `INCR` on it;
- readers build page keys with the current generation, so after an `INCR` they look for new keys,
  and old pages are orphaned until their TTL expires.

| Moment | `gen` | Request | Key read | Result |
|---|---|---|---|---|
| 1 | — (0) | GET page 1 | `v0:p1:l5` | MISS → stored |
| 2 | 0 | GET page 1 | `v0:p1:l5` | HIT |
| 3 | 0 → 1 | PUT /products/1 | — | `v0` pages orphaned |
| 4 | 1 | GET page 1 | `v1:p1:l5` | MISS → stored with the new data |

Trade-offs:

- One command invalidates every page, and it works in cluster mode (single-key commands only).
- A list `HIT` costs two Redis round trips (generation + page).
- Every write invalidates **all** pages, so the list hit rate drops quickly as the write rate
  grows, while hot pages (page 1–3) can still reach high hit rates in read-heavy workloads.
- The stale-SET race of single products does not apply: a slow reader stores an old page under the
  old generation, which nobody reads anymore.

### Staleness window

With `CACHE_INVALIDATE_ON_WRITE=false`, writes do not invalidate anything (no `DEL`, no `INCR`),
and reads return the old value until the TTL expires. The `version` field makes this visible:
the cached product has a lower `version` than the database.

```bash
CACHE_STRATEGY=cache-aside CACHE_TTL_SECONDS=10 CACHE_INVALIDATE_ON_WRITE=false \
  docker compose up -d --wait api
```

### Known race (single product)

Reader A misses and reads the **old** value from MongoDB; writer B updates MongoDB and `DEL`s the
key; A then `SET`s the old value. The cache stays stale until the TTL expires: the TTL bounds the
damage. This is inherent to cache-aside.

## `write-through`

`WriteThroughStrategy` extends `CacheAsideStrategy`: **reads are the same** (lazy loading with a
TTL), only writes change. Instead of deleting the key, a write stores the new value, so the next
read is already a `HIT` with the new version. Write-through alone only defines writes; combined
with lazy loading and a TTL it is the full pattern recommended by AWS: data never written since
the cache started is still loaded on a miss, and keys nobody reads expire by themselves.

### Write order

| # | Step | If it fails |
|---|---|---|
| 1 | Write to MongoDB (source of truth) | error returned to the client; the cache is untouched |
| 2 | `SET product:<id>` with the new value and a fresh TTL | partial failure, see below |
| 3 | `INCR` the list generation (a list page cannot be updated in place) | list pages may be stale until their TTL |

MongoDB comes first: if the cache were written first and the database write failed, readers would
get a value that never existed in the source of truth. `create` also caches the new product
(its first read is a `HIT`); `remove` deletes the key (there is no value to write).

### Partial failure (MongoDB written, `SET` failed)

The old value may still be in Redis. The strategy then tries a `DEL` of the key, so the next read
is a miss that loads the new value from MongoDB, and logs a warning:

```
[write-through] cache SET failed for product 42 (version 7); old value deleted, the next read loads it from the database
```

If the `DEL` also fails (Redis down), the old value can be served **until its TTL expires**; the
write still succeeds. The failed `set` (and `del`) commands appear in `GET /metrics` under
`cache.commands`.

### No atomicity

MongoDB and Redis are two separate systems and the two writes are not a transaction:

- between steps 1 and 2, readers still get the old value (a window of one Redis round trip);
- two concurrent writers A and B can write MongoDB in the order A, B and the cache in the order
  B, A: the cache keeps A's older value until the TTL expires. A conditional `SET` that only
  replaces a lower `version` (Lua script, step 7) would close this gap;
- the read race of cache-aside still exists, since reads are inherited.

Write-through therefore **narrows** the staleness window (to ~0 in the normal case, measured with
`SCRIPT=staleness`), but it does not make database and cache atomic: the TTL remains the safety net.

## Failure behavior

| Situation | Behavior |
|---|---|
| Redis down | reads answer `BYPASS` from MongoDB, without 500 errors or waiting for timeouts; `/health` returns 200 with `status: degraded`; reconnection is automatic |
| MongoDB down | data already in the cache is still served (`HIT`); everything else returns 503 immediately |
| Invalidation fails (Redis down during a write) | the MongoDB write is kept; the cache may serve the old value **until the TTL expires** |
| Write-through `SET` fails | the MongoDB write is kept; the key is deleted if possible, otherwise the old value is served until the TTL expires |

The last row is why the database and the cache are **not atomic**: a write can reach one and not
the other, and when the cache update fails only the TTL repairs it. Short TTLs bound how long this can last.

## Connecting to ElastiCache

Only `.env` changes are needed (see `.env.example`; full AWS setup in [deploy-aws.md](deploy-aws.md)):

- `REDIS_HOST` / `REDIS_PORT`: the ElastiCache endpoint.
- `REDIS_TLS=true`: when in-transit encryption is enabled.
- `REDIS_USERNAME` / `REDIS_PASSWORD`: RBAC user or AUTH token.
- `REDIS_CLUSTER_MODE=true`: for cluster mode enabled or ElastiCache Serverless (not tested yet).

The list generation counter has no TTL. Keep the default `volatile-*` eviction policy so Redis
never evicts it under memory pressure.
