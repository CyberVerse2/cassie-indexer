import { z } from "zod";
import { config } from "../config";

export type QwenReference = { url: string; title: string | null };
export type QwenContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;

const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
          annotations: z.array(z.unknown()).optional(),
        }),
      }),
    )
    .min(1),
});

async function imageUrlToDataUrl(url: string): Promise<string | null> {
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

async function withInlineImages(content: QwenContent): Promise<QwenContent> {
  if (typeof content === "string") return content;
  return Promise.all(
    content.map(async (part) => {
      if (part.type !== "image_url" || part.image_url.url.startsWith("data:")) return part;
      const data = await imageUrlToDataUrl(part.image_url.url);
      return data ? { type: "image_url" as const, image_url: { url: data } } : part;
    }),
  );
}

function messageText(payload: z.infer<typeof responseSchema>): string {
  const content = payload.choices[0].message.content;
  if (typeof content === "string" && content.trim()) return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const record = part as Record<string, unknown>;
        return typeof record.text === "string" ? record.text : "";
      })
      .join("");
    if (text.trim()) return text;
  }
  throw new Error("Qwen returned no output text");
}

export function referencesFromOpenRouter(payload: unknown): QwenReference[] {
  const references: QwenReference[] = [];
  const seen = new Set<string>();

  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    const citation =
      record.type === "url_citation" && record.url_citation && typeof record.url_citation === "object"
        ? (record.url_citation as Record<string, unknown>)
        : record;
    const url = typeof citation.url === "string" ? citation.url : null;
    const title = typeof citation.title === "string" ? citation.title : null;
    if (url && /^https?:\/\//.test(url) && (record.type === "url_citation" || record.url_citation) && !seen.has(url)) {
      seen.add(url);
      references.push({ url, title });
    }
    for (const value of Object.values(record)) visit(value);
  };

  visit(payload);
  return references;
}

function searchTools() {
  return {
    tools: [
      {
        type: "openrouter:web_search",
        parameters: {
          engine: "exa",
          max_results: 5,
          max_uses: 2,
          search_context_size: "low",
        },
      },
    ],
    max_tool_calls: 2,
  };
}

async function openRouterChat(options: {
  model?: string;
  system: string;
  content: QwenContent;
  maxTokens: number;
  webSearch?: boolean;
  json?: boolean;
  timeoutMs: number;
}) {
  const response = await fetch(`${config.openrouterBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(options.timeoutMs),
    headers: {
      Authorization: `Bearer ${config.openrouterApiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/thecyberverse/cassie-indexer",
      "X-Title": "cassie-indexer",
    },
    body: JSON.stringify({
      model: options.model ?? config.qwenModel,
      messages: [
        { role: "system", content: options.system },
        { role: "user", content: await withInlineImages(options.content) },
      ],
      reasoning: { enabled: false },
      temperature: 0,
      max_tokens: options.maxTokens,
      ...(options.json ? { response_format: { type: "json_object" } } : {}),
      ...(options.webSearch ? searchTools() : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter Qwen API ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  return responseSchema.parse(await response.json());
}

export async function generateQwenText(options: {
  model?: string;
  system: string;
  content: QwenContent;
  maxTokens?: number;
  webSearch?: boolean;
}): Promise<{ text: string; references: QwenReference[] }> {
  const payload = await openRouterChat({
    model: options.model,
    system: options.system,
    content: options.content,
    maxTokens: options.maxTokens ?? 800,
    webSearch: options.webSearch,
    timeoutMs: options.webSearch ? 60_000 : 30_000,
  });
  return { text: messageText(payload), references: referencesFromOpenRouter(payload) };
}

export async function generateQwenJson<T>(options: {
  model?: string;
  system: string;
  content: QwenContent;
  schema: z.ZodType<T>;
  maxTokens?: number;
  webSearch?: boolean;
}): Promise<T> {
  const maxTokens = options.maxTokens ?? 1_024;
  const payload = await openRouterChat({
    model: options.model,
    system: options.system,
    content: options.content,
    maxTokens,
    webSearch: options.webSearch,
    json: true,
    timeoutMs: options.webSearch || maxTokens > 2_000 ? 90_000 : 30_000,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(messageText(payload));
  } catch {
    throw new Error("Qwen returned invalid JSON");
  }
  return options.schema.parse(parsed);
}
