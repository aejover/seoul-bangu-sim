# 서울 방구 시뮬레이터

항문 크기가 방구 세기를 결정하는 서울 거리 3D 시뮬레이터입니다.
주황색 네모 얼굴의 주인공이 서울 한복판에서 방구를 뀌고, 세게 뀌면 하늘을 날고 지나가던 페라리가 날아갑니다.

## 물리

| 값 | 식 |
| --- | --- |
| 개구 면적 | A = π d² / 4 |
| 분출 추력 | F = 2 · P · A (P = 80 kPa) |
| 음높이 | 3200 / d Hz |
| 소리 크기 | 50 + 16 · log₁₀(1 + F) dB |
| 이륙 조건 | 0.8 F > 70 kg · g → 지름 약 83 mm |

## 조작

| 키보드 | 터치 |
| --- | --- |
| WASD / 방향키 걷기, Shift 달리기 | 왼쪽 아래 조이스틱 (끝까지 밀면 달리기) |
| Space 꾹 = 방구 | 방구 뀌기 버튼 |
| 공중에서 W/S 기울기, A/D 방향 | 조이스틱 |
| R 제자리로 | |
| 마우스 드래그 = 카메라 | 한 손가락 드래그 = 카메라 |

## URL 옵션

- `?quality=low` / `?quality=high` — 그래픽 품질 (폰·태블릿은 자동으로 low)
- `?cars=40` — 페라리 대수
- `?tiles=6` — 도시 크기 (짝수 권장)
- `?pipeline=default` — 메시렛 파이프라인 끄기

## 로컬 실행

빌드 과정이 없는 정적 사이트입니다. Node.js 만 있으면 됩니다.

```bash
node server.js 5173
```

그리고 http://localhost:5173 을 엽니다. WebGPU 를 지원하는 최신 Chrome / Edge / Safari 를 권장합니다 (지원하지 않으면 WebGL 2 로 떨어집니다).

## 구성

- `src/main.js` — 렌더러, 도시, 카메라, UI, 입력
- `src/character.js` — male02 모델 자동 리깅 (19개 관절, 측지선 스키닝), 포즈, 비행 물리
- `src/fart.js` — 방구 물리, 가스 입자, 충격파
- `src/traffic.js` — 페라리 교통 (차선, 신호, 회전, 경적, 날아가기)
- `src/seoul.js` — 한글 간판, 도로 표시, 은행나무, 남산타워·롯데월드타워·63빌딩·한강
- `src/audio.js` — WebAudio 로 합성한 방구 소리와 효과음

## 크레딧

- [three.js](https://threejs.org) (MIT) — 렌더러, `CityGenerator`, `MeshletDrawingPipeline`, 예제 코드
- 모델: three.js 예제의 `male02` (webgl_loader_obj), `ferrari.glb` (webgl_materials_car)
- 폰트: Black Han Sans, Noto Sans KR (Google Fonts, OFL)

## 라이선스

MIT
