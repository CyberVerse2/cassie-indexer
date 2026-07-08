import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client";

const { rawPosts } = schema;
type Post = typeof rawPosts.$inferSelect;

// A thread is a chain of same-author posts linked by reply_to_tweet_id. We
// reassemble it so a thesis spread across several tweets is extracted ONCE,
// instead of once per tweet (which produced duplicates and orphan fragments).

async function sameAuthorParent(post: Post): Promise<Post | null> {
  if (!post.replyToTweetId) return null;
  const [parent] = await db
    .select()
    .from(rawPosts)
    .where(
      and(
        eq(rawPosts.tweetId, post.replyToTweetId),
        eq(rawPosts.authorHandle, post.authorHandle),
      ),
    )
    .limit(1);
  return parent ?? null;
}

async function sameAuthorChildren(post: Post): Promise<Post[]> {
  return db
    .select()
    .from(rawPosts)
    .where(
      and(
        eq(rawPosts.replyToTweetId, post.tweetId),
        eq(rawPosts.authorHandle, post.authorHandle),
      ),
    );
}

/** Walk up same-author reply links to the tweet that opened the thread. A post
 * replying to someone ELSE (or to nothing) is itself a root. */
export async function findRoot(post: Post): Promise<Post> {
  let current = post;
  const seen = new Set([current.tweetId]);
  for (;;) {
    const parent = await sameAuthorParent(current);
    if (!parent || seen.has(parent.tweetId)) break;
    seen.add(parent.tweetId);
    current = parent;
  }
  return current;
}

/** The full same-author thread containing `post`, chronological. Length 1 when
 * the post stands alone. Branches (author replies twice to one tweet) are all
 * folded into the single unit. */
export async function assembleThread(post: Post): Promise<Post[]> {
  const root = await findRoot(post);
  const collected = new Map<string, Post>([[root.tweetId, root]]);
  const queue: Post[] = [root];
  while (queue.length) {
    const node = queue.shift()!;
    for (const child of await sameAuthorChildren(node)) {
      if (!collected.has(child.tweetId)) {
        collected.set(child.tweetId, child);
        queue.push(child);
      }
    }
  }
  return [...collected.values()].sort(
    (a, b) => a.postedAt.getTime() - b.postedAt.getTime(),
  );
}
