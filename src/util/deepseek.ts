import { config } from "../config";

export type DeepSeekReference = { url: string; title: string | null };

export async function imageUrlToDataUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024) return null;
    const mime = response.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return null;
  }
}

function outputTextFromResponses(payload: {
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string; annotations?: unknown[] }>;
  }>;
  output_text?: string;
}): string {
  if (payload.output_text) return payload.output_text;
  const text = payload.output
    ?.flatMap((item) => item.content ?? [])
    .find((item) => item.type === "output_text")?.text;
  if (!text) throw new Error("DeepSeek Responses API returned no output text");
  return text;
}

function referencesFromResponses(payload: {
  output?: unknown;
}): DeepSeekReference[] {
  const references: DeepSeekReference[] = [];
  const seen = new Set<string>();

  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    const url =
      typeof record.url === "string"
        ? record.url
        : typeof record.uri === "string"
          ? record.uri
          : null;
    const title = typeof record.title === "string" ? record.title : null;
    if (url && /^https?:\/\//.test(url) && !seen.has(url)) {
      seen.add(url);
      references.push({ url, title });
    }
    for (const value of Object.values(record)) visit(value);
  };

  visit(payload.output);
  return references;
}

export async function generateDeepSeekJson<T>(options: {
  model?: string;
  system: string;
  text: string;
  imageUrls?: string[];
  parse: (raw: unknown) => T;
  jsonSchema: Record<string, unknown>;
  schemaName: string;
  maxOutputTokens?: number;
}): Promise<{ value: T; references: DeepSeekReference[] }> {
  const images = (
    await Promise.all((options.imageUrls ?? []).slice(0, 4).map((url) => imageUrlToDataUrl(url)))
  ).filter((url): url is string => Boolean(url));

  const response = await fetch("https://api.deepseek.com/responses", {
    method: "POST",
    signal: AbortSignal.timeout(90_000),
    headers: {
      Authorization: `Bearer ${config.deepseekApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: (options.model ?? config.extractorModel).startsWith("deepseek")
        ? (options.model ?? config.extractorModel)
        : "deepseek-flash",
      instructions: options.system,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: options.text },
            ...images.map((image_url) => ({ type: "input_image", image_url, detail: "low" })),
          ],
        },
      ],
      tools: [{ type: "web_search" }],
      reasoning: { effort: "none" },
      text: {
        format: {
          type: "json_schema",
          name: options.schemaName,
          schema: options.jsonSchema,
        },
      },
      max_output_tokens: options.maxOutputTokens ?? 6_000,
    }),
  });
  if (!response.ok) {
    throw new Error(`DeepSeek API ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  const payload = (await response.json()) as {
    output?: unknown;
    output_text?: string;
  };
  return {
    value: options.parse(JSON.parse(outputTextFromResponses(payload))),
    references: referencesFromResponses(payload),
  };
}
