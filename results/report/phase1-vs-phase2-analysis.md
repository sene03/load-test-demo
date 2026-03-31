# Phase 1 vs Phase 2 병목 분석 리포트

- 비교 기준: Phase 1 (pool=10, 09:09:57) vs Phase 2 (Redis, 10:01:22)
- 목표 RPS: 10,000 / 구성: API 1인스턴스, MySQL CPU 4코어

---

## 수치 비교

| 항목 | Phase 1 (MySQL only) | Phase 2 (Redis 추가) | 변화 |
|------|---------------------|---------------------|------|
| measure RPS | 2,118 | **6,850** | **+224%** |
| Total Requests | 157,088 | **441,004** | **+181%** |
| Dropped | 472,914 | 188,998 | -60% |
| avg latency | 2,088ms | **388ms** | **-81%** |
| avg waiting | 1,725ms | **364ms** | **-79%** |
| median latency | ~1,930ms | **114ms** | **-94%** |
| p90 latency | 2,599ms | **1,262ms** | -51% |
| p95 latency | 3,139ms | **1,369ms** | -56% |
| 에러 | 0건 | 0건 | 동일 |
| 목표 RPS 달성률 | 21.2% | **68.5%** | +47.3%p |

---

## 해소된 병목

### 병목 1 — 요청마다 MySQL 직접 쓰기

**Phase 1 구조:**
```
모든 요청 (127,088건/60s) → MySQL INSERT → 응답
                              ↑
                    HikariCP 10 connections 포화
                    avg waiting: 1,725ms
```

**Phase 2 구조:**
```
모든 요청 (411,004건/60s)
    ├── Redis Lua script (SISMEMBER + INCR + SADD)  ← 수 ms
    │       ├── DUPLICATE  → 즉시 응답 (MySQL 없음)
    │       ├── SOLD_OUT   → 즉시 응답 (MySQL 없음)
    │       └── SUCCESS    → MySQL INSERT → 응답
    │
    └── 실제 MySQL write: ~100,000건 (24.3%) 만 발생
```

| | Phase 1 | Phase 2 |
|--|---------|---------|
| MySQL write 비율 | **100%** (모든 요청) | **24.3%** (SUCCESS만) |
| 나머지 요청 처리 | MySQL로 전부 전달 | Redis에서 즉시 반환 |

Redis가 전체 요청의 **75.7%를 MySQL 도달 이전에 흡수**합니다.

---

### 병목 2 — HikariCP 커넥션 큐 포화

Phase 1에서 모든 요청이 MySQL을 치면서 10개 커넥션이 항상 포화 상태였습니다.

```
Phase 1: 127,088 req/60s × 100% MySQL = 2,118 writes/s
         10 connections → connection당 212 writes/s
         MySQL INSERT 처리 속도 한계 도달 → 큐 폭발

Phase 2: 411,004 req/60s × 24.3% MySQL = ~1,667 writes/s
         10 connections → connection당 167 writes/s
         큐 압력 감소 → avg waiting: 1,725ms → 364ms
```

MySQL write 속도는 비슷하지만, **Redis가 나머지 75.7%를 바이패스**시켜 HikariCP 큐 압력이 대폭 줄었습니다.

---

## 여전히 남은 병목

### 병목 A — MySQL write 구간의 긴 꼬리 (p90/p95 ≈ 1,300ms)

**latency 이중봉 분포:**
```
Phase 2 latency 분포:

빠른 경로 (75.7%): Redis만 처리 (DUPLICATE/SOLD_OUT)
  └── ~50ms 이내

느린 경로 (24.3%): Redis 통과 후 MySQL write (SUCCESS)
  └── ~1,440ms (역산값)

median = 114ms  ← 빠른 경로가 과반수
p90    = 1,262ms ← 느린 경로 진입 구간
p95    = 1,369ms ← 느린 경로 내
avg    = 388ms   ← 이중봉 가중 평균
```

p90/p95가 1,200~1,400ms인 이유: **상위 24.3% 요청이 모두 MySQL write** 이기 때문.
MySQL write 소요시간(~1,440ms)이 p90/p95를 결정합니다.

### 병목 B — sold-out 이전 10k RPS 유지 불가

**시간축 분석:**
```
measure 60s, 6,850 RPS 기준:

0s ~14s: SUCCESS 구간 (100,000건 / 6,850 RPS ≈ 14.6초)
          → 24.3% 요청이 MySQL write (~1,440ms 대기)
          → k6 VU 수요: 10,000 × 1.44s = 14,400 VU 필요
          → 실제 cap: 4,550 VU → 대량 dropped

14s~60s: SOLD_OUT 구간 (~311,004건)
          → Redis 즉시 반환 (~50ms)
          → VU 수요: 10,000 × 0.05s = 500 VU
          → cap 여유 → 10k RPS 근접
```

sold-out 이후에는 Redis가 초고속으로 처리하지만, **초반 14초 동안의 MySQL write 구간에서 VU가 부족**해 dropped가 대량 발생합니다.

### 병목 C — Redis Lua script 직렬 실행 (잠재적)

Phase 2에서는 아직 1,000 RPS 수준 (Phase 3에서 드러남)이라 문제가 없지만, Redis Lua script는 단일 스레드이므로 10,000+ RPS 도달 시 Redis CPU 포화 한계가 있습니다.

---

## 병목 경로 흐름도

```
Phase 1:
[요청] → [HikariCP 큐 대기 ~1,725ms] → [MySQL INSERT] → [응답]
           ↑ 병목 1 (ALL 요청)

Phase 2:
[요청] → [Redis Lua ~5ms]
              ├── DUPLICATE/SOLD_OUT (75.7%) → [즉시 응답 ~50ms]  ← 해소
              └── SUCCESS (24.3%) → [HikariCP 큐 ~364ms avg] → [MySQL INSERT] → [응답]
                                          ↑ 병목 A (여전히 존재, 단 대상 축소)
```

---

## Phase 3 (Kafka) 가 해결하는 것

Phase 2에서 남은 병목 A는 **MySQL write가 HTTP 응답 경로에 있기 때문**입니다.

```
Phase 3 구조:
[요청] → [Redis 확인] → [Kafka publish ~5ms] → [즉시 응답]
                              ↓ (비동기)
                         [Kafka consumer] → [MySQL INSERT]
                                                (응답 경로 밖)
```

MySQL write가 응답 경로에서 분리되면:
- SUCCESS 요청도 Redis + Kafka 수준의 빠른 응답 가능
- p90/p95 latency 대폭 감소 예상
- MySQL write throughput 한계가 API RPS에 영향 없음

---

## 요약

| 구분 | Phase 1 → Phase 2 변화 |
|------|----------------------|
| **해소된 병목** | 전체 요청의 75.7%가 MySQL 우회 (Redis 즉시 반환) |
| **해소된 병목** | HikariCP 큐 압력: avg waiting 1,725ms → 364ms (-79%) |
| **남은 병목** | SUCCESS 24.3%는 여전히 MySQL write 대기 (~1,440ms) |
| **남은 병목** | p95=1,369ms (MySQL write 요청이 꼬리 결정) |
| **남은 병목** | sold-out 전 14초 구간에서 VU 부족 → dropped 188,998건 |
| **목표 달성** | 10,000 RPS 중 6,850 달성 (68.5%), 완전 달성 미도달 |
