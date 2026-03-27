package com.fisa.controller;

import com.fisa.dto.PointClaimRequest;
import com.fisa.dto.PointClaimResponse;
import com.fisa.service.PointService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/events")
@RequiredArgsConstructor
public class PointController {

    private final PointService pointService;

    @PostMapping("/{eventId}/points")
    public ResponseEntity<PointClaimResponse> claimPoints(
            @PathVariable String eventId,
            @RequestBody PointClaimRequest request
    ) {
        PointService.ClaimResult result = pointService.claim(eventId, request.userId());

        return switch (result) {
            case SUCCESS -> ResponseEntity.ok(PointClaimResponse.of("SUCCESS"));
            case DUPLICATE -> ResponseEntity.status(HttpStatus.CONFLICT)
                    .body(PointClaimResponse.of("DUPLICATE"));
            case SOLD_OUT -> ResponseEntity.status(HttpStatus.GONE)
                    .body(PointClaimResponse.of("SOLD_OUT"));
        };
    }
}
