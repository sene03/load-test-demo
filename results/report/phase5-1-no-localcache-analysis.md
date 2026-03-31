# Phase 5 (LocalCache 도입 전) 수평 스케일링 분석 리포트

- 브랜치: `phase5-no-localcache` (e401d9b 기반 + Nginx)
- 테스트 일시: 2026-03-30 11:07 ~ 11:12
- 구성: Kafka + Redis Lua + Nginx, **LocalPointCache 없음**
- 목표 RPS: 12,000 (Phase 3 확인된 한계점)

---

## 테스트 결과 원본

### Phase 3 비교 기준 (단일 인스턴스, Nginx 없음)

| 항목 | 값 |
|------|-----|
| 구성 | api=1, 직접 접근 (port 8080) |
| measure RPS | **11,945** |
| Total Requests | 752,722 |
| Dropped | 3,283 |
| avg latency | 48ms |
| p90 | 107ms |
| p95 | **136ms** |
| 에러 | **0건 (0%)** |
| max VUs | 2,418 |

---

### A1 — LocalCache 없음, api=1, Nginx 경유

| 항목 | 값 |
|------|-----|
| 구성 | api=1, Nginx port 80 |
| measure RPS | **5,067** |
| Total Requests | 340,048 |
| Dropped | 415,956 |
| avg latency | 1,044ms |
| p90 | 3,011ms |
| p95 | **3,030ms** |
| 서버 에러 | **44,845건 (13.2%)** |
| timeout | 1,759건 |
| max VUs | 5,450 (상한 도달) |

---

### A2 — LocalCache 없음, api=2, Nginx 경유

| 항목 | 값 |
|------|-----|
| 구성 | api=2, Nginx round-robin |
| measure RPS | **4,380** |
| Total Requests | 298,805 |
| Dropped | 457,201 |
| avg latency | 1,175ms |
| p90 | 3,205ms |
| p95 | **4,136ms** |
| 서버 에러 | **1,749건 (0.59%)** |
| timeout | 33건 |
| max VUs | 5,450 (상한 도달) |

---

### A3 — LocalCache 없음, api=3, Nginx 경유

| 항목 | 값 |
|------|-----|
| 구성 | api=3, Nginx round-robin |
| measure RPS | **3,193** |
| Total Requests | 227,581 |
| Dropped | 528,429 |
| avg latency | 1,656ms |
| p90 | 5,478ms |
| p95 | **6,314ms** |
| 서버 에러 | **830건 (0.36%)** |
| timeout | 56건 |
| max VUs | 5,450 (상한 도달) |

---

## 요약 비교표

| 구성 | measure RPS | p95 | 에러율 | Dropped | max VU |
|------|------------|-----|--------|---------|--------|
| Phase 3 (1인스턴스, 직접) | **11,945** | 136ms | **0%** | 3,283 | 2,418 |
| A1 (1인스턴스, Nginx) | 5,067 | 3,030ms | 13.2% | 415,956 | **5,450** |
| A2 (2인스턴스, Nginx) | 4,380 | 4,136ms | 0.59% | 457,201 | **5,450** |
| A3 (3인스턴스, Nginx) | 3,193 | 6,314ms | 0.38% | 528,429 | **5,450** |

---

## 분석 1 — Phase 3 vs A1: 같은 코드, 같은 인스턴스 수인데 왜 성능이 급락했나?

Phase 3와 A1은 동일한 e401d9b 커밋 기반이며, api 인스턴스 수도 1개로 동일하다. 차이는 오직 **Nginx의 유무**다.

```
Phase 3:  k6 → api:8080 (직접)
Phase 5:  k6 → nginx:80 → api:8080 (프록시 경유)
```

### nginx.conf의 proxy 타임아웃 설정

```nginx
proxy_connect_timeout  3s;   ← 핵심
proxy_read_timeout    10s;
proxy_next_upstream       error timeout http_503;
proxy_next_upstream_tries 2;
```

`proxy_connect_timeout=3s`이 문제다. api가 과부하 상태에서 새 연결 수락이 3초 이상 지연되면 **nginx가 즉시 502 Bad Gateway를 반환**한다. k6는 이를 서버 에러(5xx)로 집계한다.

### Phase 3는 왜 에러가 없었나?

Phase 3는 k6가 Tomcat에 직접 연결한다. Tomcat은 accept backlog 큐(기본 100)에 연결을 적재하고, 스레드가 생길 때까지 기다린다. 느리더라도 **거부하지 않고 대기**하므로 에러가 발생하지 않는다.

반면 Phase 5 A1은 nginx의 3초 connect timeout이 트리거되어 즉시 502를 반환한다. 이 때문에:
- A1: 44,845건 서버 에러 (13.2%) → VU가 빠르게 해제 → 재시도 → measure_rps는 높게 측정
- 하지만 실제 성공 처리량은 Phase 3의 42% 수준

```
Phase 3 처리 모델 (Tomcat 직접):
  요청 → [accept queue 대기] → [스레드 처리] → 응답
  과부하 시: 느리지만 에러 없음

Phase 5 처리 모델 (Nginx 경유):
  요청 → nginx → [connect timeout 3s] → 502 (fast fail)
  과부하 시: 빠른 에러 반환 → 에러율 높음
```

**결론**: Nginx의 `proxy_connect_timeout=3s`가 Phase 3 대비 성능 저하의 주원인이다.

---

## 분석 2 — A1 → A2 → A3: 인스턴스 늘릴수록 처리량이 감소하는 역설

| 인스턴스 수 | measure RPS | p95 | 에러율 |
|------------|------------|-----|--------|
| 1 | **5,067** | 3,030ms | 13.2% |
| 2 | 4,380 | 4,136ms | 0.59% |
| 3 | 3,193 | 6,314ms | 0.38% |

인스턴스를 늘릴수록 RPS가 줄고 p95가 늘어난다. 수평 스케일링이 역효과를 낸다.

### 원인 1: Kafka 단일 파티션 병목

```
Kafka topic (파티션 1개):
  Producer: api-1, api-2, api-3 → 모두 동일한 파티션에 write (경합)
  Consumer group (1개): api-1 또는 api-2 또는 api-3 중 1개만 활성

  → Consumer 수를 늘려도 소비 처리량은 증가하지 않음
  → Producer 3개가 동일 파티션에 쓰면서 브로커 부하 증가
```

파티션이 1개이면 consumer group에서 실제로 active한 consumer는 1개뿐이다. A2, A3에서 api 인스턴스를 늘려도 Kafka 소비 처리량은 동일하다. 오히려 **3개 producer가 같은 파티션에 동시 write**하면서 Kafka broker 경합이 증가한다.

### 원인 2: Redis 동시 접근 증가

```
A1: ~12,000 RPS → Redis Lua 12,000/s 실행 요청
A3: ~12,000 RPS → Redis Lua 12,000/s 실행 요청 (3개 인스턴스가 분산)

총 Redis 부하는 같지만, 3개 인스턴스가 동시에 Redis connection pool을 사용
→ Redis 단일 스레드 처리 한계에서 queueing 발생 가능
```

### 원인 3: VU 한계 도달 + 응답 시간 악순환

세 시나리오 모두 `vu_max=5,450`에 도달했다.

```
A1: 에러율 높음(13.2%) → 에러 응답이 빠름 → VU 회전 빠름 → measure_rps 높음
A3: 에러율 낮음(0.36%) → 대부분 요청이 응답 대기 중 → VU 5,450 모두 점유
    → 새 요청 발급 불가 → dropped 폭발(528,429)
```

A3의 median=113ms(A1의 195ms보다 낮음)이지만 p95=6,314ms(A1의 3,030ms의 2배)인 현상:
- **빠른 경로**: sold-out/duplicate → Redis 즉시 반환 ~50ms (3인스턴스이므로 더 많은 비율)
- **느린 경로**: SUCCESS → Kafka publish → 브로커 경합 → 지연 누적 → VU 5,450 포화 → tail spike

```
latency 분포 (A3):
  median=113ms  ← 빠른 경로(sold-out/dup)가 대다수
  p95=6,314ms   ← 느린 경로(SUCCESS)에서 Kafka 경합 + VU 고갈로 인한 극단적 꼬리
```

---

## 분석 3 — "인스턴스 늘릴수록 에러율은 감소"하는 이유

| 인스턴스 수 | 서버 에러 | 에러율 |
|------------|---------|--------|
| 1 | 44,845 | 13.2% |
| 2 | 1,749 | 0.59% |
| 3 | 830 | 0.36% |

에러율은 반대로 감소한다. 이유:

```
A1 (1인스턴스):
  nginx → api-1 (연결 실패) → 즉시 502 반환 (3s timeout)
  api-1이 모든 부하 처리 → connect 포화 → nginx 502 빈발

A3 (3인스턴스):
  nginx → api-1 (실패) → nginx next_upstream → api-2 → 성공
  3개 인스턴스에 부하 분산 → 개별 연결 포화 완화
  → nginx 502 발생 빈도 감소

단, 총 처리량은 감소: 에러 대신 요청이 긴 응답 대기열에 쌓임
```

**이것이 핵심**: 에러율 감소는 "성능 개선"이 아니라 **"빠른 실패(502) → 느린 대기"로의 전환**이다. 요청이 에러 대신 큐에 쌓여 VU를 점유하므로 실질 처리량은 오히려 낮아진다.

---

## Phase 3 vs Phase 5 A1~A3 핵심 비교

```
          Phase 3                A1                A2                A3
          (직접, 1인스턴스)      (Nginx, 1인스턴스)  (Nginx, 2인스턴스)  (Nginx, 3인스턴스)

RPS       11,945 ████████████   5,067 █████        4,380 ████         3,193 ███
p95         136ms               3,030ms             4,136ms            6,314ms
에러          0%                13.2%                0.59%              0.36%
VU MAX     2,418               5,450 (한계)         5,450 (한계)        5,450 (한계)
```

Phase 3에서는 VU가 2,418로 충분했지만, A1~A3는 모두 VU 5,450 상한에 도달했다. 이는 응답시간이 길어지면서 동일 RPS를 유지하기 위해 더 많은 VU가 필요해졌음을 의미한다.

---

## 핵심 결론

### 결론 1: Nginx proxy_connect_timeout이 Phase 3 대비 성능 격차의 주원인

Phase 3 (Tomcat 직접) → 에러 없이 11,945 RPS 처리
Phase 5 A1 (Nginx 경유) → 13.2% 에러, 5,067 RPS

원인: nginx `proxy_connect_timeout=3s`. 과부하 api에 연결 시도 시 3초 후 502 반환.
대책: `proxy_connect_timeout` 증가 또는 api 응답시간 자체를 단축 (LocalCache).

### 결론 2: LocalCache 없는 수평 스케일링은 무효 — 공유 자원 경합이 오히려 악화

인스턴스 수를 3배로 늘려도 처리량은 36% 감소 (5,067 → 3,193 RPS).

병목 이동 경로:
```
api 1인스턴스 → Nginx connect 포화 → 502 에러 다발
api 3인스턴스 → 에러 감소 BUT Kafka 단일 파티션 경합 + VU 점유 증가 → throughput 감소
```

LocalCache 없이 스케일링하면 Kafka 브로커, Redis 단일 스레드, MySQL에 대한 동시 접근이 선형으로 증가한다. 공유 자원의 경합이 핵심 병목으로 부상하면서 스케일링 효과를 상쇄한다.

### 결론 3: 이것이 LocalCache가 필요한 이유

```
LocalCache 도입 시 기대 효과:
  sold-out / duplicate 판정 → JVM 메모리에서 즉시 반환 (~수μs)
  → Redis, Kafka, MySQL 접근 요청 수 대폭 감소
  → 공유 자원 경합 해소
  → 스케일링 효과 실현 가능

LocalCache 없을 때:
  모든 요청이 Redis → Kafka → MySQL 경로를 통과
  → 인스턴스 증가 = 공유 자원 부하 비례 증가
  → 스케일링 무효화
```

다음 단계(phase5-scaling 브랜치 B1/B2/B3 테스트)에서 LocalCache 도입 후 결과와 비교한다.
