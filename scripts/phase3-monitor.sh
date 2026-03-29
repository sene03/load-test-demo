watch -n 1 '
echo "=== Tomcat Worker Threads ==="
curl -s http://localhost:8080/actuator/threaddump | jq "
  [.threads[] | select(.threadName | test(\"http-nio.*exec\"))] |
  {
    busy:    (map(select(.threadState != \"TIMED_WAITING\")) | length),
    max:     length,
    running: (map(select(.threadState == \"RUNNABLE\"))      | length),
    waiting: (map(select(.threadState == \"TIMED_WAITING\")) | length),
    blocked: (map(select(.threadState == \"BLOCKED\"))       | length)
  }
"

echo ""
echo "=== HikariCP ==="
printf "Active:  "; curl -s http://localhost:8080/actuator/metrics/hikaricp.connections.active  | jq ".measurements[0].value"
printf "Pending: "; curl -s http://localhost:8080/actuator/metrics/hikaricp.connections.pending | jq ".measurements[0].value"
printf "Idle:    "; curl -s http://localhost:8080/actuator/metrics/hikaricp.connections.idle    | jq ".measurements[0].value"

echo ""
echo "=== Redis ==="
printf "Ops/sec: "; docker exec load-test-demo-redis-1 redis-cli INFO stats 2>/dev/null | grep instantaneous_ops_per_sec | awk -F: "{print \$2}" | tr -d "\r"
printf "Clients: "; docker exec load-test-demo-redis-1 redis-cli INFO clients 2>/dev/null | grep "^connected_clients" | awk -F: "{print \$2}" | tr -d "\r"
echo "Granted (event별):"
docker exec load-test-demo-redis-1 redis-cli KEYS "event:*:count" 2>/dev/null | sort | while read key; do
  val=$(docker exec load-test-demo-redis-1 redis-cli GET "$key" 2>/dev/null | tr -d "\r")
  printf "  %-30s %s\n" "$key" "${val:-0}"
done

echo ""
echo "=== Kafka Consumer Lag ==="
docker exec $(docker ps --filter "ancestor=apache/kafka:3.7.0" --format "{{.ID}}" | head -1) \
  /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --describe --group point-ledger-group 2>/dev/null \
  | awk "NR==1 || /point-ledger/"

echo ""
echo "=== Data Consistency (Redis granted vs DB ledger) ==="
KAFKA_ID=$(docker ps --filter "ancestor=apache/kafka:3.7.0" --format "{{.ID}}" | head -1)
MYSQL_ID=$(docker ps --filter "ancestor=mysql:8.4.8" --format "{{.ID}}" | head -1)
printf "Kafka total msgs : "; docker exec "$KAFKA_ID" \
  /opt/kafka/bin/kafka-get-offsets.sh --bootstrap-server localhost:9092 --topic point-events 2>/dev/null \
  | awk -F: "{print \$3}"
docker exec load-test-demo-redis-1 redis-cli KEYS "event:*:count" 2>/dev/null | sort | while read key; do
  event_id=$(echo "$key" | sed "s/event://;s/:count//")
  redis_cnt=$(docker exec load-test-demo-redis-1 redis-cli GET "$key" 2>/dev/null | tr -d "\r")
  db_cnt=$(docker exec "$MYSQL_ID" mysql -u root -p1234 -se \
    "SELECT COUNT(*) FROM test_db.point_ledger WHERE event_id=\"${event_id}\";" 2>/dev/null | tail -1)
  printf "  event %-8s  Redis: %-8s  DB: %s\n" "${event_id}" "${redis_cnt:-N/A}" "${db_cnt:-N/A}"
done
'
