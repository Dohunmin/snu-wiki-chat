// Design Ref: §2.3 — 증분 처리 핵심. 스크립트(refreshAll)와 API(refresh) 공유.
// 1 호출당 maxNew건만 처리. hasMore=true이면 호출자가 다시 호출.

import fs from 'fs/promises';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { db } from '@/lib/db/client';
import { sql } from 'drizzle-orm';
import { assignClusterANN } from './cluster-ann';
import type { RefreshResult } from './types';

// ── 상수 ──────────────────────────────────────────────────────────────────
// proj.json은 정적 파일 — 읽기만 (Vercel read-only fs도 읽기는 OK). 쓰기는 DB로.
const PROJ_PATH = path.join(process.cwd(), 'public/knowledge-map-proj.json');
const SONNET_MODEL = 'claude-sonnet-4-6';
const VOYAGE_MODEL = 'voyage-4-large';
const JUDGE_CONCURRENCY = 5;
// DBSCAN eps/minPts는 cluster-ann.ts에서 관리 (ANN 증분 + rebuildAll 공유).
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

  // DB에서 미처리 질문 (limitation_questions에 없는 user 질문) — LIMIT+1로 hasMore 판정
  const batchRows = await fetchNewQuestionsFromDB(maxNew + 1);
  const hasMore = batchRows.length > maxNew;
  const batch = batchRows.slice(0, maxNew);

  if (batch.length === 0) {
    return {
      processed: 0, hasMore: false,
      totalCount: await countQuestions(),
      durationMs: Date.now() - t0, newClusterCount: 0,
    };
  }

  // Voyage 임베딩 + Sonnet 평가
  const newEmbeddings = await voyageEmbed(batch.map(r => r.question));
  const judgements = await judgeAllWithConcurrency(batch);

  // PCA 좌표 (지식 지형도 호환)
  const proj = await loadProj();
  const coords: [number, number][] = proj
    ? projectToPCA(newEmbeddings, proj)
    : newEmbeddings.map(() => [0, 0]);

  // INSERT + ANN 증분 클러스터 할당
  const affected = new Set<number>();
  for (let i = 0; i < batch.length; i++) {
    const r = batch[i];
    const j = judgements[i];
    const wiki = j.wiki || r.routedAgents[0] || '';
    const vec = `[${newEmbeddings[i].join(',')}]`;
    await db.execute(sql`
      INSERT INTO limitation_questions
        (id, question, answer, question_created_at, routed_agents, embedding,
         quality, wiki, limitation, limitation_excerpt, cluster_id, pca_x, pca_y, placement_wiki)
      VALUES (${r.id}, ${r.question}, ${r.answer}, ${r.createdAt},
        ${JSON.stringify(r.routedAgents)}::jsonb, ${vec}::vector,
        ${j.quality}, ${wiki}, ${j.limitation}, ${j.excerpt}, -1,
        ${coords[i][0]}, ${coords[i][1]}, ${wiki})
      ON CONFLICT (id) DO NOTHING
    `);
    const { affectedClusterIds } = await assignClusterANN(r.id, newEmbeddings[i]);
    affectedClusterIds.forEach(c => affected.add(c));
  }

  // 변경 클러스터 라벨 재생성 (limitation_clusters UPSERT)
  const newClusterCount = await relabelClusters([...affected]);

  return {
    processed: batch.length, hasMore,
    totalCount: await countQuestions(),
    durationMs: Date.now() - t0, newClusterCount,
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
  const res = await db.execute(sql`
    SELECT id, question, answer, quality, wiki, limitation, limitation_excerpt
    FROM limitation_questions
    ORDER BY question_created_at
  `);
  const rows = res.rows as unknown as Array<{
    id: string; question: string; answer: string;
    quality: string; wiki: string; limitation: boolean; limitation_excerpt: string;
  }>;
  if (rows.length === 0) {
    return { updated: 0, limitedBefore: 0, limitedAfter: 0, durationMs: Date.now() - t0 };
  }

  const limitedBefore = rows.filter(r => r.limitation).length;
  let limitedAfter = 0;

  for (let i = 0; i < rows.length; i += JUDGE_CONCURRENCY) {
    const batch = rows.slice(i, i + JUDGE_CONCURRENCY);
    const judged = await Promise.all(batch.map(async r => {
      try { return await judgeOne(r.question, r.answer ?? ''); }
      catch (err) {
        console.error(`  ⚠️ judge 실패 (기존값 유지): ${(err instanceof Error ? err.message : String(err)).slice(0, 100)}`);
        return null;
      }
    }));
    for (let k = 0; k < batch.length; k++) {
      const r = batch[k];
      const j = judged[k] ?? { quality: r.quality as JudgeResult['quality'], wiki: r.wiki, limitation: r.limitation, excerpt: r.limitation_excerpt };
      if (j.limitation) limitedAfter++;
      await db.execute(sql`
        UPDATE limitation_questions
        SET quality = ${j.quality}, wiki = ${j.wiki || r.wiki},
            limitation = ${j.limitation}, limitation_excerpt = ${j.excerpt}, evaluated_at = NOW()
        WHERE id = ${r.id}
      `);
    }
    opts.onProgress?.(Math.min(i + JUDGE_CONCURRENCY, rows.length), rows.length);
  }

  return { updated: rows.length, limitedBefore, limitedAfter, durationMs: Date.now() - t0 };
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

async function fetchNewQuestionsFromDB(limit: number): Promise<DbRow[]> {
  // user-assistant 페어 중 limitation_questions에 아직 없는 user 질문만 (증분)
  const res = await db.execute(sql`
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
      AND u.id NOT IN (SELECT id FROM limitation_questions)
    ORDER BY u.created_at ASC
    LIMIT ${limit}
  `);
  return (res.rows as unknown as Array<{ id: string; question: string; answer: string; createdAt: unknown; routedAgents: string[] }>)
    .map(r => ({
      id: r.id,
      question: r.question,
      answer: r.answer ?? '',
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      routedAgents: r.routedAgents ?? [],
    }));
}

async function countQuestions(): Promise<number> {
  const res = await db.execute(sql`SELECT count(*)::int AS n FROM limitation_questions`);
  return Number((res.rows[0] as { n: number }).n);
}

/**
 * 변경된 클러스터들의 라벨 재생성. 멤버 동일하면 기존 라벨 유지(Sonnet 호출 skip).
 * @returns 새로 라벨링한 클러스터 수
 */
async function relabelClusters(clusterIds: number[]): Promise<number> {
  let count = 0;
  for (const cid of clusterIds) {
    if (cid < 0) continue;
    const memRes = await db.execute(sql`
      SELECT id, question FROM limitation_questions WHERE cluster_id = ${cid} ORDER BY id
    `);
    const members = memRes.rows as unknown as Array<{ id: string; question: string }>;
    if (members.length === 0) continue;
    const memberIds = members.map(m => m.id).sort();

    // 기존 라벨 캐시 — 멤버 동일하면 skip
    const exRes = await db.execute(sql`SELECT member_ids FROM limitation_clusters WHERE cluster_id = ${cid}`);
    const existing = exRes.rows[0] as { member_ids: string[] } | undefined;
    if (existing && setEquals(existing.member_ids, memberIds)) continue;

    const label = await labelOneCluster(members.map(m => m.question));
    await db.execute(sql`
      INSERT INTO limitation_clusters (cluster_id, label, member_ids, updated_at)
      VALUES (${cid}, ${label}, ${JSON.stringify(memberIds)}::jsonb, NOW())
      ON CONFLICT (cluster_id) DO UPDATE SET label = EXCLUDED.label, member_ids = EXCLUDED.member_ids, updated_at = NOW()
    `);
    count++;
  }
  return count;
}

function setEquals(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort(), sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
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

// 한계 마커 — 챗봇이 의도적으로 단 한계 블록 표지. 이게 있을 때만 limitation=true.
// 다양한 형식 수용: "📌 한계", "⚠️ 분석의 한계", "⚠️ 자료 한계 안내", "한계:", "한계가 있", 줄머리 "한계 안내"
// false positive 차단 — 본문에 우연 등장하는 "~없습니다"는 무시.
const HAS_LIMIT_MARKER = /[📌⚠️📝][^\n]{0,30}한계|(^|\n)\s*[*#>]*\s*한계\s*(가\s*있|[:：를는 ]|안내)/m;

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

// 답변 앞부분(맥락) + 뒷부분(한계 명시 블록은 거의 항상 답변 끝에 옴) 둘 다 Sonnet에 노출.
// 1200자 단일 슬라이스 시 긴 답변(>1200자)의 "📌 한계" 블록을 못 보고 false 판정하던 버그 차단.
function squeezeAnswerForJudge(a: string, head = 1200, tail = 1000): string {
  if (a.length <= head + tail + 20) return a;
  return `${a.slice(0, head)}\n\n[...중략...]\n\n${a.slice(-tail)}`;
}

async function judgeOne(question: string, answer: string): Promise<JudgeResult> {
  const q = sanitize(question);
  const a = sanitize(answer);
  // Sonnet 호출은 quality + wiki만 (한계 판정은 코드로 답변 마커 추출 — Sonnet이 답변 핵심에만 집중해
  // 명시적 "📌 한계" 블록을 부수적 보조로 분류하는 false-negative가 잦았음).
  const msg = await getAnthropic().messages.create({
    model: SONNET_MODEL,
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `서울대 거버넌스 위키 챗봇 Q&A를 평가하세요.

질문: ${q}
답변: ${squeezeAnswerForJudge(a)}

[품질]
- answered: 위키 자료로 핵심에 구체적으로 답변
- partial: 일부만 답변하거나 불완전
- no_data: 자료없음/범위밖/실질 답변 없음

[위키 분류] 이 질문의 주제와 가장 가까운 위키 ID 하나:
${WIKI_LIST}
관련 위키가 없으면 none

JSON으로만 출력:
{"q":"answered|partial|no_data","w":"위키ID"}`,
    }],
  });

  const raw = (msg.content[0] as { text: string }).text.trim();
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

    // 한계 판정 = 답변 원문에서 명시적 마커("📌 한계" / "⚠️ 한계" / 줄머리 "한계:") 있을 때만
    // extractLimitationSentence로 추출. Sonnet 판정 무시 — 코드 추출이 더 정확.
    const hasExplicitMarker = HAS_LIMIT_MARKER.test(answer);
    const excerpt = hasExplicitMarker ? extractLimitationSentence(answer) : '';
    const limitation = excerpt.length > 0;

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

// ── 클러스터 라벨링 (Sonnet) ───────────────────────────────────────────────

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
