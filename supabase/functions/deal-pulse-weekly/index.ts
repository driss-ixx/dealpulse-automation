import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface Config {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHANNEL_ID: string;
  BLUESKY_HANDLE: string;
  BLUESKY_PASSWORD: string;
  FACEBOOK_PAGE_ACCESS_TOKEN?: string;
  FACEBOOK_PAGE_ID?: string;
}

interface Deal {
  title: string;
  url: string;
  score: number;
  posted_at: string;
}

async function postWeeklyTelegram(config: Config, deals: Deal[]): Promise<boolean> {
  try {
    let text = `🏆 *TOP 5 DEALS DE LA SEMAINE* 🏆\n\n`;
    text += `Voici les meilleurs bons plans scorés par IA cette semaine :\n\n`;
    deals.forEach((d, i) => {
      const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
      text += `${medals[i]} *${d.title}*\n`;
      text += `   Score : ${d.score}/10 | [Voir le deal](${d.url})\n\n`;
    });
    text += `📢 Rejoins @DealPulseFR pour tous les deals en temps réel !\n#BonPlan #DealPulseFR #TopDeals`;

    const resp = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: config.TELEGRAM_CHANNEL_ID, text, parse_mode: "Markdown", disable_web_page_preview: true })
    });
    const data = await resp.json();
    return data.ok === true;
  } catch { return false; }
}

async function postWeeklyBluesky(config: Config, deals: Deal[]): Promise<boolean> {
  try {
    const authResp = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: config.BLUESKY_HANDLE, password: config.BLUESKY_PASSWORD })
    });
    const auth = await authResp.json();
    if (!auth.accessJwt) return false;

    let text = `🏆 TOP 5 DEALS DE LA SEMAINE\n\n`;
    deals.forEach((d, i) => {
      const medals = ["🥇", "🥈", "🥉", "4.", "5."];
      text += `${medals[i]} ${d.title} — ${d.score}/10\n${d.url}\n\n`;
    });
    text += `#BonPlan #DealPulseFR`;

    const postResp = await fetch("https://bsky.social/xrpc/com.atproto.repo.createRecord", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${auth.accessJwt}` },
      body: JSON.stringify({ repo: auth.did, collection: "app.bsky.feed.post", record: { text: text.slice(0, 300), createdAt: new Date().toISOString(), langs: ["fr"] } })
    });
    const post = await postResp.json();
    return !!post.uri;
  } catch { return false; }
}

async function postWeeklyFacebook(config: Config, deals: Deal[]): Promise<boolean> {
  if (!config.FACEBOOK_PAGE_ACCESS_TOKEN || !config.FACEBOOK_PAGE_ID) return false;
  try {
    let message = `🏆 TOP 5 DEALS DE LA SEMAINE 🏆\n\n`;
    message += `Les meilleurs bons plans scorés par IA cette semaine :\n\n`;
    deals.forEach((d, i) => {
      const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
      message += `${medals[i]} ${d.title}\n   Score IA : ${d.score}/10\n   ${d.url}\n\n`;
    });
    message += `📢 Rejoins notre canal Telegram @DealPulseFR pour tous les deals en temps réel !\n\n#BonPlan #DealPulseFR #TopDeals #PromoFrance`;

    const resp = await fetch(`https://graph.facebook.com/v20.0/${config.FACEBOOK_PAGE_ID}/feed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, access_token: config.FACEBOOK_PAGE_ACCESS_TOKEN })
    });
    const data = await resp.json();
    return !!data.id;
  } catch { return false; }
}

serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: configRows } = await supabase.from("bot_config").select("key,value");
  const config: Config = {} as Config;
  for (const row of (configRows || [])) {
    (config as any)[row.key] = row.value;
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: deals } = await supabase
    .from("posted_deals")
    .select("title, url, score, posted_at")
    .gte("posted_at", since)
    .order("score", { ascending: false })
    .order("posted_at", { ascending: false })
    .limit(5);

  if (!deals || deals.length === 0) {
    return new Response(JSON.stringify({ success: false, reason: "no deals this week" }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  const tg = await postWeeklyTelegram(config, deals);
  const bsky = await postWeeklyBluesky(config, deals);
  const fb = await postWeeklyFacebook(config, deals);

  return new Response(JSON.stringify({
    success: true,
    deals_count: deals.length,
    posted_telegram: tg,
    posted_bluesky: bsky,
    posted_facebook: fb
  }), { headers: { "Content-Type": "application/json" } });
});
