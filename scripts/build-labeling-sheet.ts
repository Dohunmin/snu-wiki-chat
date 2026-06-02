/**
 * gold 라벨링 워크시트 생성 (읽기 쉬운 블록형).
 *   - 전체 질문(자르지 않음) + aspect(텍스트+커버리지) + missing
 *   - 봇이 실제로 내놓은 답변 발췌(시트 F열) → 코퍼스를 외우지 않아도 판단 가능
 *   - gold 입력란
 *
 * 실행: npx tsx scripts/build-labeling-sheet.ts
 *   입력: scripts/gold-results.json (평가자 출력) + 시트 답변
 *   출력: scripts/gold-labeling.md
 */
import { loadEnvFile } from 'process';
import fs from 'fs';
try { loadEnvFile('.env.local'); } catch { /* 무시 */ }

import { fetchSheetQuestions } from './fetch-sheet-questions';

interface Aspect { aspect: string; covered: string }
interface Result {
  question: string; length: number; role: string; routedWikis?: string[];
  verdict: string; aspects: Aspect[]; missing: string[]; failed?: boolean;
}

const COV = { yes: 'yes', partial: 'partial', no: 'no' } as Record<string, string>;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const excerpt = (a: string, head = 450, tail = 250) =>
  !a ? '(답변 없음)' : ([...a].length <= head + tail + 20
    ? a
    : `${[...a].slice(0, head).join('')}\n  […중략…]\n  ${[...a].slice(-tail).join('')}`);

async function main() {
  const results: Result[] = JSON.parse(fs.readFileSync('scripts/gold-results.json', 'utf-8'));
  const sheet = await fetchSheetQuestions();
  const answerByQ = new Map<string, string>();
  for (const s of sheet) if (!answerByQ.has(norm(s.question))) answerByQ.set(norm(s.question), s.answer);

  const order: Record<string, number> = { 'answerable': 0, 'opinion-grounded': 1, 'external-needed': 2, 'internal-gap': 3 };
  const sorted = [...results].sort((a, b) => (order[a.verdict] - order[b.verdict]) || (b.length - a.length));

  let md = `# 평가자 gold 라벨링 (실제 시트 질문 64개 · 길이 상위 50%)

각 블록의 **gold:** 칸에 정답 verdict를 적으세요. **모델 판정이 맞으면 비워두면** 됩니다(빈칸=동의). 판단이 어려우면 \`?\` 로 두세요(측정에서 제외).

**verdict 뜻**
- \`answerable\`     : 봇이 위키 자료로 질문의 **핵심을 사실로 답변** 가능
- \`opinion-grounded\`: 관련 사실은 있으나 질문이 **의견·제안·평가·진단**을 요구(그 판단은 자료에 없음)
- \`external-needed\` : 답하려면 **타기관 비교·외부 순위·뉴스** 등 서울대 자체 기록 밖 정보 필요
- \`internal-gap\`    : 질문 **주제 자체가 서울대 자료에 없음**(진짜 공백)

> 코퍼스를 외울 필요 없습니다. **질문 성격 + 아래 "실제 답변" + 평가자 근거**만 보고 판단하세요.

---

`;

  sorted.forEach((x, i) => {
    const ans = answerByQ.get(norm(x.question)) ?? '';
    const aspects = (x.aspects || []).map(a => `${a.aspect} **[${COV[a.covered] ?? a.covered}]**`).join('\n  - ');
    md += `## [${i + 1}] 모델: \`${x.verdict}\`${x.failed ? ' ⚠️PARSE_FAIL' : ''}  ·  ${x.length}자 · ${x.role} · 위키: ${(x.routedWikis || []).join(', ')}

**Q:** ${x.question.replace(/\n/g, ' ')}

**평가자 aspect 판정:**
  - ${aspects || '(없음)'}

**부족(missing):** ${(x.missing || []).join(' · ') || '(없음)'}

**실제 봇 답변(발췌):**
> ${excerpt(ans).replace(/\n/g, '\n> ')}

**gold:** \`\`         ← 맞으면 비워두기 / 틀리면 answerable·opinion-grounded·external-needed·internal-gap 중 하나

---

`;
  });

  fs.writeFileSync('scripts/gold-labeling.md', md, 'utf-8');
  console.log(`✅ scripts/gold-labeling.md 재생성 (${sorted.length}블록, 답변 매칭 ${[...answerByQ].length}개)`);
}

main().catch(err => { console.error(err); process.exit(1); });
