# Phase 2 vs Phase 3 병목 분석 리포트

- 비교 기준: Phase 2 (Redis, 10:01:22) vs Phase 3 (Kafka, 최근 5개 결과)
- 목표 RPS: 10,000 기준 / 구성: API 1인스턴스, MySQL CPU 4코어

---

## Phase 3 최근 5개 결과 원본

| # | 시간 | 목표 RPS | vu_max | measure RPS | Total Req | Dropped | avg latency | p90 | p95 | 에러 |
|---|------|----------|--------|------------|-----------|---------|-------------|-----|-----|------|
| 1 | 10:23:28 | 10,000 | 1,510 | **0** (invalid) | 3,101 | 9 | 0ms | 0ms | 0ms | 100% timeout |
| 2 | 10:25:37 | 10,000 | 3,420 | **9,882** | 622,917 | 7,084 | 52ms | 148ms | 208ms | **0건** |
| 3 | 10:28:32 | 15,000 | 6,800 | 4,337 | 305,246 | 639,766 | 1,515ms | 2,149ms | 2,222ms | 459건 |
| 4 | 10:30:25 | 12,000 | 2,418 | **11,945** | 752,722 | 3,283 | 48ms | 107ms | 136ms | **0건** |
| 5 | 10:32:52 | 13,000 | 5,900 | 4,214 | 291,813 | 527,189 | 1,331ms | 1,686ms | 2,040ms | 188건 |

> **#1 (10:23) 제외**: 서버 미준비 상태 (전체 3,101건 timeout, 측정 불가)

---

## Phase 2 vs Phase 3 수치 비교 (10k RPS 기준)

| 항목 | Phase 2 (Redis) | Phase 3 (Kafka, #2) | 변화 |
|------|----------------|---------------------|------|
| measure RPS | 6,850 | **9,882** | **+44%** |
| Total Requests | 441,004 | **622,917** | **+41%** |
| Dropped | 188,998 | **7,084** | **-96%** |
| avg latency | 388ms | **52ms** | **-87%** |
| avg waiting | 364ms | **50ms** | **-86%** |
| median latency | 114ms | **19ms** | **-83%** |
| p90 latency | 1,262ms | **148ms** | **-88%** |
| p95 latency | 1,369ms | **208ms** | **-85%** |
| 에러 | 0건 | **0건** | 동일 |
| 목표 RPS 달성률 | 68.5% | **98.8%** | +30.3%p |

---

## Phase 3가 해소한 병목

### 병목 A 해소 — MySQL write가 HTTP 응답 경로에 있던 문제

**Phase 2 구조 (동기):**
```
[요청] → [Redis Lua] → SUCCESS 판정 → [MySQL INSERT ~1,440ms] → [응답]
                                               ↑
                                       응답 경로 위에 있음
                                       24.3% 요청이 여기서 대기
                                       → p95 = 1,369ms
```

**Phase 3 구조 (비동기):**
```
[요청] → [LocalCache/Redis 확인] → [Kafka publish ~5ms] → [즉시 응답]
                                           ↓ (비동기, HTTP 응답 후)
                                   [Kafka Consumer] → [MySQL INSERT]
                                                      (응답 경로 밖)
```

| | Phase 2 | Phase 3 |
|--|---------|---------|
| SUCCESS 응답 시간 | ~1,440ms (MySQL wait 포함) | ~5ms (Kafka publish만) |
| MySQL write 위치 | HTTP 응답 경로 안 | HTTP 응답 경로 밖 |
| p95 | 1,369ms | 208ms |

### 병목 B 해소 — sold-out 전 VU 부족

**Phase 2 병목 재현:**
```
Phase 2: SUCCESS 구간 (~14초)
  → avg latency 1,440ms → 10,000 RPS 유지에 14,400 VU 필요
  → 실제 VU cap: 4,550 → 대량 dropped (188,998건)
```

**Phase 3 해소:**
```
Phase 3: SUCCESS 구간 포함 모든 구간
  → avg latency ~50ms → 10,000 RPS 유지에 500 VU면 충분
  → VU 3,420 cap → 여유 → dropped 7,084건 (Phase 2의 3.7%)
```

VU 소비량이 **1/28로 감소**한 이유: 응답시간 1,440ms → 50ms

---

## Phase 3 내부 비교 (포화 임계점 탐색)

### 건강한 구간: 10k → 12k RPS

```
측정 #2 (목표 10k): measure=9,882, p95=208ms  ✅
측정 #4 (목표 12k): measure=11,945, p95=136ms ✅
```

12k 목표에서 measure_rps 11,945 달성 — **실질적 처리 한계는 ~12,000 RPS** 수준.

p95가 10k(208ms)보다 12k(136ms)에서 더 낮은 이유:
- 12k 테스트 시 vu_max=2,418 (10k보다 낮음) → sold-out 도달 시간이 더 짧음
- sold-out 이후 LocalCache가 수 μs로 응답 → 전체 분포를 끌어내림
- 즉, **sold-out 이후 고속 처리 구간의 비중이 더 클수록 p95 하락**

### 포화 구간: 13k, 15k RPS

```
측정 #5 (목표 13k): measure=4,214, p95=2,040ms ❌ → 포화
측정 #3 (목표 15k): measure=4,337, p95=2,222ms ❌ → 포화
```

13k와 15k에서 measure_rps가 비슷하게 ~4,200 수준으로 수렴하는 것은 **포화 상태에서의 처리 한계 상한**을 나타냄.

**포화 임계점: 12k < 한계 < 13k**

포화 원인 분석:
```
13k RPS 시도:
  → VU 소비량 = 13,000 × avg_latency
  → 포화 전: avg ~50ms → 650 VU
  → 포화 후: avg ~1,331ms → 17,303 VU 필요
  → vu_max = 5,900 → VU 부족 → dropped 폭발

포화 원인 후보:
  1. Tomcat 스레드 한계 (max=200) → 초당 처리 가능 RPS = 200 / latency
  2. Kafka producer 큐 한계 (buffer.memory=32MB, max.block.ms=60s 기본값)
  3. LocalPointCache 누적 지연
```

---

## Phase 3 latency 분포 구조

```
Phase 3 정상 구간 (10k, 측정 #2):

빠른 경로 ← 다수 요청
  └── LocalCache 즉시 반환 (SOLD_OUT/DUPLICATE 로컬 판정)
        median = 19ms

중간 경로
  └── Redis 판정 + Kafka publish (SUCCESS)
        ~5ms Kafka + 소량 Redis overhead
        → avg = 52ms

꼬리 (p95 = 208ms)
  └── Kafka producer 연결 지연 or Redis 왕복 레이턴시 spike
        매우 낮은 비율에서만 발생
```

Phase 2의 이중봉(114ms ↔ 1,440ms) 분포와 달리 Phase 3는 **단봉 분포** — MySQL write가 응답 경로에서 제거되어 꼬리가 사라짐.

---

## 포화 임계점 비교

```
Phase 2 한계: ~6,850 RPS (측정값, 포화점 미탐색)
Phase 3 한계: ~12,000 RPS (12k ✅, 13k ❌)
```

처리 한계 **+75%** 향상.

---

## 병목 경로 흐름도

```
Phase 2:
[요청] → [Redis Lua ~5ms]
    ├── DUPLICATE/SOLD_OUT (75.7%) → [즉시 응답 ~50ms]
    └── SUCCESS (24.3%)            → [HikariCP wait] → [MySQL INSERT ~1,440ms] → [응답]
                                            ↑ 병목 A (응답 경로 위, 꼬리 결정)

Phase 3:
[요청] → [LocalCache ~수μs]
    ├── SOLD_OUT/DUPLICATE (로컬 판정) → [즉시 응답 ~5ms]   ← 매우 빠름
    └── 미확정 → [Redis Lua ~5ms]
                    ├── DUPLICATE/SOLD_OUT → [즉시 응답]
                    └── SUCCESS            → [Kafka publish ~5ms] → [즉시 응답]
                                                      ↓ (비동기)
                                              [Kafka Consumer] → [MySQL INSERT]
                                                                 (응답 경로 밖 → 병목 해소)
```

---

## 잔존 병목 (Phase 3)

### 잔존 병목 X — 포화 시 Tomcat 스레드 한계

12k → 13k 전환에서 급격한 포화가 발생하는 원인:
```
Tomcat max.threads = 200

포화점 추정:
  200 threads × (1s / avg_latency) = 처리 가능 RPS
  200 / 0.050s = 4,000 RPS (Kafka+Redis 경로)

  → 그러나 실제 12k 달성 → LocalCache 경로가 스레드 없이 처리되는 구간이 많음
  → sold-out 후 LocalCache 반환은 스레드 점유 시간 극히 짧음

포화는 SUCCESS 집중 구간(sold-out 전 ~10초)에서 발생
  → 13k RPS × ~10s × avg_latency = 과부하
```

### 잔존 병목 Y — LocalPointCache 크로스 인스턴스 중복 발급

Phase 3 (1인스턴스)에서는 영향 없지만, Phase 5 (3인스턴스)에서 확인된 문제:
- 인스턴스별 LocalCache가 독립적으로 카운트 → 동일 userId 중복 SUCCESS 가능
- 실측: Kafka offset 106,022 - Redis SCARD 94,168 = **11,854건 중복 (11.18%)**

### 잔존 병목 Z — Kafka consumer lag 누적

API 응답시간에는 영향 없으나, 고RPS 지속 시 consumer가 따라가지 못하면:
- MySQL INSERT 처리 지연 → consumer lag 증가
- 이벤트 종료 후에도 처리 계속 필요

---

## 요약

| 구분 | Phase 2 → Phase 3 변화 |
|------|----------------------|
| **해소된 병목** | MySQL write가 응답 경로에서 분리 (Kafka 비동기화) |
| **해소된 병목** | p95: 1,369ms → 208ms (-85%) |
| **해소된 병목** | Dropped: 188,998건 → 7,084건 (-96%) |
| **해소된 병목** | sold-out 전 VU 부족 문제 해소 (응답시간 단축으로 VU 수요 1/28) |
| **처리 한계** | 6,850 RPS → **~12,000 RPS** (+75%) |
| **남은 병목** | 12k→13k 전환 시 급격한 포화 (Tomcat 스레드 + VU 한계) |
| **남은 병목** | 다중 인스턴스 시 LocalCache 크로스 인스턴스 중복 발급 |
| **목표 달성** | 10,000 RPS 달성 (measure 9,882 = **98.8%**) |
