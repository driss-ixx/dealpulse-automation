import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUBREDDITS = [
  { name: "BonsPlans", flair: null, min_score: 7 },
  { name: "france", flair: null, min_score: 8 },
  { name: "consommation", flair: null, min_score: 7 },
  { name: "AskFrance", flair: null, min_score: 9 },
];

async function getRedditToken(clientId: string, clientSecret: string, username: string, password: string): Promise<string | null> {
  try {
    const resp = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        "Authorization": "Basic " + btoa(`${clientId}:${clientSecret}`),
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": `DealPulseFR/1.0 by ${username}`
      },
      body: `grant_type=password&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
    });
    const data = await resp.json();
    return data.access_token || null;
  } catch { return null; }
}

async function postToSubreddit(
  token: string, username: string,
  subreddit: string, title: string, url: string, score: number
): Promise<boolean> {
  try {
    const postTitle = `[Deal ${score}/10] ${title}`;
    const resp = await fetch("https://oauth.reddit.com/api/submit", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": `DealPulseFR/1.0 by ${username}`
      },
      body: new URLSearchParams({
        sr: subreddit,
        kind: "link",
        title: postTitle,
        url: url,
        resubmit: "false",
        nsfw: "false",
        spoiler: "false"
      }).toString()
    });
    const data = await resp.json();
    if (data?.jquery) {
      const errors = data.jquery?.filter((x: any) => x?.[2] === "errors")?.[0]?.[3];
      if (errors?.length > 0) {
        console.error(`Reddit r/${subreddit} error:`, JSON.stringify(errors));
        return false;
      }
    }
    const success = !data?.json?.errors?.length;
    if (success) console.log(`Reddit r/${subreddit} posted: ${data?.json?.data?.url}`);
    else console.error(`Reddit r/${subreddit} errors:`, JSON.stringify(data?.json?.errors));
    return success;
  } catch (e) { console.error("Reddit post error:", e); return false; }
}

serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: configRows } = await supabase.from("bot_config").select("key,value");
  const config: Record<string, string> = {};
  for (const row of (configRows || [])) config[row.key] = row.value;

  const { REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD } = config;
  if (!REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET || !REDDIT_USERNAME || !REDDIT_PASSWORD) {
    return new Response(JSON.stringify({ success: false, reason: "Reddit credentials missing" }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  const token = await getRedditToken(REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD);
  if (!token) {
    return new Response(JSON.stringify({ success: false, reason: "Reddit auth failed" }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  const since = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const { data: deals } = await supabase
    .from("posted_deals")
    .select("title, url, score")
    .gte("posted_at", since)
    .gte("score", 7)
    .is("reddit_posted", null)
    .order("score", { ascending: false })
    .limit(2);

  if (!deals || deals.length === 0) {
    return new Response(JSON.stringify({ success: true, reason: "no eligible deals" }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  let posted = 0;
  for (const deal of deals) {
    for (const sub of SUBREDDITS) {
      if (deal.score < sub.min_score) continue;
      const ok = await postToSubreddit(token, REDDIT_USERNAME, sub.name, deal.title, deal.url, deal.score);
      if (ok) {
        await supabase.from("posted_deals").update({ reddit_posted: new Date().toISOString() }).eq("url", deal.url);
        posted++;
        break;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  return new Response(JSON.stringify({ success: true, deals_posted_reddit: posted }), {
    headers: { "Content-Type": "application/json" }
  });
});
