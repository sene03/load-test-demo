package com.fisa.service;

import com.fisa.cache.LocalPointCache;
import com.fisa.event.PointEvent;
import com.fisa.kafka.PointEventProducer;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;

@Service
@RequiredArgsConstructor
public class PointService {

    private final LocalPointCache localPointCache;
    private final PointEventProducer pointEventProducer;

    public ClaimResult claim(String eventId, String userId) {
        ClaimResult result = localPointCache.claim(eventId, userId);
        if (result == ClaimResult.SUCCESS) {
            pointEventProducer.publish(new PointEvent(eventId, userId, LocalDateTime.now().toString()));
        }
        return result;
    }

    public enum ClaimResult {
        SUCCESS, DUPLICATE, SOLD_OUT
    }
}
