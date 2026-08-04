import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface Config {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHANNEL_ID: string;
  BLUESKY_HANDLE: string;
  BLUESKY_PASSWORD: string;
  GROQ_API_KEY: string;
  AMAZON_AFFILIATE_TAG: string;
  FACEBOOK_PAGE_ACCESS_TOKEN?: string;
  FACEBOOK_PAGE_ID?: string;
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  INSTAGRAM_ACCESS_TOKEN?: string;
  INSTAGRAM_USER_ID?: string;
}

interface Deal {
  title: string;
  link: string;
  price?: string;
  original_price?: string;
  discount?: string;
  image_url?: string;
}

interface ScoreData {
  score: number;
  verdict: string;
  emoji: string;
}

function hashLink(link: string): string {
  // Simple hash for dedup — extract ASIN or use last 16 chars of URL
  const asin = link.match(/\/dp\/([A-Z0-9]{10})/)?.[1];
  if (asin) return asin;
  return link.slice(-32).replace(/[^a-zA-Z0-9]/g, '');
}

async function autoRefreshFacebookToken(config: Config, supabase: any): Promise<string | null> {
  if (!config.FACEBOOK_PAGE_ACCESS_TOKEN || !config.META_APP_ID || !config.META_APP_SECRET) return null;
  try {
    // Use app token (app_id|app_secret) to debug the page token
    const appToken = `${config.META_APP_ID}|${config.META_APP_SECRET}`;
    const debugResp = await fetch(
      `https://graph.facebook.com/debug_token?input_token=${config.FACEBOOK_PAGE_ACCESS_TOKEN}&access_token=${appToken}`
    );
    const debug = await debugResp.json();
    const expiresAt = debug?.data?.expires_at || 0;

    // expiresAt === 0 means it's a long-lived token that never expires (page token)
    if (expiresAt === 0) {
      console.log("Facebook page token: never expires (long-lived)");
      return null;
    }

    const daysLeft = (expiresAt - Date.now() / 1000) / 86400;
    console.log(`Facebook token expires in ${daysLeft.toFixed(1)} days`);

    if (daysLeft > 10) return null;

    // Exchange user token for new long-lived token, then get page token
    const exchangeResp = await fetch(
      `https://graph.facebook.com/v20.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${config.META_APP_ID}&client_secret=${config.META_APP_SECRET}&fb_exchange_token=${config.FACEBOOK_PAGE_ACCESS_TOKEN}`
    );
    const exchange = await exchangeResp.json();
    if (!exchange.access_token) {
      console.error("Facebook token refresh failed:", JSON.stringify(exchange));
      return null;
    }

    await supabase.from("bot_config")
      .update({ value: exchange.access_token })
      .eq("key", "FACEBOOK_PAGE_ACCESS_TOKEN");

    console.log("Facebook token refreshed successfully");
    return exchange.access_token;
  } catch (e) {
    console.error("autoRefreshFacebookToken error:", e);
    return null;
  }
}

async function scoreWithGroq(config: Config, deal: Deal): Promise<ScoreData> {
  const prompt = `Tu es un expert deals/bons plans. Note ce deal de 1 à 10 et donne un verdict court (max 10 mots).\nDeal: ${deal.title}\nPrix: ${deal.price || "?"} (était: ${deal.original_price || "?"}, remise: ${deal.discount || "?"})\nRéponds UNIQUEMENT en JSON: {"score": X, "verdict": "...", "emoji": "🔥/✅/👍/😐/❌"}`;
  try {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${config.GROQ_API_KEY}` },
      body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: prompt }], max_tokens: 100, temperature: 0.3 })
    });
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || '{"score":5,"verdict":"Deal correct","emoji":"👍"}';
    return JSON.parse(text.match(/\{.*\}/s)?.[0] || text);
  } catch {
    return { score: 5, verdict: "Deal intéressant", emoji: "👍" };
  }
}

/**
 * Extrait les tableaux "products":[…] du HTML en equilibrant les crochets, puis les parse en JSON.
 *
 * POURQUOI PAS UNE REGEX SUR LE HTML. La version precedente cherchait le motif
 * `"title":"…","asin":"…"`. Amazon a INVERSE l'ordre de ces deux cles : le motif ne
 * correspondait plus a rien, et la panne est passee inapercue 67 jours (voir README).
 * Une regex depend de l'ordre des cles ET de la longueur des titres ; le JSON, non.
 * Mesure du 2026-08-04 sur la vraie page : ancienne regex = 2 produits, ce parseur = 30.
 */
function extraireProduits(html: string): Array<Record<string, unknown>> {
  const trouves: Array<Record<string, unknown>> = [];
  const re = /"products"\s*:\s*\[/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const debut = html.indexOf("[", m.index);
    let prof = 0, i = debut, dansTexte = false, echap = false;
    for (; i < html.length; i++) {
      const c = html[i];
      if (echap) { echap = false; continue; }
      if (c === "\\") { echap = true; continue; }
      if (c === '"') { dansTexte = !dansTexte; continue; }
      if (dansTexte) continue;
      if (c === "[") prof++;
      else if (c === "]" && --prof === 0) {
        try {
          const arr = JSON.parse(html.slice(debut, i + 1));
          if (Array.isArray(arr)) trouves.push(...arr);
        } catch { /* bloc illisible : on passe au suivant, sans casser le reste */ }
        break;
      }
    }
  }
  return trouves;
}

async function scrapeAmazonDeals(affiliateTag: string): Promise<Deal[]> {
  const deals: Deal[] = [];
  const vus = new Set<string>();

  // ⚠️ L'ancienne construction d'image etait FAUSSE :
  //   https://images-na.ssl-images-amazon.com/images/I/<ASIN>._AC_SL500_.jpg
  // Le segment /images/I/ attend un identifiant d'IMAGE, pas un ASIN. Verifie le
  // 2026-08-04 : ces URLs rendent HTTP 400. Or Instagram REFUSE de publier si l'image
  // est inaccessible — c'est une des raisons pour lesquelles IG ne postait rien.
  // La vraie adresse est dans le JSON de la page : image.hiRes.baseUrl + "." + extension
  // (verifie : HTTP 200).
  const ajouter = (asin: string, titre: string, image?: string) => {
    if (!asin || !titre || vus.has(asin) || deals.length >= 10) return;
    vus.add(asin);
    deals.push({
      title: titre.trim(),
      link: `https://www.amazon.fr/dp/${asin}?tag=${affiliateTag}`,
      image_url: image || undefined
    });
  };

  /** Reconstruit l'adresse de la vignette produit depuis le bloc `image` du JSON Amazon. */
  const imageDuProduit = (p: Record<string, unknown>): string | undefined => {
    const img = p.image as Record<string, unknown> | undefined;
    if (!img) return undefined;
    for (const taille of ["hiRes", "lowRes", "thumbnail"]) {
      const t = img[taille] as Record<string, unknown> | undefined;
      if (t && typeof t.baseUrl === "string") {
        const ext = typeof t.extension === "string" ? t.extension : "jpg";
        return `${t.baseUrl}.${ext}`;
      }
    }
    return undefined;
  };

  try {
    const resp = await fetch("https://www.amazon.fr/deals?ref=nav_cs_gb", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
    });
    if (!resp.ok) throw new Error(`Amazon HTTP ${resp.status}`);
    const html = await resp.text();

    // Voie principale : le JSON de la page.
    for (const p of extraireProduits(html)) {
      const asin = typeof p.asin === "string" ? p.asin : "";
      const titre = typeof p.title === "string" ? p.title : "";
      if (/^[A-Z0-9]{10}$/.test(asin) && titre.length >= 10) ajouter(asin, titre, imageDuProduit(p));
    }

    // Filet de secours : regex tolerante aux DEUX ordres de cles, si le JSON change de forme.
    if (deals.length === 0) {
      console.warn("Parsing JSON vide — repli sur la regex tolerante");
      for (const m of html.matchAll(/"asin":"([A-Z0-9]{10})","title":"((?:[^"\\]|\\.){10,300})"/g)) ajouter(m[1], m[2]);
      for (const m of html.matchAll(/"title":"((?:[^"\\]|\\.){10,300})","asin":"([A-Z0-9]{10})"/g)) ajouter(m[2], m[1]);
    }
  } catch (e) {
    console.error("Scrape error:", e);
  }

  // ⚠️ AUCUN repli en liens de listing ici. L'ancienne version injectait
  // amazon.fr/deals et amazon.fr/s?k=deal quand le scrape echouait : deux liens deja
  // en base, donc rejetes par la dedup — d'ou « 2 deals trouves, 0 publie » a l'infini,
  // en affichant success:true. Une liste vide doit rester vide : c'est ce qui permet
  // a l'appelant de voir la panne.
  console.log(`Amazon: ${deals.length} produit(s) extrait(s)`);
  return deals;
}

async function postToTelegram(config: Config, title: string, link: string, score: ScoreData): Promise<boolean> {
  try {
    const text = `${score.emoji} *${title}*\n\n🤖 Score IA : *${score.score}/10* — ${score.verdict}\n\n🔗 [Voir le deal](${link})\n\n💡 _Lien affilié Amazon — commission sans surcoût_\n\n#BonPlan #DealPulseFR`;
    const resp = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: config.TELEGRAM_CHANNEL_ID, text, parse_mode: "Markdown", disable_web_page_preview: false })
    });
    const result = await resp.json();
    if (!result.ok) console.error("Telegram error:", JSON.stringify(result));
    return result.ok === true;
  } catch (e) { console.error("Telegram exception:", e); return false; }
}

async function postToBluesky(config: Config, title: string, link: string, score: ScoreData): Promise<boolean> {
  try {
    const authResp = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: config.BLUESKY_HANDLE, password: config.BLUESKY_PASSWORD })
    });
    const auth = await authResp.json();
    if (!auth.accessJwt) { console.error("Bluesky auth failed:", JSON.stringify(auth)); return false; }
    const text = `${score.emoji} ${title}\n\n🤖 Score IA : ${score.score}/10 — ${score.verdict}\n\n🔗 ${link}\n\n💡 Lien affilié Amazon\n\n#BonPlan #DealPulseFR`;
    const postResp = await fetch("https://bsky.social/xrpc/com.atproto.repo.createRecord", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${auth.accessJwt}` },
      body: JSON.stringify({ repo: auth.did, collection: "app.bsky.feed.post", record: { text: text.slice(0, 300), createdAt: new Date().toISOString(), langs: ["fr"] } })
    });
    const postResult = await postResp.json();
    if (!postResult.uri) console.error("Bluesky post failed:", JSON.stringify(postResult));
    return !!postResult.uri;
  } catch (e) { console.error("Bluesky exception:", e); return false; }
}

async function postToFacebook(config: Config, title: string, link: string, score: ScoreData): Promise<boolean> {
  if (!config.FACEBOOK_PAGE_ACCESS_TOKEN || !config.FACEBOOK_PAGE_ID) return false;
  try {
    const message = `${score.emoji} ${title}\n\n🤖 Score IA : ${score.score}/10 — ${score.verdict}\n\n🔗 ${link}\n\n💡 Lien affilié Amazon — commission sans surcoût\n\n📢 Rejoins @DealPulseFR sur Telegram pour tous les deals scorés par IA !\n\n#BonPlan #DealPulseFR #Promo`;
    const resp = await fetch(`https://graph.facebook.com/v20.0/${config.FACEBOOK_PAGE_ID}/feed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, link, access_token: config.FACEBOOK_PAGE_ACCESS_TOKEN })
    });
    const data = await resp.json();
    if (data.id) { console.log("Facebook posted:", data.id); return true; }
    console.error("Facebook error:", JSON.stringify(data));
    return false;
  } catch (e) { console.error("Facebook exception:", e); return false; }
}

async function postToInstagram(config: Config, title: string, link: string, score: ScoreData, imageProduit?: string): Promise<boolean> {
  if (!config.INSTAGRAM_ACCESS_TOKEN || !config.INSTAGRAM_USER_ID) return false;
  try {
    // ⚠️ L'image etait figee sur https://dealpulse-fr.vercel.app/og.png — or ce site
    // N'EXISTE PLUS (verifie le 2026-08-04 : HTTP 404 sur le domaine entier). Instagram
    // exige une image accessible, sinon il refuse la publication. On utilise desormais
    // la vraie vignette du produit, extraite du JSON Amazon.
    const imageUrl = imageProduit;
    if (!imageUrl) {
      console.error("Instagram: aucune image produit disponible, publication impossible");
      return false;
    }
    const caption = `${score.emoji} ${title}\n\n🤖 Score IA : ${score.score}/10\n💬 ${score.verdict}\n\n🔗 Lien en bio | ${link}\n💡 Lien affilié Amazon\n\n📢 Rejoins @dealpulsefr pour recevoir les deals scorés par IA en temps réel !\n\n#bonplan #dealfrance #amazonfr #promocode #dealpulsefr #bonnesaffaires #shoppingfrance #dealoftheday`;
    const containerResp = await fetch(`https://graph.facebook.com/v20.0/${config.INSTAGRAM_USER_ID}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_url: imageUrl, caption, access_token: config.INSTAGRAM_ACCESS_TOKEN })
    });
    const container = await containerResp.json();
    if (!container.id) { console.error("Instagram container error:", JSON.stringify(container)); return false; }
    await new Promise(resolve => setTimeout(resolve, 2000));
    const publishResp = await fetch(`https://graph.facebook.com/v20.0/${config.INSTAGRAM_USER_ID}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creation_id: container.id, access_token: config.INSTAGRAM_ACCESS_TOKEN })
    });
    const publishResult = await publishResp.json();
    if (!publishResult.id) console.error("Instagram publish error:", JSON.stringify(publishResult));
    return !!publishResult.id;
  } catch (e) { console.error("Instagram exception:", e); return false; }
}

serve(async (_req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: configRows, error: configError } = await supabase.from("bot_config").select("key,value");
  if (configError) console.error("Config load error:", configError);
  const config: Config = {} as Config;
  for (const row of (configRows || [])) (config as any)[row.key] = row.value;

  const freshToken = await autoRefreshFacebookToken(config, supabase);
  if (freshToken) config.FACEBOOK_PAGE_ACCESS_TOKEN = freshToken;

  const deals = await scrapeAmazonDeals(config.AMAZON_AFFILIATE_TAG || "dealpulse02-21");
  let postedTelegram = 0, postedBluesky = 0, postedFacebook = 0, postedInstagram = 0;
  const errors: string[] = [];

  // ⚠️ BUG STRUCTUREL corrige le 2026-08-04. L'ancienne boucle faisait
  // `deals.slice(0, 3)` PUIS ecartait ceux deja publies : si les 3 premiers produits
  // d'Amazon etaient connus — ce qui est le cas la plupart du temps, la page bougeant
  // lentement — le bot ne publiait RIEN, tout en se declarant en bonne sante.
  // On ecarte d'abord les deja-vus, ON PREND ENSUITE les 3 premiers restants.
  const { data: dejaPublies } = await supabase.from("posted_deals").select("deal_hash");
  const connus = new Set((dejaPublies || []).map((r: { deal_hash: string }) => r.deal_hash));
  const nouveaux = deals.filter((d) => !connus.has(hashLink(d.link)));
  console.log(`${deals.length} produit(s) extrait(s), ${nouveaux.length} pas encore publie(s)`);

  for (const deal of nouveaux.slice(0, 3)) {
    const dealHash = hashLink(deal.link);

    const score = await scoreWithGroq(config, deal);
    console.log(`Deal: ${deal.title} | Score: ${score.score} | Hash: ${dealHash}`);
    if (score.score < 6) {
      console.log("Score too low, skipping");
      continue;
    }

    const [tg, bsky, fb, ig] = await Promise.all([
      postToTelegram(config, deal.title, deal.link, score),
      postToBluesky(config, deal.title, deal.link, score),
      postToFacebook(config, deal.title, deal.link, score),
      postToInstagram(config, deal.title, deal.link, score, deal.image_url)
    ]);

    if (tg || bsky || fb || ig) {
      // Insert into posted_deals with correct schema
      const { error: insertError } = await supabase.from("posted_deals").insert({
        deal_id: dealHash,
        deal_hash: dealHash,
        title: deal.title,
        link: deal.link,
        url: deal.link,
        score: score.score,
        source: "amazon",
        posted_at: new Date().toISOString()
      });
      if (insertError) {
        console.error("Insert error:", insertError.message);
        errors.push(`insert:${insertError.message}`);
      } else {
        console.log(`Saved to posted_deals: ${deal.title}`);
      }
      if (tg) postedTelegram++;
      if (bsky) postedBluesky++;
      if (fb) postedFacebook++;
      if (ig) postedInstagram++;
    }
  }

  // ⚠️ `success` etait ecrit EN DUR a true : la fonction se declarait saine meme en ne
  // publiant rien, et `errors` n'etait alimente que par les erreurs d'insert SQL. Resultat :
  // 67 jours de panne totalement verte. Desormais un scrape a vide est une VRAIE erreur.
  if (deals.length === 0) {
    errors.push("scrape:0 produit extrait d'Amazon — le format de la page a probablement change");
  }
  const success = errors.length === 0;

  return new Response(JSON.stringify({
    success,
    version: 11,
    token_refreshed: !!freshToken,
    deals_found: deals.length,
    deals_nouveaux: nouveaux.length,
    deals_posted_telegram: postedTelegram,
    deals_posted_bluesky: postedBluesky,
    deals_posted_facebook: postedFacebook,
    deals_posted_instagram: postedInstagram,
    errors
  }), {
    // Un code HTTP 500 quand ca ne va pas : le workflow GitHub echoue enfin pour de vrai,
    // et Driss recoit un mail au lieu d'un silence de plusieurs mois.
    status: success ? 200 : 500,
    headers: { "Content-Type": "application/json" }
  });
});
