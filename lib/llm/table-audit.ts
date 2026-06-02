/**
 * 표 산수 검산 (코드, LLM 0) — 답변의 마크다운 수치 표에서
 *   (A) 비중(%) 합 = 100% 인지, (B) 항목 합 = '합계' 행 값 인지 결정적으로 검산.
 *
 * 배경: LLM이 각주(¹)로 표시된 별도 행(예: 적립금)을 세출 항목으로 오인해
 *       비중 합 101.4%·항목 합 ≠ 총계 같은 산수 오류를 냄(2026-06-02 적립금 사례).
 *       프롬프트 nudge로는 안 잡혀 코드 검산이 필요. 모든 재무·통계 표에 일반 적용.
 *
 * 보수적(오탐 최소화): 소계가 있는 계층 표는 합계검사 skip, 범위·추정(~,약)은 제외,
 *   %는 share성 컬럼(헤더가 비중/비율 또는 합이 100 근처)일 때만 검사.
 */
export interface TableIssue {
  kind: 'percent-mismatch' | 'total-mismatch';
  detail: string;
  expected: number;
  actual: number;
}

function parseAmount(cell: string): number | null {
  const c = cell.replace(/\*\*/g, '').trim();
  if (/\d\s*~\s*\d|약|내외|미정|개선/.test(c)) return null;   // 범위·추정 제외
  const m = c.match(/-?[\d,]+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(/,/g, ''));
  return Number.isNaN(n) ? null : n;
}
function parsePercent(cell: string): number | null {
  const m = cell.replace(/\*\*/g, '').match(/(-?[\d,]+(?:\.\d+)?)\s*%/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return Number.isNaN(n) ? null : n;
}

/** 마크다운 표(연속된 | 줄) 추출 → 표마다 행×셀 */
function parseTables(text: string): string[][][] {
  const tables: string[][][] = [];
  let cur: string[][] = [];
  for (const line of text.split('\n')) {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      cur.push(line.trim().replace(/^\||\|$/g, '').split('|').map(s => s.trim()));
    } else { if (cur.length >= 3) tables.push(cur); cur = []; }
  }
  if (cur.length >= 3) tables.push(cur);
  return tables;
}

const isSep = (row: string[]) => row.every(c => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')) || c === '');
const TOTAL_RE = /합\s*계|총\s*계|총액/;
const SUBTOTAL_RE = /소\s*계/;
const SHARE_HEADER_RE = /비중|구성|비율|점유/;

export function validateTables(text: string): TableIssue[] {
  const issues: TableIssue[] = [];
  for (const table of parseTables(text)) {
    const rows = table.filter(r => !isSep(r));
    if (rows.length < 4) continue;          // 헤더+항목3+ 이상만
    const header = rows[0];
    const body = rows.slice(1);
    const ncol = Math.max(...rows.map(r => r.length));
    const hasSubtotal = body.some(r => SUBTOTAL_RE.test(r[0] ?? ''));
    const totalIdx = body.findIndex(r => TOTAL_RE.test((r[0] ?? '').replace(/\*/g, '')));

    for (let col = 1; col < ncol; col++) {
      const head = header[col] ?? '';
      // (A) 비중(%) 합 = 100%
      const itemPcts = body.filter((r, i) => i !== totalIdx && !SUBTOTAL_RE.test(r[0] ?? ''))
        .map(r => parsePercent(r[col] ?? '')).filter((v): v is number => v !== null);
      if (itemPcts.length >= 3) {
        const sum = itemPcts.reduce((a, b) => a + b, 0);
        const isShare = SHARE_HEADER_RE.test(head) || Math.abs(sum - 100) <= 5;
        if (isShare && Math.abs(sum - 100) > 1.0) {
          issues.push({ kind: 'percent-mismatch', detail: `'${head || `${col}열`}' 비중 합 ${sum.toFixed(1)}% ≠ 100%`, expected: 100, actual: +sum.toFixed(1) });
        }
      }
      // (B) 항목 합 = 합계 행 (소계 없을 때만 — 계층 표 오탐 방지)
      if (!hasSubtotal && totalIdx >= 0) {
        const total = parseAmount(body[totalIdx][col] ?? '');
        const items = body.filter((_, i) => i !== totalIdx).map(r => parseAmount(r[col] ?? '')).filter((v): v is number => v !== null);
        if (total !== null && total > 0 && items.length >= 3) {
          const sum = items.reduce((a, b) => a + b, 0);
          const tol = Math.max(2, total * 0.005);
          if (Math.abs(sum - total) > tol) {
            issues.push({ kind: 'total-mismatch', detail: `'${head || `${col}열`}' 항목 합 ${sum.toLocaleString()} ≠ 합계 ${total.toLocaleString()}`, expected: total, actual: sum });
          }
        }
      }
    }
  }
  const seen = new Set<string>();
  return issues.filter(i => { const k = i.kind + i.detail; if (seen.has(k)) return false; seen.add(k); return true; });
}
