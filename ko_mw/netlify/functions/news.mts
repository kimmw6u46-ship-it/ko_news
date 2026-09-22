import type { Config, Context } from '@netlify/functions'
import { XMLParser } from 'fast-xml-parser'
import { getStore } from '@netlify/blobs'
import Anthropic from '@anthropic-ai/sdk'

/**
 * /api/news/:section
 *
 * 브라우저 대신 서버에서 RSS를 가져온다. CORS 우회 프록시가 필요 없고,
 * 모바일 네트워크·회사망에서 차단될 여지가 사라진다.
 *
 * 응답: { section, items, fetchedAt, stale, notes }
 */

const MAX_ITEMS = 8
const WINDOW_MS = 3 * 24 * 60 * 60 * 1000 // 최근 3일
const UPSTREAM_TIMEOUT_MS = 6000
const TRANSLATE_TIMEOUT_MS = 7000

type Section = {
  id: string
  label: string
  kind: 'news' | 'sensor' | 'ticker'
  query?: string
  /** 화이트리스트 매체는 대부분 영문이라, 영문 에디션 검색어를 따로 둔다. */
  queryEn?: string
  whitelist?: string[]
  feeds?: { url: string; source: string; format: 'rss' | 'atom' }[]
}

const SECTIONS: Record<string, Section> = {
  top: {
    id: 'top',
    label: '종합 속보',
    kind: 'ticker',
    feeds: [
      {
        url: 'https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko',
        source: '',
        format: 'rss',
      },
    ],
  },
  primary: {
    id: 'primary',
    label: '공식 센서 · 1차 경보',
    kind: 'sensor',
    feeds: [
      {
        url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.atom',
        source: 'USGS',
        format: 'atom',
      },
      { url: 'https://www.gdacs.org/xml/rss.xml', source: 'GDACS', format: 'rss' },
    ],
  },
  war: {
    id: 'war',
    label: '전쟁 · 분쟁',
    kind: 'news',
    whitelist: ['reuters.com', 'apnews.com', 'bbc.com', 'aljazeera.com'],
    query: '전쟁 OR 분쟁 OR 휴전 OR 공습 OR 교전',
    queryEn: 'war OR conflict OR ceasefire OR airstrike OR offensive OR "front line"',
  },
  ai: {
    id: 'ai',
    label: 'AI',
    kind: 'news',
    whitelist: ['arxiv.org', 'openai.com', 'blog.google', 'theverge.com', 'ieee.org', 'huggingface.co'],
    query: '인공지능 OR AI 모델 OR 챗봇',
    queryEn: '"artificial intelligence" OR "AI model" OR chatbot OR "language model"',
  },
  disaster: {
    id: 'disaster',
    label: '재난 뉴스',
    kind: 'news',
    whitelist: ['reuters.com', 'apnews.com', 'gdacs.org', 'usgs.gov'],
    query: '지진 OR 홍수 OR 산불 OR 태풍 OR 재난',
    queryEn: 'earthquake OR flood OR wildfire OR typhoon OR hurricane OR "natural disaster"',
  },
  econ: {
    id: 'econ',
    label: '경제',
    kind: 'news',
    whitelist: ['reuters.com', 'apnews.com', 'bloomberg.com'],
    query: '금리 OR 증시 OR 경제위기 OR 무역',
    queryEn: '"interest rates" OR "stock market" OR inflation OR tariffs OR recession',
  },
  politics: {
    id: 'politics',
    label: '국제정치',
    kind: 'news',
    whitelist: ['reuters.com', 'apnews.com', 'un.org', 'bbc.com'],
    query: '정상회담 OR 외교 OR 유엔 OR 제재',
    queryEn: 'summit OR diplomacy OR "United Nations" OR sanctions OR treaty',
  },
  health: {
    id: 'health',
    label: '보건 경보',
    kind: 'news',
    whitelist: ['who.int', 'cdc.gov', 'reuters.com', 'apnews.com'],
    query: '전염병 OR 발병 OR 팬데믹 OR 보건경보',
    queryEn: 'outbreak OR epidemic OR pandemic OR "health emergency" OR virus',
  },
  korea: {
    id: 'korea',
    label: '한국 주요 뉴스',
    kind: 'news',
    // 국내 소식은 연합뉴스(국가 기간통신사) 원문을 1순위로 직결하고,
    // 구글 뉴스 검색(국내 방송사·통신사 화이트리스트 한정)을 보조로 붙인다.
    // 이미 한국어라 번역 단계는 자동으로 건너뛴다.
    feeds: [
      { url: 'https://www.yna.co.kr/RSS/news.xml', source: '연합뉴스', format: 'rss' },
      {
        url:
          'https://news.google.com/rss/search?q=' +
          encodeURIComponent(
            '(site:yna.co.kr OR site:news.kbs.co.kr OR site:ytn.co.kr OR site:news.sbs.co.kr OR site:imnews.imbc.com) ' +
              '(속보 OR 발표 OR 결정 OR 논란 OR 사고 OR 정부 OR 국회 OR 대통령) when:3d',
          ) +
          '&hl=ko&gl=KR&ceid=KR:ko',
        source: '',
        format: 'rss',
      },
    ],
  },
}

type Item = {
  title: string
  titleOriginal?: string
  source: string
  link: string
  pubDate: string
  sensor?: boolean
}

const HANGUL = /[가-힣]/

const EDITIONS = {
  ko: 'hl=ko&gl=KR&ceid=KR:ko',
  en: 'hl=en-US&gl=US&ceid=US:en',
} as const

function googleNewsUrl(query: string, edition: keyof typeof EDITIONS) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query + ' when:3d')}&${EDITIONS[edition]}`
}

/**
 * 화이트리스트 매체(Reuters·AP·BBC 등)는 영문으로 기사를 내기 때문에, 한국어 검색어만으로는
 * 결과가 거의 잡히지 않는다. 그래서 신뢰 모드에서는 한국어판과 영문판을 함께 조회하고,
 * 영문 제목은 뒤에서 번역한다. 제한 없는 모드는 한국어판만 본다.
 */
function newsFeeds(section: Section, trustedOnly: boolean) {
  const query = section.query as string
  if (!trustedOnly || !section.whitelist?.length) {
    return [{ url: googleNewsUrl(query, 'ko'), source: '', format: 'rss' as const }]
  }
  const siteFilter = '(' + section.whitelist.map((d) => 'site:' + d).join(' OR ') + ')'
  const feeds = [
    { url: googleNewsUrl(`${siteFilter} (${query})`, 'ko'), source: '', format: 'rss' as const },
  ]
  if (section.queryEn) {
    feeds.push({
      url: googleNewsUrl(`${siteFilter} (${section.queryEn})`, 'en'),
      source: '',
      format: 'rss' as const,
    })
  }
  return feeds
}

function splitSource(title: string) {
  const idx = title.lastIndexOf(' - ')
  if (idx === -1) return { headline: title, source: '' }
  return { headline: title.slice(0, idx), source: title.slice(idx + 3) }
}

function asText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if ('#text' in obj) return asText(obj['#text'])
    if ('@_href' in obj) return asText(obj['@_href'])
  }
  return ''
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

function firstLink(entryLink: unknown): string {
  for (const candidate of toArray(entryLink as unknown[])) {
    if (typeof candidate === 'string' && candidate) return candidate
    const obj = candidate as Record<string, unknown> | null
    if (obj && typeof obj === 'object') {
      const rel = asText(obj['@_rel'])
      if (!rel || rel === 'alternate') {
        const href = asText(obj['@_href'])
        if (href) return href
      }
    }
  }
  return '#'
}

async function fetchFeed(url: string) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // 일부 피드는 브라우저 계열 UA가 아니면 빈 응답을 준다.
        'User-Agent': 'Mozilla/5.0 (compatible; WorldBriefing/1.0; +https://netlify.app)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    if (!text || text.length < 40) throw new Error('빈 응답')
    return text
  } finally {
    clearTimeout(timer)
  }
}

function parseFeed(xml: string, format: 'rss' | 'atom', fallbackSource: string): Item[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    trimValues: true,
    processEntities: true,
  })
  const doc = parser.parse(xml)

  if (format === 'atom') {
    const entries = toArray<Record<string, unknown>>(doc?.feed?.entry)
    return entries.map((entry) => ({
      title: asText(entry.title),
      source: fallbackSource,
      link: firstLink(entry.link),
      pubDate: asText(entry.updated) || asText(entry.published),
    }))
  }

  const items = toArray<Record<string, unknown>>(doc?.rss?.channel?.item)
  return items.map((item) => {
    const rawTitle = asText(item.title)
    if (fallbackSource) {
      return {
        title: rawTitle,
        source: fallbackSource,
        link: asText(item.link) || '#',
        pubDate: asText(item.pubDate),
      }
    }
    const { headline, source } = splitSource(rawTitle)
    return {
      title: headline,
      source,
      link: asText(item.link) || '#',
      pubDate: asText(item.pubDate),
    }
  })
}

/**
 * 피드에는 기사가 아닌 항목이 섞여 들어온다 — CDC 논문의 그림 캡션, Hugging Face 저장소 이름,
 * 언론사 섹션 색인 페이지 등. 번역 전에 걸러 비용과 노이즈를 함께 줄인다.
 */
function looksLikeNoise(title: string) {
  const t = title.trim()
  if (t.length < 12) return true
  if (/^(figure|fig\.|table|appendix|supplement)\b/i.test(t)) return true
  if (/latest news|news & updates|news and updates/i.test(t) && t.includes('|')) return true
  if (!/\s/.test(t) && t.includes('/')) return true // 예: someuser/some-model
  return false
}

function dedupe(items: Item[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = item.link !== '#' ? item.link : item.title.toLowerCase().replace(/\s+/g, ' ').trim()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function withinWindow(item: Item) {
  const d = new Date(item.pubDate)
  if (Number.isNaN(d.getTime())) return true // 날짜를 못 읽으면 일단 통과
  return d.getTime() >= Date.now() - WINDOW_MS
}

/* ---------------- 저장소 (번역 메모 + 마지막 정상 응답) ---------------- */

function store(name: string) {
  try {
    return getStore(name)
  } catch {
    return null // 로컬에서 Blobs가 없을 때도 동작하도록
  }
}

function cacheKey(text: string) {
  // 제목을 그대로 키로 쓰기엔 길고 특수문자가 많아 간단한 해시를 쓴다.
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return 'v1-' + (h >>> 0).toString(36) + '-' + text.length
}

/* ---------------- 번역 (Netlify AI Gateway) ---------------- */

async function translateTitles(items: Item[]): Promise<{ items: Item[]; note?: string }> {
  const needsWork = items.filter((it) => it.title && !HANGUL.test(it.title))
  if (!needsWork.length) return { items }

  const memo = store('translations')
  const pending: Item[] = []

  // 1) 이미 번역해 둔 제목은 재사용한다 (같은 기사는 여러 카테고리에 걸쳐 반복 등장).
  for (const item of needsWork) {
    const hit = memo ? await memo.get(cacheKey(item.title), { type: 'text' }).catch(() => null) : null
    if (hit) {
      item.titleOriginal = item.title
      item.title = hit
    } else {
      pending.push(item)
    }
  }
  if (!pending.length) return { items }

  // 2) 남은 제목은 한 번의 요청으로 묶어 번역한다.
  try {
    // Netlify가 주입하는 Anthropic 변수를 쓰고, 없으면 AI Gateway 공용 변수로 직접 붙는다.
    const gatewayBase = process.env.NETLIFY_AI_GATEWAY_BASE_URL?.replace(/\/$/, '')
    const anthropic = process.env.ANTHROPIC_API_KEY
      ? new Anthropic()
      : new Anthropic({
          apiKey: process.env.NETLIFY_AI_GATEWAY_KEY,
          baseURL: gatewayBase ? `${gatewayBase}/anthropic` : undefined,
        })
    const numbered = pending.map((it, i) => `${i + 1}. ${it.title}`).join('\n')
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 2000,
      system:
        '너는 뉴스 헤드라인 번역기다. 입력된 번호 목록의 각 헤드라인을 자연스러운 한국어로 번역해라. ' +
        '고유명사와 기관명은 통용되는 한국어 표기를 쓰고, 없으면 원문을 유지한다. ' +
        '설명·인용부호·추가 문장 없이 JSON 문자열 배열만 출력한다. 배열 길이는 입력 헤드라인 수와 정확히 같아야 한다.',
      messages: [{ role: 'user', content: numbered }],
    }, { timeout: TRANSLATE_TIMEOUT_MS, maxRetries: 0 })

    const raw = message.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
      .trim()
    const json = raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1)
    const translated = JSON.parse(json) as string[]

    if (!Array.isArray(translated) || translated.length !== pending.length) {
      throw new Error('번역 결과 길이 불일치')
    }

    await Promise.all(
      pending.map(async (item, i) => {
        const value = String(translated[i] || '').trim()
        if (!value) return
        item.titleOriginal = item.title
        const original = item.title
        item.title = value
        if (memo) await memo.set(cacheKey(original), value).catch(() => {})
      }),
    )
    return { items }
  } catch (e) {
    // 번역이 실패해도 기사 자체는 원문 제목으로 보여준다.
    return { items, note: `번역 건너뜀 (${(e as Error).message || '오류'})` }
  }
}

/* ---------------- 핸들러 ---------------- */

export default async (req: Request, context: Context) => {
  const sectionId = (context.params.section || '').toLowerCase()
  const section = SECTIONS[sectionId]

  if (!section) {
    return Response.json(
      { error: '알 수 없는 섹션', sections: Object.keys(SECTIONS) },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  const trustedOnly = new URL(req.url).searchParams.get('trusted') !== '0'
  const snapshots = store('feed-snapshots')
  const snapshotKey = `${section.id}${section.kind === 'news' && !trustedOnly ? '-open' : ''}`
  const notes: string[] = []

  const feeds = section.feeds ?? newsFeeds(section, trustedOnly)

  const results = await Promise.all(
    feeds.map(async (feed) => {
      try {
        const xml = await fetchFeed(feed.url)
        return parseFeed(xml, feed.format, feed.source)
      } catch (e) {
        notes.push(`${feed.source || section.label}: ${(e as Error).message || '요청 실패'}`)
        return [] as Item[]
      }
    }),
  )

  const failedAll = results.every((r) => r.length === 0) && notes.length > 0

  if (failedAll) {
    // 업스트림이 죽었으면 마지막 정상 응답을 재사용한다 — 빈 화면보다 낫다.
    const snapshot = snapshots
      ? await snapshots.get(snapshotKey, { type: 'json' }).catch(() => null)
      : null
    if (snapshot) {
      return Response.json(
        { ...snapshot, stale: true, notes },
        {
          headers: {
            'Cache-Control': 'public, max-age=30',
            'Netlify-CDN-Cache-Control': 'public, s-maxage=60',
          },
        },
      )
    }
    return Response.json(
      { section: section.id, items: [], fetchedAt: new Date().toISOString(), notes },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  let items = dedupe(
    results
      .flat()
      .filter((it) => it.title && !looksLikeNoise(it.title))
      .filter(withinWindow),
  )
    .sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime())
    .slice(0, MAX_ITEMS)

  if (section.kind === 'sensor') items = items.map((it) => ({ ...it, sensor: true }))

  const translation = await translateTitles(items)
  if (translation.note) notes.push(translation.note)

  const payload = {
    section: section.id,
    label: section.label,
    items: translation.items,
    fetchedAt: new Date().toISOString(),
    trustedOnly: section.kind === 'news' ? trustedOnly : undefined,
    notes,
  }

  if (snapshots) await snapshots.setJSON(snapshotKey, payload).catch(() => {})

  return Response.json(payload, {
    headers: {
      // 브라우저는 짧게, CDN은 5분 — 방문자가 몰려도 업스트림 호출과 번역 비용은 한 번이다.
      'Cache-Control': 'public, max-age=60',
      'Netlify-CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=1800',
    },
  })
}

export const config: Config = {
  path: '/api/news/:section',
  method: 'GET',
}
