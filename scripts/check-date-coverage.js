const fs = require('fs');
const path = require('path');

const wikis = ['senate', 'board', 'plan', 'vision', 'history', 'status', 'yhl-speeches', 'finance', 'leesj'];

console.log('Wiki           | sources | w/date | %    | facts (w/date) | stances (w/date) | overviews');
console.log('-'.repeat(95));

for (const id of wikis) {
  const file = path.join('data', id + '.json');
  if (!fs.existsSync(file)) {
    console.log(id, '— NO FILE');
    continue;
  }
  const d = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const sources = d.sources || [];
  const facts = d.facts || [];
  const stances = d.stances || [];
  const overviews = d.overviews || [];

  const sWithDate = sources.filter(s => s.date).length;
  const sPct = sources.length ? Math.round(sWithDate / sources.length * 100) : 0;
  const fWithDate = facts.filter(f => f.date || f.yearsCovered).length;
  const stWithDate = stances.filter(s => s.date).length;

  console.log(
    `${id.padEnd(14)} | ${String(sources.length).padStart(7)} | ${String(sWithDate).padStart(6)} | ${String(sPct + '%').padEnd(4)} | ${String(facts.length).padStart(3)} (${fWithDate})       | ${String(stances.length).padStart(3)} (${stWithDate})         | ${overviews.length}`
  );
}
