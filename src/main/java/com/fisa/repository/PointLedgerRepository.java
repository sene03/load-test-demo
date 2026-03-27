package com.fisa.repository;

import com.fisa.domain.PointLedger;
import org.springframework.data.jpa.repository.JpaRepository;

public interface PointLedgerRepository extends JpaRepository<PointLedger, Long> {

    boolean existsByEventIdAndUserId(String eventId, String userId);

    long countByEventId(String eventId);
}
