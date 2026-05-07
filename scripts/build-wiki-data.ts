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

interface WikiSynthesis {
  id: string;
  query: string;
  answeredAt: string;
  routedTo: string[];
  tags: string[];
  content: string;
  source: 'obsidian' | 'chat';
}

interface WikiFact {
  id: string;
  title: string;
  category: string;
  sources: string[];
  unit?: string;
  yearsCovered?: string;
  metricScope?: string;
  verifiedAt?: string;
  tags: string[];
  content: string;
  sensitive: boolean;
}

interface WikiStance {
  id: string;
  title: string;
  holder: string;
  topic: string;
  sources: string[];
  tags: string[];
  content: string;
  sensitive: boolean;
}

interface WikiOverview {
  id: string;
  title: string;
  편: string;
  시기?: [number, number];
  관련_stance?: Record<string, string[]>;
  tags: string[];
  content: string;
  sensitive: boolean;
}

interface WikiData {
  id: string;
  name: string;
  sources: WikiSource[];
  topics: WikiTopic[];
  entities: WikiEntity[];
  syntheses: WikiSynthesis[];
  facts: WikiFact[];
  stances: WikiStance[];
  overviews: WikiOverview[];
  index: string;
}

interface ConceptEntry {
  wikis: string[];
  aliases: string[];
  linkedPages: {
    wiki: string;
    type: 'entity' | 'topic' | 'stance' | 'source' | 'fact' | 'overview';
    id: string;
  }[];
}

interface ConceptIndex {
  [conceptName: string]: ConceptEntry;
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
  {
    id: 'history',
    name: '70년역사',
    folder: 'SNU_70년역사_LLM_Wiki',
    sensitiveTopics: [],
  },
  {
    id: 'status',
    name: '대학현황',
    folder: 'SNU_대학현황_LLM_Wiki',
    sensitiveTopics: [],
  },
  {
    id: 'yhl-speeches',
    name: '유홍림총장연설',
    folder: 'SNU_유홍림총장연설_LLM_Wiki',
    sensitiveTopics: [],
  },
  {
    id: 'finance',
    name: '재무정보공시',
    folder: 'SNU_재무정보공시_LLM_Wiki',
    sensitiveTopics: [],
  },
  {
    id: 'leesj',
    name: '이석재 후보',
    folder: 'SNU_후보 철학_LLM_Wiki',
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
    return {
      id: wikiConfig.id, name: wikiConfig.name,
      sources: [], topics: [], entities: [], syntheses: [],
      facts: [], stances: [], overviews: [], index: '',
    };
  }

  // index.md
  const indexPath = path.join(wikiPath, 'wiki', 'index.md');
  const indexContent = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf-8') : '';

  // ─── Topics ────────────────────────────────────────────────────
  const topicsDir = path.join(wikiPath, 'wiki', 'topics');
  const topics: WikiTopic[] = [];
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

    const title = (meta.title as string) || extractTitle(body, sourceId);
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

  // ─── Syntheses ─────────────────────────────────────────────────
  const synthesisDir = path.join(wikiPath, 'wiki', 'syntheses');
  const syntheses: WikiSynthesis[] = [];

  for (const { id: synthId, content } of collectMdFiles(synthesisDir)) {
    const { meta, body } = parseFrontmatter(content);
    if (meta.type !== 'synthesis') continue;

    syntheses.push({
      id: synthId,
      query: (meta.query as string) || synthId,
      answeredAt: (meta.answered_at as string) || '',
      routedTo: (meta.routed_to as string[] | undefined) || [],
      tags: (meta.tags as string[] | undefined) || [],
      content: body,
      source: 'obsidian',
    });
  }

  // ─── Facts ─────────────────────────────────────────────────────
  const factsDir = path.join(wikiPath, 'wiki', 'facts');
  const facts: WikiFact[] = [];

  for (const { id, content } of collectMdFiles(factsDir)) {
    const { meta, body } = parseFrontmatter(content);
    if (meta.type !== 'fact') continue;

    facts.push({
      id,
      title: extractTitle(body, id),
      category: (meta.category as string) ?? '',
      sources: (meta.sources as string[]) ?? [],
      unit: meta.unit as string | undefined,
      yearsCovered: meta.years_covered as string | undefined,
      metricScope: meta.metric_scope as string | undefined,
      verifiedAt: meta.verified_at as string | undefined,
      tags: (meta.tags as string[]) ?? [],
      content: body,
      sensitive: false,
    });
  }

  // ─── Stances ───────────────────────────────────────────────────
  const stancesDir = path.join(wikiPath, 'wiki', 'stances');
  const stances: WikiStance[] = [];

  for (const { id, content } of collectMdFiles(stancesDir)) {
    const { meta, body } = parseFrontmatter(content);
    if (meta.type !== 'stance') continue;

    stances.push({
      id,
      title: extractTitle(body, id),
      holder: (meta.holder as string) ?? '',
      topic: (meta.topic as string) ?? '',
      sources: (meta.sources as string[]) ?? [],
      tags: (meta.tags as string[]) ?? [],
      content: body,
      sensitive: false,
    });
  }

  // ─── Overviews ─────────────────────────────────────────────────
  const overviewsDir = path.join(wikiPath, 'wiki', 'overviews');
  const overviews: WikiOverview[] = [];

  for (const { id, content } of collectMdFiles(overviewsDir)) {
    const { meta, body } = parseFrontmatter(content);
    if (meta.type !== 'overview') continue;

    overviews.push({
      id,
      title: extractTitle(body, id),
      편: (meta['편'] as string) ?? '',
      시기: meta['시기'] as [number, number] | undefined,
      관련_stance: meta['관련_stance'] as Record<string, string[]> | undefined,
      tags: (meta.tags as string[]) ?? [],
      content: body,
      sensitive: false,
    });
  }

  console.log(
    `  ✅ ${wikiConfig.name}: sources ${sources.length}개, topics ${topics.length}개, ` +
    `entities ${entities.length}개, syntheses ${syntheses.length}개, ` +
    `facts ${facts.length}개, stances ${stances.length}개, overviews ${overviews.length}개`
  );

  return {
    id: wikiConfig.id,
    name: wikiConfig.name,
    sources,
    topics,
    entities,
    syntheses,
    facts,
    stances,
    overviews,
    index: indexContent,
  };
}

function buildConceptIndex(allWikis: WikiData[]): ConceptIndex {
  const index: ConceptIndex = {};

  const add = (
    name: string,
    wikiId: string,
    pageType: ConceptEntry['linkedPages'][0]['type'],
    pageId: string,
    aliases: string[] = [],
  ) => {
    if (!name || name.length < 2) return;
    if (!index[name]) {
      index[name] = { wikis: [], aliases: [], linkedPages: [] };
    }
    if (!index[name].wikis.includes(wikiId)) index[name].wikis.push(wikiId);
    for (const a of aliases) {
      if (!index[name].aliases.includes(a)) index[name].aliases.push(a);
    }
    index[name].linkedPages.push({ wiki: wikiId, type: pageType, id: pageId });
  };

  for (const wiki of allWikis) {
    for (const e of wiki.entities) {
      add(e.name, wiki.id, 'entity', e.id, e.aliases);
      for (const sid of e.sources) add(e.name, wiki.id, 'source', sid);
    }
    for (const t of wiki.topics) {
      add(t.name, wiki.id, 'topic', t.id);
    }
    for (const s of wiki.stances) {
      add(s.holder, wiki.id, 'stance', s.id);
      add(s.topic, wiki.id, 'stance', s.id);
    }
    for (const f of wiki.facts) {
      if (f.category) add(f.category, wiki.id, 'fact', f.id);
    }
  }

  // linkedPages가 1개뿐이고 wikis도 1개인 concept은 제외 (cross-wiki 가치 없음)
  return Object.fromEntries(
    Object.entries(index).filter(([, v]) =>
      v.wikis.length >= 2 || v.linkedPages.length >= 3
    )
  );
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

  // lensPersona agents는 일반 라우팅에서 제외되므로 키워드 자동 채움 불필요
  if (agent.lensPersona) return;

  const keywordSet = new Set<string>(agent.keywords as string[]);

  for (const topic of data.topics) {
    if (topic.id.length >= 2) keywordSet.add(topic.id);
    if (topic.name.length >= 2) keywordSet.add(topic.name);
    for (const tag of topic.tags) {
      if (tag.length >= 2) keywordSet.add(tag);
    }
  }

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

  for (const source of data.sources) {
    for (const tag of source.tags) {
      if (tag.length >= 2 && !/^\d+$/.test(tag)) keywordSet.add(tag);
    }
  }

  // 신규: stance holder/topic, fact category, overview 편
  for (const s of data.stances) {
    if (s.holder.length >= 2) keywordSet.add(s.holder);
    if (s.topic.length >= 2) keywordSet.add(s.topic);
    for (const tag of s.tags) {
      if (tag.length >= 2) keywordSet.add(tag);
    }
  }
  for (const f of data.facts) {
    if (f.category.length >= 2) keywordSet.add(f.category);
    for (const tag of f.tags) {
      if (tag.length >= 2) keywordSet.add(tag);
    }
  }
  for (const o of data.overviews) {
    if (o.편.length >= 2) keywordSet.add(o.편);
    for (const tag of o.tags) {
      if (tag.length >= 2) keywordSet.add(tag);
    }
  }

  agent.keywords = Array.from(keywordSet).slice(0, 200);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  console.log(`   → keywords 갱신: ${agent.keywords.length}개`);
}

// ─── 메인 실행 ─────────────────────────────────────────────────────
console.log('🔄 위키 데이터 전처리 시작...');
console.log(`   Obsidian 경로: ${path.resolve(OBSIDIAN_PATH)}`);

const outputDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

const agentsConfigPath = path.join(process.cwd(), 'data', 'agents.config.json');
const allWikis: WikiData[] = [];

for (const wikiConfig of WIKI_MAP) {
  console.log(`\n📚 ${wikiConfig.name} 처리 중...`);
  const data = buildWikiData(wikiConfig);
  allWikis.push(data);
  const outputPath = path.join(outputDir, `${wikiConfig.id}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`   → ${outputPath} 저장 완료`);
  updateAgentKeywords(wikiConfig.id, data, agentsConfigPath);
}

console.log('\n🔗 Concept Index 생성 중...');
// lensPersona 위키는 일반 라우팅에 노출되면 안 되므로 concept-index에서도 제외
const agentsForIndex = JSON.parse(fs.readFileSync(agentsConfigPath, 'utf-8')).agents as Array<{ id: string; lensPersona?: boolean }>;
const lensPersonaIds = new Set(agentsForIndex.filter(a => a.lensPersona).map(a => a.id));
const indexableWikis = allWikis.filter(w => !lensPersonaIds.has(w.id));
const conceptIndex = buildConceptIndex(indexableWikis);
fs.writeFileSync(
  path.join(outputDir, 'concept-index.json'),
  JSON.stringify(conceptIndex, null, 2),
  'utf-8'
);
console.log(`✨ Concept Index: ${Object.keys(conceptIndex).length} concepts`);

console.log('\n✨ 전처리 완료!');
