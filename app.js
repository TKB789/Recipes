/* =====================================================
   SpicyCitrus Recipe App
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
  groupBy: 'cuisine'
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

function renderLibrary() {
  const container = document.getElementById('libraryContainer');
  const empty = document.getElementById('libraryEmpty');
  let recipes = state.recipes.slice();
  if (state.searchTerm) {
    const q = state.searchTerm.toLowerCase();
    recipes = recipes.filter(r =>
      r.title.toLowerCase().includes(q) ||
      (r.cuisine||'').toLowerCase().includes(q) ||
      (r.mainIngredient||'').toLowerCase().includes(q)
    );
  }
  if (!recipes.length) {
    container.innerHTML = '';
    empty.style.display = 'block';
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
      groups[key] = groups[key] || [];
      groups[key].push(r);
    }
    const sortedKeys = Object.keys(groups).sort((a,b) => {
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
  const ingredientsList = (r.ingredients||[]).map(i => `<li>${escapeHtml(i)}</li>`).join('') || '<li class="muted">None listed</li>';
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
      <ul>${ingredientsList}</ul>
      ${(r.ingredients||[]).length ? '<button class="add-ingredients-btn" id="addAllToShopping">+ Add all to shopping list</button>' : ''}
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

    // Label
    ctx.save();
    ctx.rotate(start + slice/2);
    ctx.fillStyle = '#fbf7f0';
    ctx.font = '700 15px Inter, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    // Text shadow for legibility
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 4;
    const maxChars = inRot.length > 8 ? 14 : 22;
    const txt = r.title.length > maxChars ? r.title.slice(0, maxChars - 1) + '…' : r.title;
    ctx.fillText(txt, R - 16, 0);
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
      const winner = inRot[targetIdx];
      lastWinnerId = winner.id;
      showWinner(winner);
    }
  }
  requestAnimationFrame(animate);
});

function showWinner(winner) {
  // Build the tappable result card
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

  // Highlight the winner card in the rotation grid and scroll to it
  const card = document.querySelector(`#rotationGrid .recipe-card[data-id="${winner.id}"]`);
  if (card) {
    card.classList.add('winner');
    // Smooth-scroll the card into view, leaving a little headroom for the sticky tabs.
    setTimeout(() => {
      const rect = card.getBoundingClientRect();
      const top = window.scrollY + rect.top - 140;
      window.scrollTo({ top, behavior: 'smooth' });
    }, 250);
  }
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
  await dbPut('pantry', item);
  state.pantry.push(item);
  document.getElementById('pantryInput').value = '';
  renderPantry();
}

function renderPantry() {
  const lists = {
    fridge: document.getElementById('fridgeList'),
    pantry: document.getElementById('pantryList'),
    freezer: document.getElementById('freezerList')
  };
  Object.values(lists).forEach(l => l.innerHTML = '');
  for (const item of state.pantry) {
    const li = document.createElement('li');
    li.className = 'pantry-item' + (item.used ? ' used' : '');
    li.innerHTML = `
      <input type="checkbox" ${item.used?'checked':''}>
      <span class="item-name">${escapeHtml(item.name)}</span>
      <div class="item-actions">
        <button class="mini-btn">+ Shop</button>
        <button class="mini-btn danger">×</button>
      </div>
    `;
    const [cb, _, actions] = li.children;
    cb.addEventListener('change', async () => {
      item.used = cb.checked;
      await dbPut('pantry', item);
      renderPantry();
    });
    actions.children[0].addEventListener('click', async () => {
      const shop = { id: uid(), name: item.name, checked: false, createdAt: Date.now() };
      await dbPut('shopping', shop);
      state.shopping.push(shop);
      toast('Added to shopping list');
      renderShopping();
    });
    actions.children[1].addEventListener('click', async () => {
      await dbDelete('pantry', item.id);
      state.pantry = state.pantry.filter(x => x.id !== item.id);
      renderPantry();
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
    const li = document.createElement('li');
    li.className = 'shopping-item' + (item.checked ? ' checked' : '');
    li.innerHTML = `
      <input type="checkbox" ${item.checked?'checked':''}>
      <span class="item-name">${escapeHtml(item.name)}</span>
      <div class="item-actions">
        <button class="mini-btn danger">×</button>
      </div>
    `;
    const [cb, _, actions] = li.children;
    cb.addEventListener('change', async () => {
      item.checked = cb.checked;
      await dbPut('shopping', item);
      li.classList.toggle('checked', item.checked);
    });
    actions.children[0].addEventListener('click', async () => {
      await dbDelete('shopping', item.id);
      state.shopping = state.shopping.filter(x => x.id !== item.id);
      renderShopping();
    });
    list.appendChild(li);
  }
}

document.getElementById('clearCheckedBtn').addEventListener('click', async () => {
  const toRemove = state.shopping.filter(s => s.checked);
  for (const item of toRemove) await dbDelete('shopping', item.id);
  state.shopping = state.shopping.filter(s => !s.checked);
  renderShopping();
  toast(`Cleared ${toRemove.length} items`);
});

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
  a.download = `spicycitrus-backup-${date}.json`;
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
