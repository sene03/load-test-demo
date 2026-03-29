package com.fisa.kafka;

import com.fisa.domain.PointLedger;
import com.fisa.event.PointEvent;
import com.fisa.repository.PointLedgerRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

@Slf4j
@Component
@RequiredArgsConstructor
public class PointEventConsumer {

    private final PointLedgerRepository pointLedgerRepository;
    private final ObjectMapper objectMapper;

    @KafkaListener(topics = PointEventProducer.TOPIC, groupId = "point-ledger-group")
    public void consume(String payload) {
        try {
            PointEvent event = objectMapper.readValue(payload, PointEvent.class);
            pointLedgerRepository.save(new PointLedger(event.getEventId(), event.getUserId()));
        } catch (DataIntegrityViolationException e) {
            // 동일 이벤트 중복 수신 → 무시 (idempotent)
            log.debug("Duplicate event ignored: {}", payload);
        } catch (Exception e) {
            log.error("Consumer error for payload: {} — {}", payload, e.getMessage());
            throw new RuntimeException(e); // Kafka가 retry하도록 re-throw
        }
    }
}
