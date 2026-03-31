# 라이브 쇼핑 포인트 선착순 지급 시스템

라이브 쇼핑 방송 중 수십만 명이 동시에 포인트를 요청하는 상황을 가정하고, **단계별 아키텍처 개선**이 성능에 어떤 영향을 미치는지 측정하는 백엔드 부하테스트 세미나 프로젝트입니다.

- **비즈니스 규칙**: 선착순 N명에게만 지급, 1인 1회 제한, 즉시 결과 반환, 모든 지급 내역 DB 기록
- **부하테스트 도구**: [k6](https://k6.io/) `constant-arrival-rate` executor
- **테스트 환경**: macOS / Docker Desktop / 단일 머신

참고 자료: https://toss.tech/article/monitoring-traffic

---

## 아키텍처 진화

| Phase | 브랜치 | 핵심 변경 | 해결하려는 문제 |
|-------|--------|----------|--------------|
| **1** | `phase1-baseline` | Spring Boot + MySQL | 베이스라인 측정 |
| **2** | `phase2-redis` | + Redis Lua Script | DB 동시성 한계, 중복 체크 원자화 |
| **3** | `phase3-kafka` | + Kafka 비동기 처리 | DB 동기 쓰기로 인한 응답 지연 |
| **5** | `phase5-scaling` 🚧 | + Nginx + LocalCache | 단일 인스턴스 처리량 한계 |

> Phase 4(Nginx Rate Limit)는 실험 계획에서 제외됨.

---

## 성능 결과 요약

| Phase | 구성 | measure_rps | p95 | 에러 |
|-------|------|-------------|-----|------|
| 1 | Spring + MySQL | 2,118 | 3,139ms | — |
| 2 | + Redis | 6,850 | 1,369ms | — |
| 3 | + Kafka | **11,945** | **136ms** | 0 |
| 3 (13k 초과) | Kafka 포화 | 4,214 | 2,040ms | 188건 timeout |
| 3-partition | 3파티션 + CPU 4 | 11,755 | 129ms | 0 |
| 5-B1 | LocalCache, 1 instance | 6,186 | 3,047ms | — |
| 5-B2 | LocalCache, 3 instances | 2,664 | 6,068ms | ⚠️ 중복 발급 |

> 각 Phase 상세 분석 → [`results/report/`](./results/report/)

---

## 브랜치 구조

```
phase1-baseline        # Spring Boot + MySQL 단순 구현
phase2-redis           # Redis Lua 스크립트로 원자적 선착순 처리
phase3-kafka           # Kafka 비동기 이벤트로 DB 쓰기 분리
phase3-kafka-partition # Kafka 3파티션 + CPU 확장 실험 (현재)
phase5-no-localcache   # Nginx + 수평 스케일링 베이스라인
phase5-scaling         # LocalCache 도입 실험
```

---

## 빠른 시작

```bash
# Phase 3 (가장 안정적인 결과)
git checkout phase3-kafka

docker compose up --build -d

# 부하 테스트
k6 run -e TARGET_RPS=10000 k6/phase3-load-test-local.js

# 데이터 정합성 확인 (consumer lag 소진 후)
docker exec load-test-demo-redis-1 redis-cli GET event:1:count
docker exec load-test-demo-mysql-1 mysql -u root -p1234 -se \
  "SELECT COUNT(*) FROM test_db.point_ledger WHERE event_id='1';"
```

---

## Phase별 상세

### Phase 1 — Spring Boot + MySQL (베이스라인)

동기적 요청 처리. 매 요청마다 DB를 직접 조회/삽입.

**스택**: Spring Boot 4 / MySQL 8 / HikariCP (pool=10)

**핵심 코드 흐름**:
```
POST /events/{id}/points
  → DB: SELECT count (중복 체크)
  → DB: SELECT count (수량 체크)
  → DB: INSERT point_ledger
  → 응답 반환
```

**결과** (10k RPS 목표):

| 지표 | 수치 |
|------|------|
| measure_rps | 2,118 |
| p95 | 3,139ms |

**병목**: DB 커넥션 풀 고갈, 동시성 없는 SELECT→INSERT 사이 race condition

📄 [분석 보고서](./results/report/phase1-pool-size-analysis.md)

---

### Phase 2 — Redis Lua Script 도입

중복 체크 + 수량 체크 + 증가를 Redis Lua로 원자적 처리. DB는 Fallback 전용.

**스택**: + Redis 7

**핵심 코드**:
```lua
-- 원자적 실행 (SISMEMBER → GET → INCR → SADD)
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then return 'DUPLICATE' end
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if count >= tonumber(ARGV[2]) then return 'SOLD_OUT' end
redis.call('INCR', KEYS[1])
redis.call('SADD', KEYS[2], ARGV[1])
return 'SUCCESS'
```

**결과** (10k RPS 목표):

| 지표 | Phase 1 | Phase 2 | 변화 |
|------|---------|---------|------|
| measure_rps | 2,118 | 6,850 | +223% |
| p95 | 3,139ms | 1,369ms | -56% |

**병목**: 성공 응답마다 DB INSERT 동기 처리 → 높은 p95

📄 [분석 보고서](./results/report/phase1-vs-phase2-analysis.md)

---

### Phase 3 — Kafka 비동기 처리

DB INSERT를 Kafka 이벤트로 비동기화. HTTP 스레드는 Redis 처리 후 즉시 반환.

**스택**: + Kafka 3.7 (단일 파티션, concurrency=1)

**핵심 코드 흐름**:
```
POST /events/{id}/points
  → Redis Lua (원자적 선착순 처리)
  → kafkaTemplate.send() [비동기, 즉시 반환]
  → 응답 반환 ← HTTP 스레드 해제

[별도 Consumer 스레드]
  Kafka topic → DB INSERT (point_ledger)
```

**결과** (12k RPS 목표):

| 지표 | Phase 2 | Phase 3 | 변화 |
|------|---------|---------|------|
| measure_rps | 6,850 | **11,945** | +74% |
| p95 | 1,369ms | **136ms** | -90% |
| dropped | 많음 | 3,283 | — |

**처리 한계**: ~12k RPS. 13k 이상부터 Kafka producer buffer 포화 (HTTP 스레드 블로킹)

📄 [분석 보고서](./results/report/phase2-vs-phase3-analysis.md) · [Kafka buffer 진단](./results/report/phase3-kafka-buffer-diagnosis.md)

#### 파티션 실험 (`phase3-kafka-partition`)

> "파티션을 늘리면 더 빠를까?" 에 대한 실증 실험

3 파티션 + consumer concurrency=3 + userId 기반 파티셔닝 도입 시:

| 설정 | measure_rps | 원인 |
|------|-------------|------|
| 단일 파티션 (기준) | 11,945 | — |
| 3파티션 + CPU=2 | 3,947 (-67%) | API 컨테이너 CPU 포화 |
| 3파티션 + CPU=4 | **11,755** | CPU 확장 후 회복 |

**진단 방법**: JFR(Java Flight Recorder) 프로파일링으로 스레드별 CPU 점유 확인
- consumer 3개 스레드가 HTTP 스레드와 CPU 경합 → API 컨테이너 CPU 2 → 4로 확장 필요

📄 [파티션 실험 보고서](./results/report/phase3-partition-analysis.md)

---

### Phase 5 — Nginx + LocalCache + 수평 스케일링 🚧 WIP

단일 인스턴스 한계를 수평 확장으로 극복. LocalCache로 Redis 호출 빈도 감소 시도.

**스택**: + Nginx 1.27 (로드밸런서) + 인스턴스별 LocalPointCache (`@Scheduled` 1초 flush)

**테스트 시나리오**:

```
A 시리즈 (no-localcache): 기존 구조로 인스턴스만 증가
B 시리즈 (localcache):    LocalCache 도입 후 인스턴스 증가
```

**관측 결과** (12k RPS 목표):

| 시나리오 | 인스턴스 | measure_rps | p95 | claims | 정합성 |
|----------|----------|-------------|-----|--------|--------|
| A1 (no-cache) | 1 | 5,067 | 3,030ms | 100,000 | ✅ |
| A2 (no-cache) | 2 | 4,380 | 4,136ms | 100,000 | ✅ |
| A3 (no-cache) | 3 | 3,193 | 6,314ms | 100,000 | ✅ |
| B1 (localcache) | 1 | 6,186 | 3,047ms | 100,000 | ✅ |
| B2 (localcache) | 3 | 2,664 | 6,068ms | **103,160** | ⚠️ |
| B3 (localcache, 24k) | 3 | 1,015 | 10,246ms | **112,284** | ⚠️ |

#### 발견된 병목

**1. LocalCache 크로스 인스턴스 불일치**

```
인스턴스 A: 로컬 카운터 = 32,000 → "아직 여유 있음" → 포인트 지급
인스턴스 B: 로컬 카운터 = 34,000 → "아직 여유 있음" → 포인트 지급
인스턴스 C: 로컬 카운터 = 35,000 → "아직 여유 있음" → 포인트 지급

합산 실제 지급 = 101,000 (한도 초과)
↑ 1초 flush 지연 동안 각 인스턴스가 서로의 지급 현황을 모름
```

**2. Kafka 단일 파티션 한계**

Consumer group에서 active consumer = 파티션 수. 파티션이 1개이면 인스턴스를 늘려도 소비 처리량이 증가하지 않음 → 오히려 인스턴스 증가 시 Kafka 생산 속도만 빨라져 consumer lag 증가.

**다음 과제**: LocalCache flush 전 Redis에서 남은 수량을 확인하거나, 인스턴스 간 카운터를 Redis로 글로벌하게 관리하는 방식으로 중복 발급 해소 필요.

📄 [no-localcache 분석](./results/report/phase5-1-no-localcache-analysis.md) · [localcache 분석](./results/report/phase5-2-localcache-analysis.md)

---

## 부하 테스트 실행

### 환경 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `TARGET_RPS` | 스크립트마다 다름 | 목표 RPS |
| `DURATION` | `60s` | measure 구간 길이 |
| `BASE_URL` | `http://localhost:8080` | API 서버 주소 |
| `EVENT_ID` | `1` | 테스트할 이벤트 ID |

### 실행

```bash
# Phase 3 — 단일 파티션
k6 run -e TARGET_RPS=10000 k6/phase3-load-test-local.js
k6 run -e TARGET_RPS=12000 k6/phase3-load-test-local.js

# Phase 3 — 파티션 실험
k6 run -e TARGET_RPS=12000 k6/phase3-partition-load-test-local.js
k6 run -e TARGET_RPS=14000 k6/phase3-partition-load-test-local.js
```

### 결과 파일

```
results/
├── html/phase3/          # 그래프 포함 HTML 리포트
├── json/phase3/          # 원본 메트릭 JSON
└── report/               # 분석 보고서 (Markdown)
```

### 테스트 전 데이터 초기화

```bash
docker exec load-test-demo-redis-1 redis-cli FLUSHALL
docker exec load-test-demo-mysql-1 mysql -u root -p1234 -e \
  "TRUNCATE TABLE test_db.point_ledger;"
```

---

## API

```
POST /events/{eventId}/points
Content-Type: application/json

{"userId": "user-12345"}
```

| 상태코드 | 의미 |
|----------|------|
| 200 | 포인트 지급 성공 |
| 409 | 이미 받은 사용자 (중복) |
| 410 | 선착순 마감 (SOLD_OUT) |
| 503 | Redis 장애 → DB 폴백 처리 중 |

---

## 기술 스택

| 분류 | 기술 |
|------|------|
| 언어 / 프레임워크 | Java 17 · Spring Boot 4.0.5 |
| 데이터베이스 | MySQL 8.4 · Spring Data JPA · HikariCP |
| 캐시 | Redis 7 · Lettuce · Lua Script |
| 메시지 큐 | Apache Kafka 3.7 · Spring Kafka |
| 로드밸런서 | Nginx 1.27 (Phase 5) |
| 부하 테스트 | k6 |
| 모니터링 | Micrometer · Prometheus · Grafana (선택) |
| 인프라 | Docker Compose |
