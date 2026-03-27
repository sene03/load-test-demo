package com.fisa.domain;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.NoArgsConstructor;

import java.time.LocalDateTime;

@Entity
@Table(
        name = "point_ledger",
        uniqueConstraints = @UniqueConstraint(
                name = "uk_event_user",
                columnNames = {"event_id", "user_id"}
        )
)
@Getter
@NoArgsConstructor
public class PointLedger {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "event_id", nullable = false, length = 100)
    private String eventId;

    @Column(name = "user_id", nullable = false, length = 100)
    private String userId;

    @Column(name = "granted_at", nullable = false)
    private LocalDateTime grantedAt;

    public PointLedger(String eventId, String userId) {
        this.eventId = eventId;
        this.userId = userId;
        this.grantedAt = LocalDateTime.now();
    }
}
