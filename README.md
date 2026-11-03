# 서울 방구 시뮬레이터

항문 크기가 방구 세기를 결정하는 서울 거리 3D 시뮬레이터입니다.
주황색 네모 얼굴의 주인공이 서울 한복판에서 방구를 뀌고, 세게 뀌면 하늘을 날고 지나가던 페라리가 날아갑니다.

**바로 하기: https://aejover.github.io/seoul-bangu-sim/**

- 인도를 걷는 사람들과 자전거(따릉이) 타는 사람들: 관절이 있어서 걷고, 페달을 밟고, 방구에 반응합니다 (웃기, 코 막기, 도망, 비명, 날아가기, 일어나서 화내기)
- 사람 얼굴은 webgl_decals 예제의 Lee Perry-Smith 스캔. 감은 눈 위에 뜬 눈을 데칼로 붙였고, 입술을 갈라 턱을 벌릴 수 있게 한 뒤 표정 모프(웃음·놀람·역겨움·슬픔·찡그림)를 넣었습니다. 여자는 턱·코·입술 모양과 화장, 긴 머리
- 페라리 타기 (E), 방구 부스터
- 아주 센 방구는 은행나무와 빌딩까지 날려 버립니다
- 카메라 시점 5가지: 1인칭, 3인칭, 사람들, 도시 전체, 자동 연출

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
| E 페라리 타기 / 내리기 (운전: W 가속, S 브레이크, A/D 핸들) | 🏎️ 타기 버튼 |
| 1~5 / C 카메라 시점, Tab 다른 사람 | 패널의 카메라 시점 버튼 |
| R 제자리로 | |
| 마우스 드래그 = 카메라 | 한 손가락 드래그 = 카메라 |

## URL 옵션

- `?quality=low` / `?quality=high` — 그래픽 품질 (폰·태블릿은 자동으로 low)
- `?cars=40` — 페라리 대수
- `?people=30&bikes=8` — 걷는 사람 / 자전거 수
- `?tiles=6` — 도시 크기 (짝수 권장)
- `?pipeline=default` — 메시렛 파이프라인 끄기

## 로컬 실행

빌드 과정이 없는 정적 사이트입니다. Node.js 만 있으면 됩니다.

```bash
node server.js 5173
```

그리고 http://localhost:5173 을 엽니다. WebGPU 를 지원하는 최신 Chrome / Edge / Safari 를 권장합니다 (지원하지 않으면 WebGL 2 로 떨어집니다).

## 구성

- `src/main.js` — 렌더러, 도시, UI, 입력
- `src/rig.js` — male02 모델 자동 리깅 (19개 관절, 측지선 스키닝), 포즈 풀이, IK
- `src/character.js` — 나 (네모 얼굴), 포즈, 비행 물리
- `src/face.js` — 행인 얼굴: 스캔 가공, 뜬 눈 데칼, 표정 모프, 머리카락, 화장
- `src/people.js` — 행인과 자전거, 길 찾기, 방구 반응, 날아가기
- `src/destruction.js` — 나무·빌딩 날리기
- `src/director.js` — 카메라 시점과 자동 연출
- `src/fart.js` — 방구 물리, 가스 입자, 충격파
- `src/traffic.js` — 페라리 교통 (차선, 신호, 회전, 경적, 날아가기)
- `src/seoul.js` — 한글 간판, 도로 표시, 은행나무, 남산타워·롯데월드타워·63빌딩·한강
- `src/audio.js` — WebAudio 로 합성한 방구 소리와 효과음

## 크레딧

- [three.js](https://threejs.org) (MIT) — 렌더러, `CityGenerator`, `MeshletDrawingPipeline`, 예제 코드
- 모델: three.js 예제의 `male02` (webgl_loader_obj), `ferrari.glb` (webgl_materials_car), `LeePerrySmith.glb` (webgl_decals)
- 폰트: Black Han Sans, Jua (Google Fonts, OFL)

## 라이선스

MIT
