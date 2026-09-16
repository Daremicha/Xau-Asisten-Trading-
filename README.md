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

## Signing in is optional

The app is fully usable without an account. As a guest, your locked equity,
risk settings and learning history are saved in the browser you are using.
Signing in with Google adds cloud sync across devices, nothing else.

### If the Google sign-in button reports an unauthorised domain

This means the address your app is served from is not on the authorised list of
the Firebase project it points at. The repository ships with the project it was
generated in, and **you may not have permission to change that project's
settings**. The Firebase Console says so directly: "To manage settings, ask a
project owner for the necessary permission."

You have three options.

**Keep using it as a guest.** Nothing else in the app depends on signing in.
Dismiss the message and carry on.

**Authorise the domain, if you own the project.** Firebase Console,
Authentication, Settings, Authorized domains, then add your deployment domain.

**Point the app at your own Firebase project.** Create a free project at
[console.firebase.google.com](https://console.firebase.google.com), enable
Google sign-in under Authentication, create a Firestore database, then set these
variables in your hosting platform. No file in the repository needs editing.

| Variable | Where to find it |
| --- | --- |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Project settings, Your apps, SDK setup |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | same place |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | same place |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | same place |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | same place |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | same place |

The override only takes effect when the key, project id, app id and auth domain
are all present, so a half filled set cannot break a working app. Copy the rules
in `firestore.rules` into your new project so each user can only read and write
their own records.

## Data provider quota

The free Twelve Data tier allows 800 requests a day. The app reuses one quote
for 60 seconds and only refreshes when someone is actually looking, so eight
hours of continuous use costs about 480 requests. Set
`MARKET_DATA_CACHE_SECONDS` lower only if you move to a paid plan.

## How the engine works

**Price levels are deterministic.** Entry, stop and targets come from
`lib/signal-engine.ts`, which reads market structure measured from live candles.
Nothing is hardcoded to a particular price, so the engine works whether gold
trades at 1,200 or 7,500.

**Language models are optional and only write prose.** If you set
`GEMINI_API_KEY`, `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, a model writes the
narrative around the setup. It never sets a price. The app is fully functional
with none of them.

**The self-learning loop feeds back into the numbers.** Outcomes you record
adjust the adaptive weights, which change the entry anchor, the stop buffer and
how each confluence is weighted on the next signal. A per-style stop ceiling
keeps a long losing run from turning an intraday setup into a swing trade.

**Missing data is reported, never invented.** If no provider answers, the app
says so and refuses to build a signal rather than showing a made up price.

## Commands

| Command | What it does |
| --- | --- |
| `bun run check:feed` | Verifies the market data connection |
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
