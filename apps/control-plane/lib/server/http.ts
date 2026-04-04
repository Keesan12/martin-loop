const DEFAULT_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff"
};

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(DEFAULT_HEADERS);
  const initHeaders = new Headers(init.headers ?? undefined);

  initHeaders.forEach((value, key) => {
    headers.set(key, value);
  });

  return new Response(JSON.stringify(body), {
    ...init,
    headers
  });
}

export function jsonError(
  code: string,
  message: string,
  init: ResponseInit = {}
): Response {
  return jsonResponse(
    {
      accepted: false,
      error: {
        code,
        message
      }
    },
    {
      status: init.status ?? 400,
      ...init
    }
  );
}
