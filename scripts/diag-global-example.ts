/** 전역 top-K 예시 — 복잡한 실제 질의 2개로 "현재 per-wiki 덤프 vs 전역 top-K" 대조. LLM 0(Voyage만). */
import { loadEnvFile } from 'process';
import fs from 'fs';
try { loadEnvFile('.env.local'); } catch { /* 무시 */ }
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { embedOne } from '@/lib/embed/voyage';
import { routeQuery } from '@/lib/agents/router';
import { canAccessSensitive } from '@/lib/auth/roles';
import type { Role } from '@/lib/auth/roles';

const NAME: Record<string, string> = {
  senate: '평의원회', board: '이사회', plan: '대학운영계획', vision: '중장기발전계획',
  history: '70년역사', status: '대학현황(always)', 'yhl-speeches': '유홍림총장연설', finance: '재무정보공시', leesj: '이석재',
};

async function globalTopK(emb: number[], sensitiveAllowed: boolean, k: number) {
  const lit = `[${emb.join(',')}]`;
  const res = await db.execute(sql`
    SELECT wiki_id, page_type, COALESCE(metadata->>'title', page_id) AS title,
           1 - (embedding <=> ${lit}::vector) / 2 AS sim, LENGTH(chunk_text) AS chars
    FROM chunk_embeddings
    WHERE (${sensitiveAllowed} OR sensitive = FALSE)
    ORDER BY embedding <=> ${lit}::vector
    LIMIT ${k}
  `);
  const rows = Array.isArray(res) ? res : ((res as unknown as { rows?: unknown[] }).rows ?? []);
  return rows as Array<{ wiki_id: string; page_type: string; title: string; sim: number | string; chars: number | string }>;
}

async function main() {
  const role = 'admin' as Role;
  const sensitiveAllowed = canAccessSensitive(role);
  const all = JSON.parse(fs.readFileSync('scripts/gold-questions.json', 'utf-8')) as Array<{ question: string; mode?: string }>;
  const byLen = all.filter(q => !(q.mode || '').startsWith('lens:')).sort((a, b) => [...b.question].length - [...a.question].length);
  const picks = [byLen[0].question, byLen[1].question];   // 가장 복잡한 2개

  for (let idx = 0; idx < picks.length; idx++) {
    const q = picks[idx];
    console.log('\n' + '═'.repeat(82));
    console.log(`예시 ${idx + 1}: "${q.slice(0, 70)}..."`);
    console.log('═'.repeat(82));

    // 현재 — per-wiki 덤프
    const routing = await routeQuery(q, role);
    const cur = routing.contexts.map(c => ({ id: c.agentId, chars: [...c.relevantData].length, src: c.sources.length }))
      .sort((a, b) => b.chars - a.chars);
    const curTotal = cur.reduce((s, c) => s + c.chars, 0);

    // 전역 top-K=24
    const emb = await embedOne(q, 'query');
    const top = await globalTopK(emb, sensitiveAllowed, 24);
    const byWiki = new Map<string, { n: number; chars: number; simMin: number; simMax: number; titles: string[] }>();
    for (const r of top) {
      const sim = Number(r.sim), chars = Number(r.chars);
      const e = byWiki.get(r.wiki_id) ?? { n: 0, chars: 0, simMin: 1, simMax: 0, titles: [] };
      e.n++; e.chars += chars; e.simMin = Math.min(e.simMin, sim); e.simMax = Math.max(e.simMax, sim);
      if (e.titles.length < 2) e.titles.push(`${r.page_type}:${String(r.title).slice(0, 22)}`);
      byWiki.set(r.wiki_id, e);
    }
    const gTotal = top.reduce((s, r) => s + Number(r.chars), 0);
    const globalWikis = new Set(byWiki.keys());

    console.log(`\n[현재 — per-wiki 덤프]  총 ${curTotal.toLocaleString()}자 / 위키 ${cur.length}개`);
    for (const c of cur) {
      const inG = globalWikis.has(c.id);
      const tag = inG ? `✅ 전역 top-K에 ${byWiki.get(c.id)!.n}청크` : '❌ 전역 top-K에 0 — 노이즈로 탈락';
      console.log(`  ${(NAME[c.id] ?? c.id).padEnd(16)} ${String(c.chars).padStart(7)}자 (소스 ${c.src})   ${tag}`);
    }

    console.log(`\n[전역 top-K=24]  총 ${gTotal.toLocaleString()}자 / 위키 ${byWiki.size}개  →  추정 절감 ${Math.round((1 - gTotal / curTotal) * 100)}%`);
    for (const [id, e] of [...byWiki.entries()].sort((a, b) => b[1].n - a[1].n)) {
      console.log(`  ${(NAME[id] ?? id).padEnd(16)} ${String(e.n).padStart(2)}청크  sim ${e.simMin.toFixed(2)}~${e.simMax.toFixed(2)}  ${String(e.chars).padStart(6)}자   ${e.titles.join(' / ')}`);
    }
    const dropped = cur.filter(c => !globalWikis.has(c.id));
    if (dropped.length) console.log(`  → 전역이 버린 위키: ${dropped.map(c => `${NAME[c.id] ?? c.id}(${c.chars}자)`).join(', ')}`);
  }
}
main().catch(err => { console.error(err); process.exit(1); });
