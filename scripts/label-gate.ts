import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const port = Number(process.env.LABEL_PORT ?? 3477);
const dir = process.env.BENCHMARK_DIR ?? "eval/gate-benchmark-v1";
const postsPath = join(dir, "posts.json");
const labelsPath = join(dir, "labels.json");
const pagePath = join(dir, "index.html");

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}

type PostsFile = { posts: Array<{ tweetId: string }> };
type LabelsFile = { id: string; updatedAt: string | null; labels: Record<string, "idea" | "not_idea"> };

const posts = await readJson<PostsFile>(postsPath);
const tweetIds = new Set(posts.posts.map((post) => post.tweetId));

async function loadLabels(): Promise<LabelsFile> {
  try {
    return await readJson<LabelsFile>(labelsPath);
  } catch {
    return { id: "gate-benchmark-v1", updatedAt: null, labels: {} };
  }
}

await mkdir(dir, { recursive: true });

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(Bun.file(pagePath), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
    if (request.method === "GET" && url.pathname === "/posts.json") {
      return new Response(Bun.file(postsPath), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (request.method === "GET" && url.pathname === "/labels.json") {
      return Response.json(await loadLabels());
    }
    if (request.method === "PUT" && url.pathname === "/api/label") {
      const body = (await request.json()) as { tweetId?: string; label?: "idea" | "not_idea" | null };
      if (!body.tweetId || !tweetIds.has(body.tweetId)) {
        return Response.json({ error: "Unknown post" }, { status: 400 });
      }
      if (body.label !== "idea" && body.label !== "not_idea" && body.label !== null) {
        return Response.json({ error: "Label must be idea, not_idea, or null" }, { status: 400 });
      }
      const file = await loadLabels();
      if (body.label === null) delete file.labels[body.tweetId];
      else file.labels[body.tweetId] = body.label;
      file.updatedAt = new Date().toISOString();
      await writeJson(labelsPath, file);
      return Response.json(file);
    }
    if (request.method === "GET" && url.pathname === "/img") {
      const imageUrl = url.searchParams.get("u");
      if (!imageUrl || !/^https?:\/\//.test(imageUrl)) {
        return new Response("Bad image URL", { status: 400 });
      }
      const upstream = await fetch(imageUrl, {
        signal: AbortSignal.timeout(15_000),
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
      });
      if (!upstream.ok) return new Response("Image not found", { status: 502 });
      return new Response(upstream.body, {
        headers: {
          "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Idea bench: http://127.0.0.1:${server.port}`);
