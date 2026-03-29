package com.fisa.kafka;

import com.fisa.event.PointEvent;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * F-3.6: Kafka 발행 실패 시 fallback 파일에 저장된 이벤트를 주기적으로 재발행
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class FallbackReconciler {

    private final KafkaTemplate<String, String> kafkaTemplate;
    private final ObjectMapper objectMapper;

    @Scheduled(fixedDelay = 60_000)
    public void reconcile() {
        Path fallback = Path.of(PointEventProducer.FALLBACK_FILE);
        if (!Files.exists(fallback)) return;

        Path processing = Path.of(PointEventProducer.FALLBACK_FILE + ".processing");
        try {
            Files.move(fallback, processing, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException e) {
            return;
        }

        List<String> failed = new ArrayList<>();
        try (BufferedReader reader = Files.newBufferedReader(processing)) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) continue;
                try {
                    PointEvent event = objectMapper.readValue(line, PointEvent.class);
                    kafkaTemplate.send(PointEventProducer.TOPIC, event.getEventId(), line)
                            .get(1, TimeUnit.SECONDS);
                    log.info("Reconciled: eventId={}, userId={}", event.getEventId(), event.getUserId());
                } catch (Exception e) {
                    log.warn("Reconciliation re-publish failed: {}", line);
                    failed.add(line);
                }
            }
        } catch (IOException e) {
            log.error("Failed to read processing file", e);
            return;
        }

        try {
            Files.delete(processing);
            if (!failed.isEmpty()) {
                Files.write(Path.of(PointEventProducer.FALLBACK_FILE), failed,
                        StandardOpenOption.CREATE, StandardOpenOption.APPEND);
                log.warn("Reconciliation: {} events re-queued to fallback", failed.size());
            }
        } catch (IOException e) {
            log.error("Failed to clean up processing file", e);
        }
    }
}
