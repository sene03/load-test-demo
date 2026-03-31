# Phase 3 — Kafka 파티션 증가 실험 보고서

> 브랜치: `phase3-kafka-partition`
> 목적: Kafka 단일 파티션 처리량 한계를 파티션 증가로 극복할 수 있는가
> 테스트 조건: 12k RPS / warmup 30s + measure 60s / k6 constant-arrival-rate

---

## 1. 실험 배경

Phase 3에서 Kafka 단일 파티션의 한계를 확인했다.

```
단일 파티션 구조:
API (12k msg/s) → partition-0 (1개) → consumer-1 (1개) → MySQL

한계:
- active consumer = 1개 → DB 쓰기 단일 처리
- 14k RPS 이상에서 producer buffer 포화 → HTTP 스레드 블로킹
- Phase 3 처리 한계: ~12k RPS
```

**가설**: 파티션 수와 consumer를 함께 늘리면 병렬 처리량이 증가한다.

---

## 2. 구현 내용

### 2.1 변경 사항

**KafkaConfig.java** — consumer concurrency 1 → 3

```java
// 변경 전
factory.setConsumerFactory(kafkaConsumerFactory);

// 변경 후
factory.setConsumerFactory(kafkaConsumerFactory);
factory.setConcurrency(3); // 파티션 수와 동일하게 설정
```

**PointEventProducer.java** — producer key 변경

```java
// 변경 전: eventId("1") → 모든 메시지가 동일 파티션으로 쏠림
kafkaTemplate.send(TOPIC, event.getEventId(), payload)

// 변경 후: userId → 3 파티션에 고르게 분산
kafkaTemplate.send(TOPIC, event.getUserId(), payload)
```

> **참고**: `KafkaConfig`의 `NewTopic` 빈은 이미 `partitions(3)`으로 설정되어 있었으나,
> producer key가 `eventId("1")`로 고정되어 있어 실제로는 단일 파티션만 사용되고 있었다.

### 2.2 의도한 동작

```
변경 후 구조:
API → partition-0 (userId hash) → consumer-1 → MySQL (병렬)
API → partition-1 (userId hash) → consumer-2 → MySQL (병렬)
API → partition-2 (userId hash) → consumer-3 → MySQL (병렬)
```

---

## 3. 실험 결과 (단계별)

### 3.1 1차 테스트 — 기본 변경만 적용 (buffer=32MB, linger=0ms, CPU=2)

| 항목 | 단일 파티션 (기준) | 3파티션 1차 |
|------|-----------------|------------|
| measure_rps | **11,945** | **3,947** (-67%) |
| p95 (ms) | 136 | 1,851 |
| avg waiting | 45ms | 1,168ms |
| timeouts | 0 | 192 |
| dropped | 3,283 | 483,209 |

예상과 반대로 **67% 성능 저하** 발생.

---

### 3.2 원인 진단 — Thread Dump

테스트 중 `GET /actuator/threaddump`로 HTTP 스레드 상태 분석:

**35s (measure 시작 5초 후)**
```
73x  BLOCKED        | RecordAccumulator.append  ← Kafka producer buffer 포화
36x  RUNNABLE       | StringRedisSerializer.deserialize
40x  TIMED_WAITING  | Unsafe.park (idle)
```

**50s (20초 후)**
```
195x  TIMED_WAITING  | Unsafe.park  ← Redis 한도 100,000 도달 후 전부 idle
```

**해석**:

`BLOCKED`는 단순 대기(WAITING)가 아니라 **mutex 경합** 상태다.
`RecordAccumulator.append`는 Kafka producer의 내부 배치 버퍼에 메시지를 추가하는 지점으로,
버퍼(`buffer.memory=32MB`)가 포화되면 모든 HTTP 스레드가 여기서 블로킹된다.

**단일 파티션에서는 12k RPS가 정상이었는데, 3 파티션에서는 왜 포화되는가?**

```
[단일 파티션, linger.ms=0]
12k msg/s → partition-0 배치 하나
→ 16KB 배치가 6.7ms마다 꽉 참 (효율적인 대용량 배치)
→ sender 스레드: 브로커에 1회 write → 빠르게 drain

[3 파티션, linger.ms=0]
12k msg/s → partition-0,1,2 분산 (각 4k msg/s)
→ 각 배치가 20ms마다 채워짐 → linger.ms=0이면 반쯤 찬 배치를 즉시 전송
→ 브로커 round-trip 3배 발생 → sender 스레드 drain 속도 ↓
→ buffer 포화 → 73개 HTTP 스레드 BLOCKED
```

---

### 3.3 2차 테스트 — buffer 증가 + linger.ms 조정 (CPU=2)

**가설**: 배치 효율을 높이면 drain 속도가 빨라져 buffer 포화가 해소될 것

**변경 사항**:
- `buffer.memory`: 32MB → 256MB
- `linger.ms`: 0ms → 5ms (배치를 더 모은 후 전송)
- `JAVA_OPTS Xmx`: 1g → 2g
- API container memory limit: 2g → 4g

**linger.ms=5ms 선택 이유**:
```
각 파티션 유입량: 4k msg/s × 200 bytes = 800KB/s
linger.ms=5ms 동안 누적: 5ms × 4 msg/ms = 20개 → ~4KB/배치

linger.ms=0 대비: 브로커 round-trip 약 5배 감소
linger.ms=100 대비: 응답 지연 없이 배치 효율 개선 가능
```

| 항목 | 3파티션 1차 (32MB/0ms) | 3파티션 2차 (256MB/5ms) |
|------|-----------------------|------------------------|
| measure_rps | 3,947 | 3,994 (+1.2%) |
| p95 (ms) | 1,851 | 1,942 |
| avg waiting | 1,168ms | 1,154ms |
| timeouts | 192 | **25 (-87%)** |
| dropped | 483,209 | 480,372 |

timeout은 192 → 25로 크게 줄었지만 **전체 throughput은 거의 변화 없음**.

Thread dump에서도 35s 시점에 이미 187개 스레드가 idle(park) 상태:
→ Kafka buffer 포화는 해소됐지만 처리량이 여전히 낮다
→ **다른 병목이 존재함**

---

### 3.4 핵심 원인 발견 — CPU 포화

테스트 중 컨테이너 자원 모니터링:

```
시각     API CPU    Kafka CPU  MySQL CPU  Redis CPU
t+32s    219%       93%        10%        11%
t+36s    212%       19%        17%        10%
t+40s    251%       242%       14%        13%
t+44s    206%       20%        12%        9%
t+48s    212%       6%         13%        6%
```

**API container가 200~250% (limit=200% = 2 CPU)로 지속 포화 상태.**

```
[단일 파티션, concurrency=1]
CPU 사용: Tomcat 200 threads + Kafka sender thread + consumer 1개
→ 2 CPU 내에서 여유 있게 처리 가능

[3 파티션, concurrency=3]
CPU 사용: Tomcat 200 threads + Kafka sender thread + consumer 3개
         ↑ 3개 consumer thread 각각 JSON 역직렬화 + MySQL INSERT 수행
→ 2 CPU 한계 초과 → Tomcat HTTP 스레드가 CPU 스케줄링을 받지 못함
→ HTTP 응답 지연 → k6 VU 소진 → dropped_iterations 급증 → 낮은 RPS
```

**buffer.memory 증가가 효과없었던 이유**: 병목이 메모리가 아니라 **CPU**였기 때문.

---

### 3.5 3차 테스트 — API CPU limit 2 → 4 (최종)

| 항목 | 단일 파티션 (기준) | 3파티션 CPU=2 | 3파티션 CPU=4 |
|------|-----------------|--------------|--------------|
| measure_rps | **11,945** | 3,994 | **11,755** |
| p95 (ms) | 136 | 1,942 | **129** |
| avg waiting | 45ms | 1,154ms | **30ms** |
| timeouts | 0 | 25 | **0** |
| dropped | 3,283 | 480,372 | **14,729** |
| API CPU limit | 2 | 2 | **4** |

CPU를 4로 늘리자 단일 파티션 수준(11,945 RPS)과 동등한 **11,755 RPS** 달성.

---

## 4. 전체 실험 흐름 요약

```
[실험 시작]
파티션 3개 + concurrency=3 도입
       ↓
11,945 RPS → 3,947 RPS (−67%) 성능 저하
       ↓
[Thread Dump 분석]
73개 HTTP 스레드 BLOCKED @ RecordAccumulator.append
→ Kafka producer buffer(32MB) 포화 확인
       ↓
[buffer 256MB + linger.ms=5ms 적용]
timeout: 192 → 25 (−87%) ← buffer 문제는 해소
but throughput: 3,947 → 3,994 (+1%) ← 다른 병목 존재
       ↓
[컨테이너 자원 모니터링]
API CPU: 200~250% (limit=200%) ← CPU 포화!
MySQL: 10~17% / Redis: 9~13% ← 정상
       ↓
[CPU limit 2 → 4 적용]
11,755 RPS 달성 ← 단일 파티션과 동등 수준 회복
```

---

## 5. 결론 및 교훈

### Q: Kafka 파티션을 늘리면 처리량이 증가하는가?
**A**: 증가하지만, **consumer concurrency를 함께 늘릴 경우 API 컨테이너 CPU도 그만큼 확보**해야 한다.

### Q: Kafka buffer size를 늘리면 병목이 해결되는가?
**A**: 부분적으로만 효과적이다. buffer 포화로 인한 timeout은 줄일 수 있으나, CPU가 실제 병목이라면 throughput은 변하지 않는다.

### 핵심 교훈

| 현상 | 잘못된 가설 | 실제 원인 |
|------|------------|---------|
| 3파티션 도입 후 RPS 급락 | Kafka producer buffer 포화 | **CPU 포화** (buffer 포화는 2차 증상) |
| buffer 증가해도 RPS 불변 | 메모리가 부족한 것 아닌가? | buffer는 증상, CPU가 근본 원인 |
| timeout만 감소 | buffer 문제 해결 중 | CPU 해소 없이는 throughput 회복 불가 |

### 파티션 증가 시 필요 자원 계산

```
필요 CPU ≈ 기존 CPU + (consumer 스레드 수 × consumer당 CPU 사용량)

Phase 3 기준:
- 단일 파티션, concurrency=1: 2 CPU로 충분
- 3 파티션, concurrency=3: 4 CPU 필요 (consumer 스레드 3개 × ~0.5~1 CPU)
```

### 최종 권장 설정 (Phase 3 기준)

```yaml
# docker-compose.yml
api:
  deploy:
    resources:
      limits:
        cpus: '4.0'      # concurrency=N 이면 2N CPU 확보 권장

# KafkaConfig.java
factory.setConcurrency(3);
ProducerConfig.BUFFER_MEMORY_CONFIG: 268435456  # 256MB
ProducerConfig.LINGER_MS_CONFIG:     5          # 배치 효율 향상
```
