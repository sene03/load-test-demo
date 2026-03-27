package com.fisa.dto;

public record PointClaimResponse(String result) {

    public static PointClaimResponse of(String result) {
        return new PointClaimResponse(result);
    }
}
