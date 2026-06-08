/**
 * 라우터 진단 — (a) 22% fallback 원인 + (b) 애매대 크기. 실질문 58개.
 *   질문당 2콜: OLD(현행 2-state, 실패원인 계측) + NEW(3-state+confidence, 애매대 측정).
 *   각 콜에서 raw 출력·지연(ms)·예외를 잡아 "예외(burst/infra) vs silent 파싱실패(실버그)"를 가른다.
 *   ⚠️ 유료 Haiku ×116 ~$0.08. npx tsx --env-file=.env.local scripts/diagnose-router.ts
 */
import fs from 'fs';
import { sql } from '@vercel/postgres';
import { getAnthropicClient, LLM_MODEL_LIGHT } from '@/lib/llm/client';

const master = (process.env.MASTER_ADMIN_EMAIL ?? '').toLowerCase();

// OLD — agent-router.ts ROUTER_SYSTEM 그대로 (현행 재현)
const OLD_SYSTEM = `당신은 서울대 거버넌스 챗봇의 *질문 분류기*입니다. 질문의 **답변 방식**을 두 유형으로 분류하세요.
⚠️ 데이터가 내부 자료에 있냐 / 외부 웹검색이 필요하냐는 **분류 기준이 아닙니다** — 그건 답변 에이전트가 따로 판단합니다. "웹이 필요해 보인다"는 이유로 insight로 분류하지 마세요.

- **fact**: 사실을 *직접 찾아 보고·나열·비교*하면 되는 질문 (자료가 곧 답). **외부 사실 조회도 fact**(외부 시선·타 대학·언론 — 웹 필요해도 *보고*면 fact). *구체적 사실*의 연관성·차이·패턴을 *보고*하는 것도 fact.
  예: "2026 예산은?", "이사회 안건 종류", "법인화 후 재정구조 변화", "외부에서 서울대 보는 시선·부정 언급"(웹 필요하지만 fact), "역대 총장 전공과 사업의 연관성"(데이터 보고), "SNU홀딩스와 기술지주 차이"(조직 차이 보고), "일관되게 유지해온 정책은 무엇인가"(패턴 보고).
- **insight**: 사실을 *해석·판단·진단·제안*하도록 요구하는 질문. ⭐ **자료로 답할 수 있어도(웹 불필요해도) 해석/판단/원인/제안을 요구하면 insight.**
  예: "예산 늘릴 방안 그 외 없을까?", "~가능할까?", "종합대학 체계가 *최선인가*", "어떻게 *개선해야* 하나", "채용이 어려운 *이유/원인*"(진단), "X와 Y가 *무슨 상관*?"(의미 해석), "권한 행사하는 것 *아니야?*"(비판·판단), "인문대와 사회대 거버넌스 *입장 차이*"(관점 해석).

판단 기준:
1. **"무엇/얼마/어떤 것들/구체적 차이·연관성/패턴을 *보고*" → fact** (복잡·웹 필요해도).
2. **"왜/이유/원인/무슨 의미·상관/맞나·아니야/어떻게 해야/제안/전망/관점 차이 해석" → insight** (자료로 답 되어도, 웹 불필요해도).
   ⭐ *이유·원인·의미·의의*를 묻는 질문은 **"~는 무엇인가"로 끝나도 insight** (묻는 대상이 사실이 아니라 *해석/진단*이므로). 예: "일괄 운영하는 *이유는 무엇인가*"=insight.
3. **애매하면 → insight** (분석 원하는 걸 fact로 보내면 빈약해 *나쁘고*, 반대는 풍부할 뿐 *무해*).

반드시 JSON 한 줄만 출력: {"agent":"fact"|"insight","reason":"짧은 근거"}`;

// NEW — 3-state + confidence (애매대 측정)
const NEW_SYSTEM = `당신은 서울대 거버넌스 챗봇의 *질문 분류기*입니다. 질문의 **답변 방식**을 분류하세요.
⚠️ 데이터가 내부에 있냐/외부 웹이 필요하냐는 분류 기준이 아닙니다.

- **fact**: 사실을 직접 찾아 보고·나열·비교하면 되는 질문 (자료가 곧 답).
- **insight**: 사실을 해석·판단·진단·제안하도록 요구 (이유·원인·의미·비판·관점차이·제안·전망). 자료로 답 되어도 해석/판단/원인을 요구하면 insight. 이유·의미를 물으면 "~무엇인가"로 끝나도 insight.
- **ambiguous**: fact로 정리해도, insight로 분석·제안해도 *둘 다 합리적*이라 사용자 의도를 한쪽으로 단정하기 어려운 질문.

confidence: 그 분류의 확신도 0.0~1.0 (ambiguous는 보통 낮음).

반드시 JSON 한 줄만 출력: {"agent":"fact"|"insight"|"ambiguous","confidence":0.0,"reason":"짧은 근거"}`;

async function callHaiku(system: string, query: string) {
  const t0 = Date.now();
  let raw = '', err: string | null = null;
  try {
    const resp = await getAnthropicClient().messages.create(
      { model: LLM_MODEL_LIGHT, max_tokens: 150, temperature: 0, system, messages: [{ role: 'user', content: query }] },
      { timeout: 4000, maxRetries: 1 },
    );
    raw = (resp.content.find((b): b is { type: 'text'; text: string } => b.type === 'text')?.text) ?? '';
  } catch (e) {
    err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  return { raw, err, ms: Date.now() - t0 };
}

function parse(raw: string, valid: string[]) {
  const m = raw.match(/\{[\s\S]*?\}/);
  if (!m) return { ok: false as const, reason: 'no-regex' };
  try {
    const p = JSON.parse(m[0]) as { agent?: string; confidence?: number };
    if (p.agent && valid.includes(p.agent)) return { ok: true as const, agent: p.agent, conf: p.confidence };
    return { ok: false as const, reason: `invalid-agent(${JSON.stringify(p.agent)})` };
  } catch { return { ok: false as const, reason: 'json-error' }; }
}

async function main() {
  const r = await sql`
    SELECT m.content AS q, u.email, u.role AS urole
    FROM messages m JOIN conversations c ON m.conversation_id=c.id JOIN users u ON c.user_id=u.id
    WHERE m.role='user' AND m.mode='normal'`;
  const seen = new Set<string>();
  const qs = (r.rows as { q: string; email: string; urole: string }[])
    .filter(x => x.urole !== 'admin' && (x.email || '').toLowerCase() !== master && (x.q || '').length >= 12 && (seen.has(x.q) ? false : (seen.add(x.q), true)))
    .map(x => x.q).sort((a, b) => b.length - a.length);

  console.log(`진단 ${qs.length}개 × 2콜 (~$${(qs.length * 2 * 0.0007).toFixed(3)})...\n`);

  type Rec = { q: string; oldOk: boolean; oldReason: string; oldErr: string | null; oldMs: number; oldRaw: string;
               newOk: boolean; newAgent: string; newConf: number | undefined; newErr: string | null; newMs: number; newRaw: string };
  const recs: Rec[] = [];

  for (let i = 0; i < qs.length; i++) {
    const q = qs[i];
    const o = await callHaiku(OLD_SYSTEM, q);
    const op = parse(o.raw, ['fact', 'insight']);
    const n = await callHaiku(NEW_SYSTEM, q);
    const np = parse(n.raw, ['fact', 'insight', 'ambiguous']);
    recs.push({
      q, oldOk: op.ok, oldReason: op.ok ? op.agent : op.reason, oldErr: o.err, oldMs: o.ms, oldRaw: o.raw,
      newOk: np.ok, newAgent: np.ok ? np.agent : '(fail)', newConf: np.ok ? np.conf : undefined, newErr: n.err, newMs: n.ms, newRaw: n.raw,
    });
    const oldTag = o.err ? `EXC` : op.ok ? op.agent.slice(0, 3) : `✗${op.reason}`;
    process.stdout.write(`${String(i + 1).padStart(2)}. OLD:${oldTag}(${o.ms}ms) NEW:${np.ok ? np.agent : '✗'}${np.ok && np.conf !== undefined ? ` c${np.conf}` : ''}  ${q.slice(0, 36)}\n`);
  }

  // ── (a) OLD fallback 원인 분석 ──
  const oldFails = recs.filter(x => !x.oldOk || x.oldErr);
  const exc = recs.filter(x => x.oldErr);
  const silentNoRegex = recs.filter(x => !x.oldErr && !x.oldOk && x.oldReason === 'no-regex');
  const silentJson = recs.filter(x => !x.oldErr && !x.oldOk && x.oldReason === 'json-error');
  const silentInvalid = recs.filter(x => !x.oldErr && !x.oldOk && x.oldReason.startsWith('invalid-agent'));
  const oldMsArr = recs.map(x => x.oldMs).sort((a, b) => a - b);
  const over3500 = recs.filter(x => x.oldMs >= 3500).length;

  // ── (b) NEW 애매대 ──
  const nFact = recs.filter(x => x.newAgent === 'fact').length;
  const nIns = recs.filter(x => x.newAgent === 'insight').length;
  const nAmb = recs.filter(x => x.newAgent === 'ambiguous').length;
  const nFail = recs.filter(x => !x.newOk || x.newErr).length;
  const confs = recs.filter(x => x.newConf !== undefined).map(x => x.newConf as number);

  console.log(`\n━━━ (a) OLD fallback: ${oldFails.length}/${recs.length} | 예외 ${exc.length} / silent(no-regex ${silentNoRegex.length}, json ${silentJson.length}, invalid-agent ${silentInvalid.length}) | 지연 max ${oldMsArr[oldMsArr.length - 1]}ms, ≥3500ms ${over3500}건`);
  console.log(`━━━ (b) NEW: fact ${nFact} / insight ${nIns} / ambiguous ${nAmb} | NEW실패 ${nFail}`);

  const md: string[] = [
    `# 라우터 진단 — fallback 원인 + 애매대 (실질문 ${recs.length})\n`,
    `## (a) OLD 2-state fallback 원인\n`,
    `- 총 fallback: **${oldFails.length}/${recs.length}**`,
    `- **예외(rate-limit/timeout = burst·infra)**: ${exc.length}`,
    `- **silent 파싱실패(실버그)**: no-regex ${silentNoRegex.length} / json-error ${silentJson.length} / invalid-agent ${silentInvalid.length}`,
    `- 지연: median ${oldMsArr[Math.floor(oldMsArr.length / 2)]}ms, max ${oldMsArr[oldMsArr.length - 1]}ms, ≥3500ms ${over3500}건 (timeout 4000ms 근접)\n`,
    `### fallback 케이스 raw 출력 (원인 확인용)\n`,
  ];
  for (const x of oldFails) {
    md.push(`**Q**: ${x.q.slice(0, 70)}`);
    md.push(`- 원인: ${x.oldErr ? `예외 → ${x.oldErr}` : `silent → ${x.oldReason}`} (${x.oldMs}ms)`);
    md.push(`- raw: \`${(x.oldRaw || '(빈 응답)').replace(/\n/g, ' ').slice(0, 200)}\`\n`);
  }
  md.push(`\n## (b) NEW 3-state 애매대\n`);
  md.push(`- fact ${nFact} / insight ${nIns} / **ambiguous ${nAmb}** / NEW실패 ${nFail}`);
  md.push(`- confidence: min ${Math.min(...confs)} / 평균 ${(confs.reduce((a, b) => a + b, 0) / confs.length).toFixed(2)} / max ${Math.max(...confs)}`);
  md.push(`- conf<0.7 (불확실): ${confs.filter(c => c < 0.7).length}건\n`);
  md.push(`### ambiguous 판정 질문\n`);
  for (const x of recs.filter(x => x.newAgent === 'ambiguous')) md.push(`- (c${x.newConf}) ${x.q.slice(0, 80)}`);
  md.push(`\n### OLD↔NEW 분류 변화 (애매대가 OLD에서 뭐로 갔나)\n`);
  md.push(`| OLD | NEW | conf | 질문 |`, `|---|---|---|---|`);
  for (const x of recs.filter(x => x.newAgent === 'ambiguous')) {
    md.push(`| ${x.oldErr ? 'EXC' : x.oldReason} | ambiguous | ${x.newConf} | ${x.q.replace(/\|/g, '/').slice(0, 60)} |`);
  }

  fs.writeFileSync('scripts/diagnose-router.out.md', md.join('\n'), 'utf-8');
  console.log(`✅ scripts/diagnose-router.out.md`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
