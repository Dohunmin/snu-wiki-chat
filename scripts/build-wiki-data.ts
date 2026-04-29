/**
 * 위키 데이터 전처리 스크립트
 * Obsidian 폴더의 마크다운 파일들을 웹 앱용 JSON으로 변환
 *
 * 실행: npx tsx scripts/build-wiki-data.ts
 */

import fs from 'fs';
import path from 'path';

const OBSIDIAN_PATH = process.env.OBSIDIAN_PATH || '../Obsidian';

interface WikiSource {
  id: string;
  title: string;
  date?: string;
  tags: string[];
  topics: string[];
  entities: string[];
  content: string;
  sensitive: boolean;
}

interface WikiTopic {
  id: string;
  name: string;
  category?: string;
  tags: string[];
  sources: string[];
  content: string;
}

interface WikiEntity {
  id: string;
  name: string;
  entityType: string;
  aliases: string[];
  tags: string[];
  sources: string[];
  content: string;
}

interface WikiData {
  id: string;
  name: string;
  sources: WikiSource[];
  topics: WikiTopic[];
  entities: WikiEntity[];
  index: string;
}

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

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  if (!raw.startsWith('---')) return { meta: {}, body: raw };
  const end = raw.indexOf('---', 3);
  if (end === -1) return { meta: {}, body: raw };

  const frontmatter = raw.slice(3, end).trim();
  const body = raw.slice(end + 3).trim();
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
        meta[key] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
      }
    } else {
      meta[key] = val.replace(/^["']|["']$/g, '');
    }
  }
  return { meta, body };
}

function extractTitle(body: string, fallback: string): string {
  const m = body.match(/^#\s+(.+)/m);
  return m ? m[1].trim() : fallback;
}

/** 디렉토리 내 .md 파일을 재귀적으로 수집 */
function collectMdFiles(dir: string): Array<{ id: string; content: string }> {
  if (!fs.existsSync(dir)) return [];
  const result: Array<{ id: string; content: string }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectMdFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      result.push({
        id: entry.name.replace(/\.md$/, ''),
        content: fs.readFileSync(fullPath, 'utf-8'),
      });
    }
  }
  return result;
}

function buildWikiData(wikiConfig: typeof WIKI_MAP[0]): WikiData {
  const wikiPath = path.resolve(OBSIDIAN_PATH, wikiConfig.folder);

  if (!fs.existsSync(wikiPath)) {
    console.warn(`  ⚠️  폴더 없음: ${wikiPath}`);
    return { id: wikiConfig.id, name: wikiConfig.name, sources: [], topics: [], entities: [], index: '' };
  }

  // index.md
  const indexPath = path.join(wikiPath, 'wiki', 'index.md');
  const indexContent = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf-8') : '';

  // ─── Topics ────────────────────────────────────────────────────
  const topicsDir = path.join(wikiPath, 'wiki', 'topics');
  const topics: WikiTopic[] = [];
  // sourceId → topic names (역매핑)
  const sourceTopicsMap = new Map<string, string[]>();

  for (const { id: topicId, content } of collectMdFiles(topicsDir)) {
    const { meta, body } = parseFrontmatter(content);
    const topicName = extractTitle(body, topicId);
    const topicSources = (meta.sources as string[] | undefined) || [];
    const topicTags = (meta.tags as string[] | undefined) || [];

    topics.push({
      id: topicId,
      name: topicName,
      category: meta.category as string | undefined,
      tags: topicTags,
      sources: topicSources,
      content: body,
    });

    for (const srcId of topicSources) {
      if (!sourceTopicsMap.has(srcId)) sourceTopicsMap.set(srcId, []);
      sourceTopicsMap.get(srcId)!.push(topicName);
    }
  }

  // ─── Entities ──────────────────────────────────────────────────
  const entitiesDir = path.join(wikiPath, 'wiki', 'entities');
  const entities: WikiEntity[] = [];
  // sourceId → entity names (역매핑)
  const sourceEntitiesMap = new Map<string, string[]>();

  for (const { id: entityId, content } of collectMdFiles(entitiesDir)) {
    const { meta, body } = parseFrontmatter(content);
    const entityName = extractTitle(body, entityId);
    const entitySources = (meta.sources as string[] | undefined) || [];
    const entityTags = (meta.tags as string[] | undefined) || [];
    const aliases = (meta.aliases as string[] | undefined) || [];

    entities.push({
      id: entityId,
      name: entityName,
      entityType: (meta.entity_type as string) || '',
      aliases,
      tags: entityTags,
      sources: entitySources,
      content: body,
    });

    for (const srcId of entitySources) {
      if (!sourceEntitiesMap.has(srcId)) sourceEntitiesMap.set(srcId, []);
      sourceEntitiesMap.get(srcId)!.push(entityName);
    }
  }

  // ─── Sources ───────────────────────────────────────────────────
  const sourcesDir = path.join(wikiPath, 'wiki', 'sources');
  const sources: WikiSource[] = [];

  for (const { id: sourceId, content } of collectMdFiles(sourcesDir)) {
    const { meta, body } = parseFrontmatter(content);

    const sourceTags = (meta.tags as string[] | undefined) || [];
    const derivedTopics = sourceTopicsMap.get(sourceId) || [];
    const derivedEntities = sourceEntitiesMap.get(sourceId) || [];

    // 제목: 파일 H1 > frontmatter title > id
    const title = (meta.title as string) || extractTitle(body, sourceId);

    // 날짜: 회의일 > date > 연도
    const dateRaw = meta['회의일'] ?? meta['date'] ?? meta['연도'];
    const date = dateRaw != null ? String(dateRaw) : undefined;

    const isSensitive = wikiConfig.sensitiveTopics.some(st =>
      derivedTopics.some(t => t.includes(st)) ||
      sourceTags.includes(st) ||
      body.includes(st)
    );

    sources.push({
      id: sourceId,
      title,
      date,
      tags: sourceTags,
      topics: derivedTopics,
      entities: derivedEntities,
      content: body,
      sensitive: isSensitive,
    });
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

/** wiki 데이터에서 라우팅 키워드를 추출하여 agents.config.json을 자동 갱신 */
function updateAgentKeywords(
  agentId: string,
  data: WikiData,
  configPath: string,
): void {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const agent = config.agents.find((a: { id: string }) => a.id === agentId);
  if (!agent) return;

  const keywordSet = new Set<string>(agent.keywords as string[]);

  // topic id (파일명) + topic name (H1 제목) + topic tags
  for (const topic of data.topics) {
    if (topic.id.length >= 2) keywordSet.add(topic.id);
    if (topic.name.length >= 2) keywordSet.add(topic.name);
    for (const tag of topic.tags) {
      if (tag.length >= 2) keywordSet.add(tag);
    }
  }

  // entity id + entity name + aliases + entity tags
  for (const entity of data.entities) {
    if (entity.id.length >= 2) keywordSet.add(entity.id);
    if (entity.name.length >= 2) keywordSet.add(entity.name);
    for (const alias of entity.aliases) {
      if (alias.length >= 2) keywordSet.add(alias);
    }
    for (const tag of entity.tags) {
      if (tag.length >= 2) keywordSet.add(tag);
    }
  }

  // source tags (날짜·기수 등 숫자만인 태그 제외)
  for (const source of data.sources) {
    for (const tag of source.tags) {
      if (tag.length >= 2 && !/^\d+$/.test(tag)) keywordSet.add(tag);
    }
  }

  agent.keywords = Array.from(keywordSet).slice(0, 150);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  console.log(`   → keywords 갱신: ${agent.keywords.length}개`);
}

// ─── 메인 실행 ─────────────────────────────────────────────────────
console.log('🔄 위키 데이터 전처리 시작...');
console.log(`   Obsidian 경로: ${path.resolve(OBSIDIAN_PATH)}`);

const outputDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

const agentsConfigPath = path.join(process.cwd(), 'data', 'agents.config.json');

for (const wikiConfig of WIKI_MAP) {
  console.log(`\n📚 ${wikiConfig.name} 처리 중...`);
  const data = buildWikiData(wikiConfig);
  const outputPath = path.join(outputDir, `${wikiConfig.id}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`   → ${outputPath} 저장 완료`);
  updateAgentKeywords(wikiConfig.id, data, agentsConfigPath);
}

console.log('\n✨ 전처리 완료!');
