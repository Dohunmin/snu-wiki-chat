// Design Ref: college-grad-wiki §4 (adapter_key → SiteAdapter) / §1.2 (점진 구축)
// adapter_key로 어댑터 인스턴스 해석. 셀렉터/URL은 config/adapters/{key}.selectors.yaml(데이터).
// Phase 1은 snu-cms·wordpress-kboard 2종만. 나머지 6 엔진은 조직 활성화 시 추가.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import type { AdapterKey, SelectorConfig } from '../types';
import type { SiteAdapter } from '../adapter';
import { createSnuCms } from './snu-cms';
import { createWordpressKboard } from './wordpress-kboard';
import { createEgovframe } from './egovframe';
import { createPathBased } from './path-based';

const SELECTORS_DIR = join(process.cwd(), 'config', 'adapters');
const selectorCache = new Map<AdapterKey, SelectorConfig>();

function loadSelectors(key: AdapterKey): SelectorConfig {
  if (selectorCache.has(key)) return selectorCache.get(key)!;
  let cfg: SelectorConfig;
  try {
    cfg = yaml.load(readFileSync(join(SELECTORS_DIR, `${key}.selectors.yaml`), 'utf-8')) as SelectorConfig;
  } catch {
    cfg = { key, extract: { main_selector: ['main', '#content', '.contents', 'body'], strip_selectors: [] } };
  }
  selectorCache.set(key, cfg);
  return cfg;
}

// Phase별 점진 구축: 구현된 엔진만 등록. (남은: gnuboard·dotnet-mvc·asp-bidx·wordpress-custom)
const FACTORIES: Partial<Record<AdapterKey, (s: SelectorConfig) => SiteAdapter>> = {
  'snu-cms': createSnuCms,
  'wordpress-kboard': createWordpressKboard,
  'egovframe': createEgovframe, // medicine·dent
  'path-based': createPathBased, // music·gsep
};

export function getAdapter(key: AdapterKey): SiteAdapter {
  const factory = FACTORIES[key];
  if (!factory) {
    throw new Error(
      `[adapters] 미구현 어댑터: "${key}". Phase별 점진 구축 — 현재 ${Object.keys(FACTORIES).join('·')}만 지원.`,
    );
  }
  return factory(loadSelectors(key));
}

export function isAdapterImplemented(key: AdapterKey): boolean {
  return key in FACTORIES;
}
