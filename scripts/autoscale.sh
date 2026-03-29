#!/usr/bin/env bash
# Phase 5 Auto-scaling Script
# F-5.4: docker stats로 API 컨테이너 CPU 평균 모니터링
# F-5.5: avg CPU > SCALE_OUT_THRESHOLD → scale out
# F-5.6: avg CPU < SCALE_IN_THRESHOLD  → scale in
# F-5.7: 스케일 액션 간 cooldown 적용

set -euo pipefail

# ── 파라미터 (환경변수로 오버라이드 가능) ─────────────────────────────────────
SCALE_OUT_THRESHOLD="${SCALE_OUT_THRESHOLD:-60}"   # CPU > 60% → scale out
SCALE_IN_THRESHOLD="${SCALE_IN_THRESHOLD:-20}"     # CPU < 20% → scale in
MIN_INSTANCES="${MIN_INSTANCES:-1}"
MAX_INSTANCES="${MAX_INSTANCES:-5}"
CHECK_INTERVAL="${CHECK_INTERVAL:-5}"              # 초
COOLDOWN="${COOLDOWN:-15}"                         # 스케일 액션 간 최소 대기(초)

# docker compose ps 필터용 프로젝트명 (디렉토리명 기준)
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$(basename "$(pwd)")}"

# ── 함수 ───────────────────────────────────────────────────────────────────────

# 현재 실행 중인 api 컨테이너 수
get_api_count() {
    docker compose ps --quiet api 2>/dev/null | wc -l | tr -d ' '
}

# api 컨테이너들의 평균 CPU 사용률 (%)
get_avg_cpu() {
    docker stats --no-stream --format "{{.Name}} {{.CPUPerc}}" 2>/dev/null \
        | grep "^${PROJECT_NAME}-api-" \
        | awk '{
            gsub(/%/, "", $2)
            sum += $2
            count++
          }
          END {
            if (count > 0) printf "%.1f", sum / count
            else print "0"
          }'
}

# N개로 스케일 후 nginx reload (DNS 재조회 → 신규 컨테이너 감지)
scale_to() {
    local target=$1
    echo "[autoscale] api 인스턴스: ${current_count} → ${target}"
    docker compose up --scale api="$target" --no-recreate -d
    # nginx reload: 새 DNS A 레코드 반영
    docker compose exec -T nginx nginx -s reload 2>/dev/null || true
    echo "[autoscale] 완료. nginx 재로드됨."
}

# ── 메인 루프 ──────────────────────────────────────────────────────────────────

echo "[autoscale] 시작"
echo "[autoscale] scale-out: CPU > ${SCALE_OUT_THRESHOLD}%"
echo "[autoscale] scale-in:  CPU < ${SCALE_IN_THRESHOLD}%"
echo "[autoscale] min: ${MIN_INSTANCES}  max: ${MAX_INSTANCES}  cooldown: ${COOLDOWN}s"
echo ""

last_scale_time=0

while true; do
    current_count=$(get_api_count)
    avg_cpu=$(get_avg_cpu)
    now=$(date +%s)
    elapsed=$(( now - last_scale_time ))
    remaining=$(( COOLDOWN - elapsed ))
    remaining=$(( remaining < 0 ? 0 : remaining ))

    printf "[autoscale] 인스턴스: %s | 평균 CPU: %s%% | cooldown: %ss\n" \
        "$current_count" "$avg_cpu" "$remaining"

    # cooldown 중이면 스킵
    if (( elapsed < COOLDOWN )); then
        sleep "$CHECK_INTERVAL"
        continue
    fi

    # 부동소수점 비교는 awk 사용 (bash는 정수만 지원)
    should_scale_out=$(awk "BEGIN{ print ($avg_cpu > $SCALE_OUT_THRESHOLD) ? 1 : 0 }")
    should_scale_in=$(awk  "BEGIN{ print ($avg_cpu < $SCALE_IN_THRESHOLD && $current_count > $MIN_INSTANCES) ? 1 : 0 }")

    if [[ "$should_scale_out" == "1" ]] && (( current_count < MAX_INSTANCES )); then
        echo "[autoscale] CPU ${avg_cpu}% > ${SCALE_OUT_THRESHOLD}% — scale OUT"
        scale_to $(( current_count + 1 ))
        last_scale_time=$now

    elif [[ "$should_scale_in" == "1" ]]; then
        echo "[autoscale] CPU ${avg_cpu}% < ${SCALE_IN_THRESHOLD}% — scale IN"
        scale_to $(( current_count - 1 ))
        last_scale_time=$now
    fi

    sleep "$CHECK_INTERVAL"
done
