/**
 * 앱 아이콘과 공유용 OG 이미지를 Netlify AI Gateway(Gemini 이미지 모델)로 한 번 생성한다.
 * 결과물은 public/img/ 에 커밋되어 있으므로 빌드마다 실행할 필요가 없다.
 *
 *   node scripts/generate-images.mjs
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { GoogleGenAI } from '@google/genai'

const OUT_DIR = new URL('../public/img/', import.meta.url)

const TARGETS = [
  {
    file: 'icon.png',
    prompt:
      'A mobile app icon, perfectly square 1:1 composition, centered. Subject: a minimal ' +
      'wireframe globe made of thin glowing grid lines, overlaid with a single soft radar ' +
      'sweep arc and one small red pulsing alert dot. Very dark near-black navy background ' +
      '(#0a0d12). Line colors: cool desaturated periwinkle blue (#7c9eff) and pale cyan, with ' +
      'one accent in signal red (#e5484d). Flat vector style, precise thin strokes, generous ' +
      'negative space, no text, no letters, no numbers, no drop shadows, no photorealism. ' +
      'Reads clearly at 64 pixels. Serious newsroom telemetry aesthetic.',
  },
  {
    file: 'og.png',
    prompt:
      'A wide 1.91:1 social share banner for a world news monitoring dashboard. Subject: an ' +
      'abstract dark world map rendered as a sparse dot matrix, with a few thin arcing ' +
      'connection lines between continents and three small glowing alert markers. Near-black ' +
      'navy background (#0a0d12) with subtle radial glow in the upper left (periwinkle blue) ' +
      'and upper right (faint signal red). Colors limited to deep navy, periwinkle blue ' +
      '(#7c9eff), pale cyan, and one signal red accent. Flat vector data-visualization style, ' +
      'thin precise strokes, lots of empty dark space in the lower left for a caption overlay. ' +
      'Absolutely no text, no letters, no numbers, no logos, no watermarks.',
  },
]

const ai = new GoogleGenAI({
  apiKey: process.env.NETLIFY_AI_GATEWAY_KEY,
  httpOptions: { baseUrl: process.env.NETLIFY_AI_GATEWAY_BASE_URL?.replace(/\/$/, '') },
})

await mkdir(OUT_DIR, { recursive: true })

for (const target of TARGETS) {
  const response = await ai.models.generateContent({
    model: 'gemini-3.1-flash-image',
    contents: target.prompt,
  })

  const part = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)
  if (!part?.inlineData?.data) {
    console.error(`${target.file}: 이미지 데이터가 없습니다.`)
    process.exitCode = 1
    continue
  }

  const out = new URL(target.file, OUT_DIR)
  await writeFile(out, Buffer.from(part.inlineData.data, 'base64'))
  console.log(`${target.file}: 생성 완료`)
}
