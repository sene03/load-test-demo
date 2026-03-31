# Phase 1 HikariCP Pool Size 비교 분석

- 테스트 일시: 2026-03-30
- 구성: Spring Boot + MySQL (Redis/Kafka 없음)
- 목표 RPS: 10,000 / MySQL CPU limit: 4 core

---

## 결과 비교표

| 항목 | pool=10 (09:09:57) | pool=30 (09:25:54) | 차이 |
|------|-------------------|-------------------|------|
| measure RPS | **2,118** | 1,766 | pool=10이 +20% 높음 |
| Total Requests | **157,088** | 136,006 | pool=10이 +21,082건 더 많음 |
| Dropped | 472,914 | 493,996 | pool=30이 +21,082건 더 버림 |
| avg waiting | **1,725ms** | 2,006ms | pool=10이 281ms 빠름 |
| p95 latency | 3,139ms | **2,658ms** | pool=30이 481ms 낮음 |
| p90 latency | 2,599ms | **2,505ms** | pool=30이 94ms 낮음 |
| avg latency | **2,088ms** | 2,159ms | pool=10이 71ms 빠름 |
| 에러 | 0건 | 0건 | 동일 |

> 참고: pool=10 첫 실행 (09:01:12) — p95=2,515ms, total=159,563 (InnoDB 버퍼풀 미워밍)

---

## 핵심 질문 1 — 왜 pool=30이 p95는 더 낮은가 (더 빠른가)

### pool=10의 요청 분포 (이중봉 분포)

```
pool=10: 10개 커넥션 → 빠르게 포화
        ↓
일부 요청: 커넥션 즉시 획득 → 빠르게 완료
일부 요청: HikariCP 큐 대기 → 수백~수천ms 추가 대기
        ↓
분포가 이중봉(bimodal) → 꼬리(tail)가 길어짐 → p95 높음
```

### pool=30의 요청 분포 (균일 분포)

```
pool=30: 30개 커넥션 → 거의 큐잉 없음
        ↓
모든 요청: 커넥션 즉시 획득 → DB로 바로 전달
DB: 30개 동시 쓰기 → 4 CPU에 균등 부하
        ↓
분포가 균일(uniform) → 극단적 outlier 없음 → p95 낮음
```

**결론**: p95 개선은 커넥션 큐 스파이크 제거 덕분. DB 자체가 빨라진 게 아님.

---

## 핵심 질문 2 — 왜 pool=30이 total requests는 더 적은가

### 평균 waiting 시간이 핵심

| | avg waiting | VU당 처리량 (1/waiting) | VU 4,550개 기준 이론 RPS |
|--|------------|------------------------|------------------------|
| pool=10 | 1,725ms | 0.580 req/s | **2,639 RPS** |
| pool=30 | 2,006ms | 0.499 req/s | **2,270 RPS** |

→ 실측 measure RPS (pool=10: 2,118 / pool=30: 1,766) 와 부합

### 원인: DB CPU 경합

```
pool=10:  10개 동시 쿼리 × 4 CPU = CPU당 2.5 쿼리 처리
pool=30: 30개 동시 쿼리 × 4 CPU = CPU당 7.5 쿼리 처리
                                          ↑
                              CPU 스케줄링 오버헤드 증가
                              쿼리당 실행 시간 늘어남
                              avg waiting: 1,725ms → 2,006ms (+16%)
```

사용자의 직관이 맞았습니다. pool=30은 DB CPU 경합을 유발해 **쿼리당 실행 시간을 늘립니다.**

---

## 역설 해소: "p95는 낮은데 total은 더 적다"

```
p95 (tail latency)      = 극단적 대기 케이스 제거 효과   → pool=30 유리
avg waiting (throughput) = 평균 처리 속도 결정           → pool=10 유리
```

두 지표가 서로 다른 현상을 측정합니다.

- pool=10: HikariCP 큐 스파이크 → tail 나쁨, 평균은 상대적으로 좋음
- pool=30: DB CPU 경합 → tail 좋음(큐 없음), 평균은 나쁨(쿼리 느려짐)

**constant-arrival-rate에서 throughput은 avg latency에 비례합니다.** p95가 낮아도 평균이 높으면 VU가 더 오래 점유됩니다.

---

## DB CPU limit 4코어 기준 이론적 최적 pool size

HikariCP 공식 권장 공식:
```
pool size = CPU core 수 × 2 + effective_spindle_count
          = 4 × 2 + 1 (SSD 기준)
          = 9
```

현재 설정 pool=10이 이론값(9)에 가장 가깝습니다.
pool=30은 이론값의 3배 — DB CPU 경합이 발생하는 구간입니다.

---

## 종합

| 관점 | pool=10 | pool=30 |
|------|---------|---------|
| 처리량 (RPS) | ✅ 높음 (2,118) | ❌ 낮음 (1,766) |
| 평균 응답시간 | ✅ 낮음 (2,088ms) | ❌ 높음 (2,159ms) |
| p95 꼬리 지연 | ❌ 높음 (3,139ms) | ✅ 낮음 (2,658ms) |
| DB CPU 경합 | ✅ 적음 | ❌ 많음 |
| HikariCP 큐 | ❌ 발생함 | ✅ 거의 없음 |

**pool=10이 Phase 1 병목(MySQL 단일 DB, CPU 4코어) 조건에서 전체 처리량은 더 우수합니다.**
pool=30은 p95 tail만 개선되며, 이는 HikariCP 큐 제거 효과이지 DB 성능 향상이 아닙니다.

### 다음 실험 제안

- pool=6 (이론값 하한): HikariCP 큐 발생하지만 DB CPU 경합 최소
- pool=9 (이론 최적): 두 효과의 균형점
- pool=10 (현재): 이론값에 근접, 현재 가장 좋은 처리량
- pool=30 (테스트): p95 개선이지만 throughput 손해
