export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch("/api" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const error = data as { error: { message: string; hint?: string } };
    throw Error(
      error.error.message + (error.error.hint ? " " + error.error.hint : ""),
    );
  }
  return data as T;
}
