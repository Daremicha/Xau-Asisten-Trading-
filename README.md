# XAUUSD Institutional Trading Assistant

A Next.js terminal for XAUUSD (gold) that reads live market data, derives Smart
Money Concepts structure from real candles, and sizes an executable MetaTrader 5
order against your account risk.

## Where the API key goes

**Never put the key in GitHub.** `.env.local` is listed in `.gitignore` on
purpose. Committing it would publish your key to anyone who can see the
repository, and a leaked key can be used until its quota is drained.

The key belongs in exactly one of two places, depending on how you run the app:

| How you run it | Where the key goes |
| --- | --- |
| Hosted online | The hosting platform's environment variable settings |
| On your own computer | A `.env.local` file on that computer |

## Deploying to Vercel

This needs nothing installed on your machine. Everything happens in a browser.

### 1. Get a market data key

Sign up at [twelvedata.com](https://twelvedata.com/pricing) and copy your API
key. The free tier is enough.

### 2. Import the repository

Go to [vercel.com](https://vercel.com), sign in with GitHub, and choose
**Add New → Project**. Pick this repository. Vercel detects Next.js on its own,
so leave the build settings alone.

### 3. Add the key as an environment variable

Before clicking Deploy, open **Environment Variables** and add:

| Name | Value |
| --- | --- |
| `TWELVE_DATA_API_KEY` | your key |

Then deploy. This is the step that replaces editing a file.

### 4. Optional: enable Google sign-in

The app works without it, so you can skip this and come back later. If you do
want sign-in, see "Signing in is optional" below, which also covers what to do
when Firebase says you lack permission to change the project.

### 5. Check it

Open your Vercel URL. A green line reading "Live data source" means it works.
A red banner means the key did not take, so recheck step 3 and redeploy.

From then on, every push to this branch redeploys automatically.

### Changing the key later

Edit it in Vercel's environment variable settings, then redeploy. Variables are
read when the server starts, so an existing deployment keeps the old value until
it restarts.

## Running on your own computer instead

Only if you have [Bun](https://bun.sh) installed.

1. Create a file named `.env.local` next to `package.json`:

   ```
   TWELVE_DATA_API_KEY="paste_your_key_here"
   ```

2. Install, verify, and run:

   ```bash
   bun install
   bun run check:feed
   bun run dev
   ```

`check:feed` calls the real provider and says plainly whether a live gold price
came back, listing what to check when it does not.

## Signing in and cloud sync

The app works without an account. As a guest, your locked balance, risk settings
and trade history live in the browser you are using. Signing in with Google adds
cloud sync, so the same data follows you to another device.

**Your guest data is not lost when you sign in.** The first time you sign in on
an account that has no cloud record yet, the app copies your saved balance and
every recorded trade up to the cloud, tells you how many it moved, and remembers
that it has done so. Records are stored under their own id, so the transfer
cannot duplicate a trade even if it runs again.

### Firebase project

The app is configured for the Firebase project **`xauasistenengine`**, stored in
`firebase-applet-config.json`. These values are public by design: they appear in
every browser that loads the app. Firestore security rules, not secrecy, are what
protect the data. Nothing needs to be set in your hosting platform for Firebase
to work.

Verify the values are complete and consistent at any time:

```bash
bun run check:firebase
```

It catches the mistakes that happen while copying between the console and the
app, such as an auth domain from a different project, or a messaging sender id
that disagrees with the app id.

### Four things to confirm in the Firebase Console

The check above cannot see inside the console, so confirm these once, in the
[Firebase Console](https://console.firebase.google.com) for `xauasistenengine`:

1. **Authentication → Sign-in method** — enable **Google**, choose a support
   email, save. Without this the sign-in popup is refused.
2. **Firestore Database → Create database** — pick a region near you, start in
   production mode. This is where your balance and trade history are stored.
3. **Firestore Database → Rules** — replace what is there with the contents of
   `firestore.rules` from this repository, then publish. These rules let each
   signed-in person read and write only their own records. Without them,
   production mode denies every write and nothing will save.
4. **Authentication → Settings → Authorized domains** — add the domain your app
   is served from, such as `your-app.vercel.app`. Add `localhost` too if you run
   it locally.

### Pointing the app at a different project later

Set these in your hosting platform's environment variables. The override applies
only when all of the first four are present, so a partial set cannot break a
working app.

| Variable | Field in `firebaseConfig` |
| --- | --- |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | `apiKey` |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | `authDomain` |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | `projectId` |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | `appId` |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | `storageBucket` |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | `messagingSenderId` |

### If sign-in still fails

The app now explains the reason on screen instead of doing nothing. The most
common message is an unauthorised domain, which means step 6 is missing or the
domain does not match exactly.

## The chart, the quote, and why they differ

The quote is the current tick, not the close of the last finished candle. That
distinction is the difference between a market order you can fill and one you
cannot: between fifteen minute bars, a candle close can be minutes and several
dollars behind the market. If the tick endpoint cannot be reached the snapshot
falls back to the candle close, reports the real age of that price, and marks
itself stale once it is too old to place a market order against.


The candles are **TradingView's own live feed** (OANDA:XAUUSD), embedded
directly, so they tick in real time. The bid, ask and every number the engine
computes come from **your market data provider**, a few seconds behind. The two
will never agree to the tick, so the chart bar prints how old the quote is, and
a refresh button asks for a new one on demand. The toggle beside it switches
between TradingView and the engine's own level view, with the active one
highlighted.

## Data provider quota

The free Twelve Data tier allows 800 requests a day, so the app spends them
where they matter:

| Situation | How often it asks |
| --- | --- |
| An order is working | Every 20 seconds, because the status panel and the automatic close both read the price |
| Nothing open | Every 60 seconds |
| Tab in the background | Not at all |

A quote is cached for 20 seconds server-side, so extra tabs cost nothing. Two
hours in a trade plus four hours watching is about 600 requests, inside the free
allowance with room to spare. `MARKET_DATA_CACHE_SECONDS` raises the cache
window if your allowance is tighter.

## Economic calendar

The calendar reads the weekly Forex Factory JSON by default, so scheduled
releases appear without any setup. It refreshes alongside the quote, which means
the panel stays populated whether or not a setup is open.

| Setting | Effect |
| --- | --- |
| `ECONOMIC_CALENDAR_URL` unset | The default published feed |
| `ECONOMIC_CALENDAR_URL=<url>` | Your own provider, mapped from the usual field names |
| `ECONOMIC_CALENDAR_URL=` (empty) | No calendar at all, and the engine ignores news |

When a high-impact release is within the hour, the engine widens the stop
buffer. A feed that cannot be reached leaves the calendar empty and says so
rather than inventing a schedule.

## How the engine works

**Price levels are deterministic.** Entry, stop and targets come from
`lib/signal-engine.ts`, which reads market structure measured from live candles.
Nothing is hardcoded to a particular price, so the engine works whether gold
trades at 1,200 or 7,500.

**Language models are optional and only write prose.** If you set
`GEMINI_API_KEY`, `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, a model writes the
narrative around the setup. It never sets a price. The app is fully functional
with none of them.

**Every panel on the screen reaches the decision.** The signal card lists what
the engine read to produce that setup, built where the decision was made rather
than re-derived afterwards, so the claim is checkable:

| Input | What it contributes |
| --- | --- |
| Live chart and structure | Direction, across D1, H4, H1 and M15 |
| Indicators | EMA stack, RSI and stochastic votes; ATR sets the stop |
| Institutional structure and confluence | Order block, imbalance, liquidity, premium and discount |
| Pivot and directional bias | Which side of the daily pivot price is working |
| Wyckoff and Quasimodo | Phase and sweep pattern, weighted below the structure |
| Institutional trading session | Conviction, the stop, and how long a pending order stays valid |
| USD economic calendar | Widens the stop ahead of a release |
| Adaptive self-learning engine | The weights every factor above is scaled by |
| Strategy backtest lab | The starting parameters, when a replay earned them |
| Portfolio and equity growth | A drawdown reduces position size |

**The self-learning loop feeds back into the numbers.** Outcomes you record
adjust the adaptive weights, which change the stop buffer and how each
confluence is weighted on the next signal. A per-style stop ceiling keeps a long
losing run from turning an intraday setup into a swing trade.

**Results are learned by condition, not just by average.** Every closed trade
records what the setup looked like when it was produced: the level the entry
came from, the session, whether the timeframes agreed, whether a release was
inside the hour, and the result in multiples of risk. The engine then measures
each kind of setup separately, so it can find that order block entries are
carrying the account while gap entries are draining it, and move the weighting
accordingly. A condition needs eight closed trades before it moves anything, and
a gap smaller than a tenth of R is treated as noise.

**A strike rate is judged against what the target needs.** A 1.5R target breaks
even at 40%, a 2R target at 33%, so a healthy intraday system runs well under
half. Stops are only widened when the strike rate is below the style's own break
even *and* the account is losing money. Judged against a flat threshold instead,
a profitable 44% run had its stops widened for no reason: a 24 month replay put
that at 410.90 cent and took the worst drawdown from 22% to 29.6%.

**Learning never chases fills.** Orders that never filled used to tell the engine
its entries sat too deep, and it answered by moving them toward price. A 24 month
replay of real candles isolated that adaptation, froze it and traded the period
again: it earned less than the engine's defaults and raised the worst drawdown
from 22% to 31.6%. The arithmetic explains why. Pulling an entry closer converts
the misses nearest the level into fills, and those are the marginal setups rather
than the average one, which is the only thing the engine can measure. A missed
order costs nothing, so entries stay on their levels. An entry buffer can still
arrive from a backtest that measured one — that is evidence the live engine
cannot gather — capped at 40% of the style's maximum stop.

**Missing data is reported, never invented.** If no provider answers, the app
says so and refuses to build a signal rather than showing a made up price.

## Backtesting the engine

The **Strategy Backtest Lab** at the bottom of the page replays the same engine
over real history and answers one question: does learning from each result make
the next signal better?

Pick a period (6, 12 or 24 months) and press run. The app downloads real XAUUSD
candles a page at a time, then trades the period twice:

| Run | What it does |
| --- | --- |
| Fixed parameters | Keeps the engine's starting weights for the whole period |
| Learning from results | Re-derives the weights after every closed trade, exactly as the live app does |
| Learned, held fixed | Trades the whole period with the weights the learning run ended on, frozen from the first candle |

Same candles, same rules, one difference, so the comparison measures learning
rather than luck. The report shows win rate, net result, profit factor,
drawdown, the two balance curves on a shared date axis, and the first half of
the learning run against its second half.

The third run is what the adopt button rests on. The weights a learning run
ends on are the end of a path, not a configuration that was ever traded as
such, so they are replayed once more from the first candle before being offered
for live use.

**The button is a promise: if it can be pressed, adopting is an improvement.**
It opens only when all of these hold, and says which one failed when it does
not:

| Condition | Why |
| --- | --- |
| The parameters differ from the engine defaults | Otherwise pressing it changes nothing |
| The frozen run earned more than the defaults | Otherwise adopting costs money |
| It earned more by at least 5% of what the defaults made | A hair's margin over one period is luck, not an edge |
| Its worst drawdown is no deeper | A rougher ride for the same edge is not an improvement |

A period is still a single sample. When the button does open, running the same
test at 12 months, or on the other base timeframe, and seeing it win there too
is what separates a real improvement from a fit to one stretch of chart. Live analysis then shrinks toward
those instead of the built-in defaults, and your real trades keep adjusting
from there. The choice is stored with your profile and can be reverted.

### What the replay does and does not model

- Every decision sees only the candles that had printed at that moment. The
  test suite proves this by replaying a truncated series and checking the trade
  comes out identical.
- When one candle contains both the stop and the target, the stop is taken. The
  order of events inside a bar cannot be recovered from its open, high, low and
  close.
- Spread is charged on every fill, and commission where the account charges it.
- A position that reaches neither level is closed at market at the style's
  holding limit.
- Historical economic releases are not available to the app, so the news shield
  is inactive for the whole replay.
- Slippage, execution gaps over the weekend and swap are not modelled.

### Choosing which setups are worth taking

The report ends with a breakdown of the run by the conviction each setup scored
when it was taken: signals, fills, strike rate, average result and net, per
band. It is the cheapest honest answer to "should the engine trade less" —
the trades already happened, so grouping them by their score shows which bands
paid for themselves and which funded the losses, with no extra replay.

Underneath it, the report states what refusing everything below each floor
would have left. If a floor looks worth it, set the same number in **Only trade
conviction above** under Capital & Account Configuration and re-run the
backtest to trade it properly, with sizing and compounding applied.

With a floor set, a live analysis that finds nothing good enough says so and
offers no order, naming the score it reached and why. Skipping costs nothing; a
weak fill does not.

### History depth

A 24 month replay at the M15 base needs about a dozen provider requests. With a
Twelve Data key that is a minute of downloading; the free plan allows eight
requests a minute, and the app waits when it is asked to. Without a key the app
falls back to Yahoo, which serves sixty days of fifteen minute candles or two
years of hourly ones, so switch to the **H1 base** for a long replay. Whatever
arrives, the report states the exact period and candle count it actually
covered.

## Commands

| Command | What it does |
| --- | --- |
| `bun run check:feed` | Verifies the market data connection |
| `bun run check:firebase` | Verifies the Firebase configuration |
| `bun run dev` | Starts the development server |
| `bun run build` | Production build |
| `bun run start` | Serves the production build |
| `bun test` | Runs the test suite |
| `bun run typecheck` | TypeScript check, including dead code |
| `bun run lint` | ESLint |

## Risk warning

Gold trading carries real financial risk. The signals here are generated by an
algorithm, are not investment advice, and should be tested on a demo account
before any live capital is committed.
