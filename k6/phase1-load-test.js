/**
 * Phase 1 Load Test — Spring Boot + MySQL Baseline
 *
 * 실행 방법:
 *   k6 run -e TARGET_RPS=50 k6/phase1-load-test.js
 *
 * RPS 단계별 테스트 (각 단계 독립 실행):
 *   k6 run -e TARGET_RPS=50  k6/phase1-load-test.js
 *   k6 run -e TARGET_RPS=100 k6/phase1-load-test.js
 *   k6 run -e TARGET_RPS=150 k6/phase1-load-test.js
 *   k6 run -e TARGET_RPS=200 k6/phase1-load-test.js
 *
 * 포화점 기준: p95 > 300ms OR error rate > 1%
 * 409(DUPLICATE) / 410(SOLD_OUT) 은 정상 응답으로 처리
 */

import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const TARGET_RPS = parseInt(__ENV.TARGET_RPS || '50');
const DURATION = __ENV.DURATION || '30s';
const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const EVENT_ID = __ENV.EVENT_ID || '1';

// 커스텀 메트릭
const errorRate = new Rate('error_rate');
const successCount = new Rate('success_rate');

export const options = {
  scenarios: {
    constant_load: {
      executor: 'constant-arrival-rate',
      rate: TARGET_RPS,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: TARGET_RPS * 2,
      maxVUs: TARGET_RPS * 4,
    },
  },
  thresholds: {
    // 포화점 감지 기준 (SRS LT-1.3)
    http_req_duration: ['p(95)<300'],
    error_rate: ['rate<0.01'],
  },
};

export default function () {
  // 유니크한 userId — 매 요청이 INSERT 경로를 타도록 강제
  const userId = `user-${__VU}-${__ITER}`;

  const payload = JSON.stringify({ userId });
  const params = {
    headers: { 'Content-Type': 'application/json' },
    timeout: '5s',
  };

  const res = http.post(`${BASE_URL}/events/${EVENT_ID}/points`, payload, params);

  // 200: SUCCESS, 409: DUPLICATE, 410: SOLD_OUT → 정상 응답
  const isExpected = res.status === 200 || res.status === 409 || res.status === 410;
  // 5xx 또는 타임아웃 → 에러
  const isError = res.status === 0 || res.status >= 500;

  check(res, {
    'status is expected (200/409/410)': () => isExpected,
    'not a server error': () => !isError,
  });

  errorRate.add(isError);
  successCount.add(res.status === 200);
}

export function handleSummary(data) {
  const p95 = data.metrics.http_req_duration?.values?.['p(95)'] ?? 'N/A';
  const p99 = data.metrics.http_req_duration?.values?.['p(99)'] ?? 'N/A';
  const avg = data.metrics.http_req_duration?.values?.avg ?? 'N/A';
  const max = data.metrics.http_req_duration?.values?.max ?? 'N/A';
  const totalReqs = data.metrics.http_reqs?.values?.count ?? 'N/A';
  const actualRPS = data.metrics.http_reqs?.values?.rate ?? 'N/A';
  const errors = data.metrics.error_rate?.values?.rate ?? 'N/A';

  const summary = `
=== Phase 1 Load Test Result ===
Target RPS    : ${TARGET_RPS}
Duration      : ${DURATION}
Event ID      : ${EVENT_ID}

--- Latency ---
p95           : ${typeof p95 === 'number' ? p95.toFixed(2) : p95} ms
p99           : ${typeof p99 === 'number' ? p99.toFixed(2) : p99} ms
avg           : ${typeof avg === 'number' ? avg.toFixed(2) : avg} ms
max           : ${typeof max === 'number' ? max.toFixed(2) : max} ms

--- Throughput ---
Total Requests: ${totalReqs}
Actual RPS    : ${typeof actualRPS === 'number' ? actualRPS.toFixed(2) : actualRPS}

--- Errors ---
Error Rate    : ${typeof errors === 'number' ? (errors * 100).toFixed(2) : errors} %

--- Saturation Check ---
p95 > 300ms   : ${typeof p95 === 'number' ? (p95 > 300 ? 'YES ⚠️' : 'NO ✅') : 'N/A'}
Error > 1%    : ${typeof errors === 'number' ? (errors > 0.01 ? 'YES ⚠️' : 'NO ✅') : 'N/A'}
================================
`;

  console.log(summary);

  return {
    stdout: summary,
  };
}
