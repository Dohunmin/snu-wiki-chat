/**
 * 위키 데이터 전처리 스크립트
 * Obsidian 폴더의 마크다운 파일들을 웹 앱용 JSON으로 변환
 *
 * 실행: npx tsx scripts/build-wiki-data.ts
 */

import fs from 'fs';
import path from 'path';

// Obsidian 폴더 경로 (상대경로 또는 절대경로)
const OBSIDIAN_PATH = process.env.OBSIDIAN_PATH || '../Obsidian';

interface WikiSource {
  id: string;
  title: string;
  date?: string;
  topics: string[];
  entities: string[];
  content: string;
  sensitive: boolean;
}

interface WikiData {
  id: string;
  name: string;
  sources: WikiSource[];
  topics: string[];
  entities: string[];
  index: string;
}

// 에이전트별 Wiki 폴더 매핑
const WIKI_MAP = [
  {
    id: 'senate',
    name: '평의원회',
    folder: 'SNU_Senate_LLM_Wiki',
    sensitiveTopics: ['총장추천위', '인사-비공개'],
  },
  {
    id: 'board',
    name: '이사회',
    folder: 'SNU_이사회_LLM_Wiki',
    sensitiveTopics: ['총장-선출', '이사-선임', '감사-선임'],
  },
  {
    id: 'plan',
    name: '대학운영계획',
    folder: 'SNU_대학운영계획_LLM_Wiki',
    sensitiveTopics: [],
  },
  {
    id: 'vision',
    name: '중장기발전계획',
    folder: 'SNU_중장기발전계획_LLM_Wiki',
    sensitiveTopics: [],
  },
];

function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  if (!content.startsWith('---')) return { meta: {}, body: content };
  const end = content.indexOf('---', 3);
  if (end === -1) return { meta: {}, body: content };
  const frontmatter = content.slice(3, end).trim();
  const body = content.slice(end + 3).trim();
  const meta: Record<string, unknown> = {};
  for (const line of frontmatter.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (val.startsWith('[')) {
      try {
        meta[key] = JSON.parse(val.replace(/'/g, '"'));
      } catch {
        meta[key] = val.slice(1, -1).split(',').map(s => s.trim().replace(/"/g, ''));
      }
    } else {
      meta[key] = val.replace(/^["']|["']$/g, '');
    }
  }
  return { meta, body };
}

function buildWikiData(wikiConfig: typeof WIKI_MAP[0]): WikiData {
  const wikiPath = path.resolve(OBSIDIAN_PATH, wikiConfig.folder);

  if (!fs.existsSync(wikiPath)) {
    console.warn(`  ⚠️  폴더 없음: ${wikiPath}`);
    return {
      id: wikiConfig.id,
      name: wikiConfig.name,
      sources: [],
      topics: [],
      entities: [],
      index: '',
    };
  }

  // index.md
  const indexPath = path.join(wikiPath, 'wiki', 'index.md');
  const indexContent = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf-8') : '';

  // sources
  const sourcesDir = path.join(wikiPath, 'wiki', 'sources');
  const sources: WikiSource[] = [];

  if (fs.existsSync(sourcesDir)) {
    for (const file of fs.readdirSync(sourcesDir)) {
      if (!file.endsWith('.md')) continue;
      const sourceId = file.replace('.md', '');
      const content = fs.readFileSync(path.join(sourcesDir, file), 'utf-8');
      const { meta, body } = parseFrontmatter(content);

      const topics = (meta.topics as string[] | undefined) || [];
      const entities = (meta.entities as string[] | undefined) || [];

      // 민감 토픽 여부 확인
      const isSensitive = wikiConfig.sensitiveTopics.some(st =>
        topics.includes(st) || body.includes(st)
      );

      sources.push({
        id: sourceId,
        title: (meta.title as string) || sourceId,
        date: meta.date as string | undefined,
        topics,
        entities,
        content: body,
        sensitive: isSensitive,
      });
    }
  }

  // topics
  const topicsDir = path.join(wikiPath, 'wiki', 'topics');
  const topics: string[] = [];
  if (fs.existsSync(topicsDir)) {
    for (const file of fs.readdirSync(topicsDir)) {
      if (file.endsWith('.md')) topics.push(file.replace('.md', ''));
    }
  }

  // entities
  const entitiesDir = path.join(wikiPath, 'wiki', 'entities');
  const entities: string[] = [];
  if (fs.existsSync(entitiesDir)) {
    for (const subDir of fs.readdirSync(entitiesDir)) {
      const subPath = path.join(entitiesDir, subDir);
      if (fs.statSync(subPath).isDirectory()) {
        for (const file of fs.readdirSync(subPath)) {
          if (file.endsWith('.md')) entities.push(file.replace('.md', ''));
        }
      }
    }
  }

  console.log(`  ✅ ${wikiConfig.name}: sources ${sources.length}개, topics ${topics.length}개, entities ${entities.length}개`);

  return {
    id: wikiConfig.id,
    name: wikiConfig.name,
    sources,
    topics,
    entities,
    index: indexContent,
  };
}

// 메인 실행
console.log('🔄 위키 데이터 전처리 시작...');
console.log(`   Obsidian 경로: ${path.resolve(OBSIDIAN_PATH)}`);

const outputDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

for (const wikiConfig of WIKI_MAP) {
  console.log(`\n📚 ${wikiConfig.name} 처리 중...`);
  const data = buildWikiData(wikiConfig);
  const outputPath = path.join(outputDir, `${wikiConfig.id}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`   → ${outputPath} 저장 완료`);
}

console.log('\n✨ 전처리 완료!');
