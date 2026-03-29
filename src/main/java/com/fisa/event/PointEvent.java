package com.fisa.event;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
public class PointEvent {
    private String eventId;
    private String userId;
    private String claimedAt; // ISO-8601 문자열 (Jackson 3 호환성을 위해 String 사용)
}
