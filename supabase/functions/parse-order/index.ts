// Supabase Edge Function: AI rozpoznání položek objednávky (text nebo fotka) proti katalogu produktů.
// Nasazení:  supabase functions deploy parse-order
// Tajný klíč: supabase secrets set ANTHROPIC_API_KEY=sk-ant-...   (nebo Dashboard → Edge Functions → Secrets)
// Klíč k Claude API zůstává na serveru, do aplikace se nikdy nedostane.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'customer', 'note'],
  properties: {
    customer: { type: 'string', description: 'Odběratel / zákazník, pokud je v objednávce uveden, jinak prázdný řetězec' },
    note: { type: 'string', description: 'Termín dodání, číslo objednávky nebo jiná důležitá poznámka, jinak prázdný řetězec' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'name', 'qty', 'unit', 'raw', 'confidence'],
        properties: {
          code: { type: ['string', 'null'], description: 'Kód produktu z katalogu, nebo null pokud nic z katalogu neodpovídá' },
          name: { type: 'string', description: 'Název produktu (z katalogu pokud nalezen, jinak jak je v objednávce)' },
          qty: { type: 'number' },
          unit: { type: 'string' },
          raw: { type: 'string', description: 'Původní řádek / text z objednávky' },
          confidence: { type: 'number', description: '0–1 jistota přiřazení ke katalogu' },
        },
      },
    },
  },
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) throw new Error('Chybí ANTHROPIC_API_KEY v secrets.');
    const { text, image, products } = await req.json();
    if (!text && !image) throw new Error('Pošli text nebo image.');

    const catalog = (products || []).map((p: { code: string; name: string; unit: string }) => `${p.code}\t${p.name}\t${p.unit}`).join('\n');
    const system = `Jsi asistent skladu. Dostaneš objednávku (text z e-mailu nebo fotku dodacího listu / objednávky) a katalog produktů skladu ve formátu "kód<TAB>název<TAB>jednotka".
Úkol: vypiš každou objednanou položku s množstvím a přiřaď ji k produktu z katalogu podle názvu (toleruj překlepy, zkratky, jiné pořadí slov, gramatiku, balení). Pokud žádný produkt rozumně neodpovídá, dej code=null a confidence nízkou. Množství převeď na číslo; jednotku použij z katalogu, pokud je produkt nalezen. Nevymýšlej položky, které v objednávce nejsou.

KATALOG:
${catalog || '(prázdný)'}`;

    const content: unknown[] = [];
    if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.media_type, data: image.data } });
    content.push({ type: 'text', text: text ? `OBJEDNÁVKA:\n${text}` : 'OBJEDNÁVKA je na obrázku.' });

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2026-10-21' },
      body: JSON.stringify({
        model: 'claude-opus-5-5',
        max_tokens: 8000,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        system,
        messages: [{ role: 'user', content }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `Claude API ${res.status}`);
    if (data.stop_reason === 'refusal') throw new Error('Model požadavek odmítl.');
    const textBlock = (data.content || []).find((b: { type: string }) => b.type === 'text');
    const parsed = JSON.parse(textBlock?.text || '{"items":[],"customer":"","note":""}');
    return new Response(JSON.stringify(parsed), { headers: { ...CORS, 'content-type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 400, headers: { ...CORS, 'content-type': 'application/json' } });
  }
});
