package com.fisa.service;

import com.fisa.domain.PointLedger;
import com.fisa.event.PointEvent;
import com.fisa.kafka.PointEventProducer;
import com.fisa.repository.PointLedgerRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.List;

@Slf4j
@Service
@RequiredArgsConstructor
public class PointService {

    private final PointLedgerRepository pointLedgerRepository;
    private final StringRedisTemplate redisTemplate;
    private final PointEventProducer pointEventProducer;

    @Value("${event.max-claims}")
    private int maxClaims;

    // Lua 스크립트: duplicate check → count check → increment → user 등록 (원자적 실행)
    // KEYS[1] = event:{eventId}:count, KEYS[2] = event:{eventId}:users
    // ARGV[1] = userId, ARGV[2] = maxClaims
    private static final RedisScript<String> CLAIM_SCRIPT = RedisScript.of("""
            if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then
              return 'DUPLICATE'
            end
            local count = tonumber(redis.call('GET', KEYS[1]) or '0')
            if count >= tonumber(ARGV[2]) then
              return 'SOLD_OUT'
            end
            redis.call('INCR', KEYS[1])
            redis.call('SADD', KEYS[2], ARGV[1])
            return 'SUCCESS'
            """, String.class);

    public ClaimResult claim(String eventId, String userId) {
        try {
            String countKey = "event:" + eventId + ":count";
            String usersKey = "event:" + eventId + ":users";

            String result = redisTemplate.execute(
                    CLAIM_SCRIPT,
                    List.of(countKey, usersKey),
                    userId,
                    String.valueOf(maxClaims)
            );

            return switch (result) {
                case "DUPLICATE" -> ClaimResult.DUPLICATE;
                case "SOLD_OUT"  -> ClaimResult.SOLD_OUT;
                // SUCCESS → Kafka 비동기 발행 (DB write는 consumer가 처리)
                default          -> {
                    pointEventProducer.publish(new PointEvent(eventId, userId, LocalDateTime.now().toString()));
                    yield ClaimResult.SUCCESS;
                }
            };

        } catch (org.springframework.data.redis.RedisConnectionFailureException |
                 org.springframework.data.redis.RedisSystemException e) {
            log.warn("Redis unavailable, falling back to DB: {}", e.getMessage());
            return claimFromDb(eventId, userId);
        }
    }

    @Transactional
    protected ClaimResult saveToDb(String eventId, String userId) {
        pointLedgerRepository.save(new PointLedger(eventId, userId));
        return ClaimResult.SUCCESS;
    }

    @Transactional
    protected ClaimResult claimFromDb(String eventId, String userId) {
        if (pointLedgerRepository.existsByEventIdAndUserId(eventId, userId)) {
            return ClaimResult.DUPLICATE;
        }
        long currentCount = pointLedgerRepository.countByEventId(eventId);
        if (currentCount >= maxClaims) {
            return ClaimResult.SOLD_OUT;
        }
        pointLedgerRepository.save(new PointLedger(eventId, userId));
        return ClaimResult.SUCCESS;
    }

    public enum ClaimResult {
        SUCCESS, DUPLICATE, SOLD_OUT
    }
}
