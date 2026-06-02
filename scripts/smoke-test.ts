/**
 * 커밋 전 라이브 스모크 — 핵심 기능이 실제로 도는지 최소 비용 확인.
 *   1) 일반 단일위키  2) 다중위키  3) lens 모드(admin)
 *   각: 라우팅 → 번호컨텍스트 → 생성 → 인용변환 까지 실행하고 결과 점검.
 *
 * 실행: npx tsx scripts/smoke-test.ts   (Sonnet 생성 3회 ≈ $0.35)
 */
import { loadEnvFile } from 'process';
try { loadEnvFile('.env.local'); } catch {}
import { routeQuery } from '@/lib/agents/router';
import { loadPersonaContext } from '@/lib/agents/lens';
import { buildNumberedContexts, resolveText, extractCitedNumbers, resolveCitations } from '@/lib/llm/citations';
import { buildSystemPrompt, buildUserMessage, buildLensSystemPrompt, buildLensUserMessage } from '@/lib/llm/prompts';
import { getAnthropicClient, LLM_MODEL, MAX_TOKENS } from '@/lib/llm/client';
import type { Role } from '@/lib/auth/roles';

const textOf = (c: { type: string }[]) => c.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join('');

const CASES: { label: string; q: string; role: Role; mode: string }[] = [
  { label: '① 일반 단일위키(재무)', q: '2024년 정부출연금은 얼마인가요?', role: 'tier1', mode: 'normal' },
  { label: '② 다중위키(등록금 동결 결정주체)', q: '등록금 동결은 어디서 결정하나? 법인화 이후 재정 변화도 알려줘', role: 'tier1', mode: 'normal' },
  { label: '③ lens 모드(이석재, admin)', q: '대학원생 처우에 대한 입장은?', role: 'admin', mode: 'lens:leesj' },
];

async function main() {
  for (const c of CASES) {
    console.log('\n' + '═'.repeat(76));
    console.log(c.label + '  | role=' + c.role + ' mode=' + c.mode);
    console.log('Q: ' + c.q);
    try {
      const routing = await routeQuery(c.q, c.role);
      const numbered = buildNumberedContexts(routing.contexts);
      let system: string, user: string, lensInfo = '';
      if (c.mode.startsWith('lens:')) {
        const persona = await loadPersonaContext(c.mode.slice(5), c.q, c.role);
        if (!persona) { console.log('❌ persona 로드 실패'); continue; }
        lensInfo = `persona=${persona.displayName}, insufficient=${persona.insufficient}, stanceBlock 길이=${persona.stanceBlock?.length ?? 0}`;
        system = buildLensSystemPrompt(routing.contexts, persona, c.role);
        user = buildLensUserMessage(c.q, numbered.contextMarkdown, numbered.summary, persona);
      } else {
        system = buildSystemPrompt(routing.contexts, c.role);
        user = buildUserMessage(c.q, numbered.contextMarkdown, numbered.summary);
      }
      const resp = await getAnthropicClient().messages.create({ model: LLM_MODEL, max_tokens: MAX_TOKENS, system, messages: [{ role: 'user', content: user }] });
      const raw = textOf(resp.content);
      const resolved = resolveText(raw, numbered.mapping);
      const cited = resolveCitations(extractCitedNumbers(raw), numbered.mapping);
      const bareNums = (resolved.match(/\[\d[\d,\s]*\](?!\()/g) || []);
      const oldFmtLeak = (resolved.match(/\[[가-힣]{2,}\]\s*[\w가-힣·\-]+\.(?:fact|stance|overview)/g) || []);

      console.log('라우팅 위키: ' + (routing.selectedAgentIds.join(', ') || '(없음)'));
      if (lensInfo) console.log('lens: ' + lensInfo);
      console.log('인용 소스 수: ' + cited.length + ' | 미해결 숫자노출: ' + bareNums.length + ' | 내부ID노출: ' + oldFmtLeak.length);
      console.log('답변 앞 320자:\n  ' + resolved.replace(/\n/g, '\n  ').slice(0, 320));
      const ok = routing.selectedAgentIds.length > 0 && raw.length > 50 && bareNums.length === 0 && oldFmtLeak.length === 0;
      console.log(ok ? '✅ 정상' : '⚠️ 점검 필요(위 수치 확인)');
    } catch (e) {
      console.log('❌ 오류: ' + (e instanceof Error ? e.message : String(e)));
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
