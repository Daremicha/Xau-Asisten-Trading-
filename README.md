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

### Setting up your own Firebase project

The project bundled with this repository was created by Google AI Studio. If you
do not own it, its console will tell you "To manage settings, ask a project owner
for the necessary permission", and you will not be able to authorise your own
domain. Creating your own project takes a few minutes and gives you full control.

**1. Create the project.** Go to
[console.firebase.google.com](https://console.firebase.google.com), choose
**Add project**, give it a name, and finish the wizard. Google Analytics is not
needed.

**2. Register a web app.** On the project overview, click the web icon `</>`,
give the app a nickname, and register it. Firebase then shows a `firebaseConfig`
block. Keep that page open.

**3. Turn on Google sign-in.** Go to **Authentication → Get started →
Sign-in method**, choose **Google**, enable it, pick a support email, and save.

**4. Create the database.** Go to **Firestore Database → Create database**. Pick
a region close to you. Start in production mode.

**5. Apply the security rules.** Open the **Rules** tab and replace what is there
with the contents of `firestore.rules` from this repository, then publish. These
rules let each signed-in person read and write only their own records.

**6. Authorise your site.** Go to **Authentication → Settings → Authorized
domains** and add the domain your app is served from, such as
`your-app.vercel.app`. Add `localhost` too if you run it locally.

**7. Give the values to your app.** From the `firebaseConfig` block in step 2,
copy each value into the matching variable. On Vercel these go in the project's
Environment Variables, then redeploy. Locally they go in `.env.local`.

| Variable | Field in `firebaseConfig` |
| --- | --- |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | `apiKey` |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | `authDomain` |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | `projectId` |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | `appId` |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | `storageBucket` |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | `messagingSenderId` |

**8. Check your work.**

```bash
bun run check:firebase
```

It reports which values are missing and whether they came from the same project,
which is where this usually goes wrong. The first four in the table are
required; a partial set is ignored and the app silently falls back to the
bundled project.

These values are public by design. They appear in every browser that loads the
app. The security rules, not secrecy, are what protect your data.

### If sign-in still fails

The app now explains the reason on screen instead of doing nothing. The most
common message is an unauthorised domain, which means step 6 is missing or the
domain does not match exactly.

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
