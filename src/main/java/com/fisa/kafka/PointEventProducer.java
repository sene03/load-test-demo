package com.fisa.kafka;

import com.fisa.event.PointEvent;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

@Slf4j
@Component
@RequiredArgsConstructor
public class PointEventProducer {

    static final String TOPIC = "point-events";
    static final String FALLBACK_FILE = "logs/kafka-fallback.log";

    private final KafkaTemplate<String, String> kafkaTemplate;
    private final ObjectMapper objectMapper;

    // 예외를 밖으로 던지지 않음 — Kafka 실패는 fallback으로 처리, PointService의 Redis catch에 잡히면 안 됨
    public void publish(PointEvent event) {
        try {
            String payload = objectMapper.writeValueAsString(event);
            kafkaTemplate.send(TOPIC, event.getEventId(), payload)
                    .whenComplete((result, ex) -> {
                        if (ex != null) {
                            log.error("Kafka produce failed: eventId={}, userId={} — writing to fallback",
                                    event.getEventId(), event.getUserId(), ex);
                            writeFallback(event);
                        } else {
                            log.debug("Kafka produce OK: eventId={}, userId={}, partition={}, offset={}",
                                    event.getEventId(), event.getUserId(),
                                    result.getRecordMetadata().partition(),
                                    result.getRecordMetadata().offset());
                        }
                    });
        } catch (Exception e) {
            log.error("Kafka publish error: {} — writing to fallback", e.getMessage());
            writeFallback(event);
        }
    }

    private synchronized void writeFallback(PointEvent event) {
        try {
            Path path = Path.of(FALLBACK_FILE);
            Files.createDirectories(path.getParent());
            String line = objectMapper.writeValueAsString(event) + "\n";
            Files.writeString(path, line, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException e) {
            log.error("Failed to write fallback: {}", e.getMessage());
        }
    }
}
