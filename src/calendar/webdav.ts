const textEncoder = new TextEncoder();

export type WebDavResponse = {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
};

export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

export async function httpRequest(input: {
  method: string;
  url: string;
  username: string;
  password: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string | null;
  expectBody?: boolean;
}): Promise<WebDavResponse> {
  const headers = new Headers(input.headers || {});
  if (!headers.has("Authorization")) {
    headers.set("Authorization", basicAuthHeader(input.username, input.password));
  }

  let body: BodyInit | undefined;
  if (typeof input.body === "string") {
    body = input.body;
  } else if (input.body instanceof Uint8Array) {
    body = input.body.buffer.slice(
      input.body.byteOffset,
      input.body.byteOffset + input.body.byteLength,
    ) as ArrayBuffer;
  } else if (input.body) {
    body = input.body as BodyInit;
  }

  const response = await fetch(input.url, {
    method: input.method.toUpperCase(),
    headers,
    body,
  });

  const headerMap: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headerMap[key.toLowerCase()] = value;
  });

  if (input.expectBody === false) {
    return {
      status: response.status,
      headers: headerMap,
      body: new Uint8Array(),
    };
  }

  const buffer = await response.arrayBuffer();
  return {
    status: response.status,
    headers: headerMap,
    body: new Uint8Array(buffer),
  };
}

export async function httpRequestXml(input: {
  method: string;
  url: string;
  username: string;
  password: string;
  headers?: Record<string, string>;
  body?: string | null;
  expectBody?: boolean;
}): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  const response = await httpRequest({
    ...input,
    body: input.body ? textEncoder.encode(input.body) : undefined,
  });
  return {
    status: response.status,
    headers: response.headers,
    text: new TextDecoder().decode(response.body),
  };
}

export function getHeader(
  headers: Record<string, string>,
  name: string,
): string | null {
  return headers[name.toLowerCase()] || null;
}
