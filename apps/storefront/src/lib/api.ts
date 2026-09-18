const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}/api${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export { API_URL };
