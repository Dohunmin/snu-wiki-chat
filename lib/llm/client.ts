import Anthropic from '@anthropic-ai/sdk';

let _client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다. .env.local 파일에 API 키를 추가해 주세요.');
  }
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

export const LLM_MODEL = 'claude-sonnet-4-6';
// Design Ref: rag-cost-reduction §2 M1c — 보조 작업(형식 교정 등) 티어링용(후속 모듈에서 사용).
export const LLM_MODEL_LIGHT = 'claude-haiku-4-5-20251001';
// 16000→12000: runaway 출력 상한(평균 비용 영향 ~0 — 미사용분 미청구). M0c stop_reason 로깅이 절단 감지.
//   8000 금지(망라형 '정리해줘' + 말미 P5 한계마커 절단 위험). 출력 p99 측정 후 추가 조정.
export const MAX_TOKENS = 12000;
