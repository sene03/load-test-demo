# 1단계: 빌드 스테이지
FROM amazoncorretto:17-alpine AS build
WORKDIR /app

# Gradle 래퍼 & 설정 파일 먼저 복사 (캐시 레이어 분리)
COPY gradlew .
COPY gradle gradle
COPY build.gradle .
COPY settings.gradle .

# Gradle 배포본 & 의존성만 먼저 다운로드 (소스 변경 시 이 레이어 재사용)
RUN chmod +x ./gradlew && ./gradlew dependencies --no-daemon

# 소스코드는 마지막에 복사
COPY src src

# 소스만 컴파일 (이미 다운로드된 캐시 활용)
RUN ./gradlew clean build -x test --no-daemon

# 2단계: 실행 스테이지
FROM amazoncorretto:17-alpine
WORKDIR /app

COPY --from=build /app/build/libs/*.jar app.jar

ENTRYPOINT ["java", "-jar", "app.jar"]

# 로컬에서 빌드 후 도커만 재시작
# 명령어:
# ./gradlew clean build -x test && docker-compose up -d --build --no-deps api
#FROM amazoncorretto:17-alpine AS build
#WORKDIR /app
#
#COPY gradlew .
#COPY gradle gradle
#COPY build.gradle .
#COPY settings.gradle .
#COPY src src
#
## 호스트에서 미리 빌드한 jar를 그냥 복사
#FROM amazoncorretto:17-alpine
#WORKDIR /app
#COPY build/libs/*.jar app.jar
#ENTRYPOINT ["java", "-jar", "app.jar"]