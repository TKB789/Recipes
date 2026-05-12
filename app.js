/* =====================================================
   Citrus&Spice Recipe App
   ===================================================== */

// ----- IndexedDB Wrapper -----
const DB_NAME = 'spicycitrus_db';
const DB_VERSION = 1;
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('recipes')) {
        d.createObjectStore('recipes', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('pantry')) {
        d.createObjectStore('pantry', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('shopping')) {
        d.createObjectStore('shopping', { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = (e) => reject(e.target.error);
  });
}

function txStore(storeName, mode='readonly') {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function dbGetAll(store) {
  return new Promise((resolve, reject) => {
    const req = txStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(store, item) {
  return new Promise((resolve, reject) => {
    const req = txStore(store, 'readwrite').put(item);
    req.onsuccess = () => resolve(item);
    req.onerror = () => reject(req.error);
  });
}

function dbDelete(store, id) {
  return new Promise((resolve, reject) => {
    const req = txStore(store, 'readwrite').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function dbClear(store) {
  return new Promise((resolve, reject) => {
    const req = txStore(store, 'readwrite').clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ----- State -----
const state = {
  recipes: [],
  pantry: [],
  shopping: [],
  searchTerm: '',
  groupBy: 'time',
  filterCuisine: '',
  filterMain: ''
};

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ----- Toast -----
const toastEl = document.getElementById('toast');
let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
}

// ----- Tabs -----
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'rotation') drawWheel();
  });
});

// Words to ignore when matching ingredients (units, prep words, articles).
// Used by ingredientStem() so "1 lb ground pork" matches pantry "pork".
const STOP_WORDS = new Set([
  'a','an','the','of','and','or','to','for','with','in','on','at',
  'cup','cups','c','tbsp','tablespoon','tablespoons','tsp','teaspoon','teaspoons',
  'oz','ounce','ounces','lb','lbs','pound','pounds','g','gram','grams','kg','kilo','kilogram',
  'ml','milliliter','milliliters','l','liter','liters','liter','pint','pints','quart','quarts','gallon',
  'small','medium','large','big','little','extra',
  'fresh','frozen','dried','dry','raw','cooked','prepared','ripe',
  'whole','half','quarter','third','one','two','three','four','five','six','seven','eight','nine','ten',
  'chopped','minced','diced','sliced','crushed','grated','shredded','peeled','seeded','crumbled',
  'finely','coarsely','thinly','thickly','roughly',
  'optional','plus','more','about','approximately','approx','around','almost','plain','pure',
  'taste','needed','desired','garnish','serving','servings','divided','separated',
  'package','packages','can','cans','jar','jars','bottle','bottles','bag','bags','box','boxes',
  'container','containers','pinch','pinches','dash','dashes','handful','handfuls',
  'lean','boneless','skinless','skin-on','organic','free-range','grass-fed',
  'see','note','notes','room','temperature','warm','cold','hot','room-temperature'
]);

// Distill an ingredient line down to its content words for matching.
// "1 ½ pound skin-on boneless pork belly" -> ["pork", "belly"]
function ingredientStem(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    // remove parenthetical notes
    .replace(/\([^)]*\)/g, ' ')
    // remove fractions, numbers, slash-fractions
    .replace(/\d+\s*\/\s*\d+/g, ' ')
    .replace(/\d+([.,]\d+)?/g, ' ')
    // unicode fractions (½ ⅓ ¼ ¾ etc.)
    .replace(/[\u00BC-\u00BE\u2150-\u215E]/g, ' ')
    // strip non-letter chars (keeps hyphens for compound words like sun-dried)
    .replace(/[^a-z\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w))
    // strip simple plural/possessive
    .map(w => w.replace(/'s$/, '').replace(/s$/, ''));
}

// Does pantry contain an item matching a recipe ingredient?
// Both go through ingredientStem(); if any non-trivial word overlaps, it's a match.
function pantryMatchesIngredient(pantryItems, ingredientText) {
  const wanted = new Set(ingredientStem(ingredientText));
  if (wanted.size === 0) return null;
  for (const p of pantryItems) {
    if (p.used) continue;
    const have = ingredientStem(p.name);
    for (const w of have) {
      if (wanted.has(w)) return p; // first match wins
    }
  }
  return null;
}

// Mini-sheet for what to do when tapping an expiry badge.
// Resolves to 'extend' | 'reset' | 'clear' | null.
function pickExpiryAction(item) {
  return new Promise(resolve => {
    const sheet = document.createElement('div');
    sheet.className = 'modal location-picker open';
    const days = daysUntilExpiry(item);
    const status = days === null ? 'No expiry'
      : days < 0 ? `Expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`
      : days === 0 ? 'Expires today'
      : `${days} day${days === 1 ? '' : 's'} left`;
    sheet.innerHTML = `
      <div class="modal-card location-card">
        <div class="modal-scroll">
          <h2 class="picker-title">${escapeHtml(item.name)}</h2>
          <p class="picker-hint" style="margin-bottom:14px">Currently: ${escapeHtml(status)}</p>
          <div class="picker-stack">
            <button class="picker-row-btn" data-choice="extend">
              <span>+ Extend by N days</span>
              <span class="picker-row-hint">Push the expiry date out</span>
            </button>
            <button class="picker-row-btn" data-choice="reset">
              <span>↻ Reset to N days from now</span>
              <span class="picker-row-hint">Replace with a fresh count</span>
            </button>
            <button class="picker-row-btn danger" data-choice="clear">
              <span>✕ Clear expiry</span>
              <span class="picker-row-hint">Remove the date entirely</span>
            </button>
          </div>
          <button class="primary-btn outline picker-cancel">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(sheet);
    const cleanup = (val) => {
      sheet.classList.remove('open');
      setTimeout(() => sheet.remove(), 200);
      resolve(val);
    };
    sheet.querySelectorAll('.picker-row-btn').forEach(btn => {
      btn.addEventListener('click', () => cleanup(btn.dataset.choice));
    });
    sheet.querySelector('.picker-cancel').addEventListener('click', () => cleanup(null));
    sheet.addEventListener('click', e => { if (e.target === sheet) cleanup(null); });
  });
}
// Auto-flag items as perishable based on their name. Default shelf-life by
// category in days (rough estimates the user can override later).
const PERISHABLE_RULES = [
  { match: ['chicken','beef','pork','lamb','turkey','fish','salmon','tuna','shrimp','steak','ground'], days: 3, kind: 'meat' },
  { match: ['egg','eggs'], days: 21, kind: 'dairy' },
  { match: ['milk','cream','yogurt','sour','buttermilk'], days: 7, kind: 'dairy' },
  { match: ['cheese'], days: 14, kind: 'dairy' },
  { match: ['lettuce','spinach','arugula','kale','greens','herbs','basil','cilantro','parsley','mint','dill','chive'], days: 5, kind: 'leafy' },
  { match: ['tomato','tomatoes','cucumber','pepper','peppers','zucchini','squash','eggplant','mushroom','mushrooms','asparagus','broccoli','cauliflower','bok'], days: 7, kind: 'veg' },
  { match: ['berry','berries','strawberry','strawberries','raspberry','raspberries','blueberry','blueberries','blackberry'], days: 4, kind: 'berry' },
  { match: ['banana','bananas','peach','peaches','plum','plums','nectarine','apricot'], days: 5, kind: 'fruit' },
  { match: ['apple','apples','orange','oranges','pear','pears','grape','grapes','melon','watermelon','pineapple','mango'], days: 10, kind: 'fruit' },
  { match: ['carrot','carrots','celery','onion','onions','garlic','potato','potatoes','sweet potato','ginger'], days: 21, kind: 'root' }
];

// Given an item name, return {perishable: bool, days: number, kind: string} or null
function detectPerishable(name) {
  if (!name) return null;
  const stems = new Set(ingredientStem(name));
  for (const rule of PERISHABLE_RULES) {
    for (const m of rule.match) {
      if (stems.has(m)) return { perishable: true, days: rule.days, kind: rule.kind };
    }
  }
  return null;
}

// Days remaining until expiry; negative if already expired
function daysUntilExpiry(item) {
  if (!item.expiresAt) return null;
  const now = Date.now();
  const ms = item.expiresAt - now;
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

// Build the visual badge HTML for an item's expiry status
function expiryBadgeHtml(item) {
  if (!item.expiresAt) return '';
  return `<span class="expiry-badge ${expiryStatusClass(item)}">${expiryLabel(item)}</span>`;
}

// Inner content (label only) for use inside an interactive button-shaped badge.
// We attach the status class to the wrapping button instead.
function expiryBadgeInner(item) {
  if (!item.expiresAt) return '';
  return expiryLabel(item);
}

function expiryStatusClass(item) {
  const days = daysUntilExpiry(item);
  if (days === null) return '';
  if (days < 0) return 'expired';
  if (days === 0) return 'danger';
  if (days <= 2) return 'danger';
  if (days <= 5) return 'warning';
  return '';
}

function expiryLabel(item) {
  const days = daysUntilExpiry(item);
  if (days === null) return '';
  if (days < 0) return `Expired ${Math.abs(days)}d ago`;
  if (days === 0) return 'Use today';
  return `${days}d left`;
}

// Sensible starter lists. These appear in the dropdowns even before any
// recipes are saved, plus any user-created values get merged in.
const DEFAULT_CUISINES = [
  'American','Chinese','French','Greek','Indian','Indonesian','Italian',
  'Japanese','Korean','Mediterranean','Mexican','Middle Eastern',
  'Spanish','Thai','Vietnamese'
];
const DEFAULT_MAIN_INGREDIENTS = [
  'Beef','Chicken','Duck','Egg','Fish','Lamb','Pasta','Pork','Rice',
  'Salmon','Shrimp','Tofu','Turkey','Vegetable'
];

// Returns a sorted list of unique values for a field, combining defaults
// with values found across saved recipes. Empty/Other are filtered out
// because they get a separate "Other / Add new" option in the dropdown.
function uniqueRecipeValues(field, defaults) {
  const set = new Set(defaults);
  for (const r of state.recipes) {
    const v = (r[field] || '').trim();
    if (v && v.toLowerCase() !== 'other') set.add(v);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

// Builds a <select> for cuisine or main ingredient, with the current value
// pre-selected. Includes "+ Add new…" which reveals a paired text input.
function buildSelectField({ id, field, defaults, currentValue, placeholder }) {
  const options = uniqueRecipeValues(field, defaults);
  const current = (currentValue || '').trim();
  const isCustom = current && current.toLowerCase() !== 'other' && !options.includes(current);
  // If the current value isn't in the defaults or recipes, surface it anyway
  if (isCustom) options.push(current);
  options.sort((a, b) => a.localeCompare(b));

  const opts = options.map(opt =>
    `<option value="${escapeAttr(opt)}" ${opt === current ? 'selected' : ''}>${escapeHtml(opt)}</option>`
  ).join('');

  return `
    <select id="${id}" class="edit-select" data-custom-input="${id}_custom">
      <option value="" ${!current ? 'selected' : ''}>— Select —</option>
      ${opts}
      <option value="__new__">+ Add new…</option>
    </select>
    <input type="text" id="${id}_custom" class="edit-custom-input" placeholder="${escapeAttr(placeholder)}" style="display:none;margin-top:6px">
  `;
}

// Wires up a select+custom-input pair: when "Add new…" is chosen, reveal the
// text input. Returns a getValue() function that gives the final string.
function wireSelectField(selectId) {
  const sel = document.getElementById(selectId);
  const custom = document.getElementById(selectId + '_custom');
  if (!sel || !custom) return () => '';
  const sync = () => {
    if (sel.value === '__new__') {
      custom.style.display = '';
      custom.focus();
    } else {
      custom.style.display = 'none';
      custom.value = '';
    }
  };
  sel.addEventListener('change', sync);
  return () => {
    if (sel.value === '__new__') return custom.value.trim();
    return sel.value.trim();
  };
}

/* =====================================================
   RECIPE EXTRACTION FROM URL
   Tries multiple CORS proxies, parses JSON-LD schema.
   ===================================================== */

const CORS_PROXIES = [
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`
];

async function fetchHtml(url) {
  let lastErr;
  for (const proxy of CORS_PROXIES) {
    try {
      const r = await fetch(proxy(url), { method: 'GET' });
      if (r.ok) {
        const txt = await r.text();
        if (txt && txt.length > 100) return txt;
      }
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('All CORS proxies failed');
}

function parseRecipeFromHtml(html, sourceUrl) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  let recipeData = null;

  for (const s of scripts) {
    try {
      const raw = s.textContent.trim();
      const data = JSON.parse(raw);
      const found = findRecipe(data);
      if (found) { recipeData = found; break; }
    } catch (e) { /* skip bad JSON */ }
  }

  if (!recipeData) {
    // Fallback: try og:title and og:image
    const ogTitle = doc.querySelector('meta[property="og:title"]')?.content;
    const ogImage = doc.querySelector('meta[property="og:image"]')?.content;
    if (ogTitle) {
      return {
        title: ogTitle,
        image: ogImage || '',
        ingredients: [],
        instructions: [],
        partial: true
      };
    }
    return null;
  }

  return normalizeRecipe(recipeData, doc, sourceUrl);
}

function findRecipe(data) {
  if (!data) return null;
  if (Array.isArray(data)) {
    for (const it of data) {
      const r = findRecipe(it);
      if (r) return r;
    }
    return null;
  }
  if (typeof data !== 'object') return null;
  const t = data['@type'];
  if (t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'))) return data;
  if (data['@graph']) return findRecipe(data['@graph']);
  if (data.mainEntity) return findRecipe(data.mainEntity);
  return null;
}

function normalizeRecipe(r, doc, sourceUrl) {
  const getStr = (v) => {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(getStr).filter(Boolean).join(', ');
    if (v.name) return v.name;
    if (v.text) return v.text;
    return '';
  };

  let image = '';
  if (r.image) {
    if (typeof r.image === 'string') image = r.image;
    else if (Array.isArray(r.image)) image = typeof r.image[0] === 'string' ? r.image[0] : r.image[0]?.url || '';
    else image = r.image.url || '';
  }
  if (!image) {
    image = doc.querySelector('meta[property="og:image"]')?.content || '';
  }

  const ingredients = (r.recipeIngredient || []).map(i => typeof i === 'string' ? i : getStr(i)).filter(Boolean);
  let instructions = [];
  if (r.recipeInstructions) {
    if (typeof r.recipeInstructions === 'string') {
      instructions = r.recipeInstructions.split(/\n|(?<=\.)\s+(?=[A-Z])/).map(s => s.trim()).filter(Boolean);
    } else if (Array.isArray(r.recipeInstructions)) {
      instructions = r.recipeInstructions.flatMap(step => {
        if (typeof step === 'string') return [step];
        if (step['@type'] === 'HowToSection' && step.itemListElement) {
          return step.itemListElement.map(s => getStr(s));
        }
        return [getStr(step)];
      }).filter(Boolean);
    }
  }

  const cuisine = getStr(r.recipeCuisine);
  const category = getStr(r.recipeCategory);
  const yieldStr = getStr(r.recipeYield);
  const totalTime = formatDuration(r.totalTime) || formatDuration(r.cookTime) || '';

  // Heuristic main ingredient: first noun-y ingredient
  const mainIngredient = guessMainIngredient(ingredients, r.name || '');

  return {
    title: getStr(r.name) || 'Untitled Recipe',
    image,
    ingredients,
    instructions,
    cuisine: cuisine || guessCuisine(getStr(r.name) || '', sourceUrl),
    category,
    mainIngredient,
    yield: yieldStr,
    totalTime,
    description: getStr(r.description),
    sourceUrl
  };
}

function formatDuration(iso) {
  if (!iso || typeof iso !== 'string') return '';
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return iso;
  const h = parseInt(m[1] || 0), mn = parseInt(m[2] || 0);
  if (h && mn) return `${h}h ${mn}m`;
  if (h) return `${h}h`;
  if (mn) return `${mn} min`;
  return '';
}

function guessMainIngredient(ingredients, title) {
  const proteins = ['chicken','beef','pork','lamb','salmon','shrimp','tofu','tuna','turkey','fish','egg','bean','lentil','chickpea','duck'];
  const t = (title + ' ' + ingredients.join(' ')).toLowerCase();
  for (const p of proteins) if (t.includes(p)) return p.charAt(0).toUpperCase() + p.slice(1);
  const veggies = ['mushroom','squash','potato','eggplant','cauliflower','broccoli','pasta','rice','noodle'];
  for (const v of veggies) if (t.includes(v)) return v.charAt(0).toUpperCase() + v.slice(1);
  return 'Other';
}

function guessCuisine(title, url) {
  const t = (title + ' ' + (url||'')).toLowerCase();
  const map = {
    'italian': ['pasta','italian','risotto','pizza','lasagna','carbonara','bolognese'],
    'mexican': ['taco','mexican','enchilada','burrito','quesadilla','salsa','mole'],
    'japanese': ['japanese','ramen','sushi','teriyaki','udon','miso','tempura'],
    'chinese': ['chinese','stir-fry','stir fry','dumpling','wonton','kung pao','szechuan','dim sum'],
    'thai': ['thai','pad thai','curry','tom yum','larb'],
    'indian': ['indian','curry','tikka','masala','biryani','dal','naan'],
    'french': ['french','ratatouille','coq au vin','bouillabaisse','cassoulet'],
    'mediterranean': ['mediterranean','greek','hummus','tzatziki','tabbouleh','falafel'],
    'american': ['burger','bbq','barbecue','meatloaf','mac and cheese'],
    'korean': ['korean','bulgogi','kimchi','bibimbap','gochujang']
  };
  for (const [name, kws] of Object.entries(map)) {
    if (kws.some(k => t.includes(k))) return name.charAt(0).toUpperCase() + name.slice(1);
  }
  return 'Other';
}

/* =====================================================
   FETCH FLOW
   ===================================================== */
const urlInput = document.getElementById('urlInput');
const fetchBtn = document.getElementById('fetchBtn');
const fetchStatus = document.getElementById('fetchStatus');

fetchBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) {
    setStatus('Please enter a full URL starting with http(s)://', 'error');
    return;
  }
  setStatus('Fetching recipe…');
  fetchBtn.disabled = true;
  try {
    const html = await fetchHtml(url);
    const recipe = parseRecipeFromHtml(html, url);
    if (!recipe) {
      setStatus("Couldn't auto-extract this recipe. Try the manual form below.", 'error');
      return;
    }
    if (recipe.partial) {
      setStatus('Got the title and image, but no structured recipe data. Edit details manually.', 'error');
    }
    const newRecipe = {
      id: uid(),
      ...recipe,
      inRotation: false,
      made: false,
      notes: '',
      createdAt: Date.now()
    };
    await dbPut('recipes', newRecipe);
    state.recipes.push(newRecipe);
    setStatus('Saved! ✓', 'success');
    urlInput.value = '';
    renderLibrary();
    renderRotation();
    // Open the new recipe so the user can review/edit it right away
    openRecipe(newRecipe.id);
  } catch (e) {
    console.error(e);
    setStatus('Could not load that page. Try the manual form below.', 'error');
  } finally {
    fetchBtn.disabled = false;
  }
});

function setStatus(msg, cls='') {
  fetchStatus.textContent = msg;
  fetchStatus.className = 'fetch-status ' + cls;
}

// Manual entry
let manualGetCuisine = () => '';
let manualGetMain = () => '';

document.getElementById('manualToggle').addEventListener('click', () => {
  const f = document.getElementById('manualForm');
  const opening = f.style.display === 'none';
  f.style.display = opening ? 'flex' : 'none';
  if (opening) {
    // Re-build the dropdowns each time the form opens so they reflect any
    // newly-added cuisines/ingredients from edits or other recipes.
    document.getElementById('mCuisineSlot').innerHTML = buildSelectField({
      id: 'mCuisine', field: 'cuisine', defaults: DEFAULT_CUISINES,
      currentValue: '', placeholder: 'New cuisine name'
    });
    document.getElementById('mMainSlot').innerHTML = buildSelectField({
      id: 'mMain', field: 'mainIngredient', defaults: DEFAULT_MAIN_INGREDIENTS,
      currentValue: '', placeholder: 'New ingredient name'
    });
    manualGetCuisine = wireSelectField('mCuisine');
    manualGetMain = wireSelectField('mMain');
  }
});

document.getElementById('saveManualBtn').addEventListener('click', async () => {
  const title = document.getElementById('mTitle').value.trim();
  if (!title) { toast('Please enter a title'); return; }
  const recipe = {
    id: uid(),
    title,
    image: document.getElementById('mImage').value.trim(),
    cuisine: manualGetCuisine() || 'Other',
    mainIngredient: manualGetMain() || 'Other',
    totalTime: document.getElementById('mTime').value.trim(),
    yield: document.getElementById('mYield').value.trim(),
    ingredients: document.getElementById('mIngredients').value.split('\n').map(s=>s.trim()).filter(Boolean),
    instructions: document.getElementById('mInstructions').value.split('\n').map(s=>s.trim()).filter(Boolean),
    sourceUrl: document.getElementById('mUrl').value.trim(),
    inRotation: false,
    made: false,
    notes: '',
    createdAt: Date.now()
  };
  await dbPut('recipes', recipe);
  state.recipes.push(recipe);
  ['mTitle','mImage','mTime','mYield','mIngredients','mInstructions','mUrl']
    .forEach(id => document.getElementById(id).value = '');
  document.getElementById('manualForm').style.display = 'none';
  toast('Recipe saved');
  renderLibrary();
  renderRotation();
  // Open the new recipe so the user can review/edit it right away
  openRecipe(recipe.id);
});

/* =====================================================
   RENDERING
   ===================================================== */

function recipeCardHtml(r) {
  const imgStyle = r.image ? `style="background-image:url('${escapeAttr(r.image)}')"` : '';
  const placeholderClass = r.image ? '' : 'placeholder';
  const tags = [];
  if (r.cuisine && r.cuisine !== 'Other') tags.push(`<span class="tag">${escapeHtml(r.cuisine)}</span>`);
  if (r.mainIngredient && r.mainIngredient !== 'Other') tags.push(`<span class="tag">${escapeHtml(r.mainIngredient)}</span>`);
  return `
    <article class="recipe-card" data-id="${r.id}">
      <div class="card-flags">
        ${r.inRotation ? '<span class="flag active" title="In rotation">★</span>' : ''}
        ${r.made ? '<span class="flag made" title="Made">✓</span>' : ''}
      </div>
      <div class="recipe-image ${placeholderClass}" ${imgStyle}></div>
      <div class="recipe-body">
        <h3 class="recipe-title">${escapeHtml(r.title)}</h3>
        <div class="recipe-meta">
          ${r.totalTime ? `<span>⏱ ${escapeHtml(r.totalTime)}</span>` : ''}
          ${r.yield ? `<span>👥 ${escapeHtml(r.yield)}</span>` : ''}
        </div>
        ${tags.length ? `<div class="recipe-tags">${tags.join('')}</div>` : ''}
        <div class="card-actions">
          <button class="card-action ${r.inRotation ? 'on' : ''}" data-action="rotation" data-id="${r.id}">
            ${r.inRotation ? '★ In Rotation' : '☆ Rotation'}
          </button>
          <button class="card-action olive ${r.made ? 'on' : ''}" data-action="made" data-id="${r.id}">
            ${r.made ? '✓ Made' : '○ Made'}
          </button>
        </div>
      </div>
    </article>
  `;
}

// Wire up clicks on a container of recipe cards. Handles both the card-tap-to-open
// flow and the inline action buttons (which must NOT also trigger the open).
function wireCardClicks(container) {
  container.querySelectorAll('.recipe-card').forEach(card => {
    card.addEventListener('click', (e) => {
      // Ignore clicks on the action buttons
      if (e.target.closest('.card-action')) return;
      openRecipe(card.dataset.id);
    });
  });
  container.querySelectorAll('.card-action').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      const recipe = state.recipes.find(x => x.id === id);
      if (!recipe) return;
      if (action === 'rotation') {
        recipe.inRotation = !recipe.inRotation;
        await dbPut('recipes', recipe);
        toast(recipe.inRotation ? 'Added to rotation' : 'Removed from rotation');
      } else if (action === 'made') {
        recipe.made = !recipe.made;
        await dbPut('recipes', recipe);
        toast(recipe.made ? 'Marked as made' : 'Unmarked');
      }
      renderRotation();
      renderLibrary();
    });
  });
}

function renderRotation() {
  const grid = document.getElementById('rotationGrid');
  const empty = document.getElementById('rotationEmpty');
  const inRot = state.recipes.filter(r => r.inRotation);
  if (!inRot.length) {
    grid.innerHTML = '';
    empty.style.display = 'block';
  } else {
    empty.style.display = 'none';
    grid.innerHTML = inRot.map(recipeCardHtml).join('');
    wireCardClicks(grid);
    // Re-apply winner highlight if a card was the last winner
    if (lastWinnerId) {
      const card = grid.querySelector(`.recipe-card[data-id="${lastWinnerId}"]`);
      if (card) card.classList.add('winner');
    }
  }
  drawWheel();
}

// Parse a free-form time string (like "20 min", "1h 30m", "45 minutes",
// "1.5 hours") into minutes. Returns null if no number found.
function parseTimeMinutes(str) {
  if (!str) return null;
  const s = String(str).toLowerCase();
  let total = 0;
  let matched = false;
  // Hours: "1h", "1 hr", "1 hour", "1.5 hours"
  const hMatch = s.match(/(\d+(?:\.\d+)?)\s*(?:h\b|hr|hour)/);
  if (hMatch) { total += parseFloat(hMatch[1]) * 60; matched = true; }
  // Minutes: "30m", "30 min", "30 minutes" — but not the 'm' inside "hour"
  const mMatch = s.match(/(\d+(?:\.\d+)?)\s*(?:m(?:in|inute)?s?\b|m\b)/);
  if (mMatch) { total += parseFloat(mMatch[1]); matched = true; }
  // If no unit was detected at all but there's a number, assume minutes
  if (!matched) {
    const nMatch = s.match(/(\d+(?:\.\d+)?)/);
    if (nMatch) total = parseFloat(nMatch[1]);
    else return null;
  }
  return total > 0 ? Math.round(total) : null;
}

function timeBucket(totalTime) {
  const m = parseTimeMinutes(totalTime);
  if (m === null) return 'No time listed';
  if (m < 15) return 'Under 15 min';
  if (m <= 30) return '15-30 min';
  if (m <= 60) return '30-60 min';
  if (m <= 120) return '1-2 hours';
  return 'Over 2 hours';
}

function refreshFilterDropdowns() {
  const cuisines = uniqueRecipeValues('cuisine', DEFAULT_CUISINES);
  const mains = uniqueRecipeValues('mainIngredient', DEFAULT_MAIN_INGREDIENTS);
  const cuisineSel = document.getElementById('filterCuisine');
  const mainSel = document.getElementById('filterMain');

  // Only show options that actually have at least one matching recipe,
  // so we don't list cuisines the user has never used.
  const usedCuisines = new Set(state.recipes.map(r => (r.cuisine||'').trim()).filter(Boolean));
  const usedMains = new Set(state.recipes.map(r => (r.mainIngredient||'').trim()).filter(Boolean));

  const cuisineOpts = cuisines.filter(c => usedCuisines.has(c));
  const mainOpts = mains.filter(m => usedMains.has(m));
  // Include "Other" if any recipes have it
  if ([...usedCuisines].some(c => c.toLowerCase() === 'other')) cuisineOpts.push('Other');
  if ([...usedMains].some(m => m.toLowerCase() === 'other')) mainOpts.push('Other');

  cuisineSel.innerHTML = '<option value="">Cuisine</option>' +
    cuisineOpts.map(c => `<option value="${escapeAttr(c)}" ${c === state.filterCuisine ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('');
  mainSel.innerHTML = '<option value="">Main</option>' +
    mainOpts.map(m => `<option value="${escapeAttr(m)}" ${m === state.filterMain ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');

  // Visual highlight for active filters
  cuisineSel.classList.toggle('active', !!state.filterCuisine);
  mainSel.classList.toggle('active', !!state.filterMain);

  // Show/hide the Clear filters link
  const hasFilters = state.searchTerm || state.filterCuisine || state.filterMain;
  document.getElementById('filterClearBtn').style.display = hasFilters ? 'block' : 'none';
}

function renderLibrary() {
  refreshFilterDropdowns();

  const container = document.getElementById('libraryContainer');
  const empty = document.getElementById('libraryEmpty');
  let recipes = state.recipes.slice();

  // Apply cuisine filter
  if (state.filterCuisine) {
    recipes = recipes.filter(r => (r.cuisine||'').trim() === state.filterCuisine);
  }
  // Apply main ingredient filter
  if (state.filterMain) {
    recipes = recipes.filter(r => (r.mainIngredient||'').trim() === state.filterMain);
  }
  // Apply text search (over title, cuisine, main, and ingredients)
  if (state.searchTerm) {
    const q = state.searchTerm.toLowerCase();
    recipes = recipes.filter(r =>
      r.title.toLowerCase().includes(q) ||
      (r.cuisine||'').toLowerCase().includes(q) ||
      (r.mainIngredient||'').toLowerCase().includes(q) ||
      (r.ingredients||[]).some(i => i.toLowerCase().includes(q))
    );
  }

  if (!recipes.length) {
    container.innerHTML = '';
    empty.style.display = 'block';
    // Customize empty message when filters are the cause
    const hasFilters = state.searchTerm || state.filterCuisine || state.filterMain;
    if (hasFilters && state.recipes.length > 0) {
      empty.innerHTML = `
        <p>No recipes match these filters.</p>
        <p class="muted">Try clearing them or searching for something else.</p>
      `;
    } else {
      empty.innerHTML = `
        <p>No recipes saved yet.</p>
        <p class="muted">Paste a URL above to get started.</p>
      `;
    }
    return;
  }
  empty.style.display = 'none';

  if (state.groupBy === 'none') {
    container.innerHTML = `<div class="grid">${recipes.map(recipeCardHtml).join('')}</div>`;
  } else {
    const groups = {};
    for (const r of recipes) {
      let key;
      if (state.groupBy === 'cuisine') key = r.cuisine || 'Other';
      else if (state.groupBy === 'main') key = r.mainIngredient || 'Other';
      else if (state.groupBy === 'made') key = r.made ? 'Made' : 'Not Yet Made';
      else if (state.groupBy === 'time') key = timeBucket(r.totalTime);
      groups[key] = groups[key] || [];
      groups[key].push(r);
    }
    // Time buckets need a fixed order, not alphabetical
    const TIME_ORDER = ['Under 15 min','15-30 min','30-60 min','1-2 hours','Over 2 hours','No time listed'];
    const sortedKeys = Object.keys(groups).sort((a,b) => {
      if (state.groupBy === 'time') {
        return TIME_ORDER.indexOf(a) - TIME_ORDER.indexOf(b);
      }
      if (a === 'Other') return 1;
      if (b === 'Other') return -1;
      return a.localeCompare(b);
    });
    container.innerHTML = sortedKeys.map(k => `
      <div class="group">
        <h3 class="group-title">${escapeHtml(k)} <span class="muted">· ${groups[k].length}</span></h3>
        <div class="grid">${groups[k].map(recipeCardHtml).join('')}</div>
      </div>
    `).join('');
  }
  container.querySelectorAll('.recipe-card');
  wireCardClicks(container);
}

document.getElementById('searchInput').addEventListener('input', e => {
  state.searchTerm = e.target.value;
  renderLibrary();
});
document.getElementById('groupBy').addEventListener('change', e => {
  state.groupBy = e.target.value;
  renderLibrary();
});
document.getElementById('filterCuisine').addEventListener('change', e => {
  state.filterCuisine = e.target.value;
  renderLibrary();
});
document.getElementById('filterMain').addEventListener('change', e => {
  state.filterMain = e.target.value;
  renderLibrary();
});
document.getElementById('filterClearBtn').addEventListener('click', () => {
  state.searchTerm = '';
  state.filterCuisine = '';
  state.filterMain = '';
  document.getElementById('searchInput').value = '';
  renderLibrary();
});

/* =====================================================
   RECIPE DETAIL MODAL
   ===================================================== */
const modal = document.getElementById('recipeModal');
const modalContent = document.getElementById('modalContent');
document.getElementById('modalClose').addEventListener('click', closeModal);
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

function closeModal() { modal.classList.remove('open'); }

function openRecipe(id, mode='view') {
  const r = state.recipes.find(x => x.id === id);
  if (!r) return;
  if (mode === 'edit') {
    renderRecipeEdit(r);
  } else {
    renderRecipeView(r);
  }
  modal.classList.add('open');
}

function renderRecipeView(r) {
  const img = r.image ? `<div class="detail-image" style="background-image:url('${escapeAttr(r.image)}')"></div>` : '';
  const available = state.pantry.filter(p => !p.used);
  const ingredients = r.ingredients || [];
  // Categorize each ingredient line as in-kitchen vs missing
  const ingredientStatus = ingredients.map(line => ({
    line,
    inKitchen: !!pantryMatchesIngredient(available, line)
  }));
  const haveCount = ingredientStatus.filter(i => i.inKitchen).length;
  const missingCount = ingredients.length - haveCount;

  const ingredientsList = ingredientStatus.length
    ? ingredientStatus.map(i => `
        <li class="ingredient-line ${i.inKitchen ? 'have' : 'need'}">
          <span class="ing-marker">${i.inKitchen ? '✓' : '○'}</span>
          <span class="ing-text">${escapeHtml(i.line)}</span>
        </li>
      `).join('')
    : '<li class="muted">None listed</li>';
  const instructionsList = (r.instructions||[]).map(i => `<li>${escapeHtml(i)}</li>`).join('') || '<li class="muted">None listed</li>';

  modalContent.innerHTML = `
    ${img}
    <h2 class="detail-title">${escapeHtml(r.title)}</h2>
    <div class="detail-meta">
      ${r.totalTime ? `<span><strong>Time:</strong> ${escapeHtml(r.totalTime)}</span>` : ''}
      ${r.yield ? `<span><strong>Yield:</strong> ${escapeHtml(r.yield)}</span>` : ''}
      ${r.cuisine ? `<span><strong>Cuisine:</strong> ${escapeHtml(r.cuisine)}</span>` : ''}
      ${r.mainIngredient ? `<span><strong>Main:</strong> ${escapeHtml(r.mainIngredient)}</span>` : ''}
    </div>
    <div class="detail-toggles">
      <button class="toggle-btn ${r.inRotation?'on':''}" id="toggleRotation">${r.inRotation?'★ In Rotation':'☆ Add to Rotation'}</button>
      <button class="toggle-btn olive ${r.made?'on':''}" id="toggleMade">${r.made?'✓ Made':'○ Mark as Made'}</button>
      <button class="toggle-btn" id="editRecipeBtn">✎ Edit</button>
    </div>
    <div class="detail-section">
      <h3>Ingredients</h3>
      ${ingredients.length ? `<p class="ingredients-summary"><span class="have-count">${haveCount} in kitchen</span> · <span class="need-count">${missingCount} to buy</span></p>` : ''}
      <ul class="ingredient-list">${ingredientsList}</ul>
      ${ingredients.length ? `
        <div class="ingredient-actions">
          ${missingCount > 0 ? `<button class="add-ingredients-btn terra" id="addMissingToShopping">+ Add ${missingCount} missing to shopping</button>` : ''}
          <button class="add-ingredients-btn" id="addAllToShopping">+ Add all to shopping</button>
        </div>
      ` : ''}
    </div>
    <div class="detail-section">
      <h3>Instructions</h3>
      <ol>${instructionsList}</ol>
    </div>
    <div class="detail-section">
      <h3>My Notes</h3>
      <textarea class="detail-notes" id="recipeNotes" placeholder="Tweaks, substitutions, family ratings…">${escapeHtml(r.notes||'')}</textarea>
    </div>
    ${r.sourceUrl ? `<div class="detail-source">Source: <a href="${escapeAttr(r.sourceUrl)}" target="_blank" rel="noopener">${escapeHtml(r.sourceUrl)}</a></div>` : ''}
    <div class="detail-actions">
      <button class="primary-btn" id="saveNotesBtn">Save Notes</button>
      <button class="primary-btn outline" id="deleteRecipeBtn" style="border-color:var(--terracotta);color:var(--terracotta)">Delete</button>
    </div>
  `;
  // Scroll to top when re-rendering after edits
  document.querySelector('.modal-scroll').scrollTop = 0;

  document.getElementById('toggleRotation').addEventListener('click', async () => {
    r.inRotation = !r.inRotation;
    await dbPut('recipes', r);
    renderRecipeView(r);
    renderRotation();
    renderLibrary();
    toast(r.inRotation ? 'Added to rotation' : 'Removed from rotation');
  });
  document.getElementById('toggleMade').addEventListener('click', async () => {
    r.made = !r.made;
    await dbPut('recipes', r);
    renderRecipeView(r);
    renderLibrary();
  });
  document.getElementById('editRecipeBtn').addEventListener('click', () => {
    renderRecipeEdit(r);
  });
  document.getElementById('saveNotesBtn').addEventListener('click', async () => {
    r.notes = document.getElementById('recipeNotes').value;
    await dbPut('recipes', r);
    toast('Notes saved');
  });
  document.getElementById('deleteRecipeBtn').addEventListener('click', async () => {
    if (!confirm('Delete this recipe?')) return;
    await dbDelete('recipes', r.id);
    state.recipes = state.recipes.filter(x => x.id !== r.id);
    closeModal();
    renderLibrary();
    renderRotation();
    toast('Recipe deleted');
  });
  const addAllBtn = document.getElementById('addAllToShopping');
  if (addAllBtn) {
    addAllBtn.addEventListener('click', async () => {
      for (const ing of r.ingredients) {
        const item = { id: uid(), name: ing, checked: false, createdAt: Date.now() };
        await dbPut('shopping', item);
        state.shopping.push(item);
      }
      toast(`Added ${r.ingredients.length} items to shopping list`);
      renderShopping();
    });
  }
  const addMissingBtn = document.getElementById('addMissingToShopping');
  if (addMissingBtn) {
    addMissingBtn.addEventListener('click', async () => {
      const missing = ingredientStatus.filter(i => !i.inKitchen);
      for (const i of missing) {
        const item = { id: uid(), name: i.line, checked: false, createdAt: Date.now() };
        await dbPut('shopping', item);
        state.shopping.push(item);
      }
      toast(`Added ${missing.length} missing items to shopping`);
      renderShopping();
    });
  }
}

function renderRecipeEdit(r) {
  const ingredientsText = (r.ingredients||[]).join('\n');
  const instructionsText = (r.instructions||[]).join('\n');
  const imgPreview = r.image
    ? `<div class="detail-image" style="background-image:url('${escapeAttr(r.image)}')"></div>`
    : '';

  modalContent.innerHTML = `
    ${imgPreview}
    <div class="edit-form">
      <h2 class="modal-title" style="margin-bottom:14px">Edit Recipe</h2>

      <label class="edit-label">Title</label>
      <input type="text" id="eTitle" value="${escapeAttr(r.title||'')}" placeholder="Recipe title">

      <label class="edit-label">Image URL</label>
      <input type="url" id="eImage" value="${escapeAttr(r.image||'')}" placeholder="https://…">

      <div class="edit-row">
        <div>
          <label class="edit-label">Cuisine</label>
          ${buildSelectField({ id: 'eCuisine', field: 'cuisine', defaults: DEFAULT_CUISINES, currentValue: r.cuisine, placeholder: 'New cuisine name' })}
        </div>
        <div>
          <label class="edit-label">Main Ingredient</label>
          ${buildSelectField({ id: 'eMain', field: 'mainIngredient', defaults: DEFAULT_MAIN_INGREDIENTS, currentValue: r.mainIngredient, placeholder: 'New ingredient name' })}
        </div>
      </div>

      <div class="edit-row">
        <div>
          <label class="edit-label">Total Time</label>
          <input type="text" id="eTime" value="${escapeAttr(r.totalTime||'')}" placeholder="45 min">
        </div>
        <div>
          <label class="edit-label">Yield</label>
          <input type="text" id="eYield" value="${escapeAttr(r.yield||'')}" placeholder="4 servings">
        </div>
      </div>

      <label class="edit-label">Ingredients <span class="muted">(one per line)</span></label>
      <textarea id="eIngredients" rows="8" placeholder="1 cup flour&#10;2 eggs&#10;…">${escapeHtml(ingredientsText)}</textarea>

      <label class="edit-label">Instructions <span class="muted">(one step per line)</span></label>
      <textarea id="eInstructions" rows="8" placeholder="Preheat oven&#10;Mix wet ingredients&#10;…">${escapeHtml(instructionsText)}</textarea>

      <label class="edit-label">Source URL</label>
      <input type="url" id="eSourceUrl" value="${escapeAttr(r.sourceUrl||'')}" placeholder="https://…">

      <div class="detail-actions">
        <button class="primary-btn" id="saveEditBtn">Save Changes</button>
        <button class="primary-btn outline" id="cancelEditBtn">Cancel</button>
      </div>
    </div>
  `;
  document.querySelector('.modal-scroll').scrollTop = 0;

  const getCuisine = wireSelectField('eCuisine');
  const getMain = wireSelectField('eMain');

  document.getElementById('saveEditBtn').addEventListener('click', async () => {
    r.title = document.getElementById('eTitle').value.trim() || r.title;
    r.image = document.getElementById('eImage').value.trim();
    r.cuisine = getCuisine() || 'Other';
    r.mainIngredient = getMain() || 'Other';
    r.totalTime = document.getElementById('eTime').value.trim();
    r.yield = document.getElementById('eYield').value.trim();
    r.ingredients = document.getElementById('eIngredients').value.split('\n').map(s=>s.trim()).filter(Boolean);
    r.instructions = document.getElementById('eInstructions').value.split('\n').map(s=>s.trim()).filter(Boolean);
    r.sourceUrl = document.getElementById('eSourceUrl').value.trim();

    // Bust the wheel image cache for this URL so the new image redraws
    if (r.image && imageCache.has(r.image)) imageCache.delete(r.image);

    await dbPut('recipes', r);
    toast('Recipe updated');
    renderRecipeView(r);
    renderLibrary();
    renderRotation();
  });

  document.getElementById('cancelEditBtn').addEventListener('click', () => {
    renderRecipeView(r);
  });
}

/* =====================================================
   WHEEL
   ===================================================== */
const COLORS = ['#c5573b','#d99a3d','#6b7148','#9d3f29','#a8763a','#3d6661','#b54a3c','#8b6f3f'];
let wheelAngle = 0;
let spinning = false;
let lastWinnerId = null;
let pendingAutoOpenTimer = null;

// Image cache for the wheel
const imageCache = new Map(); // url -> {img, loaded, failed}

function loadWheelImage(url) {
  if (!url) return null;
  if (imageCache.has(url)) return imageCache.get(url);
  const entry = { img: new Image(), loaded: false, failed: false };
  // crossOrigin='anonymous' lets us draw to canvas without tainting it,
  // but only works if the host sends CORS headers. If it fails, retry without.
  entry.img.crossOrigin = 'anonymous';
  let triedFallback = false;
  entry.img.onload = () => {
    entry.loaded = true;
    drawWheel(); // redraw when image arrives
  };
  entry.img.onerror = () => {
    if (!triedFallback) {
      triedFallback = true;
      // Retry without crossOrigin — image may still display but canvas may be tainted.
      // We catch tainted-canvas errors at draw time.
      const retry = new Image();
      retry.onload = () => {
        entry.img = retry;
        entry.loaded = true;
        drawWheel();
      };
      retry.onerror = () => { entry.failed = true; };
      retry.src = url;
    } else {
      entry.failed = true;
    }
  };
  entry.img.src = url;
  imageCache.set(url, entry);
  return entry;
}

function drawWheel() {
  const canvas = document.getElementById('wheel');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const inRot = state.recipes.filter(r => r.inRotation);
  const W = canvas.width, H = canvas.height;
  const cx = W/2, cy = H/2, R = Math.min(W,H)/2 - 10;
  ctx.clearRect(0,0,W,H);

  if (!inRot.length) {
    ctx.fillStyle = '#ece4d4';
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI*2);
    ctx.fill();
    ctx.fillStyle = '#8a7e6e';
    ctx.font = 'italic 28px Fraunces, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Add recipes', cx, cy - 14);
    ctx.fillText('to rotation', cx, cy + 22);
    return;
  }

  const slice = (Math.PI*2) / inRot.length;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(wheelAngle);

  inRot.forEach((r, i) => {
    const start = i * slice;

    // Build the slice path
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0,0);
    ctx.arc(0, 0, R, start, start + slice);
    ctx.closePath();

    // Try to fill with image
    let drewImage = false;
    if (r.image) {
      const entry = loadWheelImage(r.image);
      if (entry && entry.loaded && !entry.failed) {
        try {
          ctx.clip(); // clip to slice shape
          // Draw image rotated so it sits "upright" within the slice.
          // The slice spans angles [start, start+slice]; its mid is start + slice/2.
          // Rotate canvas so the slice's mid points "outward to the right",
          // then draw the image in a square that covers the slice region.
          const mid = start + slice/2;
          ctx.rotate(mid);
          // Cover area: from origin out to R along x-axis, with height ~ R*tan(slice/2)*2.
          // Simplest: draw a square sized 2R by 2R centered around (R/2, 0)... use cover math.
          const aspect = entry.img.width / entry.img.height || 1;
          // Target: fill the slice region. We'll draw to fit a box from x=0..R, y=-R..R, then cover.
          const boxW = R;
          const boxH = R; // half-height per side; total 2R wedge but image only needs to cover wedge
          // Use cover scaling
          let sw = entry.img.width, sh = entry.img.height;
          let dx = 0, dy = -boxH, dw = boxW, dh = boxH * 2;
          // Cover crop:
          const targetAspect = dw / dh;
          let srcX = 0, srcY = 0, srcW = sw, srcH = sh;
          if (aspect > targetAspect) {
            // image wider than target, crop sides
            srcW = sh * targetAspect;
            srcX = (sw - srcW) / 2;
          } else {
            srcH = sw / targetAspect;
            srcY = (sh - srcH) / 2;
          }
          ctx.drawImage(entry.img, srcX, srcY, srcW, srcH, dx, dy, dw, dh);
          // Darken overlay for text legibility
          ctx.fillStyle = 'rgba(28,24,20,0.35)';
          ctx.fillRect(dx, dy, dw, dh);
          drewImage = true;
        } catch (e) {
          // If clip/draw fails, fall through to color
          drewImage = false;
        }
      }
    }
    ctx.restore();

    // If no image drew, fill with color
    if (!drewImage) {
      ctx.beginPath();
      ctx.moveTo(0,0);
      ctx.arc(0, 0, R, start, start + slice);
      ctx.closePath();
      ctx.fillStyle = COLORS[i % COLORS.length];
      ctx.fill();
    }

    // Slice border
    ctx.beginPath();
    ctx.moveTo(0,0);
    ctx.arc(0, 0, R, start, start + slice);
    ctx.closePath();
    ctx.strokeStyle = '#fbf7f0';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Short label so you can verify the wheel and the picker agree.
    // Only the first word or two, with strong text shadow.
    ctx.save();
    ctx.rotate(start + slice/2);
    ctx.fillStyle = '#fbf7f0';
    ctx.font = '700 13px Inter, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 5;
    // Just enough text to identify the slice — long titles get truncated short
    const maxLen = inRot.length > 6 ? 10 : 14;
    const txt = (r.title || '').length > maxLen
      ? (r.title.slice(0, maxLen - 1) + '…')
      : (r.title || '');
    ctx.fillText(txt, R - 14, 0);
    ctx.restore();
  });
  ctx.restore();

  // Center hub
  ctx.beginPath();
  ctx.arc(cx, cy, 30, 0, Math.PI*2);
  ctx.fillStyle = '#fbf7f0';
  ctx.fill();
  ctx.strokeStyle = '#1c1814';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#c5573b';
  ctx.font = '22px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('✺', cx, cy);
}

document.getElementById('spinBtn').addEventListener('click', () => {
  if (spinning) return;
  const inRot = state.recipes.filter(r => r.inRotation);
  if (!inRot.length) { toast('Add recipes to rotation first'); return; }
  // Cancel any pending auto-open from a previous spin
  if (pendingAutoOpenTimer) {
    clearTimeout(pendingAutoOpenTimer);
    pendingAutoOpenTimer = null;
  }
  spinning = true;
  // Clear previous winner state
  document.getElementById('wheelResult').innerHTML = '';
  document.querySelectorAll('.recipe-card.winner').forEach(c => c.classList.remove('winner'));
  lastWinnerId = null;

  const targetIdx = Math.floor(Math.random() * inRot.length);
  const slice = (Math.PI*2) / inRot.length;
  // Pointer at top = -PI/2. We want target slice center at -PI/2.
  const targetCenter = targetIdx * slice + slice/2;
  const fullSpins = 5 + Math.random() * 2;
  const finalAngle = (Math.PI*2) * fullSpins + (-Math.PI/2 - targetCenter);
  const start = wheelAngle;
  const startTime = performance.now();
  const duration = 4200;

  function animate(now) {
    const t = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    wheelAngle = start + (finalAngle - start) * eased;
    drawWheel();
    if (t < 1) {
      requestAnimationFrame(animate);
    } else {
      // Normalize once at the end
      wheelAngle = wheelAngle % (Math.PI*2);
      spinning = false;
      // Determine the winner from the ACTUAL rotation of the wheel,
      // not the originally-intended target index. This guarantees the
      // displayed pointer position and the picked recipe always agree,
      // even if floating-point drift or any other oddity happened.
      const winner = sliceAtPointer();
      if (!winner) {
        toast('Could not determine winner');
        return;
      }
      lastWinnerId = winner.id;
      showWinner(winner);
    }
  }
  requestAnimationFrame(animate);
});

// Returns the recipe whose slice is currently under the pointer (at the top
// of the wheel). Source of truth = current wheelAngle + current rotation list.
function sliceAtPointer() {
  const inRot = state.recipes.filter(r => r.inRotation);
  if (!inRot.length) return null;
  const slice = (Math.PI*2) / inRot.length;
  const TOP = 3 * Math.PI / 2; // canvas angle for "12 o'clock"
  let bestIdx = 0;
  let bestErr = Infinity;
  for (let i = 0; i < inRot.length; i++) {
    const sliceCenter = wheelAngle + i * slice + slice/2;
    let norm = ((sliceCenter % (Math.PI*2)) + Math.PI*2) % (Math.PI*2);
    let err = Math.abs(norm - TOP);
    if (err > Math.PI) err = Math.PI*2 - err;
    if (err < bestErr) { bestErr = err; bestIdx = i; }
  }
  return inRot[bestIdx];
}

function showWinner(winner) {
  // Build the tappable result card (still useful for re-opening after closing)
  const resultEl = document.getElementById('wheelResult');
  const thumbStyle = winner.image
    ? `style="background-image:url('${escapeAttr(winner.image)}')"`
    : '';
  resultEl.innerHTML = `
    <button class="wheel-result-card" id="openWinnerBtn">
      <div class="winner-thumb" ${thumbStyle}></div>
      <div class="winner-text">
        <span class="winner-label">Tonight you're cooking</span>
        <span class="winner-name">${escapeHtml(winner.title)}</span>
      </div>
      <span class="winner-arrow">→</span>
    </button>
  `;
  document.getElementById('openWinnerBtn').addEventListener('click', () => {
    openRecipe(winner.id);
  });

  // Highlight the winner card in the rotation grid (no auto-scroll —
  // user can tap the result banner to open the recipe directly).
  const card = document.querySelector(`#rotationGrid .recipe-card[data-id="${winner.id}"]`);
  if (card) {
    card.classList.add('winner');
  }

  // Auto-open the winning recipe card after a short pause so the user has
  // a moment to register the result before being taken into it. Track the
  // timer so a subsequent spin can cancel a pending open.
  if (pendingAutoOpenTimer) clearTimeout(pendingAutoOpenTimer);
  pendingAutoOpenTimer = setTimeout(() => {
    pendingAutoOpenTimer = null;
    openRecipe(winner.id);
  }, 700);
}

/* =====================================================
   PANTRY / KITCHEN
   ===================================================== */
document.getElementById('addPantryBtn').addEventListener('click', addPantryItem);
document.getElementById('pantryInput').addEventListener('keydown', e => { if (e.key === 'Enter') addPantryItem(); });

async function addPantryItem() {
  const name = document.getElementById('pantryInput').value.trim();
  if (!name) return;
  const location = document.getElementById('pantryLocation').value;
  const item = { id: uid(), name, location, used: false, createdAt: Date.now() };
  // Auto-detect perishability and set initial expiry
  const detect = detectPerishable(name);
  if (detect && detect.perishable) {
    item.expiresAt = Date.now() + detect.days * 24 * 60 * 60 * 1000;
    item.perishableKind = detect.kind;
  }
  await dbPut('pantry', item);
  state.pantry.push(item);
  document.getElementById('pantryInput').value = '';
  renderPantry();
  renderShopping(); // shopping list "in kitchen" badges depend on pantry
}

function renderPantry() {
  const lists = {
    fridge: document.getElementById('fridgeList'),
    pantry: document.getElementById('pantryList'),
    freezer: document.getElementById('freezerList')
  };
  Object.values(lists).forEach(l => l.innerHTML = '');
  // Sort each location's items: expiring soonest first, then by name
  const sorted = state.pantry.slice().sort((a, b) => {
    const ad = daysUntilExpiry(a);
    const bd = daysUntilExpiry(b);
    if (ad === null && bd === null) return a.name.localeCompare(b.name);
    if (ad === null) return 1;
    if (bd === null) return -1;
    return ad - bd;
  });
  for (const item of sorted) {
    const li = document.createElement('li');
    const days = daysUntilExpiry(item);
    const isExpired = days !== null && days < 0;
    li.className = 'pantry-item' + (item.used ? ' used' : '') + (isExpired ? ' expired' : '');
    li.innerHTML = `
      <input type="checkbox" ${item.used?'checked':''}>
      <span class="item-name">${escapeHtml(item.name)}</span>
      ${item.expiresAt ? `<button class="expiry-badge-btn" data-action="expiryMenu">${expiryBadgeInner(item)}</button>` : ''}
      <div class="item-actions">
        <button class="mini-btn" data-action="edit">✎ Edit</button>
        ${!item.expiresAt ? '<button class="mini-btn" data-action="addExpiry">Expiry</button>' : ''}
        <button class="mini-btn" data-action="shop">+ Shop</button>
        <button class="mini-btn danger" data-action="delete">×</button>
      </div>
    `;
    const cb = li.querySelector('input[type="checkbox"]');
    cb.addEventListener('change', async () => {
      item.used = cb.checked;
      await dbPut('pantry', item);
      renderPantry();
      renderShopping();
    });
    li.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        if (action === 'edit') {
          const result = await pickKitchenLocation({
            title: 'Edit item',
            defaultName: item.name,
            defaultLocation: item.location,
            showName: true
          });
          if (!result) return;
          const oldName = item.name;
          item.name = result.name;
          item.location = result.location;
          // If the name changed substantively, refresh perishable detection
          // (so renaming "1lb chicken" → "chicken" still gives expiry).
          if (oldName !== result.name && !item.expiresAt) {
            const detect = detectPerishable(item.name);
            if (detect && detect.perishable) {
              item.expiresAt = Date.now() + detect.days * 24 * 60 * 60 * 1000;
              item.perishableKind = detect.kind;
            }
          }
          await dbPut('pantry', item);
          renderPantry();
          renderShopping();
          toast('Updated');
        } else if (action === 'shop') {
          const shop = { id: uid(), name: item.name, checked: false, createdAt: Date.now() };
          await dbPut('shopping', shop);
          state.shopping.push(shop);
          toast('Added to shopping list');
          renderShopping();
        } else if (action === 'delete') {
          await dbDelete('pantry', item.id);
          state.pantry = state.pantry.filter(x => x.id !== item.id);
          renderPantry();
          renderShopping();
        } else if (action === 'expiryMenu') {
          // Tapping the expiry badge: extend, change, or clear
          const choice = await pickExpiryAction(item);
          if (choice === 'extend') {
            const more = prompt('Extend expiry by how many days?', '3');
            if (!more) return;
            const n = parseInt(more, 10);
            if (!isNaN(n) && n > 0) {
              const base = (item.expiresAt && item.expiresAt > Date.now()) ? item.expiresAt : Date.now();
              item.expiresAt = base + n * 24 * 60 * 60 * 1000;
              await dbPut('pantry', item);
              renderPantry();
            }
          } else if (choice === 'reset') {
            const days = prompt('How many days from now?', '5');
            if (!days) return;
            const n = parseInt(days, 10);
            if (!isNaN(n) && n > 0) {
              item.expiresAt = Date.now() + n * 24 * 60 * 60 * 1000;
              await dbPut('pantry', item);
              renderPantry();
            }
          } else if (choice === 'clear') {
            delete item.expiresAt;
            delete item.perishableKind;
            await dbPut('pantry', item);
            renderPantry();
            toast('Expiry cleared');
          }
        } else if (action === 'addExpiry') {
          const days = prompt('How many days until this expires?', '5');
          if (!days) return;
          const n = parseInt(days, 10);
          if (!isNaN(n) && n > 0) {
            item.expiresAt = Date.now() + n * 24 * 60 * 60 * 1000;
            await dbPut('pantry', item);
            renderPantry();
          }
        }
      });
    });
    (lists[item.location] || lists.pantry).appendChild(li);
  }
}

/* =====================================================
   SHOPPING LIST
   ===================================================== */
document.getElementById('addShopBtn').addEventListener('click', addShopItem);
document.getElementById('shopInput').addEventListener('keydown', e => { if (e.key === 'Enter') addShopItem(); });

async function addShopItem() {
  const name = document.getElementById('shopInput').value.trim();
  if (!name) return;
  const item = { id: uid(), name, checked: false, createdAt: Date.now() };
  await dbPut('shopping', item);
  state.shopping.push(item);
  document.getElementById('shopInput').value = '';
  renderShopping();
}

function renderShopping() {
  const list = document.getElementById('shoppingList');
  list.innerHTML = '';
  for (const item of state.shopping) {
    // Check if a matching item already exists in pantry (and isn't used up)
    const inKitchen = pantryMatchesIngredient(state.pantry, item.name);
    const li = document.createElement('li');
    li.className = 'shopping-item'
      + (item.checked ? ' checked' : '')
      + (inKitchen ? ' in-kitchen' : '');
    li.innerHTML = `
      <input type="checkbox" ${item.checked?'checked':''}>
      <span class="item-name">${escapeHtml(item.name)}</span>
      ${inKitchen ? '<span class="in-kitchen-badge">✓ In Kitchen</span>' : ''}
      <div class="item-actions">
        <button class="mini-btn" data-action="edit">✎</button>
        <button class="mini-btn terra" data-action="kitchen">→ Kitchen</button>
        <button class="mini-btn danger" data-action="delete">×</button>
      </div>
    `;
    const cb = li.querySelector('input[type="checkbox"]');
    cb.addEventListener('change', async () => {
      item.checked = cb.checked;
      await dbPut('shopping', item);
      li.classList.toggle('checked', item.checked);
    });
    li.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        if (action === 'kitchen') {
          await moveShoppingItemToKitchen(item);
        } else if (action === 'edit') {
          const newName = prompt('Edit item:', item.name);
          if (!newName || newName.trim() === '') return;
          item.name = newName.trim();
          await dbPut('shopping', item);
          renderShopping();
        } else if (action === 'delete') {
          await dbDelete('shopping', item.id);
          state.shopping = state.shopping.filter(x => x.id !== item.id);
          renderShopping();
        }
      });
    });
    list.appendChild(li);
  }
}

async function moveShoppingItemToKitchen(item) {
  // Open the picker with the shopping item's name pre-filled and editable,
  // so user can simplify "1¼ lb salmon cut into pieces" → "salmon".
  const result = await pickKitchenLocation({
    title: 'Move to kitchen',
    defaultName: item.name,
    showName: true
  });
  if (!result) return;
  const { name, location } = result;
  const pantryItem = {
    id: uid(),
    name,
    location,
    used: false,
    createdAt: Date.now()
  };
  const detect = detectPerishable(name);
  if (detect && detect.perishable) {
    pantryItem.expiresAt = Date.now() + detect.days * 24 * 60 * 60 * 1000;
    pantryItem.perishableKind = detect.kind;
  }
  await dbPut('pantry', pantryItem);
  state.pantry.push(pantryItem);
  // Remove from shopping list
  await dbDelete('shopping', item.id);
  state.shopping = state.shopping.filter(x => x.id !== item.id);
  renderShopping();
  renderPantry();
  toast(`Moved to ${location}`);
}

// Bottom-sheet picker for kitchen location with editable item name.
// Resolves to {name, location} | null (if cancelled).
function pickKitchenLocation(opts = {}) {
  const { title = 'Where does it go?', defaultName = '', showName = false, defaultLocation = '' } = opts;
  return new Promise(resolve => {
    const sheet = document.createElement('div');
    sheet.className = 'modal location-picker open';
    const nameField = showName ? `
      <label class="picker-name-label">Item name</label>
      <input type="text" class="picker-name-input" value="${escapeAttr(defaultName)}" placeholder="e.g. salmon" autofocus>
      <p class="picker-hint">Tip: simplify long ingredient names so they're easier to find later (e.g. "salmon" instead of "1¼ lb salmon cut into pieces").</p>
    ` : '';
    sheet.innerHTML = `
      <div class="modal-card location-card">
        <div class="modal-scroll">
          <h2 class="picker-title">${escapeHtml(title)}</h2>
          ${nameField}
          <div class="picker-options">
            <button class="picker-btn ${defaultLocation === 'fridge' ? 'preselected' : ''}" data-loc="fridge">
              <span class="picker-icon">🧊</span>
              <span class="picker-label">Fridge</span>
            </button>
            <button class="picker-btn ${defaultLocation === 'pantry' ? 'preselected' : ''}" data-loc="pantry">
              <span class="picker-icon">🥫</span>
              <span class="picker-label">Pantry</span>
            </button>
            <button class="picker-btn ${defaultLocation === 'freezer' ? 'preselected' : ''}" data-loc="freezer">
              <span class="picker-icon">❄️</span>
              <span class="picker-label">Freezer</span>
            </button>
          </div>
          <button class="primary-btn outline picker-cancel">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(sheet);

    const cleanup = (val) => {
      sheet.classList.remove('open');
      setTimeout(() => sheet.remove(), 200);
      resolve(val);
    };

    const nameInput = sheet.querySelector('.picker-name-input');
    sheet.querySelectorAll('.picker-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const finalName = nameInput ? nameInput.value.trim() : defaultName;
        if (showName && !finalName) {
          nameInput.focus();
          return;
        }
        cleanup({ name: finalName, location: btn.dataset.loc });
      });
    });
    sheet.querySelector('.picker-cancel').addEventListener('click', () => cleanup(null));
    sheet.addEventListener('click', e => {
      if (e.target === sheet) cleanup(null);
    });
    if (nameInput) {
      // Focus the input slightly after open so iOS doesn't fight us.
      setTimeout(() => nameInput.focus(), 100);
      // Pre-select all text so user can immediately retype if desired.
      nameInput.addEventListener('focus', () => nameInput.select(), { once: true });
    }
  });
}

document.getElementById('clearCheckedBtn').addEventListener('click', async () => {
  const toRemove = state.shopping.filter(s => s.checked);
  for (const item of toRemove) await dbDelete('shopping', item.id);
  state.shopping = state.shopping.filter(s => !s.checked);
  renderShopping();
  toast(`Cleared ${toRemove.length} items`);
});

/* =====================================================
   WHAT CAN I MAKE?
   ===================================================== */
const makeModal = document.getElementById('makeModal');
let makeFilter = 'have-all'; // current "missing N" filter
let cookWithSelection = []; // pantry-item IDs to require — empty = no filter

document.getElementById('whatCanIMakeBtn').addEventListener('click', () => {
  makeFilter = 'have-all';
  cookWithSelection = [];
  renderMakeResults();
  makeModal.classList.add('open');
});
document.getElementById('makeClose').addEventListener('click', () => makeModal.classList.remove('open'));
makeModal.addEventListener('click', (e) => { if (e.target === makeModal) makeModal.classList.remove('open'); });

// "Cook with…" — open a picker of kitchen items, then show recipes that
// use at least one of the selected items.
document.getElementById('cookWithBtn').addEventListener('click', async () => {
  const available = state.pantry.filter(p => !p.used);
  if (!available.length) {
    toast('Add items to your kitchen first');
    return;
  }
  const picked = await pickKitchenItems(available);
  if (!picked || !picked.length) return;
  cookWithSelection = picked;
  makeFilter = 'have-all';
  renderMakeResults();
  makeModal.classList.add('open');
});

// Modal picker: multi-select kitchen items via tappable chips.
// Resolves to array of item names (the original pantry strings).
function pickKitchenItems(items) {
  return new Promise(resolve => {
    const sheet = document.createElement('div');
    sheet.className = 'modal location-picker open';
    sheet.innerHTML = `
      <div class="modal-card location-card">
        <div class="modal-scroll">
          <h2 class="picker-title">Cook with…</h2>
          <p class="picker-hint" style="margin-bottom:14px">Tap items you want to use. We'll find recipes that include at least one of them.</p>
          <div class="kitchen-chips" id="kitchenChips">
            ${items.map(it => `
              <button class="kitchen-chip" data-name="${escapeAttr(it.name)}">
                <span class="chip-name">${escapeHtml(it.name)}</span>
              </button>
            `).join('')}
          </div>
          <div class="detail-actions">
            <button class="primary-btn" id="cookWithConfirm">Find recipes</button>
            <button class="primary-btn outline" id="cookWithCancel">Cancel</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(sheet);
    const selected = new Set();
    const cleanup = (val) => {
      sheet.classList.remove('open');
      setTimeout(() => sheet.remove(), 200);
      resolve(val);
    };
    sheet.querySelectorAll('.kitchen-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const n = chip.dataset.name;
        if (selected.has(n)) {
          selected.delete(n);
          chip.classList.remove('on');
        } else {
          selected.add(n);
          chip.classList.add('on');
        }
      });
    });
    sheet.querySelector('#cookWithConfirm').addEventListener('click', () => {
      if (!selected.size) { toast('Pick at least one item'); return; }
      cleanup(Array.from(selected));
    });
    sheet.querySelector('#cookWithCancel').addEventListener('click', () => cleanup(null));
    sheet.addEventListener('click', e => { if (e.target === sheet) cleanup(null); });
  });
}

// Score every recipe by how many ingredients we have on hand vs missing.
// Returns array of {recipe, missing: [string], have: number, total: number,
// matchesSelection: bool}
function scoreRecipesByPantry() {
  const available = state.pantry.filter(p => !p.used);
  // When user selected "cook with X, Y", we require that the recipe actually
  // calls for at least one of X or Y. We compute this by checking each recipe
  // ingredient against just the selected pantry items.
  const selectionItems = cookWithSelection.length
    ? available.filter(p => cookWithSelection.includes(p.name))
    : null;
  return state.recipes.map(r => {
    const ingredients = r.ingredients || [];
    const missing = [];
    let have = 0;
    let matchesSelection = !selectionItems; // true when no filter applied
    for (const ing of ingredients) {
      if (pantryMatchesIngredient(available, ing)) {
        have++;
      } else {
        missing.push(ing);
      }
      if (selectionItems && pantryMatchesIngredient(selectionItems, ing)) {
        matchesSelection = true;
      }
    }
    return { recipe: r, missing, have, total: ingredients.length, matchesSelection };
  })
    .filter(s => s.total > 0) // skip recipes with no ingredients listed
    .filter(s => s.matchesSelection); // honor the "cook with" filter
}

function renderMakeResults() {
  const scored = scoreRecipesByPantry();
  const tabsEl = document.getElementById('makeTabs');
  const resultsEl = document.getElementById('makeResults');
  const introEl = document.getElementById('makeIntro');

  // Update header to reflect cook-with selection
  if (cookWithSelection.length) {
    const chipsHtml = cookWithSelection.map(name =>
      `<span class="active-chip">${escapeHtml(name)} <button class="active-chip-x" data-name="${escapeAttr(name)}" aria-label="Remove">×</button></span>`
    ).join('');
    introEl.innerHTML = `
      Cooking with: ${chipsHtml}
      <button class="link-btn" id="clearCookWithBtn" style="margin-left:8px">Clear</button>
    `;
    introEl.querySelectorAll('.active-chip-x').forEach(btn => {
      btn.addEventListener('click', () => {
        cookWithSelection = cookWithSelection.filter(n => n !== btn.dataset.name);
        renderMakeResults();
      });
    });
    const clearBtn = document.getElementById('clearCookWithBtn');
    if (clearBtn) clearBtn.addEventListener('click', () => {
      cookWithSelection = [];
      renderMakeResults();
    });
  } else {
    introEl.textContent = 'Recipes ranked by what you have on hand.';
  }

  // Build dynamic tabs based on what's actually achievable
  const buckets = { 'have-all': 0, 'missing-1': 0, 'missing-2': 0, 'missing-3': 0, 'missing-4': 0, 'missing-more': 0 };
  for (const s of scored) {
    const m = s.missing.length;
    if (m === 0) buckets['have-all']++;
    else if (m === 1) buckets['missing-1']++;
    else if (m === 2) buckets['missing-2']++;
    else if (m === 3) buckets['missing-3']++;
    else if (m === 4) buckets['missing-4']++;
    else buckets['missing-more']++;
  }

  const tabDefs = [
    { key: 'have-all', label: `Ready to cook (${buckets['have-all']})` },
    { key: 'missing-1', label: `Missing 1 (${buckets['missing-1']})` },
    { key: 'missing-2', label: `Missing 2 (${buckets['missing-2']})` },
    { key: 'missing-3', label: `Missing 3 (${buckets['missing-3']})` },
    { key: 'missing-4', label: `Missing 4 (${buckets['missing-4']})` },
    { key: 'missing-more', label: `Missing 5+ (${buckets['missing-more']})` }
  ];
  tabsEl.innerHTML = tabDefs.map(t =>
    `<button class="make-tab ${t.key === makeFilter ? 'active' : ''}" data-key="${t.key}">${escapeHtml(t.label)}</button>`
  ).join('');
  tabsEl.querySelectorAll('.make-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      makeFilter = btn.dataset.key;
      renderMakeResults();
    });
  });

  // Filter to current bucket
  let filtered = scored.filter(s => {
    const m = s.missing.length;
    if (makeFilter === 'have-all') return m === 0;
    if (makeFilter === 'missing-1') return m === 1;
    if (makeFilter === 'missing-2') return m === 2;
    if (makeFilter === 'missing-3') return m === 3;
    if (makeFilter === 'missing-4') return m === 4;
    if (makeFilter === 'missing-more') return m >= 5;
    return true;
  });
  // Sort by have-ratio descending, then missing count ascending
  filtered.sort((a, b) => {
    const ra = a.have / a.total;
    const rb = b.have / b.total;
    if (rb !== ra) return rb - ra;
    return a.missing.length - b.missing.length;
  });

  if (!filtered.length) {
    resultsEl.innerHTML = `
      <div class="empty-state">
        <p>Nothing in this bucket.</p>
        <p class="muted">Try a different "missing" tab, or add more items to your kitchen.</p>
      </div>
    ` + webSearchFooterHtml();
    wireWebSearchFooter(resultsEl);
    return;
  }

  resultsEl.innerHTML = filtered.map(s => {
    const r = s.recipe;
    const thumbStyle = r.image ? `style="background-image:url('${escapeAttr(r.image)}')"` : '';
    const missingLine = s.missing.length === 0
      ? `<div class="make-ratio">✓ Have all ${s.total} ingredients</div>`
      : `<div class="make-missing">Missing: <strong>${s.missing.slice(0, 3).map(escapeHtml).join(', ')}${s.missing.length > 3 ? `, +${s.missing.length - 3} more` : ''}</strong></div>`;
    return `
      <div class="make-recipe" data-id="${r.id}">
        <div class="make-thumb" ${thumbStyle}></div>
        <div class="make-info">
          <h3 class="make-info-title">${escapeHtml(r.title)}</h3>
          <div class="make-info-meta">${s.have}/${s.total} ingredients on hand</div>
          ${missingLine}
        </div>
      </div>
    `;
  }).join('') + webSearchFooterHtml();

  resultsEl.querySelectorAll('.make-recipe').forEach(el => {
    el.addEventListener('click', () => {
      makeModal.classList.remove('open');
      openRecipe(el.dataset.id);
    });
  });
  wireWebSearchFooter(resultsEl);
}

// Build a "search the web" footer based on the current selection (or the
// kitchen contents if no selection). Opens Google in a new tab.
function webSearchFooterHtml() {
  const terms = cookWithSelection.length
    ? cookWithSelection
    : state.pantry.filter(p => !p.used).slice(0, 6).map(p => p.name);
  if (!terms.length) return '';
  const query = 'recipe with ' + terms.join(', ');
  const gUrl = 'https://www.google.com/search?q=' + encodeURIComponent(query);
  const ymUrl = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query);
  const allUrl = 'https://www.allrecipes.com/search?q=' + encodeURIComponent(terms.join(' '));
  return `
    <div class="web-search-footer">
      <h4>Nothing here? Search the web</h4>
      <p class="muted">Look beyond your library for ideas using ${escapeHtml(terms.slice(0,4).join(', '))}${terms.length > 4 ? '…' : ''}</p>
      <div class="web-search-buttons">
        <a class="web-search-btn" href="${gUrl}" target="_blank" rel="noopener noreferrer">Google</a>
        <a class="web-search-btn" href="${ymUrl}" target="_blank" rel="noopener noreferrer">YouTube</a>
        <a class="web-search-btn" href="${allUrl}" target="_blank" rel="noopener noreferrer">AllRecipes</a>
      </div>
    </div>
  `;
}
function wireWebSearchFooter(_root) {
  // Links use target="_blank" so the click handler is just the browser default.
  // Placeholder in case we want to add tracking or in-app browsing later.
}

/* =====================================================
   IMPORT / EXPORT
   ===================================================== */
const ioModal = document.getElementById('ioModal');
document.getElementById('btnImportExport').addEventListener('click', () => ioModal.classList.add('open'));
document.getElementById('ioClose').addEventListener('click', () => ioModal.classList.remove('open'));
ioModal.addEventListener('click', (e) => { if (e.target === ioModal) ioModal.classList.remove('open'); });

document.getElementById('exportBtn').addEventListener('click', () => {
  const data = {
    version: 1,
    exportedAt: new Date().toISOString(),
    recipes: state.recipes,
    pantry: state.pantry,
    shopping: state.shopping
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const date = new Date().toISOString().slice(0,10);
  a.download = `citrus-spice-backup-${date}.json`;
  a.click();
  URL.revokeObjectURL(url);
  document.getElementById('ioNote').textContent = 'Exported ✓';
});

document.getElementById('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  try {
    const data = JSON.parse(text);
    if (!data.recipes && !data.pantry && !data.shopping) throw new Error('Not a valid backup file');
    const replace = confirm('Replace existing data with the backup? Click OK to replace, Cancel to merge.');
    if (replace) {
      await dbClear('recipes');
      await dbClear('pantry');
      await dbClear('shopping');
      state.recipes = [];
      state.pantry = [];
      state.shopping = [];
    }
    for (const r of (data.recipes||[])) {
      const item = { ...r, id: r.id || uid() };
      await dbPut('recipes', item);
      if (!state.recipes.find(x => x.id === item.id)) state.recipes.push(item);
    }
    for (const p of (data.pantry||[])) {
      const item = { ...p, id: p.id || uid() };
      await dbPut('pantry', item);
      if (!state.pantry.find(x => x.id === item.id)) state.pantry.push(item);
    }
    for (const s of (data.shopping||[])) {
      const item = { ...s, id: s.id || uid() };
      await dbPut('shopping', item);
      if (!state.shopping.find(x => x.id === item.id)) state.shopping.push(item);
    }
    document.getElementById('ioNote').textContent = `Imported ${data.recipes?.length||0} recipes, ${data.pantry?.length||0} pantry items, ${data.shopping?.length||0} shopping items.`;
    renderLibrary();
    renderRotation();
    renderPantry();
    renderShopping();
  } catch (err) {
    document.getElementById('ioNote').textContent = 'Could not read that file: ' + err.message;
  } finally {
    e.target.value = '';
  }
});

/* =====================================================
   HELPERS
   ===================================================== */
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

/* =====================================================
   BACK TO TOP
   ===================================================== */
const backToTopBtn = document.getElementById('backToTopBtn');
let scrollTickPending = false;
function updateBackToTop() {
  scrollTickPending = false;
  if (window.scrollY > 400) {
    backToTopBtn.classList.add('show');
  } else {
    backToTopBtn.classList.remove('show');
  }
}
window.addEventListener('scroll', () => {
  if (!scrollTickPending) {
    scrollTickPending = true;
    requestAnimationFrame(updateBackToTop);
  }
}, { passive: true });
backToTopBtn.addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

/* =====================================================
   INIT
   ===================================================== */
async function init() {
  try {
    await openDB();
    state.recipes = await dbGetAll('recipes');
    state.pantry = await dbGetAll('pantry');
    state.shopping = await dbGetAll('shopping');
    renderLibrary();
    renderRotation();
    renderPantry();
    renderShopping();
  } catch (e) {
    console.error('DB init failed', e);
    toast('Could not open database');
  }
}
init();
