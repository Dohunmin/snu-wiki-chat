/**
 * Design Ref: §4.1 — Voyage API 클라이언트
 * Plan SC: SC2 (finance 임베딩 성공)
 *
 * Voyage 4 large 임베딩 API 클라이언트 (최신·최고 품질).
 * - Matryoshka 임베딩: 256/512/1024/2048 차원 지원, 1024로 사용
 * - 한국어 거버넌스 도메인 SOTA, Anthropic 공식 파트너
 * - 다국어 통합 모델 (voyage-multilingual-2 후속, 우월)
 * - REST API 직접 호출 (SDK 의존성 회피, Edge 런타임 호환)
 * - 가격: $0.12/M 토큰, 200M 무료 (PoC는 사실상 $0)
 *
 * 환경변수: VOYAGE_API_KEY 필수
 */

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const MODEL = 'voyage-4-large';      // 최신 최고 품질 (Matryoshka, 한국어 SOTA)
const MAX_BATCH = 128;               // Voyage 권장 배치 크기
const MAX_RETRY = 3;
const RETRY_DELAY_MS = 1000;         // 초기 지연 (exponential backoff)
export const EMBEDDING_DIMS = 1024;  // schema VECTOR(1024)와 일치, Matryoshka로 명시 요청

export interface VoyageRequest {
  texts: string[];                   // 최대 128개
  inputType: 'document' | 'query';   // document=빌드용, query=검색용
}

interface VoyageApiResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { total_tokens: number };
}

class VoyageError extends Error {
  constructor(message: string, public status?: number, public cause?: unknown) {
    super(message);
    this.name = 'VoyageError';
  }
}

function getApiKey(): string {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) {
    throw new VoyageError(
      'VOYAGE_API_KEY 환경변수가 설정되지 않았습니다. .env.local에 추가하거나 Vercel 환경변수로 설정하세요.',
    );
  }
  return key;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Voyage API 단일 호출 (최대 128 텍스트).
 * 실패 시 exponential backoff로 재시도.
 */
async function embedSingleBatch(req: VoyageRequest): Promise<number[][]> {
  if (req.texts.length === 0) return [];
  if (req.texts.length > MAX_BATCH) {
    throw new VoyageError(`Batch size ${req.texts.length} exceeds max ${MAX_BATCH}. Use embedBatched().`);
  }

  const apiKey = getApiKey();

  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    try {
      const res = await fetch(VOYAGE_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          input: req.texts,
          input_type: req.inputType,
          output_dimension: EMBEDDING_DIMS,   // Matryoshka — 1024 명시 (기본도 1024지만 안전)
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        // 429(rate limit), 500-599(서버 에러)는 재시도. 4xx은 즉시 실패.
        if (res.status === 429 || res.status >= 500) {
          throw new VoyageError(`Voyage API ${res.status}: ${body}`, res.status);
        }
        throw new VoyageError(`Voyage API ${res.status}: ${body}`, res.status);
      }

      const data = (await res.json()) as VoyageApiResponse;

      // 응답 인덱스 순으로 정렬 (Voyage가 보장하지만 명시적으로)
      const sorted = [...data.data].sort((a, b) => a.index - b.index);
      const embeddings = sorted.map(d => d.embedding);

      // 차원 검증
      for (const emb of embeddings) {
        if (emb.length !== EMBEDDING_DIMS) {
          throw new VoyageError(`Expected ${EMBEDDING_DIMS} dims, got ${emb.length}`);
        }
      }

      return embeddings;
    } catch (err) {
      lastError = err;
      const isRetryable =
        err instanceof VoyageError &&
        (err.status === 429 || (err.status !== undefined && err.status >= 500));

      if (!isRetryable || attempt === MAX_RETRY) {
        throw err;
      }

      // Exponential backoff: 1s → 2s → 4s
      const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
      console.warn(`[voyage] Retry ${attempt + 1}/${MAX_RETRY} after ${delay}ms (${(err as Error).message})`);
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * 임의 개수의 텍스트를 자동으로 128개씩 배치하여 임베딩.
 * 진행률을 console.log로 출력.
 *
 * @param texts 임베딩할 텍스트 배열
 * @param inputType 'document' (빌드) 또는 'query' (검색)
 * @returns 입력 순서와 같은 임베딩 배열
 */
export async function embedBatched(
  texts: string[],
  inputType: 'document' | 'query' = 'document',
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const results: number[][] = [];
  const totalBatches = Math.ceil(texts.length / MAX_BATCH);

  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const batch = texts.slice(i, i + MAX_BATCH);
    const batchIdx = Math.floor(i / MAX_BATCH) + 1;
    console.log(`[voyage] Batch ${batchIdx}/${totalBatches} (${batch.length} texts)...`);

    const embeddings = await embedSingleBatch({ texts: batch, inputType });
    results.push(...embeddings);
  }

  return results;
}

/**
 * 단일 텍스트 임베딩 (편의 함수, 주로 검색 시 사용).
 */
export async function embedOne(
  text: string,
  inputType: 'document' | 'query' = 'query',
): Promise<number[]> {
  const [emb] = await embedBatched([text], inputType);
  return emb;
}

export { VoyageError };
