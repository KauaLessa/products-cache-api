# Products API — Distributed cache with Amazon ElastiCache

A products REST API used to **implement, measure and compare distributed caching strategies**
(cache-aside and write-through) with Redis / Amazon ElastiCache, with MongoDB as the source of truth.
The caching strategy is chosen at startup by an environment variable, so load tests compare
strategies under identical conditions.

```
Clients / load generator → API (Express) → Redis / ElastiCache → MongoDB (source of truth)
```

## Quick start

Requires Docker with Compose v2.

```bash
git clone https://github.com/KauaLessa/products-cache-api.git && cd products-cache-api
cp .env.example .env
docker compose up -d --build --wait                              # API + MongoDB + Redis
docker compose exec -T api node scripts/seed.js --count 10000    # sample data
curl -s localhost:3000/health
```

Expected: `{"status":"ok","services":{"mongo":"up","redis":"disabled"}}`
(`redis` is `disabled` with the default `none` strategy).

Stop with `docker compose down`. **Never add `-v`**: it deletes the MongoDB data volume.

To run the API on your machine instead (auto-reload): `npm install`,
`docker compose up -d --wait mongo redis`, then `npm run dev`.

## Caching strategies

| `CACHE_STRATEGY` | Reads | Writes | Status |
|---|---|---|---|
| `none` (default) | always MongoDB | MongoDB | ✅ baseline |
| `cache-aside` | Redis first; on a miss, load from MongoDB and store with a TTL | MongoDB, then invalidate the cache | ✅ |
| `write-through` | same as cache-aside | MongoDB and cache updated together | 🔴 planned |

Switch strategies by recreating only the API:

```bash
CACHE_STRATEGY=cache-aside docker compose up -d --wait api
CACHE_STRATEGY=cache-aside CACHE_TTL_SECONDS=10 CACHE_INVALIDATE_ON_WRITE=false \
  docker compose up -d --wait api    # no invalidation: observe stale reads until the TTL
```

Every read returns an `X-Cache` header: `HIT` (from Redis), `MISS` (loaded from MongoDB and cached)
or `BYPASS` (cache not used: `none` strategy or Redis down). If Redis is down, the API keeps
answering from MongoDB.

How each strategy works, list caching and failure behavior: [docs/caching-strategies.md](docs/caching-strategies.md).

## API

| Method | Route | Description |
|---|---|---|
| `GET` | `/health` | API and dependency status (503 if MongoDB is down) |
| `GET` | `/products?page=1&limit=20` | Paginated list (`limit` ≤ 100) |
| `GET` | `/products/:id` | One product |
| `POST` | `/products` | Create (`name`, `category`, `price`, `stock`; optional `description`) |
| `PUT` | `/products/:id` | Partial update; increments `version` |
| `DELETE` | `/products/:id` | Delete |

`productId` (sequential 1..N) and `version` are managed by the API; unknown fields return 400.
`version` makes stale cache entries visible: compare it with the value in the database.

```bash
curl -s -i localhost:3000/products/1 | grep -i x-cache    # MISS (with a caching strategy)
curl -s -i localhost:3000/products/1 | grep -i x-cache    # HIT
curl -s -X PUT localhost:3000/products/1 -H 'content-type: application/json' -d '{"price": 15}'
```

## Seed

```bash
docker compose exec -T api node scripts/seed.js --count 50000   # default: 10000
npm run seed -- --count 50000                                   # outside Docker
```

- **Deterministic:** the same count always produces the same products, so load test runs are comparable.
- **Replaces** all products in the configured database; new products continue from N + 1.
- Does **not** clear Redis: after re-seeding, run `docker compose exec -T redis redis-cli FLUSHDB`.

## Configuration

All settings are environment variables, documented in [`.env.example`](.env.example) and validated
at startup (invalid values stop the API with a clear message). The most used:

| Variable | Default | Purpose |
|---|---|---|
| `CACHE_STRATEGY` | `none` | `none` \| `cache-aside` \| `write-through` |
| `CACHE_TTL_SECONDS` | `60` | TTL of cache entries |
| `CACHE_INVALIDATE_ON_WRITE` | `true` | `false` skips invalidation (demonstrates stale data) |
| `REDIS_HOST`, `REDIS_TLS`, `REDIS_CLUSTER_MODE`, `REDIS_PASSWORD` | local Redis | point the API to ElastiCache, `.env` changes only |

## Status

| # | Specification item | Status |
|---|---|---|
| 1 | API + database with reads and updates; no-cache baseline | ✅ |
| 2 | Cache-aside with explicit key and TTL; measure hits, misses, latency, load on the source | 🟡 implemented; metrics next |
| 3 | Write-through; write order and behavior when the cache update fails | 🔴 |
| 4 | Demonstrate invalidation/expiration and the staleness window | 🟡 building blocks ready |
| 5 | Load tests with and without cache, scaling clients; percentiles, throughput, hit rate, costs | 🔴 |
