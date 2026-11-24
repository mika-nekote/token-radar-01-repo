// Launch Radar model: one sealed DefiLlama snapshot in, one ranked board out.
//
// The question the board answers: if a protocol that records no token today launched one at the
// value its already-tokenised peers actually trade at, what would that launch be worth, and what
// should a farmer do about it before it happens? Every number below is derived from the snapshot
// itself at run time. No protocol name is ever special-cased, and nothing is read from the clock,
// the network or a random source, so two runs over the same snapshot write the same bytes.
//
// The model, in the order it is applied to each pre-token protocol:
//
//   1. Category multiple. Protocols that already trade give, per category, a sample of
//      mcap / TVL ratios. Ratios are heavy-tailed, so each ratio is first winsorised to
//      [0.01, 4] (one micro-cap cannot set a whole category's price) and the estimate is made
//      in log space: each category's median log-ratio is shrunk toward the global median
//      log-ratio with an empirical-Bayes weight w = tau^2 / (tau^2 + (pi/2) * sigma^2 / n),
//      where sigma^2 is the pooled within-category variance of log-ratios and tau^2 the
//      between-category variance of the category medians, and w is further capped at
//      n / (n + 2) so a category with a single observation never speaks with more than a
//      third of the voice. The dashboard prints w and n per category, so a reader can see
//      how much evidence each multiple rests on.
//   2. Scale. A Theil-Sen fit of ln(mcap) on ln(TVL) over the same calibration set gives a slope
//      b (clamped to the sane band [0.75, 1.05]). The base value is
//      multiple * TVL_ref^(1-b) * TVL^b, with TVL_ref the calibration set's median TVL: when
//      b < 1, size is worth less than one-for-one, which keeps multi-billion tokenless giants
//      from printing absurd launch values.
//   3. Momentum. Seven-day TVL change is mostly market beta (the snapshot week's median change
//      is printed on the dashboard), so growth is measured as the excess over that median and
//      passed through a saturating curve: exp(0.22 * tanh(excess / 25)), a multiplier inside
//      [0.80, 1.25]. A one-week spike cannot dominate a ranking. Unreported change scores 1.0.
//   4. Seasoning. Value follows a hump over the protocol's age with no token: 0.85 at listing,
//      rising to 1.15 at 540 days, flat to 900 days, then easing to 0.90 by 1825 days. Old enough
//      to have proven the TVL, young enough that a launch is still a live possibility. An
//      unreported listing date scores a neutral 1.0 and is flagged, never imputed.
//   5. Breadth. 1 + min(0.18, 0.045 * log2(chain count)): a protocol live on many chains has
//      more users a launch would be distributed to, but breadth never outweighs the base.
//   6. Ceiling. The result is capped at the largest tokenised market cap in the protocol's
//      family (bridge / yield / staking / core), falling back to the global largest: no launch
//      claim may exceed the biggest launch its corner of the market has actually produced.
//      It is a guardrail against absurd prints, not a target, and it rarely binds.
//
// Alongside the value, each category carries a launch share: (tokenised + 1) / (all + 2), the
// Laplace-smoothed fraction of that category's protocols that already trade. It never ranks
// anything; it tells the reader how normal a launch is in that corner of the market.
//
// Board membership: every watchlist slug (the floor), plus the strongest remaining protocols
// that pass the watchlist's own hygiene below the floor - records no token, not an exchange,
// not a versioned pool of another protocol, not a wrapped / staked / bridged product, and not a
// sibling whose name-stem already trades. Tokenised protocols are never ranked; the dashboard
// shows the largest of them separately, at the market's own values.

/** One protocol of the snapshot: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's version label, printed on the dashboard. */
export const MODEL_VERSION = 'launch-radar-2';

/** Board size: the watchlist plus the strongest hygienic pre-token protocols below the floor. */
export const BOARD_ROWS = 200;

/** How many tokenised protocols the dashboard's already-trading view carries, by market cap. */
export const LIVE_ROWS = 24;

/** Why the snapshot cannot be scored. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Whole days from `listedAt` to the snapshot's `asOf`, clamped at zero; null when unreported. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list, computed on a sorted copy so callers keep their order. */
function median(values: number[]): number {
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** A percentile of a non-empty list by nearest rank on a sorted copy. */
function percentile(values: number[], q: number): number {
  const s = [...values].sort((x, y) => x - y);
  return s[clamp(Math.ceil(q * s.length) - 1, 0, s.length - 1)]!;
}

/** Coarse families, by category alone: they set the launch ceiling and the farm playbook's shape. */
export type Family = 'bridge' | 'yield' | 'staking' | 'core';

export function familyOf(category: string | null): Family {
  const c = (category ?? '').toLowerCase();
  if (c.includes('bridge')) return 'bridge';
  if (c.includes('staking') || c.includes('restak') || c === 'staking pool') return 'staking';
  if (
    c.includes('yield') || c.includes('curator') || c.includes('allocator') || c.includes('farm') ||
    c.includes('liquidity manager') || c.includes('basis trading')
  ) return 'yield';
  return 'core';
}

/** A protocol records no token when all three token fields are empty. */
export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whole-word wrapped / staked / staking in a name marks a product of a token that already trades. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Categories that are products of another protocol's token, per the watchlist's own rule. */
const PRODUCT_CATEGORIES = new Set([
  'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX',
]);

/** Exchange names a wrapped product may begin with, per the watchlist's own rule. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/**
 * Whether a pre-token protocol may join the board below the watchlist floor: the watchlist's
 * hygiene, minus the floor itself. `tradedStems` holds the name-stems of tokenised protocols, so
 * a tokenless sibling of a trading protocol is left out by a data rule, not by a name list.
 */
export function passesHygiene(p: SnapshotProtocol, tradedStems: Set<string>): boolean {
  if (!recordsNoToken(p)) return false;
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name) || WRAPPED_WORD.test(p.name) || EXCHANGE_PREFIX.test(p.name)) return false;
  const stem = p.slug.split('-')[0]!;
  if (tradedStems.has(stem) && !tradedStems.has(p.slug)) return false;
  return true;
}

/** One category's fitted multiple: the estimate, and the evidence behind it. */
export interface CategoryFit {
  category: string;
  n: number;
  median_ratio: number;
  weight: number;
  multiple: number;
  launch_share: number;
}

/** Everything the calibration set (the protocols that already trade) teaches the model. */
export interface Calibration {
  size: number;
  global_multiple: number;
  tvl_ref: number;
  scale_slope: number;
  market_change_7d: number;
  ceiling_global: number;
  ceiling_by_family: Record<Family, number>;
  categories: CategoryFit[];
}

/** The calibration set: tokenised, with a real market cap and at least $1M of TVL to score against. */
function calibrationRows(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd >= 1_000_000 && !recordsNoToken(p),
  );
}

/** Theil-Sen slope of ln(mcap) on ln(TVL): the median pairwise slope, robust to the heavy tail. */
function theilSenSlope(rows: SnapshotProtocol[]): number {
  const pts = rows.map((p) => ({ x: Math.log(p.tvl_usd), y: Math.log(p.mcap_usd!) }));
  const slopes: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j]!.x - pts[i]!.x;
      if (Math.abs(dx) > 1e-9) slopes.push((pts[j]!.y - pts[i]!.y) / dx);
    }
  }
  return slopes.length === 0 ? 1 : clamp(median(slopes), 0.75, 1.05);
}

/** A calibration ratio, winsorised so one micro-cap cannot set a whole category's price. */
const winsorRatio = (p: SnapshotProtocol): number => clamp(p.mcap_usd! / p.tvl_usd, 0.01, 4);

/** Fit the model to the snapshot's tokenised protocols. Pure arithmetic on the input: deterministic. */
export function calibrate(snapshot: Snapshot): Calibration {
  const rows = calibrationRows(snapshot);
  const logRatios = rows.map((p) => Math.log(winsorRatio(p)));
  const globalLog = median(logRatios);

  const byCategory = new Map<string, number[]>();
  for (const p of rows) {
    const key = p.category ?? 'Other';
    const list = byCategory.get(key) ?? [];
    list.push(Math.log(winsorRatio(p)));
    byCategory.set(key, list);
  }

  // Pooled within-category spread of log-ratios (MAD-based, rescaled to a standard deviation).
  const deviations: number[] = [];
  const medians = new Map<string, number>();
  for (const [cat, list] of byCategory) {
    const m = median(list);
    medians.set(cat, m);
    for (const v of list) deviations.push(Math.abs(v - m));
  }
  const sigma = 1.4826 * median(deviations);
  const sigma2 = Math.max(0.04, sigma * sigma);

  // Between-category variance of the medians, less what sampling noise alone would produce.
  const medianValues = [...medians.values()];
  const meanMedian = medianValues.reduce((a, b) => a + b, 0) / medianValues.length;
  const rawBetween = medianValues.reduce((a, m) => a + (m - meanMedian) * (m - meanMedian), 0) / medianValues.length;
  let noise = 0;
  for (const list of byCategory.values()) noise += (Math.PI / 2) * (sigma2 / list.length);
  noise /= byCategory.size;
  const tau2 = Math.max(0.05, rawBetween - noise);

  // Launch share per category counts every protocol in it, tokenised or not.
  const totals = new Map<string, { all: number; traded: number }>();
  for (const p of snapshot.protocols) {
    const key = p.category ?? 'Other';
    const t = totals.get(key) ?? { all: 0, traded: 0 };
    t.all += 1;
    if (!recordsNoToken(p)) t.traded += 1;
    totals.set(key, t);
  }

  const categories: CategoryFit[] = [];
  for (const cat of [...byCategory.keys()].sort()) {
    const list = byCategory.get(cat)!;
    const n = list.length;
    const weight = Math.min(tau2 / (tau2 + ((Math.PI / 2) * sigma2) / n), n / (n + 2));
    const multiple = clamp(Math.exp(weight * medians.get(cat)! + (1 - weight) * globalLog), 0.03, 2.0);
    const t = totals.get(cat) ?? { all: n, traded: n };
    categories.push({
      category: cat,
      n,
      median_ratio: round4(Math.exp(medians.get(cat)!)),
      weight: round4(weight),
      multiple: round4(multiple),
      launch_share: round4((t.traded + 1) / (t.all + 2)),
    });
  }
  // Categories with no calibration row still need a launch share for the dashboard's table.
  for (const cat of [...totals.keys()].sort()) {
    if (byCategory.has(cat)) continue;
    const t = totals.get(cat)!;
    categories.push({
      category: cat, n: 0, median_ratio: 0, weight: 0,
      multiple: round4(clamp(Math.exp(globalLog), 0.03, 2.0)),
      launch_share: round4((t.traded + 1) / (t.all + 2)),
    });
  }
  categories.sort((a, b) => (a.category < b.category ? -1 : 1));

  const ceilings = {} as Record<Family, number[]>;
  for (const fam of ['bridge', 'yield', 'staking', 'core'] as Family[]) ceilings[fam] = [];
  for (const p of rows) ceilings[familyOf(p.category)].push(p.mcap_usd!);
  const globalMax = Math.max(...rows.map((p) => p.mcap_usd!));
  const ceilingByFamily = {} as Record<Family, number>;
  for (const fam of ['bridge', 'yield', 'staking', 'core'] as Family[]) {
    ceilingByFamily[fam] = ceilings[fam].length >= 3 ? Math.max(...ceilings[fam]) : globalMax;
  }

  const changes = snapshot.protocols.map((p) => p.change_7d).filter((v): v is number => v !== null);
  return {
    size: rows.length,
    global_multiple: round4(clamp(Math.exp(globalLog), 0.03, 2.0)),
    tvl_ref: median(rows.map((p) => p.tvl_usd)),
    scale_slope: round4(theilSenSlope(rows)),
    market_change_7d: round4(median(changes)),
    ceiling_global: globalMax,
    ceiling_by_family: ceilingByFamily,
    categories,
  };
}

/** The fitted multiple and launch share a category scores with; unseen categories use the global fit. */
export function fitFor(cal: Calibration, category: string | null): CategoryFit {
  const key = category ?? 'Other';
  return cal.categories.find((c) => c.category === key) ?? {
    category: key, n: 0, median_ratio: 0, weight: 0,
    multiple: cal.global_multiple, launch_share: 0,
  };
}

/** The seasoning multiplier's hump: rises to 540 days, flat to 900, eases to 0.90 by 1825. */
export function seasoning(age: number | null): number {
  if (age === null) return 1;
  if (age <= 540) return 0.85 + (age / 540) * 0.3;
  if (age <= 900) return 1.15;
  if (age >= 1825) return 0.9;
  return 1.15 - ((age - 900) / 925) * 0.25;
}

/** One protocol's full scoring: every multiplier, so the dashboard can show the whole arithmetic. */
export interface Scoring {
  multiple: number;
  scale_multiplier: number;
  growth_multiplier: number;
  seasoning_multiplier: number;
  breadth_multiplier: number;
  ceiling_usd: number;
  capped: boolean;
  implied: number;
  age: number | null;
}

/** Score one pre-token protocol under a fitted calibration. */
export function scoreProtocol(p: SnapshotProtocol, asOf: string, cal: Calibration): Scoring {
  const fit = fitFor(cal, p.category);
  const b = cal.scale_slope;
  const scaleMult = Math.pow(cal.tvl_ref, 1 - b) * Math.pow(p.tvl_usd, b - 1);
  const excess = p.change_7d === null ? 0 : p.change_7d - cal.market_change_7d;
  const growthMult = p.change_7d === null ? 1 : Math.exp(0.22 * Math.tanh(excess / 25));
  const age = ageDays(asOf, p.listed_at);
  const seasonMult = seasoning(age);
  const breadthMult = 1 + Math.min(0.18, 0.045 * Math.log2(Math.max(1, p.chains.length)));
  const ceiling = cal.ceiling_by_family[familyOf(p.category)];
  // The board is computed from the same rounded multipliers the dashboard prints, so the page
  // can recompute any row from its own data and land on the board's number exactly.
  const rScale = round4(scaleMult);
  const rGrowth = round4(growthMult);
  const rSeason = round4(seasonMult);
  const rBreadth = round4(breadthMult);
  const raw = fit.multiple * p.tvl_usd * rScale * rGrowth * rSeason * rBreadth;
  const capped = raw > ceiling;
  return {
    multiple: fit.multiple,
    scale_multiplier: rScale,
    growth_multiplier: rGrowth,
    seasoning_multiplier: rSeason,
    breadth_multiplier: rBreadth,
    ceiling_usd: ceiling,
    capped,
    implied: Math.max(1, Math.round(Math.min(raw, ceiling))),
    age,
  };
}

/** Capital for one serious farm position, tiered by the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 5000;
  if (p.tvl_usd >= 250_000_000) return 2500;
  if (p.tvl_usd >= 50_000_000) return 1000;
  if (p.tvl_usd >= 10_000_000) return 500;
  return 250;
}

/** Typical per-transaction network cost on a chain, in dollars, as the snapshot names chains. */
function gasFor(chain: string): number {
  if (chain === 'Ethereum') return 9;
  if (chain === 'Bitcoin') return 2.5;
  if (chain === 'Tron') return 1;
  if (chain === 'Solana') return 0.05;
  if (chain === 'Binance' || chain === 'BNB Chain') return 0.6;
  return 0.4;
}

const money = (n: number): string => (n < 1 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`);

/** How long a position must be held to count across a full points season, from the protocol's age. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 75;
  if (age < 180) return 90;
  if (age < 540) return 75;
  if (age < 900) return 60;
  return 45;
}

/** The playbook group a category farms with, matched on the category's own words. */
function playbookOf(category: string | null): string {
  const c = (category ?? '').toLowerCase();
  if (c.includes('cdp')) return 'cdp';
  if (c.includes('lend')) return 'lending';
  if (c.includes('dex')) return 'dexs';
  if (c.includes('curator') || c.includes('allocator') || c.includes('liquidity manager')) return 'curator';
  if (c.includes('bridge')) return 'bridge';
  if (c.includes('staking') || c.includes('restak') || c === 'staking pool') return 'staking';
  if (c.includes('derivative') || c.includes('option')) return 'derivatives';
  if (c.includes('prediction')) return 'prediction';
  if (c.includes('basis')) return 'basis';
  if (c.includes('stable') || c.includes('algo-stables')) return 'stable';
  if (c.includes('rwa')) return 'rwa';
  if (c.includes('insurance')) return 'insurance';
  if (c.includes('payment') || c.includes('card')) return 'payments';
  if (c === 'chain') return 'chain';
  if (c.includes('yield') || c.includes('farm')) return 'yield';
  return 'core';
}

/** The three protocol-specific actions of a playbook, written for one protocol's record. */
function playbookActions(group: string, p: SnapshotProtocol, chain: string, cap: number): [string, string, string] {
  const n = p.name;
  const second = p.chains.length > 1 ? p.chains[1]! : chain;
  switch (group) {
    case 'lending': return [
      `Supply ${money(cap)} of USDC to ${n}'s deepest market on ${chain} and leave it supplied continuously, since lending points are time-weighted by balance-days.`,
      `Borrow against the position at no more than 35% loan-to-value and keep the health factor above 1.8, because borrow balances usually earn two to five times the supply weight.`,
      `Open a second, smaller supply market on ${second} inside ${n} so the wallet shows multi-market activity rather than one passive deposit.`,
    ];
    case 'cdp': return [
      `Deposit ${money(cap)} of collateral into ${n} on ${chain} and mint its stablecoin at a collateral ratio of at least 250 percent, well clear of liquidation.`,
      `Move the minted stablecoin into ${n}'s stability pool or savings module, the position these programs usually weight most heavily.`,
      `Set a liquidation alert and re-check the collateral ratio weekly, topping up collateral before adding any new debt.`,
    ];
    case 'dexs': return [
      `Provide ${money(cap)} of concentrated liquidity to ${n}'s core pair on ${chain} inside a plus-minus 5 percent range, and rebalance the range once a week.`,
      `Route your own swaps through ${n}'s own interface, never an aggregator, in at least eight separate weeks, because activity span beats raw volume in sybil filters.`,
      `Add a second smaller position on ${second} or in the main stable pair so fees accrue from two pools instead of one.`,
    ];
    case 'curator': return [
      `Read ${n}'s market allocations and idle liquidity first, then deposit ${money(cap)} into its main stablecoin vault on ${chain} only if exits are not gated.`,
      `Hold the vault shares across at least three rebalance epochs without withdrawing, since curator points accrue per curator, not per deposit.`,
      `Split a further 25 percent into a second ${n} vault on ${second} once the first position has survived one full epoch.`,
    ];
    case 'bridge': return [
      `Bridge ${money(Math.max(100, Math.round(cap / 5)))} of USDC to ${chain} through ${n} and put the bridged funds to work in the destination app the same day.`,
      `Repeat on two more distinct routes in different calendar months, because route and month diversity is what bridge programs record.`,
      `Use ${n}'s native swap or messaging feature once, not only plain transfers, and keep the destination position open afterwards.`,
    ];
    case 'staking': return [
      `Stake ${money(cap)} of the chain's staking asset through ${n} on ${chain} and delegate to a reputable operator with a long uptime record.`,
      `Deploy the liquid receipt token into a lending market or liquidity pool so the same capital earns a second, stacked multiplier.`,
      `Calendar the unbonding period, typically 7 to 21 days, before you stake, so an exit never forces a discounted secondary sale.`,
    ];
    case 'derivatives': return [
      `Deposit ${money(cap)} of USDC margin on ${n} and trade liquid pairs with limit orders on many separate days, budgeting fees at about 2 basis points of volume.`,
      `Place part of the capital in ${n}'s liquidity or market-maker vault for passive points, noting its lockup of typically one to four days.`,
      `Never self-match or wash trade: derivatives programs disqualify matched flow, so keep every position genuinely directional or hedged.`,
    ];
    case 'prediction': return [
      `Fund ${money(cap)} on ${n} and take positions in its most liquid markets, sized so no single market holds more than a fifth of the capital.`,
      `Stay active across at least three market-resolution cycles instead of concentrating activity in one event week.`,
      `Withdraw only after resolutions settle, and keep a record of each market, stake and outcome for the farm log.`,
    ];
    case 'basis': return [
      `Mint ${n}'s synthetic dollar with ${money(cap)} of stablecoins on ${chain} and stake it, noting the redemption cooldown of typically seven days.`,
      `Watch the funding rate weekly: persistent negative funding cuts the yield and can start redemption queues, which is your exit signal.`,
      `If ${n} offers a fixed-maturity points token, compare its premium and time decay against simply holding the staked position before buying.`,
    ];
    case 'stable': return [
      `Mint or acquire ${money(cap)} of ${n}'s stable asset directly on ${chain} rather than on the secondary market, so the wallet registers as a holder from the source.`,
      `Stake the stable into ${n}'s savings or staked variant and hold it there, since that balance is what ecosystem programs usually measure.`,
      `Supply part of the position to the main lending market or DEX pool that lists the asset, for the composability weight integrations carry.`,
    ];
    case 'rwa': return [
      `Complete ${n}'s KYC or allowlist process first and confirm the minimum subscription, which for real-world-asset products is often $1,000 or more.`,
      `Subscribe or mint ${money(Math.max(cap, 1000))} of the yield asset on ${chain}, or buy the secondary wrapper on a DEX if subscription is gated.`,
      `Deploy the asset into an integrated lending market or pool where ${n} lists it, and hold through at least two distribution cycles.`,
    ];
    case 'insurance': return [
      `Buy ${money(Math.round(cap / 5))} of cover from ${n} on a protocol you already farm, priced as an annual premium pro-rated to the season.`,
      `Or underwrite by staking into ${n}'s cover pool, noting the withdrawal notice period, which commonly runs 30 to 90 days.`,
      `Take part in one claims assessment or governance vote during the season so the wallet shows participation, not only capital.`,
    ];
    case 'payments': return [
      `Open the ${n} account or card and finish identity verification, then fund it with ${money(cap)} so a resting balance registers from the first month.`,
      `Run real recurring payments through ${n} every month for at least three months, counting the card fee and FX spread as the position's cost.`,
      `Keep the balance in place between payments rather than sweeping it out, since average balance is the metric payment programs publish.`,
    ];
    case 'chain': return [
      `Bridge ${money(cap)} into ${n} through its canonical bridge and keep some of the native gas token in the wallet at all times.`,
      `Use at least five distinct native applications on ${n} across six separate weeks: a DEX, a lending market, a bridge out, an NFT mint and one governance vote.`,
      `Provide a small liquidity position on the chain's main DEX and leave it in place for the whole season.`,
    ];
    case 'yield': return [
      `Deposit ${money(cap)} into ${n}'s largest flagship vault on ${chain}, the lowest-strategy-risk option, and hold through at least two harvest cycles.`,
      `Split a further 25 percent into the same vault family on ${second} for chain breadth, after checking each vault's withdrawal fee and cooldown.`,
      `Reinvest harvested yield once mid-season instead of withdrawing it, so the balance the program snapshots keeps compounding.`,
    ];
    default: return [
      `Deposit ${money(cap)} of USDC into ${n} on ${chain} through its main product flow and keep the position open, since balance-days are the base unit every points program counts.`,
      `Use ${n}'s second core feature once a week, such as a swap, a vote or a secondary market, so the wallet reads as a user rather than a parked deposit.`,
      `Add a smaller second position on ${second} once the first has run for a month, rather than splitting capital thinly from day one.`,
    ];
  }
}

/** One farm step as a single string: the action, then its cost and its time, inside the gate's limits. */
function step(action: string, cost: string, time: string): string {
  let s = `${action} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  return s;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a duration. The wallet setup,
 * the cadence, the hold and the exit are shared discipline; the middle three steps are the
 * category's own playbook, parameterised by this protocol's chains, TVL tier and age. No step is
 * written for a protocol by name.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const secondChain = p.chains.length > 1 ? p.chains[1]! : chain;
  const cap = capitalFor(p);
  const gas = gasFor(chain);
  const hold = holdDaysFor(age);
  const weeks = Math.ceil(hold / 7);
  const [a, b, c] = playbookActions(playbookOf(p.category), p, chain, cap);
  const gasText = `about ${money(gas)} per transaction on ${chain}`;
  const gasText2 = `about ${money(gasFor(secondChain))} per transaction on ${secondChain}`;
  return [
    step(
      `Set up a fresh wallet for ${p.name} alone, fund it with the position capital plus gas on ${chain}, and keep its seed phrase offline and never reused.`,
      `the ${money(cap)} position plus about ${money(gas * 3)} of gas float`, '15 minutes, once'),
    step(a, `${money(cap)} of capital and ${gasText}`, '20 minutes to set up'),
    step(b, `included in the ${money(cap)} position, plus ${gasText}`, '15 minutes, then 5 minutes a week to check'),
    step(c, `about a quarter of the position's capital and ${gasText2}`, '15 minutes, in week two'),
    step(
      `Make one qualifying action inside ${p.name} every week for ${weeks} weeks - a deposit top-up, a swap, a vote or a rebalance - so the wallet appears in many weekly snapshots, not one.`,
      `about ${money(gas)} of gas a week, ${money(gas * weeks)} across the season`, '10 minutes a week'),
    step(
      `Hold the position for at least ${hold} days and check the points or rewards page weekly, claiming nothing from any link that did not come from the protocol's own page.`,
      `the ${money(cap)} stays in the position for the full ${hold} days`, `${hold} days, with a 5-minute weekly check`),
    step(
      `When a token generation event or points conversion is announced, claim only through the official link, then unwind in tranches over two weeks instead of selling the whole position into launch-day volatility.`,
      `${gasText} to claim and exit, and never a fee to claim`, '30 minutes when announced, then two weeks to unwind'),
  ];
}

/** One row of board.json: the ranked board's row, with the model's arithmetic kept beside the claim. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    scale_multiplier: number;
    growth_multiplier: number;
    seasoning_multiplier: number;
    breadth_multiplier: number;
    ceiling_usd: number;
    capped: boolean;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one board row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  watchlist: boolean;
  launch_share: number;
  implied_value_usd: number;
  mult: [number, number, number, number, number];
  ceiling_usd: number;
  capped: boolean;
  farm_steps: string[];
}

/** A tokenised protocol: it already trades, so the page shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  ratio: number;
}

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  calibration: {
    size: number;
    global_multiple: number;
    tvl_ref: number;
    scale_slope: number;
    market_change_7d: number;
    ceiling_global: number;
  };
  categories: CategoryFit[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** The board: every watchlist slug, plus the strongest hygienic pre-token protocols below the floor. */
export function buildBoard(snapshot: Snapshot, cal: Calibration): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const tradedStems = new Set(
    snapshot.protocols.filter((p) => !recordsNoToken(p)).map((p) => p.slug.split('-')[0]!),
  );
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const extras = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && passesHygiene(p, tradedStems))
    .map((p) => ({ p, s: scoreProtocol(p, snapshot.as_of, cal) }))
    .sort((x, y) => y.s.implied - x.s.implied || (x.p.slug < y.p.slug ? -1 : 1))
    .slice(0, Math.max(0, BOARD_ROWS - chosen.size));
  for (const e of extras) chosen.set(e.p.slug, e.p);

  const scored = [...chosen.values()].map((p) => ({ p, s: scoreProtocol(p, snapshot.as_of, cal) }));
  scored.sort((x, y) => y.s.implied - x.s.implied || (x.p.slug < y.p.slug ? -1 : 1));
  const watch = new Set(snapshot.watchlist);
  return scored.map(({ p, s }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    listed_at: p.listed_at,
    age_days: s.age,
    watchlist: watch.has(p.slug),
    implied_value_usd: s.implied,
    model: {
      category_multiple: s.multiple,
      scale_multiplier: s.scale_multiplier,
      growth_multiplier: s.growth_multiplier,
      seasoning_multiplier: s.seasoning_multiplier,
      breadth_multiplier: s.breadth_multiplier,
      ceiling_usd: s.ceiling_usd,
      capped: s.capped,
    },
    farm_steps: farmSteps(p, s.age),
  }));
}

/** The tokenised protocols, by market cap, for the dashboard's already-trading view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !recordsNoToken(p) && p.mcap_usd !== null && p.mcap_usd > 0)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      change_7d: p.change_7d,
      ratio: p.tvl_usd > 0 ? round4(p.mcap_usd! / p.tvl_usd) : 0,
    }));
}

/** Everything the dashboard renders: the board, the live set, and the fitted model behind both. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const cal = calibrate(snapshot);
  const board = buildBoard(snapshot, cal);
  const live = liveRows(snapshot);
  const watch = new Set(snapshot.watchlist);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    calibration: {
      size: cal.size,
      global_multiple: cal.global_multiple,
      tvl_ref: cal.tvl_ref,
      scale_slope: cal.scale_slope,
      market_change_7d: cal.market_change_7d,
      ceiling_global: cal.ceiling_global,
    },
    categories: cal.categories,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !watch.has(r.slug)).length,
    live_size: snapshot.protocols.filter((p) => !recordsNoToken(p)).length,
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      age_days: r.age_days,
      watchlist: r.watchlist,
      launch_share: fitFor(cal, r.category).launch_share,
      implied_value_usd: r.implied_value_usd,
      mult: [
        r.model.category_multiple, r.model.scale_multiplier, r.model.growth_multiplier,
        r.model.seasoning_multiplier, r.model.breadth_multiplier,
      ],
      ceiling_usd: r.model.ceiling_usd,
      capped: r.model.capped,
      farm_steps: r.farm_steps,
    })),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, farm steps, values. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `the board holds ${board.length} rows, under the 100-row floor`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) {
    if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `rank ${i + 1} outranks rank ${i} on implied value`;
  }
  if (board.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) {
    return 'every row shares one implied value: a board that ranks nothing by value is not a ranking';
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const len = s.trim().length;
      if (len < 20 || len > 600) return `${r.slug} has a farm step of ${len} characters`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
