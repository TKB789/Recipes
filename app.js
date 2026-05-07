/* =====================================================
   Saffron Recipe App
   ===================================================== */

// ----- IndexedDB Wrapper -----
const DB_NAME = 'saffron_db';
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
document.getElementById('manualToggle').addEventListener('click', () => {
  const f = document.getElementById('manualForm');
  f.style.display = f.style.display === 'none' ? 'flex' : 'none';
});

document.getElementById('saveManualBtn').addEventListener('click', async () => {
  const title = document.getElementById('mTitle').value.trim();
  if (!title) { toast('Please enter a title'); return; }
  const recipe = {
    id: uid(),
    title,
    image: document.getElementById('mImage').value.trim(),
    cuisine: document.getElementById('mCuisine').value.trim() || 'Other',
    mainIngredient: document.getElementById('mMain').value.trim() || 'Other',
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
  ['mTitle','mImage','mCuisine','mMain','mTime','mYield','mIngredients','mInstructions','mUrl']
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
      </div>
    </article>
  `;
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
    grid.querySelectorAll('.recipe-card').forEach(c => {
      c.addEventListener('click', () => openRecipe(c.dataset.id));
    });
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
  container.querySelectorAll('.recipe-card').forEach(c => {
    c.addEventListener('click', () => openRecipe(c.dataset.id));
  });
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

function openRecipe(id) {
  const r = state.recipes.find(x => x.id === id);
  if (!r) return;
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
  modal.classList.add('open');

  document.getElementById('toggleRotation').addEventListener('click', async () => {
    r.inRotation = !r.inRotation;
    await dbPut('recipes', r);
    openRecipe(id);
    renderRotation();
    renderLibrary();
    toast(r.inRotation ? 'Added to rotation' : 'Removed from rotation');
  });
  document.getElementById('toggleMade').addEventListener('click', async () => {
    r.made = !r.made;
    await dbPut('recipes', r);
    openRecipe(id);
    renderLibrary();
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

/* =====================================================
   WHEEL
   ===================================================== */
const COLORS = ['#c5573b','#d99a3d','#6b7148','#9d3f29','#a8763a','#3d6661','#b54a3c','#8b6f3f'];
let wheelAngle = 0;
let spinning = false;

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
    ctx.beginPath();
    ctx.moveTo(0,0);
    ctx.arc(0, 0, R, start, start + slice);
    ctx.closePath();
    ctx.fillStyle = COLORS[i % COLORS.length];
    ctx.fill();
    ctx.strokeStyle = '#fbf7f0';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Label
    ctx.save();
    ctx.rotate(start + slice/2);
    ctx.fillStyle = '#fbf7f0';
    ctx.font = '600 16px Inter, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const txt = r.title.length > 22 ? r.title.slice(0,20) + '…' : r.title;
    ctx.fillText(txt, R - 16, 0);
    ctx.restore();
  });
  ctx.restore();

  // Center hub
  ctx.beginPath();
  ctx.arc(cx, cy, 28, 0, Math.PI*2);
  ctx.fillStyle = '#fbf7f0';
  ctx.fill();
  ctx.strokeStyle = '#1c1814';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#c5573b';
  ctx.font = '20px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('✺', cx, cy);
}

document.getElementById('spinBtn').addEventListener('click', () => {
  if (spinning) return;
  const inRot = state.recipes.filter(r => r.inRotation);
  if (!inRot.length) { toast('Add recipes to rotation first'); return; }
  spinning = true;
  document.getElementById('wheelResult').textContent = '';
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
    wheelAngle = wheelAngle % (Math.PI*2);
    drawWheel();
    if (t < 1) requestAnimationFrame(animate);
    else {
      spinning = false;
      const winner = inRot[targetIdx];
      document.getElementById('wheelResult').textContent = `Tonight: ${winner.title}`;
    }
  }
  requestAnimationFrame(animate);
});

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
  a.download = `saffron-backup-${date}.json`;
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
