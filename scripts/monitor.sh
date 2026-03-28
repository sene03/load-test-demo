watch -n 1 '
echo "=== Tomcat Worker Threads (exec only) ==="
curl -s http://localhost:8080/actuator/threaddump | jq "
  [.threads[] | select(.threadName | test(\"http-nio.*exec\"))] |
  {
    total:   length,
    running: [.[] | select(.threadState == \"RUNNABLE\")]      | length,
    waiting: [.[] | select(.threadState == \"TIMED_WAITING\")] | length,
    blocked: [.[] | select(.threadState == \"BLOCKED\")]       | length
  }
"
echo ""
echo "=== HikariCP ==="
echo -n "Active:  "; curl -s http://localhost:8080/actuator/metrics/hikaricp.connections.active  | jq ".measurements[0].value"
echo -n "Pending: "; curl -s http://localhost:8080/actuator/metrics/hikaricp.connections.pending | jq ".measurements[0].value"
echo -n "Idle:    "; curl -s http://localhost:8080/actuator/metrics/hikaricp.connections.idle    | jq ".measurements[0].value"
'