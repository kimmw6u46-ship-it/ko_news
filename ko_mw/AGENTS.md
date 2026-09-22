# AGENTS.md

월드 브리핑 — 세계 소식 브리핑 대시보드. 프레임워크 없는 정적 페이지 하나 + Netlify Function 하나.

## 아키텍처

```
public/index.html      대시보드 전체 (마크업 · 스타일 · 클라이언트 로직 인라인)
public/manifest.webmanifest
public/img/            AI로 생성한 앱 아이콘 / OG 이미지 (커밋된 산출물)
netlify/functions/news.mts   GET /api/news/:section — 모든 섹션을 처리하는 단일 엔드포인트
scripts/generate-images.mjs  아이콘·OG 이미지 1회 생성 (빌드마다 돌리지 않음)
netlify.toml           publish = "public", 함수 디렉터리, 캐시 헤더
```

빌드 단계가 없다. `public/`을 그대로 배포하고, 함수만 esbuild로 번들한다.

## 데이터 흐름

브라우저 → `/api/news/:section` → (서버) RSS 조회 → 필터 → 번역 → JSON.

프런트엔드는 외부 도메인에 **직접 붙지 않는다**. 원본 파일은 공용 CORS 프록시
(allorigins/codetabs/corsproxy)를 거쳤는데, 모바일·회사망에서 자주 막히는 지점이었다. 수집을 서버로
옮긴 것이 이 프로젝트의 핵심 결정이다. 프록시를 프런트로 되돌리지 말 것.

## 비자명한 결정들

- **한국어판 + 영문판 동시 조회.** 화이트리스트 모드에서 `SECTIONS[x].query`(한국어)와
  `queryEn`(영문)을 각각 구글 뉴스 ko / en-US 에디션에 던져 병합한다. Reuters·AP·BBC는 영문으로 기사를
  내므로 한국어 검색어만으로는 대부분 0건이 나온다. 카테고리를 추가할 때 `queryEn`을 빼먹으면 그
  카테고리는 사실상 비어 보인다.
- **번역은 필터 뒤에.** `looksLikeNoise()` → 3일 필터 → 중복 제거 → 8건 슬라이스 → 그 다음 번역.
  순서를 바꾸면 버려질 항목까지 번역한다.
- **번역 메모는 Blobs `translations` 스토어.** 키는 원문 제목의 FNV 해시(`cacheKey`). 같은 기사가 여러
  카테고리에 겹쳐 나오므로 재사용률이 높다.
- **`feed-snapshots` 스토어는 장애용.** 모든 상위 피드가 실패하면 마지막 정상 응답을 `stale: true`로
  반환하고 UI가 `⏳` 배지를 붙인다. 502로 빈 화면을 주지 않는다.
- **타임아웃이 함수 한계보다 짧아야 한다.** `UPSTREAM_TIMEOUT_MS` 6s, `TRANSLATE_TIMEOUT_MS` 7s
  (`maxRetries: 0`). 번역이 늦어도 원문 제목으로 응답이 나간다.
- **캐시 2단.** `Cache-Control: max-age=60` (브라우저) + `Netlify-CDN-Cache-Control: s-maxage=300,
  stale-while-revalidate=1800` (CDN). 사용자가 직접 새로고침할 때만 `_` 파라미터로 우회하고, 10분 자동
  갱신은 CDN 캐시를 탄다.
- **이미지는 원본을 직접 참조하지 않는다.** `public/img/*.png`는 1MB 내외 모델 출력물이라 항상
  `/.netlify/images?url=...&w=...` 로 경유한다.
- **SSRF 여지 없음.** 섹션 id는 `SECTIONS` 키로만 해석한다. 임의 URL을 받는 파라미터를 추가하지 말 것.
- **Service Worker 없음.** 배포 직후 낡은 셸이 남는 문제를 피하려 의도적으로 넣지 않았다. 매니페스트와
  apple-touch-icon만으로 홈 화면 추가를 지원한다.

## 코딩 규칙

- 함수는 `.mts`, v2 형식(`export default async (req, context)`) + `export const config`.
  AI Gateway 자격증명은 구형 `exports.handler` 런타임에 주입되지 않는다.
- 주석과 UI 문구는 한국어.
- `public/index.html`은 단일 파일 유지. 외부 피드에서 온 문자열은 반드시 `esc()`를 거쳐 삽입한다.
- 카테고리 추가: `news.mts`의 `SECTIONS`(`query` + `queryEn` + `whitelist`)와 `index.html`의
  `CATEGORIES`(같은 `id`, 라벨, 색)를 함께 수정.
- 모바일 우선. 탭 대상 최소 높이 36px, `env(safe-area-inset-*)` 사용, 720px 이하 브레이크포인트 유지.
