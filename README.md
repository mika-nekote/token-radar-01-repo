# token-radar-01-repo

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/mika-nekote/token-radar-01-repo/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/mika-nekote/token-radar-01-repo/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

**Launch Radar** ranks 192 protocols that record no token yet — all 40 watchlist protocols plus 152 early ones below the $50M line — by the value their token would plausibly launch at. The price model is fitted only to the sealed snapshot: each category's mcap/TVL multiple is the median of its tokenised peers, winsorised and shrunk toward the global median by an evidence weight, then adjusted by a Theil–Sen scale fit (value grows slower than TVL), market-relative 7-day momentum that saturates, a seasoning curve that peaks at 1.5–2.5 tokenless years, and a chain-breadth term, all capped at what each protocol family has actually produced. Every row carries a seven-step farm plan with position sizes, gas budgets and hold durations derived from its category, chains, TVL tier and age. The static dashboard shows the board with search, category/chain filters, sorting and a watchlist toggle, an already-trading view that keeps market facts separate from model claims, the fitted category-multiple table with its evidence counts, and a per-protocol detail drawer that recomputes the row's implied value from its printed multipliers. Deterministic: two runs over the same snapshot write byte-identical output.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input/snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=ag3w8519&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
