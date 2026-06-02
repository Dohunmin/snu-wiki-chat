/**
 * 인용 감사 가드 (B) — 생성된 답변의 각 [N] 인용이 그 [N] 자료로 실제 뒷받침되는지
 * 경량 LLM(Haiku)로 확인해 **오인용**(자료에 없는 구체 사실을 엉뚱한 [N]에 붙임)을 골라낸다.
 *
 * 배경: B-2로 위키당 청크가 늘면서 비슷한 회의록이 많아져, LLM이 합성 중 인접 주제의
 *       옆 회의록 [N]을 잘못 인용하는 사례 발생(검증 2026-06-02, 18기-19차/17기-21차 오인용).
 *       lexical/임베딩은 주제어가 겹쳐 못 잡음 → claim-vs-source 판단형 LLM 감사 필요.
 *
 * 보수적: 표현 차이/동의어는 지원으로 인정, 자료에 명시적으로 없는 구체 사실(인명·수치·날짜·
 *         고유 안건명)을 그 [N]에 붙인 경우만 unsupported. (false positive 최소화)
 */
import fs from 'fs';
import path from 'path';
import { getAnthropicClient } from './client';

// 인용 정확도는 거버넌스 신뢰의 핵심 — claim-vs-source 미세 판단이라 Sonnet 사용(사용자 지정).
export const AUDIT_MODEL = 'claude-sonnet-4-6';

export interface UnsupportedCitation { n: number; claim: string; reason: string }
export interface AuditResult { unsupported: UnsupportedCitation[]; failed?: boolean; raw?: string }

// ── 2단계: 소스 전체 로더 ──────────────────────────────────────────
//  1단계(청크 감사)는 그 [N]에 실린 *청크 조각*만 보므로, 내용이 다른 청크에 있으면 오판(FP).
//  → 1단계가 의심한 후보만 *해당 소스 전체*로 재검증해 청크-한계 FP를 걸러낸다. (토큰: 후보당 소스1개)
const WIKI_TO_AGENT: Record<string, string> = {
  '평의원회': 'senate', '이사회': 'board', '대학운영계획': 'plan',
  '중장기발전계획': 'vision', '중장기': 'vision', '70년역사': 'history',
  '대학현황': 'status', '유홍림총장연설': 'yhl-speeches', '재무정보공시': 'finance', '이석재 후보': 'leesj',
};
const _wikiCache = new Map<string, Record<string, unknown> | null>();
function loadWikiData(agentId: string): Record<string, unknown> | null {
  if (_wikiCache.has(agentId)) return _wikiCache.get(agentId)!;
  let d: Record<string, unknown> | null = null;
  try { d = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', `${agentId}.json`), 'utf-8')); } catch { d = null; }
  _wikiCache.set(agentId, d);
  return d;
}
/** 위키 display명 + sid로 그 소스의 **전체** 텍스트를 반환(없으면 null) */
export function loadFullSource(wikiDisplay: string, sid: string): string | null {
  const agentId = WIKI_TO_AGENT[wikiDisplay];
  if (!agentId) return null;
  const d = loadWikiData(agentId);
  if (!d) return null;
  const sfx = sid.match(/\.(fact|stance|overview)$/);
  const arr = (sfx
    ? (d[sfx[1] === 'fact' ? 'facts' : sfx[1] === 'stance' ? 'stances' : 'overviews'] as unknown[])
    : (d.sources as unknown[])) ?? [];
  const item = (arr as Array<Record<string, unknown>>).find(x => x.id === sid);
  if (!item) return null;
  const parts = [item.title, item.content, JSON.stringify(item.topics ?? ''), JSON.stringify(item.tags ?? '')].filter(Boolean);
  return parts.join('\n');
}

/** "## [N] ..." 헤더 기준으로 N → 블록 본문 추출 */
export function extractSourceBlocks(contextMarkdown: string): Map<number, string> {
  const map = new Map<number, string>();
  const lines = contextMarkdown.split('\n');
  let curN: number | null = null;
  let buf: string[] = [];
  const flush = () => { if (curN !== null) map.set(curN, (map.get(curN) ?? '') + '\n' + buf.join('\n')); buf = []; };
  for (const line of lines) {
    const m = line.match(/^##\s+\[(\d+)\]/);
    if (m) { flush(); curN = parseInt(m[1], 10); buf = [line]; }
    else buf.push(line);
  }
  flush();
  return map;
}

const citedNumbers = (text: string): number[] =>
  [...new Set([...text.matchAll(/\[(\d+)\]/g)].map(m => parseInt(m[1], 10)))];

/** 코드펜스/프로즈가 섞여도 첫 번째 균형 잡힌 {...} 추출 */
function extractBalancedJson(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null; // 미완결(절단)
}

/** 2단계: 후보 1건을 소스 **전체**로 재검증. supported=true면 청크-한계 FP(제거 대상). */
export async function verifyAgainstFullSource(claim: string, wiki: string, sid: string, fullSource: string): Promise<{ supported: boolean; failed?: boolean }> {
  const prompt = `다음 주장이 아래 출처 [${wiki} ${sid}]의 **전체 내용**으로 뒷받침되는지 판정하세요.
- 표현 차이·동의어·요약은 지원으로 인정.
- 여러 사실을 묶은 합리적 추론도, 각 사실이 출처에 있으면 지원으로 인정.
- 출처에 그 구체 사실(고유 안건명·인명·수치·날짜)이 전혀 없을 때만 미지원(supported:false).

주장: ${claim}

출처 전체:
${fullSource.slice(0, 11000)}

JSON만(코드펜스 금지): {"supported": true|false}`;
  try {
    const resp = await getAnthropicClient().messages.create({ model: AUDIT_MODEL, max_tokens: 150, temperature: 0, messages: [{ role: 'user', content: prompt }] });
    const raw = resp.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join('');
    const j = extractBalancedJson(raw);
    if (!j) return { supported: false, failed: true };
    return { supported: JSON.parse(j).supported === true };
  } catch { return { supported: false, failed: true }; }
}

/**
 * 답변의 [N] 인용 중 자료로 뒷받침되지 않는 것(오인용)을 반환.
 * @param answerRaw  [N] 인용이 들어간 LLM 원본 답변
 * @param contextMarkdown  buildNumberedContexts의 contextMarkdown (## [N] 블록들)
 * @param sourceMap  N → {wiki, page} 매핑. 주면 **2단계 소스-전체 재검증** 수행(청크-한계 FP 제거).
 */
export async function auditCitations(answerRaw: string, contextMarkdown: string, sourceMap?: Map<number, { wiki: string; page: string }>): Promise<AuditResult> {
  const cited = citedNumbers(answerRaw);
  if (cited.length === 0) return { unsupported: [] };
  const blocks = extractSourceBlocks(contextMarkdown);
  // 본문 블록이 있는 인용만 판정 대상 — 블록 없는 N(소스 캡으로 본문 미수록 등)은 가드가 검증 불가 → 침묵.
  const availableN = new Set(cited.filter(n => blocks.has(n)));
  if (availableN.size === 0) return { unsupported: [] };
  const evidence = [...availableN]
    .map(n => `[${n}]\n${(blocks.get(n) ?? '').trim().slice(0, 1600)}`)
    .join('\n\n---\n\n');

  const prompt = `아래 [자료]의 각 [N] 블록과, 그 자료로 작성된 [답변]이 있습니다.
답변에서 [N]으로 인용된 주장이 **해당 번호의 [N] 자료**로 뒷받침되는지 확인하여, **명백한 오인용만** 골라내세요.

[엄격한 판정 규칙 — 과탐 금지]
1. **오직 아래 제공된 번호만** 판정하세요. 제공되지 않은 번호는 절대 언급/지적하지 마세요("자료 없음"류 금지).
2. 표현 차이·동의어·요약·처리결과 서술(예: "원안 접수", "의결")은 그 자료에 해당 안건이 있으면 **지원됨**으로 봅니다.
3. **오인용 = 그 [N] 자료가 다루는 회의/주제와 전혀 다른 내용**(다른 회의의 안건, 그 자료에 없는 고유 사실)을 그 번호에 붙인 경우. 이때만 unsupported.
4. 세부 수치·날짜가 약간 다르거나 자료가 잘려 끝까지 안 보이는 경우는 **지원됨**으로 두세요(애매하면 통과).

[자료]
${evidence}

[답변]
${answerRaw.slice(0, 9000)}

JSON만 출력(코드펜스 금지):
{"unsupported":[{"n":번호,"claim":"인용 옆 주장 요약(25자 이내)","reason":"그 [N] 자료의 실제 주제 vs 붙은 주장"}]}`;

  try {
    const resp = await getAnthropicClient().messages.create({
      model: AUDIT_MODEL, max_tokens: 2000, temperature: 0, messages: [{ role: 'user', content: prompt }],
    });
    const raw = resp.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join('').trim();
    const jsonStr = extractBalancedJson(raw);
    if (!jsonStr) return { unsupported: [], failed: true, raw };
    const obj = JSON.parse(jsonStr);
    const list: UnsupportedCitation[] = Array.isArray(obj.unsupported) ? obj.unsupported
      .filter((u: unknown) => u && typeof (u as { n: unknown }).n === 'number')
      // 제공된(검증 가능한) 번호만 — 모델이 규칙 어기고 미제공 N을 지적해도 코드에서 차단
      .filter((u: { n: number }) => availableN.has(u.n))
      .map((u: { n: number; claim?: string; reason?: string }) => ({ n: u.n, claim: String(u.claim ?? '').slice(0, 60), reason: String(u.reason ?? '').slice(0, 140) }))
      // 자기모순 차단: 근거가 "지원됨/오인용 아님"이라고 말하면 진짜 지적이 아님 → 제외
      .filter((u: UnsupportedCitation) => !/오인용\s*아님|지원\s*됨|지원됨|정확히\s*지원|문제\s*없|해당\s*내용을?\s*지원/.test(u.reason))
      : [];
    // dedup: 같은 (n, claim 앞부분) 중복 제거
    const seen = new Set<string>();
    const deduped = list.filter(u => { const k = `${u.n}|${u.claim.slice(0, 15)}`; if (seen.has(k)) return false; seen.add(k); return true; });

    // ── 2단계: 후보만 소스 전체로 재검증 (청크-한계 FP 제거) ──
    if (!sourceMap || deduped.length === 0) return { unsupported: deduped };
    const confirmed: UnsupportedCitation[] = [];
    for (const u of deduped) {
      const ref = sourceMap.get(u.n);
      const full = ref ? loadFullSource(ref.wiki, ref.page) : null;
      if (!ref || !full) { confirmed.push(u); continue; }   // 검증 불가 → 1단계 유지(보수)
      const v = await verifyAgainstFullSource(u.claim, ref.wiki, ref.page, full);
      if (!v.supported) confirmed.push({ ...u, reason: `[소스전체] ${u.reason}` });
      // supported=true면 그 [N] 소스 전체엔 내용이 있음 → 청크-한계 오판 → 제거
    }
    return { unsupported: confirmed };
  } catch (err) {
    return { unsupported: [], failed: true, raw: err instanceof Error ? err.message : String(err) };
  }
}
