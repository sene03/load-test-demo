/**
 * Phase 3 Load Test — Spring Boot + MySQL + Redis + Kafka (Local Version)
 *
 * 실행 방법 (프로젝트 루트에서 실행):
 * k6 run -e TARGET_RPS=1000  k6/phase3-load-test-local.js
 * k6 run -e TARGET_RPS=2000  k6/phase3-load-test-local.js
 * k6 run -e TARGET_RPS=5000  k6/phase3-load-test-local.js
 *
 * 결과물:
 * - results/html/phase3/phase3-rps{N}-{timestamp}.html
 * - results/json/phase3/phase3-rps{N}-{timestamp}-summary.json
 *
 * 테스트 후 데이터 정합성 확인:
 *   redis-cli GET event:1:count
 *   mysql -u root -p1234 -e "SELECT COUNT(*) FROM test_db.point_ledger WHERE event_id='1';"
 *   → Consumer가 처리 완료 후 두 값이 일치해야 함
 *
 * Consumer lag 확인:
 *   docker exec <kafka-container> kafka-consumer-groups.sh \
 *     --bootstrap-server localhost:9092 --describe --group point-ledger-group
 */

import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';
import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.1/index.js";

// 200/409/410은 정상 처리, 503은 Redis 장애 → DB 폴백 (오류 아님)
http.setResponseCallback(http.expectedStatuses(200, 409, 410, 503));

const TARGET_RPS = parseInt(__ENV.TARGET_RPS || '10000');
const DURATION   = __ENV.DURATION  || '60s';
const BASE_URL   = __ENV.BASE_URL  || 'http://localhost:8080';
const EVENT_ID   = __ENV.EVENT_ID  || '1';

// 30만명이 동시에 선착순 자리를 노리는 시나리오
const USER_POOL_SIZE = 300_000;

const errorRate      = new Rate('error_rate');       // timeout + 5xx (503 제외)
const successRate    = new Rate('success_rate');     // 200 SUCCESS
const redisErrorRate = new Rate('redis_error_rate'); // 503: Redis 장애 → DB 폴백
const timeoutRate    = new Rate('timeout_rate');     // status=0: k6 timeout / 연결 실패
const serverErrRate  = new Rate('server_error_rate'); // 500~599 (503 제외): 서버 내부 오류

// VU 필요량 = RPS × 최대 응답시간(초)
const MAX_LATENCY_S = 0.3;
const estimatedVUs  = Math.ceil(TARGET_RPS * MAX_LATENCY_S);

const WARMUP_DURATION = '30s';
const WARMUP_RPS      = Math.max(10, Math.ceil(TARGET_RPS * 0.1));
const MAIN_START_TIME = WARMUP_DURATION;

export const options = {
  scenarios: {
    warmup: {
      executor: 'constant-arrival-rate',
      rate: WARMUP_RPS,
      timeUnit: '1s',
      duration: WARMUP_DURATION,
      preAllocatedVUs: 10,
      maxVUs: 50,
      tags: { phase: 'warmup' },
    },
    measure: {
      executor: 'constant-arrival-rate',
      rate: TARGET_RPS,
      timeUnit: '1s',
      duration: '60s',
      startTime: MAIN_START_TIME,
      preAllocatedVUs: Math.ceil(estimatedVUs / 2),
      maxVUs: Math.ceil(estimatedVUs * 1.5),
      tags: { phase: 'measure' },
    },
  },
  thresholds: {
    'http_req_duration{phase:measure}': ['p(95)<300'],
    'error_rate{phase:measure}':        ['rate<0.01'],
  },
};

export default function () {
  const userId  = `user-${Math.floor(Math.random() * USER_POOL_SIZE)}`;
  const payload = JSON.stringify({ userId });
  const params  = {
    headers: { 'Content-Type': 'application/json' },
    timeout: '5s',
  };

  const res = http.post(`${BASE_URL}/events/${EVENT_ID}/points`, payload, params);

  const isExpected   = res.status === 200 || res.status === 409 || res.status === 410 || res.status === 503;
  const isTimeout    = res.status === 0;
  const isServerErr  = res.status >= 500 && res.status !== 503;
  const isError      = isTimeout || isServerErr;
  const isRedisError = res.status === 503;

  check(res, {
    'status is expected (200/409/410/503)': () => isExpected,
    'not a server error':                   () => !isError,
    'not a timeout':                        () => !isTimeout,
  });

  errorRate.add(isError);
  successRate.add(res.status === 200);
  redisErrorRate.add(isRedisError);
  timeoutRate.add(isTimeout);
  serverErrRate.add(isServerErr);
}

export function handleSummary(data) {
  const now         = new Date();
  const kst         = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const timestamp   = kst.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '');
  const displayTime = now.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  const fileNameBase = `phase3-rps${TARGET_RPS}-${timestamp}`;
  const htmlPath     = `results/html/phase3/${fileNameBase}.html`;
  const jsonPath     = `results/json/phase3/${fileNameBase}-summary.json`;

  const m = data.metrics;

  // 지연시간
  const latency        = m.http_req_duration?.values        ?? {};
  const latencyMeasure = m['http_req_duration{phase:measure}']?.values ?? {};

  // 처리량
  const totalReqs   = m.http_reqs?.values?.count ?? 0;
  const actualRps   = m.http_reqs?.values?.rate  ?? 0;
  const warmupSec    = parseFloat(WARMUP_DURATION.replace('s',''));
  const durationSec  = parseFloat(DURATION.replace('s',''));
  const warmupCount  = Math.round(WARMUP_RPS * warmupSec);
  const measureCount = Math.max(0, totalReqs - warmupCount);
  const measureRps   = durationSec > 0 ? measureCount / durationSec : 0;
  const dropped     = m.dropped_iterations?.values?.count ?? 0;
  const droppedRate = m.dropped_iterations?.values?.rate  ?? 0;

  // 오류
  // http_req_failed는 Rate 메트릭: passes = 실패한 요청 수(true 추가), fails = 성공한 요청 수(false 추가)
  const failedReqs   = m.http_req_failed?.values?.passes   ?? 0;  // HTTP 레벨 실패 (5xx/timeout)
  const timeouts     = m.timeout_rate?.values?.passes      ?? 0;  // status=0: k6 timeout
  const serverErrors = m.server_error_rate?.values?.passes ?? 0;  // 500~599 (503 제외)
  const redisErrors  = m.redis_error_rate?.values?.rate    ?? 0;

  // checks
  const checkPasses  = m.checks?.values?.passes ?? 0;
  const checkFails   = m.checks?.values?.fails  ?? 0;
  const checkPassPct = (checkPasses + checkFails) > 0
    ? ((checkPasses / (checkPasses + checkFails)) * 100).toFixed(2) : '100.00';

  // 개별 check 항목
  const checkDetails = {};
  for (const [key, metric] of Object.entries(m)) {
    if (key === 'checks' || key.startsWith('checks{')) {
      checkDetails[key] = { passes: metric.values.passes, fails: metric.values.fails };
    }
  }

  // thresholds 결과
  const thresholds = {};
  for (const [key, val] of Object.entries(data.thresholds ?? {})) {
    thresholds[key] = val.ok ? 'PASS' : 'FAIL';
  }

  // VU
  const vuMax = m.vus_max?.values?.max ?? 0;

  // 요청 내부 구간 (전체)
  const reqParts = {
    blocked:    m.http_req_blocked?.values?.avg?.toFixed(3),
    connecting: m.http_req_connecting?.values?.avg?.toFixed(3),
    waiting:    m.http_req_waiting?.values?.avg?.toFixed(3),
    receiving:  m.http_req_receiving?.values?.avg?.toFixed(3),
    sending:    m.http_req_sending?.values?.avg?.toFixed(3),
  };

  console.log(`
  === Phase 3 Load Test (Kafka Async) [${displayTime}] ===
  Target RPS        : ${TARGET_RPS}
  Actual RPS (전체평균): ${actualRps.toFixed(2)} /s  (warmup 포함 전체 평균)
  Actual RPS (측정구간): ${measureRps.toFixed(2)} /s  (measure ${DURATION} 기준)
  Total Requests    : ${totalReqs}
  Dropped           : ${dropped} (${droppedRate.toFixed(2)}/s)
  p95 Latency (전체): ${latency['p(95)']?.toFixed(2) ?? 'N/A'} ms
  p95 Latency (측정): ${latencyMeasure['p(95)']?.toFixed(2) ?? 'N/A'} ms
  Failed Requests   : ${failedReqs} 건 (timeout: ${timeouts}, 5xx: ${serverErrors})
  Failed Checks     : ${checkFails} 건 / 통과율 ${checkPassPct} %
  Redis Fallback    : ${(redisErrors * 100).toFixed(2)} % (503 → DB 폴백)
  Thresholds        : ${JSON.stringify(thresholds)}
  =====================================================
  `);

  return {
    "stdout": textSummary(data, { indent: " ", enableColors: true }),
    [htmlPath]: htmlReport(data, { title: `Phase 3 Test (Kafka Async): ${TARGET_RPS} RPS (${displayTime})` }),
    [jsonPath]: JSON.stringify({
      metadata: { phase: 3, rps: TARGET_RPS, time: displayTime, vu_max: vuMax },
      throughput: {
        total_requests: totalReqs,
        actual_rps:     parseFloat(actualRps.toFixed(2)),
        measure_rps:    parseFloat(measureRps.toFixed(2)),
        dropped:        dropped,
        dropped_rate:   parseFloat(droppedRate.toFixed(2)),
      },
      latency: {
        all:     { min: latency.min, med: latency.med, avg: latency.avg,
                   p90: latency['p(90)'], p95: latency['p(95)'], max: latency.max },
        measure: { min: latencyMeasure.min, med: latencyMeasure.med, avg: latencyMeasure.avg,
                   p90: latencyMeasure['p(90)'], p95: latencyMeasure['p(95)'], max: latencyMeasure.max },
      },
      req_breakdown_avg_ms: reqParts,
      errors: {
        failed_requests: failedReqs,
        timeouts:        timeouts,
        server_errors:   serverErrors,
        http_req_failed: m.http_req_failed?.values,
        error_rate:      m.error_rate?.values,
        timeout_rate:    m.timeout_rate?.values,
        server_error_rate: m.server_error_rate?.values,
      },
      checks: {
        passes:   checkPasses,
        fails:    checkFails,
        pass_pct: checkPassPct,
        detail:   checkDetails,
      },
      thresholds,
      redis_errors: m.redis_error_rate?.values,
    }, null, 2),
  };
}
