# Phase 3 — Kafka Producer Buffer 포화 진단 보고서

- 테스트 일시: 2026-03-30 19:15
- 브랜치: `phase3-kafka`
- 목표: 14,000 RPS에서 Kafka producer buffer 포화 현상 직접 확인

---

## 1. 테스트 결과

```
=== Phase 3 Load Test (Kafka Async) [03/30/2026, 19:15:30] ===
Target RPS        : 14000
Actual RPS (측정구간): 3,575.67 /s    ← 목표의 25.5%만 처리
Total Requests    : 256,540
Dropped           : 625,469 (6,855/s) ← 요청의 71% 발급조차 못 함
avg waiting       : 1,440 ms
p95 Latency (측정): 2,582 ms
Failed Requests   : 519건 (timeout: 519, 5xx: 0)  ← 전부 타임아웃, 서버 에러 없음
```

비교 (Phase 3 12k RPS 정상 케이스):
```
Target RPS        : 12000
Actual RPS (측정구간): 11,945 /s       ← 목표의 99.5% 처리
avg waiting       : 45 ms
p95               : 136 ms
Failed Requests   : 0건
```

---

## 2. 서버 로그 — Kafka Producer 설정 확인

부하 테스트 직전 API 기동 시 출력된 ProducerConfig:

```
2026-03-30T10:13:59.887Z INFO [nio-8080-exec-10] o.a.kafka.common.config.AbstractConfig:
ProducerConfig values:
    buffer.memory  = 33554432   ← 32MB (producer 전송 버퍼)
    batch.size     = 16384      ← 16KB (브로커 전송 단위)
    max.block.ms   = 60000      ← 60초 (버퍼 포화 시 블로킹 한도)
    request.timeout.ms = 30000
```

**핵심**: `max.block.ms = 60000` — 버퍼가 꽉 차면 HTTP 스레드가 최대 **60초간 무응답으로 블로킹**됨.

---

## 3. Kafka Consumer Lag (테스트 직후 측정)

```bash
$ docker exec kafka kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 --describe --group point-ledger-group

GROUP              TOPIC        PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
point-ledger-group point-events 0          100001          100001          0
```

Lag = **0** — 버퍼에 쌓인 메시지가 결국 전부 소비됨. 유실 없음.

---

## 4. 왜 로그에 에러가 안 보이는가

```
k6 request timeout = 10s
Kafka max.block.ms  = 60s
```

두 값의 차이가 침묵의 원인입니다:

```
[HTTP 스레드] KafkaProducer.send() 호출
     │
     ▼ (버퍼 포화 → 블로킹 시작)
  5s ... 블로킹 중 (로그 없음)
 10s ← k6가 먼저 포기 (timeout) → k6에 status=0 기록
     │ (HTTP 스레드는 여전히 블로킹 중)
 30s ... 블로킹 중 (로그 없음)
 60s ← max.block.ms 도달 → TimeoutException 발생
     │ (하지만 이미 테스트 종료 후)
     ▼
  Spring이 500 반환 → 로그 출력 (이미 아무도 안 봄)
```

**결과**: k6는 `timeout`으로 기록, 서버는 `5xx 에러 0건`. 로그에는 아무것도 남지 않음.

---

## 5. 간접 증거 — "전부 타임아웃, 서버 에러 0건" 패턴

| 증거 | 정상(12k) | 포화(14k) | 해석 |
|------|----------|----------|------|
| avg waiting | 45ms | **1,440ms** | 스레드가 무언가를 기다리고 있음 |
| 서버 에러(5xx) | 0 | **0** | 예외가 로그에 안 남음 (60s 타임아웃 전에 k6가 먼저 포기) |
| k6 timeout | 0 | **519건** | 10s 내 응답 못 받은 요청 |
| Consumer lag | 0 | **0** | 버퍼 결국 전부 소비됨 (유실 없음) |

---

## 6. 직접 로그로 확인하는 방법

`max.block.ms`를 k6 timeout보다 짧게 설정하면 예외가 테스트 중에 발생해 로그에 기록됨:

```yaml
# docker-compose.yml
environment:
  SPRING_KAFKA_PRODUCER_PROPERTIES_MAX_BLOCK_MS: 1000  # 1초
```

이 경우 버퍼 포화 시 1초 후 아래 예외가 Spring 로그에 출력됨:
```
ERROR --- [nio-8080-exec-N] o.a.k.c.p.internals.FutureRecordMetadata :
org.apache.kafka.common.errors.TimeoutException:
  Failed to allocate memory within the configured max blocking time 1000 ms.
```

그리고 k6 결과가 `timeout(519건)` 대신 `server_error(5xx)` 로 바뀜.

---

## 7. 결론

| 항목 | 내용 |
|------|------|
| 포화 임계점 | 12k RPS ✅ → **13k~14k RPS ❌ 급격한 붕괴** |
| 포화 메커니즘 | SUCCESS 요청 급증 → Kafka producer buffer(32MB) 소진 → HTTP 스레드 블로킹 |
| 무증상 원인 | `max.block.ms=60s` > `k6 timeout=10s` → 예외 발화 전 k6가 먼저 포기 |
| 로그 증거 | 없음 (침묵하는 병목) — k6 timeout 패턴 + avg waiting 급등이 간접 증거 |
| 데이터 유실 | 없음 (consumer lag=0, 100,001 메시지 전부 소비) |
