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
echo "=== DB Ledger Count ==="
MYSQL_ID=$(docker ps --filter "ancestor=mysql:8.4.8" --format "{{.ID}}" | head -1)
printf "event 1 DB count: "; docker exec "$MYSQL_ID" mysql -u root -p1234 -se \
  "SELECT COUNT(*) FROM test_db.point_ledger WHERE event_id=1;" 2>/dev/null | tail -1
'
