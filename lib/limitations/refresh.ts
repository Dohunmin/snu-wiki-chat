// Design Ref: §2.3 — 증분 처리 핵심. 스크립트(refreshAll)와 API(refresh) 공유.
// 1 호출당 maxNew건만 처리. hasMore=true이면 호출자가 다시 호출.

import fs from 'fs/promises';
import path from 'path';
import pg from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { dbscan } from './dbscan';
import type {
  LimitationQuestion, LimitationsJsonFile, ClusterLabelEntry, RefreshResult,
} from './types';

// ── 상수 ──────────────────────────────────────────────────────────────────
const JSON_PATH = path.join(process.cwd(), 'public/knowledge-map-questions.json');
const PROJ_PATH = path.join(process.cwd(), 'public/knowledge-map-proj.json');
const SONNET_MODEL = 'claude-sonnet-4-6';
const VOYAGE_MODEL = 'voyage-4-large';
const JUDGE_CONCURRENCY = 5;
const LABEL_CONCURRENCY = 5;
// Plan §2.4 Risks — distance 분포 실측 기반 튜닝.
// 137건 pair 9316개 중 p25=0.74 → 무관 쌍은 0.7 이상. 의미있는 쌍은 0.3~0.5.
// 각 질문 nearest p50=0.33, p75=0.47. eps=0.40이면 63% 참여, 0.45면 74%.
// 0.40으로 시작 (보수적). outlier 여전히 많으면 0.45로.
const DBSCAN_EPS = 0.40;
const DBSCAN_MIN_PTS = 2;
// Plan §5 — Do phase 실측 후 조정. 초기 20건 = Sonnet ~3s/5건 batch × 4 = ~12s 예상.
export const DEFAULT_BATCH_SIZE = 20;

const WIKI_LAYOUT: Record<string, { fx: number; fy: number }> = {
  senate:         { fx: 0.20, fy: 0.32 },
  board:          { fx: 0.78, fy: 0.32 },
  plan:           { fx: 0.48, fy: 0.14 },
  vision:         { fx: 0.30, fy: 0.54 },
  history:        { fx: 0.16, fy: 0.68 },
  status:         { fx: 0.50, fy: 0.52 },
  'yhl-speeches': { fx: 0.68, fy: 0.54 },
  finance:        { fx: 0.84, fy: 0.68 },
  leesj:          { fx: 0.50, fy: 0.80 },
};
const WIKI_LABELS: Record<string, string> = {
  senate:'평의원회', board:'이사회', plan:'대학운영계획', vision:'중장기발전계획',
  history:'70년역사', status:'대학현황', 'yhl-speeches':'유홍림총장연설',
  finance:'재무정보공시', leesj:'이석재 후보',
};
const WIKI_LIST = Object.entries(WIKI_LABELS).map(([id, label]) => `${id}(${label})`).join(', ');

// ── 메인 진입점 ────────────────────────────────────────────────────────────

/**
 * 한 batch 처리. hasMore=true이면 호출자가 다시 호출.
 */
export async function refresh(opts: { maxNew?: number } = {}): Promise<RefreshResult> {
  const maxNew = opts.maxNew ?? DEFAULT_BATCH_SIZE;
  const t0 = Date.now();

  const existing = await loadJson();
  const processedIds = new Set(existing.questions.map(q => q.id));

  // DB에서 미처리 질문 — LIMIT (maxNew + 1)로 hasMore 판정
  const allRows = await fetchNewQuestionsFromDB(processedIds, maxNew + 1);
  const hasMore = allRows.length > maxNew;
  const batch = allRows.slice(0, maxNew);

  // 새 질문 없어도 DBSCAN/라벨링은 다시 — 파라미터(eps) 튜닝 시 즉시 반영되도록.
  // 비용: DBSCAN 137건 ~수십 ms, 라벨링은 캐싱되어 변경 없으면 Sonnet 호출 0.
  if (batch.length === 0 && existing.questions.length === 0) {
    return {
      processed: 0,
      hasMore: false,
      totalCount: 0,
      durationMs: Date.now() - t0,
      newClusterCount: 0,
    };
  }

  // 새 질문 처리 (batch.length === 0이면 모두 skip)
  let newQuestions: LimitationQuestion[] = [];
  if (batch.length > 0) {
    const newEmbeddings = await voyageEmbed(batch.map(r => r.question));
    const judgements = await judgeAllWithConcurrency(batch);

    // PCA 좌표 (지식 지형도 호환) — proj 파일 있으면 적용, 없으면 [0,0]
    const proj = await loadProj();
    const newCoords: [number, number][] = proj
      ? projectToPCA(newEmbeddings, proj)
      : newEmbeddings.map(() => [0, 0]);

    newQuestions = batch.map((r, i) => {
      const judged = judgements[i];
      const wiki = judged.wiki || r.routedAgents[0] || '';
      return {
        id: r.id,
        question: r.question,
        answer: r.answer,
        createdAt: r.createdAt,
        routedAgents: r.routedAgents,
        embedding: newEmbeddings[i],
        quality: judged.quality,
        wiki,
        limitation: judged.limitation,
        limitationExcerpt: judged.excerpt,
        clusterId: -1,
        pcaCoord: newCoords[i],
        placementWiki: wiki || r.routedAgents[0] || '',
      };
    });
  }

  const merged: LimitationQuestion[] = [...existing.questions, ...newQuestions];

  // DBSCAN 전체 재계산
  const clusterIds = dbscan(merged.map(q => q.embedding), DBSCAN_EPS, DBSCAN_MIN_PTS);
  merged.forEach((q, i) => { q.clusterId = clusterIds[i]; });

  // 클러스터 라벨링 (변경된 것만)
  const { labels: newLabels, newCount: newClusterCount } =
    await assignClusterLabels(merged, existing.clusterLabels);

  // 원자적 write
  const newJson: LimitationsJsonFile = {
    questions: merged,
    clusterLabels: newLabels,
    updatedAt: new Date().toISOString(),
    totalCount: merged.length,
  };
  await atomicWrite(JSON_PATH, JSON.stringify(newJson));

  return {
    processed: batch.length,
    hasMore,
    totalCount: merged.length,
    durationMs: Date.now() - t0,
    newClusterCount,
  };
}

/**
 * 모든 미처리 질문을 batch 자동 반복으로 처리. CLI에서 호출.
 */
export async function refreshAll(opts: {
  batchSize?: number;
  onBatch?: (batchNum: number, result: RefreshResult) => void;
} = {}): Promise<{ totalProcessed: number; totalBatches: number; durationMs: number }> {
  const t0 = Date.now();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  let batchNum = 0;
  let totalProcessed = 0;
  while (true) {
    batchNum++;
    const result = await refresh({ maxNew: batchSize });
    totalProcessed += result.processed;
    opts.onBatch?.(batchNum, result);
    if (!result.hasMore) break;
    if (result.processed === 0) break;  // safety
  }
  return { totalProcessed, totalBatches: batchNum, durationMs: Date.now() - t0 };
}

// ── JSON I/O ──────────────────────────────────────────────────────────────

/**
 * 기존 questions의 Sonnet judgement(quality/wiki/limitation/excerpt)만 재평가.
 * 임베딩·클러스터·PCA는 보존 (Voyage·DBSCAN 재계산 안 함). 프롬프트 개선 후 품질 재생성용.
 */
export async function reevaluateAll(opts: {
  onProgress?: (current: number, total: number) => void;
} = {}): Promise<{ updated: number; limitedBefore: number; limitedAfter: number; durationMs: number }> {
  const t0 = Date.now();
  const existing = await loadJson();
  const qs = existing.questions;
  if (qs.length === 0) {
    return { updated: 0, limitedBefore: 0, limitedAfter: 0, durationMs: Date.now() - t0 };
  }

  const limitedBefore = qs.filter(q => q.limitation).length;

  // judgeOne 재호출 (concurrency) — 기존 question/answer 사용
  const judgements: JudgeResult[] = [];
  for (let i = 0; i < qs.length; i += JUDGE_CONCURRENCY) {
    const batch = qs.slice(i, i + JUDGE_CONCURRENCY);
    const batchResults = await Promise.all(batch.map(async q => {
      try {
        return await judgeOne(q.question, q.answer ?? '');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ⚠️ judge 실패 (기존값 유지): ${msg.slice(0, 100)}`);
        return null;
      }
    }));
    judgements.push(...batchResults.map((r, j) => r ?? {
      // 실패 시 기존값 유지
      quality: batch[j].quality, wiki: batch[j].wiki,
      limitation: batch[j].limitation, excerpt: batch[j].limitationExcerpt,
    }));
    opts.onProgress?.(Math.min(i + JUDGE_CONCURRENCY, qs.length), qs.length);
  }

  // judgement만 갱신, embedding/clusterId/pcaCoord 보존
  qs.forEach((q, i) => {
    q.quality = judgements[i].quality;
    q.wiki = judgements[i].wiki || q.wiki;
    q.limitation = judgements[i].limitation;
    q.limitationExcerpt = judgements[i].excerpt;
  });

  const limitedAfter = qs.filter(q => q.limitation).length;

  await atomicWrite(JSON_PATH, JSON.stringify({
    questions: qs,
    clusterLabels: existing.clusterLabels,   // 멤버 안 바뀌므로 유지
    updatedAt: new Date().toISOString(),
    totalCount: qs.length,
  } satisfies LimitationsJsonFile));

  return { updated: qs.length, limitedBefore, limitedAfter, durationMs: Date.now() - t0 };
}

async function loadJson(): Promise<LimitationsJsonFile> {
  try {
    const raw = await fs.readFile(JSON_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    // 기존 형식: 그냥 배열. 신규 형식: { questions, clusterLabels, ... }
    if (Array.isArray(parsed)) {
      return { questions: [], clusterLabels: {}, updatedAt: '', totalCount: 0 };
      // 기존 137건은 embedding/limitation 필드 없으므로 그냥 무시 → 첫 갱신에서 전수 처리
      // (Plan §5에 명시 — 첫 1회 5분)
    }
    return {
      questions: parsed.questions ?? [],
      clusterLabels: parsed.clusterLabels ?? {},
      updatedAt: parsed.updatedAt ?? '',
      totalCount: parsed.questions?.length ?? 0,
    };
  } catch {
    return { questions: [], clusterLabels: {}, updatedAt: '', totalCount: 0 };
  }
}

async function atomicWrite(filePath: string, content: string) {
  const tmp = filePath + '.tmp';
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, filePath);
}

interface ProjData {
  pcaMean: number[]; pc1: number[]; pc2: number[];
  wikiStats: Record<string, { cx: number; cy: number; sx: number; sy: number }>;
}
async function loadProj(): Promise<ProjData | null> {
  try {
    const raw = await fs.readFile(PROJ_PATH, 'utf-8');
    return JSON.parse(raw) as ProjData;
  } catch {
    return null;
  }
}

// ── DB ────────────────────────────────────────────────────────────────────

interface DbRow {
  id: string;
  question: string;
  answer: string;
  createdAt: string;
  routedAgents: string[];
}

async function fetchNewQuestionsFromDB(processedIds: Set<string>, limit: number): Promise<DbRow[]> {
  const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL });
  try {
    // user-assistant 페어 + 처리 안 된 user.id만 (NOT IN). 137~수천 건 규모 OK.
    // processedIds가 빈 경우 NOT IN 조건 생략 (= 전체)
    const idsArray = Array.from(processedIds);

    const baseQuery = `
      SELECT u.id AS id,
             u.content AS question,
             a.content AS answer,
             u.created_at AS "createdAt",
             COALESCE(a.routed_agents, '{}') AS "routedAgents"
      FROM messages u
      JOIN messages a ON (
        a.conversation_id = u.conversation_id AND a.role = 'assistant'
        AND a.id = (
          SELECT id FROM messages
          WHERE conversation_id = u.conversation_id AND role = 'assistant' AND created_at > u.created_at
          ORDER BY created_at LIMIT 1
        )
      )
      WHERE u.role = 'user' AND LENGTH(u.content) > 5
    `;

    const { rows } = idsArray.length === 0
      ? await pool.query(`${baseQuery} ORDER BY u.created_at ASC LIMIT $1`, [limit])
      : await pool.query(
          `${baseQuery} AND u.id <> ALL($1::text[]) ORDER BY u.created_at ASC LIMIT $2`,
          [idsArray, limit]
        );

    return rows.map((r: any) => ({
      id: r.id,
      question: r.question,
      answer: r.answer ?? '',
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      routedAgents: r.routedAgents ?? [],
    }));
  } finally {
    await pool.end();
  }
}

// ── Voyage 임베딩 ──────────────────────────────────────────────────────────

async function voyageEmbed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const MAX_BATCH = 64;
  const all: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const batch = texts.slice(i, i + MAX_BATCH);
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: VOYAGE_MODEL, input: batch, input_type: 'query' }),
    });
    if (!res.ok) throw new Error(`Voyage error: ${res.status} ${await res.text()}`);
    const data = await res.json() as { data: { embedding: number[]; index: number }[] };
    all.push(...data.data.sort((a, b) => a.index - b.index).map(d => d.embedding));
  }
  return all;
}

// ── PCA 투영 (지식 지형도 호환) ────────────────────────────────────────────

function randomProject(vecs: number[][], dimIn: number, dimOut: number): number[][] {
  let seed = 42;
  const rand = () => { seed = (seed * 1664525 + 1013904223) & 0xffffffff; return (seed >>> 0) / 0xffffffff * 2 - 1; };
  const proj = Array.from({ length: dimIn }, () => Array.from({ length: dimOut }, () => rand() / Math.sqrt(dimOut)));
  return vecs.map(vec => {
    const out = new Array(dimOut).fill(0);
    for (let j = 0; j < dimIn; j++) {
      if (vec[j] === 0) continue;
      for (let k = 0; k < dimOut; k++) out[k] += vec[j] * proj[j][k];
    }
    return out;
  });
}

function projectToPCA(embeddings: number[][], proj: ProjData): [number, number][] {
  if (embeddings.length === 0) return [];
  const reduced = randomProject(embeddings, embeddings[0].length, 30);
  const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
  return reduced.map(v => {
    const c = v.map((x, i) => x - proj.pcaMean[i]);
    return [dot(c, proj.pc1), dot(c, proj.pc2)];
  });
}

// ── Sonnet 평가 ────────────────────────────────────────────────────────────

interface JudgeResult {
  quality: 'answered' | 'partial' | 'no_data';
  wiki: string;
  limitation: boolean;
  excerpt: string;
}

let anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY가 .env.local에 없습니다.');
    anthropic = new Anthropic({ apiKey });
  }
  return anthropic;
}

// 깨진 UTF-16 surrogate 정리 — Anthropic JSON parse 거부 방지
function sanitize(s: string): string {
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

// 한계 명시 키워드 — 답변에서 한계 문장 추출 + 후처리 검증용.
const LIMIT_KEYWORD = /않습니다|없습니다|없어|없으|확인되지|확인할 수 없|제한적|범위(를| 내| 밖| 안)|포함되어 있지|별도 자료|추가 자료|미확인|찾을 수 없|누락|벗어|부족|드리지 못|제공되지|불가능|어렵습니다|어려운|단정|명시되지|나타나지|존재하지|다루지 않|알 수 없|확인 불가/;

/**
 * 답변 원문에서 한계를 명시한 완결 문장을 직접 추출.
 * Sonnet 발췌(부정확·조각화)에 의존하지 않고 코드로 추출 → 항상 정확·완결.
 * @returns 한계 문장 (최대 300자) 또는 빈 문자열(한계 문장 없음 = false positive 신호)
 */
function extractLimitationSentence(answer: string): string {
  const lines = answer.split('\n');
  // ⚠️/📝/"한계" 마커가 있는 줄 우선, 그 다음 일반 한계 키워드 줄
  const marked: string[] = [];
  const plain: string[] = [];
  for (const raw of lines) {
    // 마크다운 기호 제거 후 검사
    const clean = raw.replace(/[#>*`|]/g, '').replace(/^\s*[-•]\s*/, '').trim();
    if (clean.length < 12) continue;
    if (!LIMIT_KEYWORD.test(clean)) continue;
    if (/⚠️|📝|한계/.test(raw)) marked.push(clean);
    else plain.push(clean);
  }
  const pick = marked[0] ?? plain[0];
  if (!pick) return '';
  // 그 줄에서 한계 키워드 포함하는 완결 문장만 추출 (마침표/종결어미 단위)
  const sentences = pick.split(/(?<=[.!?])\s+/);
  const hit = sentences.find(s => LIMIT_KEYWORD.test(s)) ?? pick;
  // 앞부분의 이모지·깨진 surrogate·기호·콜론 등 제거 → 첫 한글/영숫자/따옴표부터 시작
  return hit.replace(/^[^가-힣a-zA-Z0-9"'(]+/, '').trim().slice(0, 300);
}

async function judgeOne(question: string, answer: string): Promise<JudgeResult> {
  const q = sanitize(question);
  const a = sanitize(answer);
  const msg = await getAnthropic().messages.create({
    model: SONNET_MODEL,
    max_tokens: 600,   // 발췌 완결 문장 + JSON 구조 여유 (한글 토큰 고려)
    messages: [{
      role: 'user',
      content: `서울대 거버넌스 위키 챗봇 Q&A를 평가하세요.

질문: ${q}
답변: ${a.slice(0, 1200)}

[품질]
- answered: 위키 자료로 핵심에 구체적으로 답변
- partial: 일부만 답변하거나 불완전
- no_data: 자료없음/범위밖/실질 답변 없음

[위키 분류] 이 질문의 주제와 가장 가까운 위키 ID 하나:
${WIKI_LIST}
관련 위키가 없으면 none

[한계 여부] — 엄격하게 판정하세요.
- yes: 답변이 질문의 **핵심**에 대해 "위키 자료에 없다 / 범위 밖이다 / 확인 불가"라고 명시적으로 밝힌 경우.
       또는 답변 전체가 자료 부족으로 핵심을 답하지 못한 경우.
- no:  자료로 핵심을 답변한 경우. 답변에 표·목록·구체적 수치·인용이 있으면 거의 no.
       답변 끝에 "일부 세부사항은 별도 자료 참고" 정도의 **부수적 보조 안내**가 있어도,
       핵심 질문에 답했으면 no.
  ※ quality가 answered면 대부분 no. 잘 답변했는데 한계로 분류하지 마세요.

JSON으로만 출력:
{"q":"answered|partial|no_data","w":"위키ID","l":"yes|no"}`,
    }],
  });

  const raw = (msg.content[0] as { text: string }).text.trim();
  // 발췌는 Sonnet에 의존하지 않고 답변 원문에서 코드로 추출 (정확·완결 보장).
  return parseJudgeJson(raw, a);
}

function parseJudgeJson(raw: string, answer: string): JudgeResult {
  // JSON 추출 — Sonnet이 가끔 코드 블록으로 감싸므로 {} 만 잡기
  const m = raw.match(/\{[\s\S]+\}/);
  try {
    const parsed = JSON.parse(m?.[0] ?? '{}');
    const qRaw = String(parsed.q ?? '').toLowerCase();
    const quality: 'answered' | 'partial' | 'no_data' =
      qRaw.includes('answered') ? 'answered' :
      qRaw.includes('partial')  ? 'partial'  : 'no_data';
    const wRaw = String(parsed.w ?? '').toLowerCase().trim();
    const wiki = WIKI_LAYOUT[wRaw] ? wRaw : '';
    const lRaw = String(parsed.l ?? '').toLowerCase();
    let limitation = lRaw === 'yes' || lRaw === 'true';
    // 발췌 = 답변 원문에서 한계 문장 직접 추출 (Sonnet le 무시)
    let excerpt = limitation ? extractLimitationSentence(answer) : '';

    // 후처리 false-positive 강등: answered인데 발췌에 한계 키워드 없으면
    // (Sonnet이 답변 본문 조각을 발췌로 잘못 고른 케이스) → 한계 아님으로 강등.
    // false-positive 강등: Sonnet이 한계라 했지만 답변에서 한계 문장을 못 찾으면
    // (= 답변에 실제 한계 표현 없음) → 한계 아님. quality 무관하게 적용.
    if (limitation && !excerpt.trim()) {
      limitation = false;
      excerpt = '';
    }

    return { quality, wiki, limitation, excerpt };
  } catch {
    return { quality: 'no_data', wiki: '', limitation: false, excerpt: '' };
  }
}

async function judgeAllWithConcurrency(rows: DbRow[]): Promise<JudgeResult[]> {
  const results: JudgeResult[] = [];
  for (let i = 0; i < rows.length; i += JUDGE_CONCURRENCY) {
    const batch = rows.slice(i, i + JUDGE_CONCURRENCY);
    const batchResults = await Promise.all(batch.map(async r => {
      try {
        return await judgeOne(r.question, r.answer);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ⚠️ judge 실패 (default 처리): ${msg.slice(0, 120)}`);
        return { quality: 'no_data' as const, wiki: '', limitation: false, excerpt: '' };
      }
    }));
    results.push(...batchResults);
  }
  return results;
}

// ── 클러스터 라벨링 (캐싱) ─────────────────────────────────────────────────

async function assignClusterLabels(
  questions: LimitationQuestion[],
  existing: Record<string, ClusterLabelEntry>,
): Promise<{ labels: Record<string, ClusterLabelEntry>; newCount: number }> {
  // 클러스터별 멤버 ID 수집 (정렬해서 set 비교)
  const memberMap = new Map<number, string[]>();
  for (const q of questions) {
    if (q.clusterId < 0) continue;  // outlier 제외
    const arr = memberMap.get(q.clusterId) ?? [];
    arr.push(q.id);
    memberMap.set(q.clusterId, arr);
  }

  const newLabels: Record<string, ClusterLabelEntry> = {};
  const clustersToLabel: Array<{ clusterId: number; memberIds: string[]; questions: string[] }> = [];

  for (const [cid, memberIds] of memberMap) {
    memberIds.sort();
    const key = String(cid);
    const existingEntry = existing[key];
    const sameMembers = existingEntry && setEquals(existingEntry.memberIds, memberIds);
    if (sameMembers) {
      newLabels[key] = existingEntry;  // 기존 라벨 재사용
    } else {
      const qs = memberIds
        .map(id => questions.find(q => q.id === id)?.question)
        .filter((q): q is string => !!q);
      clustersToLabel.push({ clusterId: cid, memberIds, questions: qs });
    }
  }

  // 신규/변경 클러스터만 Sonnet 호출 (concurrency)
  for (let i = 0; i < clustersToLabel.length; i += LABEL_CONCURRENCY) {
    const batch = clustersToLabel.slice(i, i + LABEL_CONCURRENCY);
    const labels = await Promise.all(batch.map(c => labelOneCluster(c.questions)));
    batch.forEach((c, j) => {
      newLabels[String(c.clusterId)] = { label: labels[j], memberIds: c.memberIds };
    });
  }

  return { labels: newLabels, newCount: clustersToLabel.length };
}

function setEquals(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

async function labelOneCluster(questions: string[]): Promise<string> {
  const sample = questions.slice(0, 10).map((q, i) => `${i + 1}. ${sanitize(q)}`).join('\n');
  try {
    const msg = await getAnthropic().messages.create({
      model: SONNET_MODEL,
      max_tokens: 60,
      messages: [{
        role: 'user',
        content: `다음 사용자 질문들은 같은 주제로 클러스터링되었습니다:

${sample}

이 질문들의 공통 주제를 한국어 1줄(최대 25자)로 요약하세요.
예시: "트랙별 연구평가 제도", "고가 장비 관리자 채용", "비교과 프로그램 홍보"

답변 형식: 주제명만 한 줄 (따옴표·설명 없이)`,
      }],
    });
    const raw = (msg.content[0] as { text: string }).text.trim();
    // 따옴표 / 줄바꿈 제거
    return raw.split('\n')[0].replace(/^["'`]|["'`]$/g, '').slice(0, 50);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ⚠️ label 실패: ${msg.slice(0, 80)}`);
    return '(라벨 생성 실패)';
  }
}
