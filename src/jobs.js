// The four kinds of background work found in every business app, with fictional data only.
// Each job runs a few timed steps, then produces a small real result (a CSV, an email, an SVG, an import report).

export const TYPES = {
  export: {
    label: 'Invoice export',
    steps: [['Reading invoices', 900], ['Writing the CSV', 1400], ['Storing the file', 700]],
    transient: 'Accounting API timed out (504)',
  },
  email: {
    label: 'Welcome email',
    steps: [['Rendering the template', 600], ['Handing over to SMTP', 1100]],
    transient: 'SMTP 421 4.7.0 Try again later',
  },
  thumbnail: {
    label: 'Product thumbnails',
    steps: [['Decoding the photo', 700], ['Resizing to 3 sizes', 1500], ['Storing thumbnails', 500]],
    transient: 'Image storage busy (503)',
  },
  import: {
    label: 'Contacts import',
    steps: [['Parsing the CSV', 800], ['Validating 500 rows', 1300], ['Writing contacts', 900]],
    transient: 'CRM rate limit reached (429)',
  },
};

export const POISON_ERROR = 'Malformed CSV: unterminated quote at line 42';

const SHOPS = ['Atelier Lune', 'Brasserie du Quai', 'Maison Verte', 'Cycles Rivière', 'Fromagerie Bastide', 'Studio Ardoise', 'Librairie des Pins', 'Torréfaction Nord'];
const FIRST = ['Camille', 'Hugo', 'Léa', 'Nora', 'Malik', 'Inès', 'Jules', 'Zoé', 'Sacha', 'Lina', 'Théo', 'Maël'];
const LAST = ['Martin', 'Bernard', 'Moreau', 'Laurent', 'Garnier', 'Faure', 'Roux', 'Fontaine', 'Chevalier', 'Mercier'];
const PRODUCTS = ['Ceramic mug', 'Linen tote', 'Oak stool', 'Copper lamp', 'Wool scarf', 'Glass carafe', 'Walnut tray'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Small seeded generator: the same job id always gives the same data.
function rng(seed) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];

// What a job is about, decided when it is posted.
export function describe(type, id) {
  const r = rng(id);
  const shop = pick(r, SHOPS);
  const person = `${pick(r, FIRST)} ${pick(r, LAST)}`;
  switch (type) {
    case 'export': return `${MONTHS[Math.floor(r() * 10)]} invoices · ${shop}`;
    case 'email': return `To ${person}`;
    case 'thumbnail': return `${pick(r, PRODUCTS)} · ${shop}`;
    case 'import': return `contacts-${shop.toLowerCase().replace(/[^a-z]+/g, '-')}.csv`;
    default: return type;
  }
}

// Should this attempt fail, and with which error?
// plan "flaky" fails twice then succeeds; "poison" always fails; "normal" fails now and then.
export function failureFor(job, attempt, flakyRate, random = Math.random) {
  if (job.plan === 'poison') return { error: POISON_ERROR, atStep: 0 };
  const last = TYPES[job.type].steps.length - 1;
  if (job.plan === 'flaky' && attempt <= 2) return { error: TYPES[job.type].transient, atStep: last };
  if (job.plan === 'normal' && random() < flakyRate) return { error: TYPES[job.type].transient, atStep: last };
  return null;
}

// The result a successful job leaves behind for an hour, served at /results/<id>.
export function produce(job) {
  const r = rng(job.id);
  if (job.type === 'export') {
    const rows = ['invoice,customer,date,amount_eur'];
    let total = 0;
    for (let i = 1; i <= 120; i++) {
      const amount = Math.round((20 + r() * 480) * 100) / 100;
      total += amount;
      rows.push(`INV-${job.id.slice(2)}-${String(i).padStart(3, '0')},${pick(r, FIRST)} ${pick(r, LAST)},2026-10-${String(1 + Math.floor(r() * 31)).padStart(2, '0')},${amount.toFixed(2)}`);
    }
    return { contentType: 'text/csv; charset=utf-8', body: rows.join('\n') + '\n', summary: `120 invoices · ${Math.round(total).toLocaleString('en-US')} €` };
  }
  if (job.type === 'email') {
    const name = job.title.replace(/^To /, '');
    const address = `${name.toLowerCase().normalize('NFD').replace(/[^a-z ]/g, '').replace(' ', '.')}@example.com`;
    const body = [
      `From: The Sorting Office <hello@example.com>`,
      `To: ${name} <${address}>`,
      `Subject: Welcome aboard, ${name.split(' ')[0]}`,
      '',
      `Hello ${name.split(' ')[0]},`,
      '',
      'Your account is ready. This email was rendered and "sent" by a background worker,',
      'so the web request that created your account answered in a few milliseconds.',
      '',
      'Fictional message: nothing was sent to anyone.',
    ].join('\n');
    return { contentType: 'text/plain; charset=utf-8', body, summary: `sent to ${address}` };
  }
  if (job.type === 'thumbnail') {
    const hue = Math.floor(r() * 360);
    const sizes = [[160, 0], [96, 180], [48, 296]];
    const tiles = sizes.map(([s, x]) => `<g transform="translate(${x + 10} ${180 - s - 10})"><rect width="${s}" height="${s}" rx="${s / 10}" fill="hsl(${hue} 55% 22%)"/><circle cx="${s / 2}" cy="${s * 0.42}" r="${s * 0.26}" fill="hsl(${(hue + 40) % 360} 85% 62%)"/><rect x="${s * 0.18}" y="${s * 0.74}" width="${s * 0.64}" height="${s * 0.1}" rx="${s * 0.05}" fill="hsl(${hue} 30% 80%)"/></g>`).join('');
    const labels = sizes.map(([s, x]) => `<text x="${x + 10}" y="196" font-family="monospace" font-size="11" fill="#9d9dbb">${s} px</text>`).join('');
    const body = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 204" width="720" height="408"><rect width="360" height="204" fill="#13172e"/>${tiles}${labels}</svg>`;
    return { contentType: 'image/svg+xml', body, summary: '3 sizes · 160, 96, 48 px' };
  }
  if (job.type === 'import') {
    const rejected = [];
    for (let line = 2; line <= 501; line++) if (r() < 0.025) rejected.push(line);
    const lines = [`Import report for ${job.title}`, '', `Rows read:      500`, `Imported:       ${500 - rejected.length}`, `Rejected:       ${rejected.length} (invalid email address)`, '', ...rejected.map((l) => `  line ${l}: email "${pick(r, FIRST).toLowerCase()}@" has no domain`)];
    return { contentType: 'text/plain; charset=utf-8', body: lines.join('\n') + '\n', summary: `${500 - rejected.length} imported · ${rejected.length} rejected` };
  }
  return { contentType: 'text/plain; charset=utf-8', body: 'done\n', summary: 'done' };
}
