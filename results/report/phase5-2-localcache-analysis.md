# Phase 5 (LocalCache 도입 후) 분석 리포트
## A1~A3 vs B1~B3 전체 비교

- 브랜치: `phase5-scaling` (LocalCache 포함)
- 테스트 일시: 2026-03-30 11:20 ~ 11:24
- 구성: Kafka + Redis Lua + Nginx + **LocalPointCache** (@Scheduled flush=1s)

---

## B 시리즈 결과 원본

### B1 — LocalCache, api=1, RPS=12,000

| 항목 | 값 |
|------|-----|
| measure RPS | **6,186** |
| Total Requests | 407,136 |
| Dropped | 348,655 |
| avg latency | 831ms |
| median | 101ms |
| p90 | 2,634ms |
| p95 | **3,047ms** |
| 서버 에러 | **30,151건 (7.4%)** |
| timeout | 413건 (0.1%) |
| max VUs | 5,450 (상한 도달) |
| success (claims) | **100,000** (sold-out 정상) |

### B2 — LocalCache, api=3, RPS=12,000

| 항목 | 값 |
|------|-----|
| measure RPS | **2,664** |
| Total Requests | 195,848 |
| Dropped | 535,162 |
| avg latency | 1,795ms |
| median | 1,188ms |
| p90 | 4,521ms |
| p95 | **6,068ms** |
| 서버 에러 | **4,778건 (2.4%)** |
| timeout | 793건 (0.4%) |
| max VUs | 5,450 (상한 도달) |
| success (claims) | **103,160** ⚠️ 초과 발급 3,160건 |

### B3 — LocalCache, api=3, RPS=24,000

| 항목 | 값 |
|------|-----|
| measure RPS | **1,015** |
| Total Requests | 132,913 |
| Dropped | 517,274 |
| avg latency | 3,595ms |
| median | 2,388ms |
| p90 | 9,263ms |
| p95 | **10,246ms** |
| 서버 에러 | **4,585건 (3.4%)** |
| timeout | 5,114건 (3.8%) |
| max VUs | 9,377 |
| success (claims) | **112,284** ⚠️ 초과 발급 12,284건 |

---

## A vs B 전체 비교표 (목표 RPS 12,000 기준)

| 구성 | measure RPS | p95 | 에러율 | Dropped | 초과 발급 |
|------|------------|-----|--------|---------|---------|
| Phase 3 (직접, 1인스턴스) | **11,945** | 136ms | 0% | 3,283 | 0 |
| A1 (No Cache, 1인스턴스) | 5,067 | 3,030ms | 13.2% | 415,956 | 0 |
| **B1 (Cache, 1인스턴스)** | **6,186** | 3,047ms | **7.5%** | 348,655 | 0 |
| A2 (No Cache, 2인스턴스) | 4,380 | 4,136ms | 0.59% | 457,201 | 0 |
| A3 (No Cache, 3인스턴스) | 3,193 | 6,314ms | 0.36% | 528,429 | 0 |
| **B2 (Cache, 3인스턴스)** | **2,664** | 6,068ms | **2.84%** | 535,162 | **3,160** |

---

## 분석 1 — LocalCache의 단독 효과: A1 vs B1

동일 조건(1인스턴스, 12k RPS, Nginx)에서 LocalCache 유무만 다르다.

| 항목 | A1 (No Cache) | B1 (Cache) | 변화 |
|------|--------------|------------|------|
| measure RPS | 5,067 | **6,186** | **+22%** |
| median | 195ms | **101ms** | **-48%** |
| p95 | 3,030ms | 3,047ms | ≈ 동일 |
| 에러율 | 13.2% | **7.5%** | **-43%** |
| Dropped | 415,956 | **348,655** | **-16%** |

**LocalCache 효과 확인:**
- median이 195ms → 101ms로 절반 감소: sold-out/duplicate 판정이 JVM 로컬에서 수μs로 처리됨
- 에러율 13.2% → 7.5%: api로 향하는 실제 요청 수가 줄어 nginx connect timeout(3s) 발생 빈도 감소
- measure RPS +22%: 빠른 로컬 반환으로 VU 회전 속도 향상

**p95는 왜 동일한가?**

```
B1 latency 분포:
  빠른 경로: LocalCache hit (sold-out/dup) → ~수μs 반환
  느린 경로: Cache miss → Redis → Kafka → 정상 응답 (SUCCESS 구간)
  꼬리:      nginx connect timeout(3s) → 502 → p95=3,047ms

A1 latency 분포:
  모든 경로: Redis Lua → Kafka → 정상 응답
  꼬리:      nginx connect timeout(3s) → 502 → p95=3,030ms
```

p95를 결정하는 꼬리 레이턴시는 nginx `proxy_connect_timeout=3s`로 동일하게 바운드된다.
LocalCache는 중간 레이턴시(median)를 줄이지만, 꼬리는 nginx 타임아웃에 의해 cap된다.

---

## 분석 2 — LocalCache + 스케일링 역효과: B1 vs B2

같은 LocalCache 브랜치에서 인스턴스를 1 → 3으로 늘렸다.

| 항목 | B1 (Cache, 1인스턴스) | B2 (Cache, 3인스턴스) | 변화 |
|------|---------------------|---------------------|------|
| measure RPS | **6,186** | 2,664 | **-57%** |
| median | 101ms | 1,188ms | **+1,077%** |
| p95 | 3,047ms | 6,068ms | +99% |
| 에러율 | 7.5% | 2.84% | -62% |
| 초과 발급 | **0** | **3,160건** | ⚠️ |

인스턴스를 3배로 늘렸더니 처리량이 57% 감소했다. LocalCache + 다중 인스턴스가 오히려 역효과를 낸다.

### 원인 1: LocalCache 1초 동기화 지연 — Kafka 과부하 유발

```
@Scheduled(fixedDelay = 1000)  ← 1초마다 flush

1초 동기화 간격 동안:
  api-1의 LocalCache: localCount=X, soldOut=false
  api-2의 LocalCache: localCount=Y, soldOut=false
  api-3의 LocalCache: localCount=Z, soldOut=false

글로벌 실제 count = X + Y + Z ≥ maxClaims (100,000) → 이미 sold-out
그러나 각 인스턴스는 다음 flush 때까지 이를 모름

결과:
  1초간 3개 인스턴스 모두 SUCCESS 응답 → 3개 모두 Kafka publish
  Kafka 브로커에 ~(4,000 × 3) = 12,000/s SUCCESS 이벤트 폭주
  → 브로커 포화 → max.block.ms=0 → 즉시 예외 → 500 에러
```

B1에서는 1개 인스턴스만 flush하므로 Kafka 부하가 예측 가능하지만, B2에서는 3개가 동시에 폭발적으로 발행한다.

### 원인 2: sold-out 전파 지연 → 크로스 인스턴스 중복 발급

```
B2 success (claims) = 103,160  (maxClaims=100,000 초과 3,160건)

flush 흐름:
  api-1 flush: Redis INCRBY 33,000 → globalCount=33,000
  api-2 flush: Redis INCRBY 35,000 → globalCount=68,000
  api-3 flush: Redis INCRBY 40,000 → globalCount=108,000 ← 초과!

각 인스턴스가 flush 시점에 globalCount를 체크하지만
flush 전 이미 SUCCESS를 발급한 요청은 취소 불가
```

B3에서는 12,284건 초과 발급. RPS가 높을수록 1초 동기화 간격에서 더 많은 요청이 처리되므로 초과 발급이 선형 이상으로 증가한다.

### 원인 3: flush 시 Redis 동시 접근 경합

```
@Scheduled flush (매 1초):
  api-1: SADD event:1:users {userId1, userId2, ...} → INCRBY event:1:count 33000
  api-2: SADD event:1:users {userId3, userId4, ...} → INCRBY event:1:count 35000
  api-3: SADD event:1:users {userId5, userId6, ...} → INCRBY event:1:count 40000

3개 인스턴스가 같은 1초 내에 Redis에 대용량 SADD + INCRBY 동시 실행
→ Redis 단일 스레드에서 직렬 처리 → flush 지연 → 다음 1초 flush와 겹침
```

---

## 분석 3 — B2 vs A3: 같은 3인스턴스인데 LocalCache가 오히려 느린 이유

| 항목 | A3 (No Cache, 3인스턴스) | B2 (Cache, 3인스턴스) |
|------|------------------------|---------------------|
| measure RPS | **3,193** | 2,664 |
| median | **113ms** | 1,188ms |
| p95 | 6,314ms | **6,068ms** |
| 초과 발급 | 0 | **3,160건** |

LocalCache가 있는 B2가 LocalCache 없는 A3보다 measure_rps가 낮고 median이 10배 높다.

**A3가 빠른 이유:**
```
A3 (No Cache):
  모든 요청 → Redis Lua 실행
  sold-out 이후: Lua 스크립트에서 즉시 SOLD_OUT 반환 (~5ms)
  → sold-out 상태가 Redis에 원자적으로 즉시 반영됨
  → 3개 인스턴스 모두 동일한 sold-out 상태 공유
  → median=113ms (sold-out 이후 대부분 빠른 반환)
```

```
B2 (Cache):
  sold-out 이후에도 각 인스턴스의 LocalCache는 1초간 업데이트 안 됨
  → 1초간 계속 SUCCESS로 처리 → Kafka publish → 브로커 경합
  → Kafka 느려지면 응답 지연 → VU 점유 증가 → median=1,188ms
```

역설: **LocalCache가 sold-out을 "캐시"하지 못하는 동안에는 No-Cache보다 더 느리다.**

---

## 분석 4 — B3: 24k RPS 시도 결과

| 항목 | B2 (12k) | B3 (24k) |
|------|---------|---------|
| measure RPS | 2,664 | **1,015** |
| p95 | 6,068ms | **10,246ms** |
| 에러율 | 2.84% | **7.3%** |
| timeout | 793건 | **5,114건** |
| 초과 발급 | 3,160건 | **12,284건** |

24k RPS는 심각한 과부하 상태. measure_rps가 1,015로 목표의 4.2%밖에 달성하지 못했다.

눈여겨볼 지표:
- `avg blocked = 29ms`: 새 TCP 연결조차 29ms 지연. 포트 소진 또는 nginx upstream 연결 큐 고갈.
- `success = 112,284`: 초과 발급 12,284건. 1초 LocalCache 동기화 간격에 24k RPS면 이미 6,000건이 동기화 없이 처리됨.

---

## 전체 Phase 비교 (Phase 3 → Phase 5 B 시리즈)

```
처리량 (measure RPS, 12k target 기준):

Phase 3 (직접, 1inst)   ████████████████████████  11,945
B1 (Cache, 1inst)       ████████████              6,186   Phase 3의 52%
A1 (No Cache, 1inst)    ██████████                5,067   Phase 3의 42%
A2 (No Cache, 2inst)    █████████                 4,380
A3 (No Cache, 3inst)    ██████                    3,193
B2 (Cache, 3inst)       █████                     2,664
```

```
p95 latency:

Phase 3  136ms   ▌
B1      3,047ms  ████████████████████████████
A1      3,030ms  ████████████████████████████
A2      4,136ms  ████████████████████████████████████████
B2      6,068ms  ████████████████████████████████████████████████████████████
A3      6,314ms  ██████████████████████████████████████████████████████████████
B3     10,246ms  ████████████████████████████████████████████████████████████████████████████████████████████████████
```

---

## 핵심 결론

### 결론 1: LocalCache는 단일 인스턴스에서 효과 있음 (+22% RPS)

B1 vs A1: 1인스턴스 조건에서 LocalCache는 measure_rps를 5,067 → 6,186으로 22% 향상시키고 에러율을 13.2% → 7.5%로 낮춘다. median도 195ms → 101ms로 절반 감소.

단, p95는 3,030ms → 3,047ms로 동일. 꼬리 레이턴시는 nginx `proxy_connect_timeout=3s`에 의해 고정되어 LocalCache로 해결 불가.

### 결론 2: LocalCache는 다중 인스턴스에서 역효과

B2 (Cache, 3inst) measure_rps=2,664 < A3 (No Cache, 3inst) measure_rps=3,193.

LocalCache가 없으면 Redis Lua가 모든 인스턴스에 즉각적인 sold-out 상태를 공유한다. LocalCache가 있으면 1초 동기화 간격 동안 sold-out이 전파되지 않아 Kafka 과부하와 중복 발급이 발생한다.

### 결론 3: LocalCache는 정확성 문제를 동반함

| 테스트 | 초과 발급 |
|--------|---------|
| B1 (1인스턴스) | **0건** (정상) |
| B2 (3인스턴스, 12k) | **3,160건** |
| B3 (3인스턴스, 24k) | **12,284건** |

다중 인스턴스 환경에서 LocalCache의 1초 동기화 간격은 최대 `RPS × 1초 × 인스턴스수` 만큼의 초과 발급을 허용한다.

### 결론 4: Phase 5의 남은 과제

| 문제 | 원인 | 해결 방향 |
|------|------|-----------|
| Phase 3 대비 전반적 처리량 저하 | nginx `proxy_connect_timeout=3s` | timeout 증가 또는 api 응답시간 단축 |
| 수평 스케일링 역효과 | LocalCache 1초 동기화 지연 | flush 주기 단축 or Redis Pub/Sub으로 실시간 sold-out 전파 |
| 초과 발급 (정확성) | 인스턴스 간 LocalCache 불일치 | flush 시 원자적 CAS 또는 Lua 스크립트로 초과 방어 |
| Kafka 단일 파티션 병목 | 파티션 수 = 1 → consumer 1개만 활성 | topic 파티션 수를 인스턴스 수에 맞게 증가 |
