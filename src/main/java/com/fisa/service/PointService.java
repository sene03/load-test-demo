package com.fisa.service;

import com.fisa.domain.PointLedger;
import com.fisa.repository.PointLedgerRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class PointService {

    private final PointLedgerRepository pointLedgerRepository;

    @Value("${event.max-claims}")
    private int maxClaims;

    @Transactional // 하나의 트랜잭션으로 묶기
    public ClaimResult claim(String eventId, String userId) {
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
