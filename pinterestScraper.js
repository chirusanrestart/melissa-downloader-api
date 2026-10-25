/**
 * Scraper Pinterest que funciona em 2026
 * Lê __PWS_INITIAL_PROPS__ em vez de regex em /pin/
 */

async function fetchPinterestHtml(url) {
    const res = await fetch(url, {
        headers: {
            "User-Agent":
                "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        },
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}

function extractPinsFromInitialProps(html) {
    const match = html.match(
        /id="__PWS_INITIAL_PROPS__"[^>]*>(\{[\s\S]*?\})<\/script>/
    );
    if (!match) return [];

    let data;
    try {
        data = JSON.parse(match[1]);
    } catch {
        return [];
    }

    const pinsMap = data?.initialReduxState?.pins || {};
    const results = [];

    for (const pin of Object.values(pinsMap)) {
        if (!pin || typeof pin !== "object") continue;

        const images = pin.images || {};
        // prioriza a maior resolução disponível
        const best =
            images.orig ||
            images.originals ||
            images["736x"] ||
            images["564x"] ||
            images["474x"] ||
            images["236x"];

        const url = best?.url;
        if (!url) continue;

        results.push({
            id: pin.id,
            url, // imagem
            pinUrl: pin.id
                ? `https://www.pinterest.com/pin/${pin.id}/`
                : null,
            title: pin.grid_title || pin.title || "",
            description: pin.description || "",
            animated: /\.gif(?:[?#]|$)/i.test(url),
        });
    }

    return results;
}

export async function searchPinterest(query, max = 60) {
    const encoded = encodeURIComponent(query);
    const urls = [
        `https://www.pinterest.com/search/pins/?q=${encoded}`,
        `https://pinterest.com/search/pins/?q=${encoded}`,
    ];

    for (const url of urls) {
        try {
            const html = await fetchPinterestHtml(url);
            const pins = extractPinsFromInitialProps(html);
            if (pins.length) {
                // remove duplicatas por URL de imagem
                const seen = new Set();
                const unique = [];
                for (const p of pins) {
                    if (seen.has(p.url)) continue;
                    seen.add(p.url);
                    unique.push(p);
                    if (unique.length >= max) break;
                }
                return unique;
            }
        } catch (err) {
            console.log(`Falha em ${url}:`, err.message);
        }
    }
    return [];
}
