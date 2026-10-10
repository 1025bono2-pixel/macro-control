# MACRO Render Server v2

Manager PC와 웹/Windows/Android MACRO 클라이언트 사이의 HTTPS/WSS 릴레이입니다.

Render 환경변수 `HOST_SECRET`을 설정하고 Manager PC의 `MACRO_HOST_SECRET`과 동일하게 맞추세요.

- `/health`: Host 연결 상태
- `/host`: Manager PC WebSocket
- `/api/*`: Manager PC 로컬 API로 프록시
- `/`: MACRO UI

Kakao 인증 파일과 로컬 메시지 아카이브는 Render에 저장하지 않습니다.
