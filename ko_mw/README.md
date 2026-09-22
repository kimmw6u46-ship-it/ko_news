# 월드 브리핑 (World Briefing)

전쟁 · AI · 재난 · 경제 · 국제정치 · 보건 경보를 **최근 3일치만** 모아 한국어로 보여주는 실시간 브리핑
대시보드입니다. 휴대폰 브라우저에서 그대로 열리고, 홈 화면에 추가하면 앱처럼 전체 화면으로 실행됩니다.

## 화면

- **종합속보 티커** — 구글 뉴스 헤드라인이 상단에 흐릅니다.
- **공식 센서 · 1차 경보** — USGS 지진(규모 4.5+)과 GDACS 글로벌 재난 경보를 언론사를 거치지 않고 직접
  받아옵니다.
- **카테고리 6종** — 전쟁·분쟁 / AI / 재난 / 경제 / 국제정치 / 보건 경보. 칩을 눌러 한 카테고리만 볼 수
  있습니다.
- **화이트리스트 토글** — 켜면 Reuters·AP·BBC·WHO·CDC 등 지정 도메인으로 검색을 한정하고, 끄면 더 폭넓은
  결과를 보여줍니다.
- **연결 진단** — 각 섹션 API의 응답 시간과 건수를 한 번에 점검합니다.

## 동작 방식

기사 수집은 전부 **서버(Netlify Functions)에서** 일어납니다. 브라우저가 외부 사이트에 직접 붙지 않으므로
CORS 우회 프록시가 필요 없고, 공용 프록시를 막아 둔 모바일 네트워크나 회사망에서도 똑같이 열립니다.

`GET /api/news/:section` 하나가 모든 섹션을 처리합니다.

1. 섹션에 맞는 RSS/Atom 피드를 서버에서 가져옵니다. 화이트리스트 모드에서는 구글 뉴스 **한국어판과
   영문판을 함께** 조회합니다 — Reuters·AP 같은 매체는 영문으로 기사를 내기 때문에 한국어 검색어만으로는
   결과가 거의 잡히지 않습니다.
2. 3일 이내 기사만 남기고, 중복과 기사 아닌 항목(그림 캡션, 저장소 이름, 섹션 색인 페이지)을 걸러냅니다.
3. 한글이 없는 제목은 Netlify AI Gateway(Claude Haiku)로 한 번에 묶어 번역하고, 결과를 Netlify Blobs에
   저장해 같은 제목을 다시 번역하지 않습니다.
4. 응답은 CDN에 5분 캐시됩니다. 방문자가 몰려도 상위 피드 호출과 번역은 한 번만 일어납니다.
5. 상위 피드가 죽으면 Blobs에 저장된 **마지막 정상 응답**을 `⏳` 배지와 함께 보여줍니다 — 빈 화면을
   띄우지 않습니다.

## 기술 스택

| 영역 | 사용 기술 |
|------|-----------|
| 프런트엔드 | 프레임워크 없는 단일 HTML + 인라인 CSS/JS (`public/index.html`) |
| API | Netlify Functions (TypeScript, `.mts`) |
| 피드 파싱 | `fast-xml-parser` |
| 번역 | Netlify AI Gateway + `@anthropic-ai/sdk` (`claude-haiku-4-5`) |
| 캐시·스냅숏 | Netlify Blobs |
| 이미지 | Netlify Image CDN (`/.netlify/images`) |

## 로컬에서 실행하기

```bash
npm install
npm run dev          # netlify dev --port 8889
```

`http://localhost:8889` 을 엽니다. 함수와 Blobs, Image CDN까지 로컬에서 그대로 흉내 냅니다.
AI Gateway는 프로덕션 배포가 한 번 있어야 활성화되며, 번역이 실패하면 원문 제목이 그대로 표시됩니다.

## 디렉터리

```
public/
  index.html             대시보드 전체 (마크업 · 스타일 · 클라이언트 로직)
  manifest.webmanifest   홈 화면 추가용 PWA 매니페스트
  img/                   AI로 생성한 앱 아이콘 / 공유 이미지
netlify/functions/
  news.mts               GET /api/news/:section
scripts/
  generate-images.mjs    아이콘·OG 이미지 1회 생성 스크립트
```

## 커스터마이즈

카테고리, 검색어, 화이트리스트 도메인은 `netlify/functions/news.mts` 상단의 `SECTIONS` 한 곳에서
관리합니다. 카테고리를 추가하면 `public/index.html` 의 `CATEGORIES` 배열에 같은 `id`로 색과 라벨만
추가하면 됩니다.
