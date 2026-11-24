# AWS measurement environment

- Date (UTC): 2026-11-24
- Region / AZ: us-east-2 / us-east-2a
- API: c7g.large, Node in Docker, MONGODB_MAX_POOL_SIZE=20
- MongoDB: m7g.medium, mongo:8.0 in Docker, EBS gp3 20 GiB
- Load generator: c7g.xlarge, k6 grafana/k6:1.3.0
- ElastiCache: Valkey 9.1, cache.t4g.micro, 1 node, no replicas, cluster mode disabled,
  in-transit encryption on, maxmemory-policy volatile-lru
- Data: 100000 products (seed --count 100000, deterministic, 200-char description,
  35.93 MB, avg 376 bytes/document)
- Load: closed model, no think time; 60s measured after 10s warm-up
  (metrics reset after warm-up); cache flushed (FLUSHDB) before each run
- Key distributions: hotset (80% of reads on the first 20% of ids) and uniform
