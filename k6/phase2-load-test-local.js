/**
 * Phase 2 Load Test — Spring Boot + MySQL + Redis (Local Version)
 *
 * 실행 방법 (프로젝트 루트에서 실행):
 * k6 run -e TARGET_RPS=50  k6/phase2-load-test-local.js
 * k6 run -e TARGET_RPS=100 k6/phase2-load-test-local.js
 * k6 run -e TARGET_RPS=150 k6/phase2-load-test-local.js
 *
 * 결과물:
 * - results/html/phase2/phase2-rps{N}-{timestamp}.html
 * - results/json/phase2/phase2-rps{N}-{timestamp}-summary.json
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

// 경쟁하는 총 고유 사용자 수
// 초당 수십만 요청 시나리오: 30만명이 동시에 선착순 1만 자리를 노림
// → 10,000건 SUCCESS 이후 나머지 290,000명은 SOLD_OUT
// → 이미 성공한 유저의 재시도는 DUPLICATE
const USER_POOL_SIZE = 300_000;

const errorRate      = new Rate('error_rate');       // 5xx (Redis 폴백 후에도 실패한 경우)
const successRate    = new Rate('success_rate');     // 200 SUCCESS
const redisErrorRate = new Rate('redis_error_rate'); // 503: Redis 장애 → DB 폴백 발생

// VU 필요량 = RPS × 최대 응답시간(초)
const MAX_LATENCY_S = 0.3;
const estimatedVUs  = Math.ceil(TARGET_RPS * MAX_LATENCY_S);

// 워밍업: JIT C2 완전 최적화까지 약 30초 필요
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
  const isError      = res.status === 0 || res.status >= 500 && res.status !== 503;
  const isRedisError = res.status === 503;

  check(res, {
    'status is expected (200/409/410/503)': () => isExpected,
    'not a server error':                   () => !isError,
  });

  errorRate.add(isError);
  successRate.add(res.status === 200);
  redisErrorRate.add(isRedisError);
}

export function handleSummary(data) {
  const now     = new Date();
  const kst     = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const timestamp   = kst.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '');
  const displayTime = now.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  const fileNameBase = `phase2-rps${TARGET_RPS}-${timestamp}`;
  const htmlPath     = `results/html/phase2/${fileNameBase}.html`;
  const jsonPath     = `results/json/phase2/${fileNameBase}-summary.json`;

  const latency    = data.metrics.http_req_duration ? data.metrics.http_req_duration.values : {};
  const redisErrors = data.metrics.redis_error_rate?.values?.rate ?? 0;

  console.log(`
  === Phase 2 Load Test (Redis) [${displayTime}] ===
  Target RPS    : ${TARGET_RPS}
  p95 Latency   : ${latency['p(95)']?.toFixed(2) || 'N/A'} ms
  Error Rate    : ${(data.metrics.error_rate?.values?.rate * 100).toFixed(2)} %
  Redis Fallback: ${(redisErrors * 100).toFixed(2)} % (503 → DB 폴백)
  =================================================
  `);

  return {
    "stdout": textSummary(data, { indent: " ", enableColors: true }),
    [htmlPath]: htmlReport(data, { title: `Phase 2 Test (Redis): ${TARGET_RPS} RPS (${displayTime})` }),
    [jsonPath]: JSON.stringify({
      metadata: { phase: 2, rps: TARGET_RPS, time: displayTime },
      latency_detail:  latency,
      errors:          data.metrics.error_rate?.values,
      throughput:      data.metrics.http_reqs?.values,
      redis_errors:    data.metrics.redis_error_rate?.values,
    }, null, 2),
  };
}
