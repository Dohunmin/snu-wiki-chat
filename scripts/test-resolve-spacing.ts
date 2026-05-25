import { resolveText } from '@/lib/llm/citations';

const mapping = new Map<number, { wiki: string; page: string; topic?: string }>();
mapping.set(1, { wiki: '이사회', page: '2026-1차' });
mapping.set(2, { wiki: '이사회', page: '2024-1차' });
mapping.set(3, { wiki: '대학운영계획', page: '2026-운영계획-실행과제6' });

// 추가: stance 친화 형식 검증
mapping.set(4, { wiki: '유홍림총장연설', page: '그랜드퀘스트.유홍림.stance', topic: '그랜드퀘스트', title: '그랜드퀘스트 — 유홍림의 입장' });
mapping.set(5, { wiki: '재무정보공시', page: '재원구조분석.fact', topic: 'fact', title: '재원구조 분석' });

const cases: Array<[string, string]> = [
  ['의결되었습니다 [1][2].', '의결되었습니다 [이사회] 2026-1차 [이사회] 2024-1차.'],
  ['추진 [3][1] 후속', '추진 [대학운영계획] 2026-운영계획-실행과제6 [이사회] 2026-1차 후속'],
  ['plain text [1] then [2] separately', 'plain text [이사회] 2026-1차 then [이사회] 2024-1차 separately'],
  ['본문 안의 [text](http://url) 링크', '본문 안의 [text](http://url) 링크'],
  ['이사회 2026-1차[이사회] 2024-1차', '이사회 2026-1차 [이사회] 2024-1차'],
  // stance: 친화 형식 (sid 노출 X)
  ['그랜드퀘스트 발언 [4]', '그랜드퀘스트 발언 [유홍림총장연설 그랜드퀘스트 — 유홍림의 입장](/wiki?agent=yhl-speeches&type=stances&id=%EA%B7%B8%EB%9E%9C%EB%93%9C%ED%80%98%EC%8A%A4%ED%8A%B8.%EC%9C%A0%ED%99%8D%EB%A6%BC.stance)'],
  // fact: 친화 형식
  ['재무 [5] 참조', '재무 [재무정보공시 재원구조 분석](/wiki?agent=finance&type=facts&id=%EC%9E%AC%EC%9B%90%EA%B5%AC%EC%A1%B0%EB%B6%84%EC%84%9D.fact) 참조'],
];

console.log('=== resolveText 공백 처리 단위 테스트 ===\n');
for (const [input, expected] of cases) {
  const got = resolveText(input, mapping);
  const pass = got === expected;
  console.log(`${pass ? '✅' : '❌'} input : "${input}"`);
  console.log(`   expected: "${expected}"`);
  console.log(`   got     : "${got}"`);
  console.log('');
}
