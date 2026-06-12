/**
 * 데모: planQuery(Haiku)가 실제 질문을 어떻게 판별하는지 투명하게 출력.
 *   8개 = 실제 질의로그(gold-questions.json), 2개 = 후속질문 데모(코어퍼런스 쌍).
 *   각 질문의 모델 판단(intent·complexity·recency·college·resolvedQuery·isFollowup·reason) + admin 기준 mode 매핑.
 *   비용: Haiku ~10콜 ~$0.03. 실행: npx tsx --env-file=.env.local scripts/demo-agent-judgment.ts
 */
import { planQuery, type ChatTurn } from '@/lib/agents/agent-router';

type Item = { q: string; tag: string; history?: ChatTurn[] };
const ITEMS: Item[] = [
  { q: '서울대 2040 비전 내용 중 2025년 서울대 주요 시행과제로 실행된 것은?', tag: '로그·단순조회' },
  { q: '서울대학교에서 신임교원 임용 절차를 단과대학의 특성을 고려하지 않고 일괄적으로 운영하는 이유는 무엇인가?', tag: '로그·이유(anti-rule)' },
  { q: '외부에서 서울대학교를 보는 시선, 최근의 사회적 이슈에서 서울대학교가 부정적으로 언급된 사례', tag: '로그·외부사실' },
  { q: '서울대학교는 현재의 "종합대학" 체계가 최선의 운영 방식인가? 개별 단과대학의 자율성을 보장하는 방안에 대해 평가해줘', tag: '로그·평가' },
  { q: 'SNU Holdings와 서울대기술지주회사의 차이와 충돌 지점을 설명해줘.', tag: '로그·차이보고' },
  { q: '서울대 단과대별로 진행하고 있는 주요 사업과, 단과대별 교원 구성을 알려줘.', tag: '로그·단과대집계' },
  { q: '나눔기반 인재육성과 " AI 기반 협력성과 아카이브 플랫폼 구축, 시범국가 성과측정"이 무슨 상관?', tag: '로그·의미해석' },
  { q: '법인화 이후 서울대 재정 구조가 어떻게 변했나? 등록금 동결 기간 재원 구성 변화를 알려줘', tag: '로그·복합보고' },
  {
    q: '외부 자료 확인해', tag: '후속·코어퍼런스(이석재)',
    history: [
      { role: 'user', content: '이석재 교수 정보 알려줘' },
      { role: 'assistant', content: '이석재는 서울대 이사회 내부이사로 재직. 학과·전공·교수경력 등 학문적 이력은 내부 자료에 없어 외부 자료 확인이 필요합니다.' },
    ],
  },
  {
    q: '그 중 실행된 건?', tag: '후속·코어퍼런스(비전)',
    history: [
      { role: 'user', content: '서울대 2040 비전의 주요 시행과제 알려줘' },
      { role: 'assistant', content: '서울대 2040 비전의 주요 시행과제는 A, B, C, D 등이 있습니다.' },
    ],
  },
];

async function main() {
  console.log(`\n질문 ${ITEMS.length}개 — planQuery 판별 (admin 기준 mode 매핑)\n${'='.repeat(70)}`);
  for (const it of ITEMS) {
    const p = await planQuery(it.q, it.history ?? []);
    const mode = p.intent === 'insight' ? 'policy(웹허용)' : 'normal(fact)';
    const rewritten = p.resolvedQuery.trim() !== it.q.trim();
    console.log(`\n▸ [${it.tag}]`);
    console.log(`  Q: "${it.q}"${it.history ? '   (직전 맥락 있음)' : ''}`);
    console.log(`  → intent=${p.intent}  complexity=${p.complexity}  recency=${p.recency}  college(b/a)=${p.collegeBreadth}/${p.collegeAggregate}`);
    console.log(`  → isFollowup=${p.isFollowup}${rewritten ? `  resolved="${p.resolvedQuery}"` : '  (재작성 안함)'}`);
    console.log(`  → mode(admin)=${mode}  | reason: ${p.reason}`);
  }
  console.log(`\n${'='.repeat(70)}\n(웹 *발동 여부*는 여기 안 보임 — 그건 답변 모델이 런타임에 결정. e2e로 별도 시연)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
