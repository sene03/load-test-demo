# SRS — Live Shopping Point Claim System

**Version 2.0 | March 2026**

---

## 1. Purpose

Incrementally build a point claim system for a live shopping broadcast scenario. Each phase introduces one infrastructure component, followed by load testing to measure its impact on performance.

---

## 2. Business Rules

- **BR-1:** A user must not receive points more than once per event.
- **BR-2:** The user must immediately know whether they received points.
- **BR-3:** Every granted point must be recorded in the point ledger database.
- **BR-4:** Only the first N users receive points. Latecomers must be rejected.

---

## 3. Test Environment (Fixed Across All Phases)

| Parameter | Value |
|-----------|-------|
| Docker CPU limit | TBD (fixed once determined) |
| Docker memory limit | TBD (fixed once determined) |
| JVM heap (-Xmx) | TBD (fixed once determined) |
| OS | macOS |
| Docker Desktop version | 29.2.1 |
| Load test tool | k6 (`constant-arrival-rate` executor) |

> All values are determined before Phase 1 testing begins and held constant through Phase 5.

---

## 4. Phases

**각 phase는 branch로 분리됨. 
- phase1-baseline
- phase2-redis
- phase3-kafka
- phase4-nginx
- phase5-scaling


### Phase 1: Spring Boot + MySQL (Baseline)

**Goal:** Establish baseline performance with a pure MVC synchronous architecture.

#### 4.1.1 Functional Requirements

- **F-1.1:** `POST /api/v1/events/{eventId}/points` accepts `{ "userId": "string" }`.
- **F-1.2:** The API checks the DB for duplicate claims (`user_id`). If duplicate → return `409 DUPLICATE`.
- **F-1.3:** The API reads the current claim count from DB. If count ≥ N → return `410 SOLD_OUT`.
- **F-1.4:** On success, the API inserts a record into the `point_ledger` table and returns `200 SUCCESS`.
- **F-1.5:** All operations (duplicate check, count check, insert) execute within a single DB transaction.

#### 4.1.2 Tuning Variables

| Variable | Start Value | Adjust By |
|----------|-------------|-----------|
| `server.tomcat.threads.max` | 10 | Increase to 20, 50, 100, 200 |
| `spring.datasource.hikari.maximum-pool-size` | 5 | Increase to 10, 20 |

#### 4.1.3 Load Test Plan

- **LT-1.1:** Start k6 at 50 RPS. Increase by 50 RPS increments.
- **LT-1.2:** For each RPS level, record: p95 latency, error rate, DB CPU usage, DB active connections.
- **LT-1.3:** Identify the saturation point (p95 > 300ms or error rate > 1%).
- **LT-1.4:** Repeat LT-1.1 ~ LT-1.3 for each thread/pool combination.

#### 4.1.4 Expected Observation

Single-threaded DB transactions become the bottleneck. Increasing threads without increasing connection pool has no effect. Connection pool exhaustion causes request queuing.

---

### Phase 2: Redis

**Goal:** Move duplicate check and first-come judgment off the DB and onto Redis. Measure DB load reduction.

#### 4.2.1 Functional Requirements

- **F-2.1:** A Redis Lua script executes atomically: duplicate check → count check → count increment → user key set.
- **F-2.2:** Lua script returns one of: `SUCCESS`, `DUPLICATE`, `SOLD_OUT`.
- **F-2.3:** On `SUCCESS`, the API writes the ledger record to DB synchronously, then returns `200`.
- **F-2.4:** On Redis connection failure, the API returns `503 SERVICE_UNAVAILABLE`. No DB fallback is attempted.

#### 4.2.2 Tuning Variables

Same as Phase 1. Redis is added as a fixed component, not a tuning target.

#### 4.2.3 Load Test Plan

- **LT-2.1:** Run the same RPS levels as Phase 1 saturation tests.
- **LT-2.2:** Record: p95 latency, error rate, DB CPU usage, DB active connections, Redis ops/sec.
- **LT-2.3:** Compare against Phase 1 results at identical RPS and thread/pool settings.

#### 4.2.4 Expected Observation

p95 improves because duplicate/count checks no longer hit DB. DB CPU and connection usage drops significantly. However, the synchronous DB write for ledger recording still limits throughput.


추가할것
@Async + CompletableFuture로 DB write를 별도 스레드로 던지기
이거 했을때 병목이 얼마나 해결되는지? 보기


---

### Phase 3: Kafka

**Goal:** Remove the DB from the response path entirely by deferring ledger writes to an async consumer.

#### 4.3.1 Functional Requirements

- **F-3.1:** On Redis `SUCCESS`, the API publishes a `PointEvent` message to Kafka topic `point-events` and immediately returns `200`.
- **F-3.2:** The API does not wait for DB write before responding.
- **F-3.3:** A Kafka consumer reads from `point-events` and inserts records into `point_ledger`.
- **F-3.4:** The consumer uses `INSERT IGNORE` (or equivalent) with `{user_id, event_id}` unique key for idempotency.
- **F-3.5:** On Kafka produce failure, the API logs the failed event to a local fallback store and still returns `200` to the user.
- **F-3.6:** A reconciliation batch compares Redis granted keys against DB ledger records and re-publishes any missing events.

#### 4.3.2 Tuning Variables

Same as Phase 1–2. Kafka is added as a fixed component.

#### 4.3.3 Load Test Plan

- **LT-3.1:** Run the same RPS levels as Phase 2 saturation tests.
- **LT-3.2:** Record: p95 latency, error rate, Kafka produce latency, consumer lag, DB write throughput.
- **LT-3.3:** Compare against Phase 2 results at identical settings.
- **LT-3.4:** After load test, verify ledger record count matches Redis granted count (data consistency check).

#### 4.3.4 Expected Observation

p95 drops significantly because DB write is removed from the response path. Throughput ceiling increases. Consumer lag may grow during peak but catches up after.

---

### Phase 4: Nginx

**Goal:** Introduce a reverse proxy as the single entry point. Add rate limiting. Prepare for multi-instance scaling in Phase 5.

#### 4.4.1 Functional Requirements

- **F-4.1:** Nginx listens on port 80 and proxies to the API server(s).
- **F-4.2:** Nginx distributes requests using round-robin.
- **F-4.3:** Nginx enforces per-IP rate limiting (configurable, e.g., 1 request/second per IP with burst allowance).
- **F-4.4:** Requests exceeding the rate limit receive `429 Too Many Requests`.
- **F-4.5:** Nginx health check: mark backend as down after 3 consecutive failures, re-check after 10 seconds.

#### 4.4.2 Tuning Variables

Same as Phase 1–3 for the API server. Nginx rate limit parameters are additional variables.

| Variable | Start Value |
|----------|-------------|
| `limit_req rate` | 1r/s |
| `burst` | 5 |

#### 4.4.3 Load Test Plan

- **LT-4.1:** Run load test with rate limiting enabled. Record 429 response count.
- **LT-4.2:** Run same load test with rate limiting disabled. Compare p95 and error rates.
- **LT-4.3:** Verify that Nginx overhead (proxy latency) does not significantly increase p95 compared to Phase 3.

#### 4.4.4 Expected Observation

With rate limiting, the API server receives a controlled flow of requests — fewer 503s, more 429s at the Nginx level. Without rate limiting, results should be similar to Phase 3 plus minor proxy overhead.

---

### Phase 5: Server Scaling

**Goal:** Demonstrate horizontal scaling. Show that adding instances linearly increases throughput.

#### 4.5.1 Functional Requirements

- **F-5.1:** `docker compose up --scale api=N` launches N API server instances behind Nginx.
- **F-5.2:** All instances share the same Redis, Kafka, and MySQL. No configuration change required per instance.
- **F-5.3:** Nginx automatically detects new instances via Docker DNS and distributes traffic.
- **F-5.4:** A shell script monitors average CPU usage of API containers via `docker stats`.
- **F-5.5:** When average CPU exceeds the scale-out threshold, the script executes `docker compose up --scale api=N+1`.
- **F-5.6:** When average CPU drops below the scale-in threshold, the script executes `docker compose up --scale api=N-1`.
- **F-5.7:** The script enforces a cooldown period between scaling actions.

#### 4.5.2 Scaling Parameters

| Parameter | Value |
|-----------|-------|
| Scale-out threshold | TBD (start with 60% CPU) |
| Scale-in threshold | TBD (start with 20% CPU) |
| Min instances | 1 |
| Max instances | TBD (start with 5) |
| Check interval | TBD (start with 5s) |
| Cooldown | TBD (start with 15s) |

#### 4.5.3 Load Test Plan

- **LT-5.1:** Run at Phase 3 saturation RPS with 1 instance. Record p95 and error rate (should degrade).
- **LT-5.2:** Manually scale to 3 instances. Run same RPS. Record p95 and error rate (should recover).
- **LT-5.3:** Scale back to 1 instance. Start auto-scaling script. Gradually increase RPS from low to above saturation. Verify that the script adds instances and p95 recovers without manual intervention.
- **LT-5.4:** Decrease RPS to near zero. Verify that the script removes instances.

#### 4.5.4 Expected Observation

Manual scale-out: p95 recovers proportionally to instance count. Auto-scale: after detection delay + container startup time, p95 recovers. The audience sees real-time scaling.

---

## 5. API Specification

### 5.1 Endpoint

`POST /api/v1/events/{eventId}/points`

### 5.2 Request

```json
{
  "userId": "string"
}
```

### 5.3 Response Codes

| HTTP | Code | Description | Introduced |
|------|------|-------------|------------|
| 200 | SUCCESS | Points granted | Phase 1 |
| 409 | DUPLICATE | Already claimed | Phase 1 |
| 410 | SOLD_OUT | First N slots exhausted | Phase 1 |
| 429 | TOO_MANY_REQUESTS | Rate limit exceeded | Phase 4 |
| 503 | SERVICE_UNAVAILABLE | Infrastructure failure | Phase 2 |

---

## 6. Failure Handling

| Scenario | Impact | Response |
|----------|--------|----------|
| Redis down | Cannot judge claims | Return 503. No DB fallback. |
| Redis recovery | State may be lost | Warm-up script reloads granted users and count from DB. |
| Kafka produce failure | Ledger not recorded | Log to local fallback store. Reconciliation batch re-publishes. |
| Kafka consumer failure | Ledger write delayed | Kafka retains messages. Consumer resumes on restart. Idempotent insert prevents duplicates. |
| DB down | Ledger write fails | Consumer retries with backoff. After max retries → Dead Letter Topic. Process after DB recovery. |
| API server crash | Partial request failure | Nginx health check excludes server. Remaining instances handle traffic. Auto-scale replaces if needed. |
| Traffic exceeds capacity | Latency spike, 503 errors | Nginx rate limiting (Layer 1) → Tomcat fast-fail via limited accept-count (Layer 2) → Redis SOLD_OUT short-circuits post-quota traffic (Layer 3). |

---

## 7. Data Consistency

- **DC-1:** Redis granted count and DB ledger row count must match after all consumers finish processing.
- **DC-2:** After each load test, run a consistency check query comparing Redis keys against DB records.
- **DC-3:** Any mismatch is logged and resolved via the reconciliation batch (F-3.6).

---

## 8. Deliverables Per Phase

Each phase produces:

1. Configuration diff (what changed from the previous phase).
2. k6 test script for that phase.
3. Load test result summary: p95, avg latency, max latency, error rate, throughput (RPS).
4. Comparison table against all previous phases at the same RPS level.

---

## 9. Monitoring & Bottleneck Analysis

### 9.1 Required Dependencies

- `spring-boot-starter-actuator`
- `micrometer-registry-prometheus` (optional, for Grafana dashboard)

### 9.2 Actuator Endpoints

| Endpoint | What It Reveals | When to Check |
|----------|----------------|---------------|
| `/actuator/metrics/tomcat.threads.busy` | Active thread count | Thread pool saturation |
| `/actuator/metrics/tomcat.threads.current` | Total created threads | Thread creation behavior |
| `/actuator/metrics/hikaricp.connections.active` | Active DB connections | Connection pool saturation |
| `/actuator/metrics/hikaricp.connections.pending` | Threads waiting for a connection | Connection pool bottleneck (> 0 means pool is insufficient) |
| `/actuator/metrics/http.server.requests` | Per-endpoint latency, count, errors | API-level performance |
| `/actuator/threaddump` | Per-thread stack trace and state | Identifying what blocked threads are waiting on |

### 9.3 Infrastructure Monitoring

| Tool | Command / Method | What It Reveals |
|------|-----------------|----------------|
| `docker stats` | `docker stats --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"` | Per-container CPU and memory usage |
| MySQL | `SHOW PROCESSLIST;` | Currently executing queries and connection states |
| Redis | `redis-cli INFO stats` | ops/sec, connected clients, memory usage |
| Kafka | Consumer group lag via `kafka-consumer-groups.sh --describe` | How far behind the consumer is from the latest offset |

### 9.4 Bottleneck Diagnosis Flow

For each load test, follow this sequence when p95 exceeds the 300ms target:

1. Check `docker stats` → Is API container CPU near its limit? If yes → CPU bottleneck.
2. Check `tomcat.threads.busy` → Is it equal to `threads.max`? If yes → thread pool saturated. Continue to step 3.
3. Check `/actuator/threaddump` → What state are the busy threads in?
   - Waiting at `HikariPool.getConnection` → connection pool bottleneck.
   - Waiting at Redis call → Redis bottleneck.
   - Waiting at Kafka produce → Kafka bottleneck.
   - Executing DB query → query/DB performance bottleneck.
4. Check `hikaricp.connections.pending` → Is it > 0? If yes → connection pool size is insufficient for the current thread count.
5. Check `SHOW PROCESSLIST` → Are queries slow or locking? If yes → DB-level optimization needed.

### 9.5 Metrics to Record Per Phase

Every load test execution must record the following:

| Category | Metrics |
|----------|---------|
| k6 output | p95, p99, avg latency, max latency, total requests, actual RPS, error rate |
| Tomcat | `threads.busy` (peak), `threads.current` (peak) |
| HikariCP | `connections.active` (peak), `connections.pending` (peak) |
| Docker | API container CPU % (peak), memory usage (peak) |
| Redis (Phase 2+) | ops/sec (peak), connected clients |
| Kafka (Phase 3+) | produce latency (avg), consumer lag (max) |
| MySQL | active connections (peak), slow query count |

### 9.6 Grafana Dashboard (Optional)

If time permits, connect Prometheus + Grafana for real-time visualization during load tests.

| Component | Setup |
|-----------|-------|
| Prometheus | Scrapes `/actuator/prometheus` endpoint every 5s |
| Grafana | Pre-built dashboards: Spring Boot Statistics, HikariCP, Docker |

This is optional. All required metrics can be collected via Actuator endpoints and `docker stats` without Grafana.