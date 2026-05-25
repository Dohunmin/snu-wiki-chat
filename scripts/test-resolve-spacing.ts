import { resolveText } from '@/lib/llm/citations';

const mapping = new Map<number, { wiki: string; page: string; topic?: string }>();
mapping.set(1, { wiki: '이사회', page: '2026-1차' });
mapping.set(2, { wiki: '이사회', page: '2024-1차' });
mapping.set(3, { wiki: '대학운영계획', page: '2026-운영계획-실행과제6' });

const cases: Array<[string, string]> = [
  ['의결되었습니다 [1][2].', '의결되었습니다 [이사회] 2026-1차 [이사회] 2024-1차.'],
  ['추진 [3][1] 후속', '추진 [대학운영계획] 2026-운영계획-실행과제6 [이사회] 2026-1차 후속'],
  ['plain text [1] then [2] separately', 'plain text [이사회] 2026-1차 then [이사회] 2024-1차 separately'],
  ['본문 안의 [text](http://url) 링크', '본문 안의 [text](http://url) 링크'],
  ['이사회 2026-1차[이사회] 2024-1차', '이사회 2026-1차 [이사회] 2024-1차'],
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
