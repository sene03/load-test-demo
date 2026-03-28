/**
 * Phase 1 Load Test — Spring Boot + MySQL Baseline (Local Version)
 *
 * 실행 방법 (InfluxDB 없이 로컬 실행 및 파일 저장):
 프로젝트 루트에서 실행해야함
 * k6 run -e TARGET_RPS=50 k6/phase1-load-test-local.js
 * k6 run -e TARGET_RPS=100 k6/phase1-load-test-local.js
 * k6 run -e TARGET_RPS=150 k6/phase1-load-test-local.js
 * k6 run -e TARGET_RPS=10000 k6/phase1-load-test-local.js
 *
 * 결과물:
 * - result_${TARGET_RPS}rps.html : 브라우저에서 확인 가능한 시각화 리포트
 * - summary_${TARGET_RPS}rps.json : 메트릭 수치가 저장된 JSON 데이터
 */

import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';
// 리포트 생성을 위한 외부 라이브러리 임포트
import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.1/index.js";

http.setResponseCallback(http.expectedStatuses(200, 409, 410)); // success status 설정

const TARGET_RPS = parseInt(__ENV.TARGET_RPS || '10000');
const DURATION = __ENV.DURATION || '60s';
const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const EVENT_ID = __ENV.EVENT_ID || '1';

const errorRate = new Rate('error_rate');
const successCount = new Rate('success_rate');

// VU 필요량 = RPS × 최대응답시간(초)
// ex) 10000 RPS × 0.3s(300ms SLA) = 3000 VUs
const MAX_LATENCY_S = 0.3;
const estimatedVUs  = Math.ceil(TARGET_RPS * MAX_LATENCY_S);

// 워밍업: JIT C2 완전 최적화까지 약 30초 필요
//   - JIT C1 (기본 최적화): 수백 호출 후 → ~10s
//   - JIT C2 (완전 최적화): ~1만 호출 후 → ~30s
const WARMUP_DURATION = '30s';
const WARMUP_RPS      = Math.max(10, Math.ceil(TARGET_RPS * 0.1)); // 목표의 10% (최소 10 RPS)
const MAIN_START_TIME = WARMUP_DURATION;                           // 워밍업 끝나면 본 테스트 시작

export const options = {
  scenarios: {
    // 워밍업: 낮은 RPS로 JVM/DB 커넥션 예열
    warmup: {
      executor: 'constant-arrival-rate',
      rate: WARMUP_RPS,
      timeUnit: '1s',
      duration: WARMUP_DURATION,
      preAllocatedVUs: 10,
      maxVUs: 50,
      tags: { phase: 'warmup' },
    },
    // 본 측정: 워밍업 직후 시작
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
    // warmup 제외하고 measure 구간만 threshold 적용
    'http_req_duration{phase:measure}': ['p(95)<300'],
    'error_rate{phase:measure}':        ['rate<0.01'],
  },
};

export default function () {
  const userId = `user-${__VU}-${__ITER}`;
  const payload = JSON.stringify({ userId });
  const params = {
    headers: { 'Content-Type': 'application/json' },
    timeout: '5s',
  };

  const res = http.post(`${BASE_URL}/events/${EVENT_ID}/points`, payload, params);

  const isExpected = res.status === 200 || res.status === 409 || res.status === 410;
  const isError = res.status === 0 || res.status >= 500;

  check(res, {
    'status is expected (200/409/410)': () => isExpected,
    'not a server error': () => !isError,
  });

  errorRate.add(isError);
  successCount.add(res.status === 200);
}

/**
 * 테스트 종료 후 실행되는 요약 핸들러
 */
export function handleSummary(data) {
  const now = new Date();
  // 파일명용 타임스탬프: YYYYMMDD_HHmmss KST (예: 20260328_223705)
  // k6는 Goja 엔진 사용 → toLocaleString의 timezone/locale 옵션 미지원
  // toISOString()은 모든 JS 엔진에서 동일하게 동작하므로 이걸로 KST 직접 계산
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000); // UTC+9
  const timestamp = kst.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '');
  const displayTime = now.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  // 1. 파일 경로 설정
  const fileNameBase = `phase1-rps${TARGET_RPS}-${timestamp}`;
  const htmlPath = `results/html/${fileNameBase}.html`;
  const jsonPath = `results/json/${fileNameBase}-summary.json`;

  // 2. Latency 상세 데이터 추출 (AI 분석용)
  const latency = data.metrics.http_req_duration ? data.metrics.http_req_duration.values : {};

  // 3. 콘솔 로그 (Saturation Check 포함)
  console.log(`
  === Phase 1 Load Test [${displayTime}] ===
  Target RPS : ${TARGET_RPS}
  p95 Latency: ${latency['p(95)']?.toFixed(2) || 'N/A'} ms
  Error Rate : ${(data.metrics.error_rate?.values?.rate * 100).toFixed(2)} %
  ==========================================
  `);

  return {
    "stdout": textSummary(data, { indent: " ", enableColors: true }),
    // HTML 리포트 생성 (여기서 http_req_duration이 포함됨)
    [htmlPath]: htmlReport(data, { title: `Phase 1 Test: ${TARGET_RPS} RPS (${displayTime})` }),
    // AI 전용 JSON (모든 Latency 통계 포함)
    [jsonPath]: JSON.stringify({
      metadata: { rps: TARGET_RPS, time: displayTime },
      latency_detail: latency, // 여기에 min, max, avg, p90, p95, p99 다 들어감
      errors: data.metrics.error_rate?.values,
      throughput: data.metrics.http_reqs?.values
    }, null, 2),
  };

}