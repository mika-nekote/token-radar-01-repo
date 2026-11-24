// Launch Radar dashboard. Reads window.RADAR (written beside dashboard/ by main.ts) and renders
// the ranked pre-token board, an already-trading view, the fitted model with its evidence, and a
// detail drawer per protocol with the full multiplier breakdown and farm plan. No network: every
// byte on the page comes from data.js, and the drawer recomputes each row's implied value from
// the printed multipliers to prove the page and board.json run the same arithmetic.
(function () {
  'use strict';
  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var CAL = DATA.calibration;
  var state = { q: '', category: 'all', chain: 'all', wl: false, tab: 'board', sort: 'implied', dir: -1, selected: null };

  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.round(days) + 'd';
  }
  // The model in one function: the same rounded multipliers the board was built from, so this
  // recomputation lands on the board's number. mult = [category, scale, momentum, seasoning, breadth].
  function impliedOf(r) {
    var raw = r.mult[0] * r.tvl_usd * r.mult[1] * r.mult[2] * r.mult[3] * r.mult[4];
    return Math.max(1, Math.round(Math.min(raw, r.ceiling_usd)));
  }
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) node.appendChild(x); });
      else if (typeof c === 'string') node.appendChild(document.createTextNode(c));
      else node.appendChild(c);
    }
    return node;
  }

  function readHash() {
    var params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    if (params.get('q')) state.q = params.get('q');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('wl') === '1') state.wl = true;
    if (params.get('p')) state.selected = params.get('p');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.wl) params.set('wl', '1');
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    window.history.replaceState(null, '', next ? '#' + next : window.location.pathname + window.location.search);
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.wl && !r.watchlist) return false;
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (!q) return true;
      return [r.name, r.slug, r.category || '', (r.chains || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }
  function sorted(list) {
    var key = state.sort, dir = state.dir;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'share') { av = a.launch_share; bv = b.launch_share; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return a.slug < b.slug ? -1 : 1;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'ring' }),
        el('span', { class: 'brand-name' }, 'Launch ', el('b', { text: 'Radar' }))),
      el('div', { class: 'top-meta' },
        el('span', null, 'Snapshot ', el('b', { text: DATA.as_of })),
        el('span', null, 'Model ', el('b', { text: DATA.model_version })),
        el('span', null, 'Source ', el('b', { text: 'DefiLlama protocol index' }))));
  }
  function hero() {
    return el('section', { class: 'hero' },
      el('div', null,
        el('h1', { text: 'Which tokenless protocol is worth farming next?' }),
        el('p', null,
          'Every protocol here records no token yet. Each is priced by what its token would be worth if it launched at the value its already-trading peers actually hold: ',
          el('b', { text: 'TVL x a category multiple fitted from ' + CAL.size + ' tokenised protocols' }),
          ', adjusted for scale, market-relative momentum, time without a token and chain breadth. The watchlist of ' + DATA.watchlist_size + ' is the floor, not the ceiling: the radar adds ' + DATA.early_size + ' early protocols below the $' + Math.round(DATA.floor_usd / 1e6) + 'M line. Implied value is a model claim, never a promise.')),
      el('div', { class: 'stats' },
        el('div', { class: 'stat hot' }, el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size }), el('span', { text: 'watchlist protocols covered' })),
        el('div', { class: 'stat' }, el('b', { text: String(DATA.board_size) }), el('span', { text: 'pre-token rows ranked' })),
        el('div', { class: 'stat' }, el('b', { text: String(CAL.size) }), el('span', { text: 'tokenised peers fitted' })),
        el('div', { class: 'stat' }, el('b', { text: fmtPct(CAL.market_change_7d) }), el('span', { text: 'median 7d TVL move, all protocols' }))));
  }
  function modelStrip() {
    var s = function (n, title, body) {
      return el('div', { class: 'step6' }, el('b', null, el('i', { text: n }), title), el('p', { text: body }));
    };
    return el('section', { class: 'model' },
      el('div', { class: 'model-head' },
        el('h2', { text: 'How implied value is computed' }),
        el('span', { class: 'sub', text: 'One function of the snapshot figures scores every row. No protocol name is special-cased.' })),
      el('div', { class: 'formula', text: 'implied = TVL x category multiple x scale x momentum x seasoning x breadth, capped at the family ceiling' }),
      el('div', { class: 'steps6' },
        s('1', 'Category multiple', 'Median mcap/TVL of the category\u2019s tokenised peers, winsorised to [0.01, 4] and shrunk toward the global ' + CAL.global_multiple.toFixed(2) + 'x by an evidence weight w (n and w printed in the table below).'),
        s('2', 'Scale', 'A Theil\u2013Sen fit of ln(mcap) on ln(TVL) gives slope ' + CAL.scale_slope.toFixed(2) + ': value grows slower than TVL, so giants are discounted against the $' + Math.round(CAL.tvl_ref / 1e6) + 'M reference size.'),
        s('3', 'Momentum', 'Seven-day change is measured against the market\u2019s own median (' + fmtPct(CAL.market_change_7d) + ' this week) and saturates: no week moves a row more than about \u00b125%.'),
        s('4', 'Seasoning', 'Value peaks for protocols 1.5\u20132.5 years old with no token: old enough to have proven their TVL, young enough that a launch is still likely. Unknown listing dates score neutral.'),
        s('5', 'Breadth', 'Up to +18% for multi-chain reach, since a launch distributes to every chain\u2019s users. Breadth never outweighs the base value.'),
        s('6', 'Ceiling', 'No claim may exceed the largest market cap its family (bridge, yield, staking, core) has actually produced. A guardrail, not a target.')));
  }
  function controls() {
    var cats = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (a, r) { return a.concat(r.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var catSel = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      cats.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); }));
    catSel.addEventListener('change', function () { state.category = catSel.value; writeHash(); render(); });
    var chainSel = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); }));
    chainSel.addEventListener('change', function () { state.chain = chainSel.value; writeHash(); render(); });
    var wlBox = el('input', { type: 'checkbox', id: 'wl', checked: state.wl ? 'checked' : null });
    wlBox.addEventListener('change', function () { state.wl = wlBox.checked; writeHash(); render(); });
    var boardBtn = el('button', { type: 'button', 'aria-pressed': state.tab === 'board' ? 'true' : 'false', text: 'Pre-token board', onclick: function () { state.tab = 'board'; render(); } });
    var liveBtn = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Already trading', onclick: function () { state.tab = 'live'; render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), catSel),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSel),
      el('label', { class: 'check' }, wlBox, 'Watchlist only'),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'View' }), el('div', { class: 'tabs' }, boardBtn, liveBtn)),
      el('span', { class: 'count', text: state.tab === 'board' ? filtered().length + ' of ' + DATA.board_size + ' rows shown' : DATA.live.length + ' largest trading protocols' }));
  }
  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () {
        if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; }
        render();
      } }, label, state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' \u25bc' : ' \u25b2' }) : null));
  }
  function boardTable() {
    var list = sorted(filtered());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or widen the filters to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () {
          state.q = ''; state.category = 'all'; state.chain = 'all'; state.wl = false; writeHash(); render();
        } })));
    }
    var max = Math.max.apply(null, list.map(function (r) { return r.implied_value_usd; }));
    var tbody = el('tbody');
    list.forEach(function (r) {
      var tr = el('tr', { 'data-selected': state.selected === r.slug ? 'true' : 'false', tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } } },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', null, r.name, r.watchlist ? el('span', { class: 'badge', text: 'WATCHLIST' }) : null),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' \u00b7 ' + (r.chains && r.chains.length ? r.chains.slice(0, 3).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') : 'chain n/a') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d === null ? '' : r.change_7d >= CAL.market_change_7d ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: Math.round(r.launch_share * 100) + '%' }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) }))),
        el('td', null, el('span', { class: 'dot', text: 'no token' })));
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' }, el('div', { class: 'table-wrap' },
      el('table', null,
        el('caption', { text: 'Pre-token protocols by implied launch value. Launch share is how normal a launch is in the category: the smoothed fraction of its protocols that already trade. Select any row for its model breakdown and farm plan.' }),
        el('thead', null, el('tr', null,
          sortHeader('implied', 'Rank'), sortHeader('name', 'Protocol'), sortHeader('tvl', 'TVL'),
          sortHeader('growth', '7d'), sortHeader('age', 'Age'), sortHeader('share', 'Launch share'),
          sortHeader('implied', 'Implied value'), el('th', { scope: 'col', text: 'Token' }))),
        tbody)));
  }
  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: '\u2014' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' \u00b7 ' + (r.chains && r.chains.length ? r.chains.slice(0, 3).join(', ') : 'chain n/a') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: r.ratio.toFixed(2) + 'x' }),
        el('td', null, el('span', { class: 'dot live', text: 'trading' }))));
    });
    return el('div', { class: 'panel' }, el('div', { class: 'table-wrap' },
      el('table', null,
        el('caption', { text: 'Already trading: these protocols have a token, so their market cap is a market fact, not a model output. They are never ranked on the board; their mcap/TVL ratios are the evidence the category multiples are fitted from.' }),
        el('thead', null, el('tr', null,
          el('th', { scope: 'col', text: 'Rank' }), el('th', { scope: 'col', text: 'Protocol' }),
          el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }),
          el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'mcap/TVL' }),
          el('th', { scope: 'col', text: 'Token' }))),
        tbody)));
  }
  function catsTable() {
    var fits = DATA.categories.filter(function (c) { return c.n >= 1; })
      .sort(function (a, b) { return b.multiple - a.multiple; });
    var tbody = el('tbody');
    fits.forEach(function (c) {
      tbody.appendChild(el('tr', null,
        el('td', { text: c.category }),
        el('td', { class: 'num', text: String(c.n) }),
        el('td', { class: 'num', text: c.median_ratio.toFixed(2) + 'x' }),
        el('td', { class: 'num', text: c.weight.toFixed(2) }),
        el('td', { class: 'num', text: c.multiple.toFixed(2) + 'x' }),
        el('td', { class: 'num', text: Math.round(c.launch_share * 100) + '%' })));
    });
    var unseen = DATA.categories.filter(function (c) { return c.n === 0; }).length;
    return el('section', { class: 'panel cats' },
      el('h2', { text: 'The evidence: category multiples' }),
      el('p', { class: 'sub', text: 'Fitted from the ' + CAL.size + ' tokenised protocols in this snapshot alone. Weight w is how far the category\u2019s own median is trusted against the global ' + CAL.global_multiple.toFixed(2) + 'x; a category with one observation gets at most a third of the voice.' + (unseen > 0 ? ' ' + unseen + ' categories have no tokenised peer in the snapshot and score at the global multiple.' : '') }),
      el('div', { class: 'table-wrap' }, el('table', null,
        el('thead', null, el('tr', null,
          el('th', { scope: 'col', text: 'Category' }), el('th', { scope: 'col', text: 'Peers n' }),
          el('th', { scope: 'col', text: 'Median mcap/TVL' }), el('th', { scope: 'col', text: 'Weight w' }),
          el('th', { scope: 'col', text: 'Multiple used' }), el('th', { scope: 'col', text: 'Launch share' }))),
        tbody)));
  }
  function foot() {
    return el('footer', { class: 'foot' },
      el('p', { text: 'Snapshot: ' + DATA.source + '. A protocol \u201crecords no token\u201d on DefiLlama\u2019s record; that is not proof it has none, and implied value is this board\u2019s own model claim, not a price prediction.' }),
      el('p', { text: 'Farm plans are generated per protocol from its category, chains, TVL tier and age. Nothing here is financial advice; verify every step on the protocol\u2019s own page before committing capital.' }));
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); render(); });
  function multRow(label, value, lo, hi) {
    var pct = Math.max(3, Math.min(100, ((value - lo) / (hi - lo)) * 100));
    return el('div', { class: 'mult-row' },
      el('span', { text: label }),
      el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + pct + '%' })),
      el('b', { class: 'num', text: value.toFixed(2) + 'x' }));
  }
  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'kicker', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + (row.watchlist ? ' \u00b7 watchlist' : ' \u00b7 early, below the floor') }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' \u00b7 ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'chain n/a') })),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Snapshot record' }),
      el('div', { class: 'kv' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Seven-day change' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
        el('div', null, el('span', { text: 'Market median that week' }), el('b', { class: 'num', text: fmtPct(CAL.market_change_7d) })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: row.age_days === null ? 'not reported' : fmtAge(row.age_days) + ' (' + row.age_days + ' days)' })),
        el('div', null, el('span', { text: 'Chains' }), el('b', { class: 'num', text: String((row.chains || []).length) })),
        el('div', null, el('span', { text: 'Launch share in category' }), el('b', { class: 'num', text: Math.round(row.launch_share * 100) + '%' })))));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value breakdown' }),
      multRow('Category', row.mult[0], 0, 2),
      multRow('Scale', row.mult[1], 0, 1.2),
      multRow('Momentum', row.mult[2], 0.7, 1.3),
      multRow('Seasoning', row.mult[3], 0.8, 1.2),
      multRow('Breadth', row.mult[4], 1, 1.18),
      el('div', { class: 'total' }, el('span', { text: 'Implied value' }), el('b', { text: fmtUsd(row.implied_value_usd) })),
      el('p', { class: 'check-note', text: 'This page recomputes the row from the multipliers above: ' + fmtUsd(impliedOf(row)) + (impliedOf(row) === row.implied_value_usd ? ', the same number board.json carries.' : ', within rounding of the board figure.') + (row.capped ? ' The family ceiling binds on this row.' : '') })));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, row.farm_steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))));
    if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
    else dialog.setAttribute('open', '');
    renderRowsOnly();
  }
  function renderRowsOnly() {
    var rows = app.querySelectorAll('tbody tr');
    rows.forEach(function (tr) { /* selection is reapplied on full render */ });
  }
  function render() {
    var keepDialog = state.selected;
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(hero());
    shell.appendChild(modelStrip());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'board' ? boardTable() : liveTable());
    if (state.tab === 'board') shell.appendChild(catsTable());
    shell.appendChild(foot());
    app.appendChild(shell);
    app.appendChild(dialog);
    app.setAttribute('aria-busy', 'false');
    if (keepDialog && !dialog.open) openDetail(keepDialog);
  }
  readHash();
  render();
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && dialog.open) dialog.close(); });
})();
