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
| `write-through` | same as cache-aside | MongoDB, then `SET` the new value in the cache (`DEL` if the `SET` fails) | ✅ |

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
| `CACHE_INVALIDATE_ON_WRITE` | `true` | cache-aside only: `false` skips invalidation (demonstrates stale data) |
| `REDIS_HOST`, `REDIS_TLS`, `REDIS_CLUSTER_MODE`, `REDIS_PASSWORD` | local Redis | point the API to ElastiCache, `.env` changes only |

## Load testing

[k6](https://k6.io) scripts in [`loadtest/`](loadtest), run from the official Docker image (nothing to install).
The script only sends HTTP requests, so the same command works locally and on AWS: only `API_URL` changes.

```bash
loadtest/run.sh                                         # 10 clients, 60 s, 80/20 distribution
VUS_LIST="10 50 100" DIST="hotset uniform" loadtest/run.sh   # one run per distribution and number of clients
SCRIPT=staleness ITERATIONS=5 loadtest/run.sh                  # staleness window after writes
loadtest/invalidation-demo.sh                                  # read / write / read transcript (invalidation example)
```

Two scripts (`SCRIPT=...`):

- `read` (default, [`read.js`](loadtest/read.js)): read load with a known key distribution; latency per `X-Cache`, throughput, hit rate.
- `staleness` ([`staleness.js`](loadtest/staleness.js)): one sequential client writes a product (`PUT`) and then reads it
  until the new `version` comes back. Reports `stale_after_write` (share of writes whose first read was stale) and
  `staleness_window` (time until the new version is served). Compare `CACHE_INVALIDATE_ON_WRITE=true` (window ~0) with
  `false` (window ~TTL); use a short `CACHE_TTL_SECONDS` (e.g. 5). It changes products: use a test database.

| Variable | Default | Purpose |
|---|---|---|
| `API_URL` | `http://localhost:3000` | API under test |
| `PRODUCTS` | `10000` | must match the seed count (ids `1..N`) |
| `VUS_LIST` | `10` | concurrent clients, one run per value |
| `DURATION` | `60s` | measured phase |
| `WARMUP_SECONDS` | `10` | warm-up before `POST /metrics/reset` (`0` = cold cache) |
| `DIST` | `hotset` | `hotset`: 80% of reads go to the first 20% of ids; `uniform`: any id; several values = one run each |
| `ITERATIONS` | `5` | `staleness`: writes to measure |
| `POLL_MS` | `100` | `staleness`: pause between reads after a write (window precision) |
| `MAX_WAIT_SECONDS` | `120` | `staleness`: give up waiting for the new version |
| `REDIS_URL` | `redis://localhost:6379` | cache emptied (`FLUSHDB`) before each run; `rediss://...` for ElastiCache with TLS; empty = no flush |
| `RESULTS` | `results` | output folder inside `loadtest/` (e.g. `results-aws`, to keep AWS and local runs apart) |

The variables can also be kept in `loadtest/aws.env` (copy [`aws.env.example`](loadtest/aws.env.example); not versioned),
read by `run.sh` and `invalidation-demo.sh`; a variable on the command line wins over the file.

### Charts

```bash
loadtest/plot.sh                # tables and charts from loadtest/results/ into loadtest/results/charts/
```

[`plot.py`](loadtest/plot.py) (Python + matplotlib, run in Docker by `plot.sh`) reads every result pair and writes
`read-runs.csv` / `staleness-runs.csv` (one row per run) and, per key distribution, line charts of latency (p50, p95),
throughput, MongoDB queries per read and hit rate against the number of clients (one line per strategy), plus a
staleness bar chart. When a configuration ran more than once, the latest run is used.

Each run writes to `loadtest/results/` (not versioned): `<name>-k6.json` (client view: k6 summary) and
`<name>-api.json` (`GET /metrics`: cache settings, hits, misses, load on MongoDB). Names start with the
strategy, plus `-noinvalidate` for cache-aside with `CACHE_INVALIDATE_ON_WRITE=false`.

## Deploy on AWS

Step-by-step guide (in Portuguese) to build the measurement environment (VPC, security groups, EC2 for
the API, MongoDB and load generator, ElastiCache) and run every test scenario:
[docs/deploy-aws.md](docs/deploy-aws.md). On the API EC2, `scripts/api-config.sh <strategy> [ttl] [invalidate]`
switches the cache configuration and restarts the API.

## Status

| # | Specification item | Status |
|---|---|---|
| 1 | API + database with reads and updates; no-cache baseline | ✅ |
| 2 | Cache-aside with explicit key and TTL; measure hits, misses, latency, load on the source | 🟡 implemented, metrics and load generator ready; AWS measurements pending |
| 3 | Write-through; write order and behavior when the cache update fails | 🟡 implemented (see [design notes](docs/caching-strategies.md#write-through)); AWS measurements pending |
| 4 | Demonstrate invalidation/expiration and the staleness window | 🟡 building blocks ready |
| 5 | Load tests with and without cache, scaling clients; percentiles, throughput, hit rate, costs | 🔴 |
