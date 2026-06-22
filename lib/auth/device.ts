/**
 * 기기 바인딩(device binding).
 * 브라우저(기기)마다 httpOnly 랜덤 식별자 쿠키(device-id)를 발급하고,
 * 로그인 시 그 값을 세션 토큰에 고정한다. 매 요청에서 쿠키의 device-id와
 * 토큰에 박힌 값을 대조해, 다른 기기에서의 세션 쿠키 재사용을 차단한다.
 * IP가 바뀌어도(예: LTE↔Wi-Fi) 같은 기기면 유지된다.
 */
export const DEVICE_COOKIE = 'device-id';

// 브라우저가 허용하는 최대치(약 400일)까지 길게 유지 — 세션(24h)과 별개의 영속 쿠키.
export const DEVICE_COOKIE_MAX_AGE = 60 * 60 * 24 * 400;

/** Cookie 헤더 문자열에서 device-id 추출 (authorize 단계용). */
export function parseDeviceId(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key === DEVICE_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}
