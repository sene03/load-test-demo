package com.fisa.cache;

import com.fisa.service.PointService.ClaimResult;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Queue;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 로컬 포인트 캐시 — 요청마다 Redis를 호출하는 대신 로컬에서 처리하고
 * 100ms마다 Redis에 일괄 반영한다.
 *
 * 트레이드오프:
 * - flush 주기 동안 인스턴스 간 카운트가 공유되지 않아
 *   maxClaims를 소폭 초과할 수 있음 (레이스 컨디션)
 * - 같은 유저가 100ms 이내 다른 인스턴스로 요청하면 중복 지급 가능
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class LocalPointCache {

    private final StringRedisTemplate redisTemplate;

    @Value("${event.max-claims}")
    private int maxClaims;

    // eventId → 이벤트별 로컬 상태
    private final ConcurrentHashMap<String, EventCache> caches = new ConcurrentHashMap<>();

    public ClaimResult claim(String eventId, String userId) {
        return caches.computeIfAbsent(eventId, EventCache::new).claim(userId, maxClaims);
    }

    @Scheduled(fixedDelay = 1000)  // 1000ms마다 Redis에 flush (100ms는 Redis 명령 폭주 유발)
    public void flush() {
        caches.forEach((eventId, cache) -> cache.flush(redisTemplate, maxClaims));
    }

    // ── 이벤트별 로컬 상태 ─────────────────────────────────────────────────────
    static class EventCache {

        final String eventId;

        // 이 인스턴스에서 지금까지 승인된 유저 (중복 체크용)
        final Set<String> grantedUsers = ConcurrentHashMap.newKeySet();

        // 이 인스턴스에서 승인한 누적 카운트
        final AtomicLong localCount = new AtomicLong(0);

        // 다음 flush에 Redis로 보낼 유저 목록
        final Queue<String> pendingFlush = new ConcurrentLinkedQueue<>();

        // 글로벌 sold-out 플래그 (flush 시 Redis 카운트 확인 후 갱신)
        volatile boolean soldOut = false;

        EventCache(String eventId) {
            this.eventId = eventId;
        }

        ClaimResult claim(String userId, int maxClaims) {
            if (soldOut) return ClaimResult.SOLD_OUT;

            // 로컬 중복 체크 — add()가 false면 이미 존재
            if (!grantedUsers.add(userId)) return ClaimResult.DUPLICATE;

            long count = localCount.incrementAndGet();
            if (count > maxClaims) {
                grantedUsers.remove(userId); // 롤백
                soldOut = true;
                return ClaimResult.SOLD_OUT;
            }

            pendingFlush.add(userId);
            return ClaimResult.SUCCESS;
        }

        void flush(StringRedisTemplate redis, int maxClaims) {
            // pending 유저를 한 번에 수집
            List<String> batch = new ArrayList<>();
            String u;
            while ((u = pendingFlush.poll()) != null) batch.add(u);
            if (batch.isEmpty()) return;

            String countKey = "event:" + eventId + ":count";
            String usersKey = "event:" + eventId + ":users";

            // Redis에 일괄 반영
            redis.opsForSet().add(usersKey, batch.toArray(new String[0]));
            Long globalCount = redis.opsForValue().increment(countKey, batch.size());

            // 글로벌 카운트 기준으로 sold-out 갱신
            if (globalCount != null && globalCount >= maxClaims) {
                soldOut = true;
                log.info("[LocalPointCache] event:{} sold out (globalCount={})", eventId, globalCount);
            }
        }
    }
}
