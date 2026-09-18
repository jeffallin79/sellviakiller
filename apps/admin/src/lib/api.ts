const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export async function api<T = unknown>(
  path: string,
  opts: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${API_URL}/api${path}`, {
    ...opts,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return res.json();
  return (await res.text()) as T;
}

export { API_URL };
