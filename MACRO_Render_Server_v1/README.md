# MACRO Control — Render Relay

MACRO Ver 2.0의 중앙 중계 서버 기본본입니다.

## Render
- Build Command: `npm install`
- Start Command: `npm start`
- Health Check: `/health`
- 환경변수: `HOST_SECRET`, `SESSION_SECRET`

`render.yaml`을 사용하면 두 비밀값은 Render에서 자동 생성할 수 있습니다.

## 보안 경계
카카오 인증 세션, `auth.json`, 대화 내용과 로컬 메시지 보관 파일은 이 서버에 업로드하지 않습니다. 실제 카카오 연결은 총괄 PC Host에서 유지합니다.

## 현재 단계
이 저장소는 Render가 바로 실행할 수 있는 중앙 relay 기본본입니다. 회원가입/로그인/라이선스 DB와 기존 MACRO Host/Windows/Android 앱 연결은 다음 단계에서 기존 프로젝트에 맞춰 연결합니다.
