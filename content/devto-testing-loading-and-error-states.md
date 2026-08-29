---
title: "Testing loading and error states without touching your code"
published: false
description: "Your loading spinner works. Your error boundary works. You know because you commented out the fetch and hardcoded a throw — and then you had to remember to put it back."
tags: webdev, testing, javascript, react
canonical_url: https://flakyapi.dev/docs/jsonplaceholder
---

Every frontend has three states and most of us only ever look at one of them.

The happy path gets tested constantly, because it's what you see every time you
refresh. The loading state you see for 80 milliseconds on a fast connection. The
error state you see approximately never — until it's in production, and it turns
out the spinner never stops, or the retry loop hammers a dead endpoint forty
times a second, or the error boundary renders `undefined is not a function` on
top of the actual error.

So how do you actually test the other two?

## What most of us do

**Comment out the fetch and hardcode it.**

```js
// const res = await fetch('/api/posts')
// return res.json()
return new Promise(r => setTimeout(() => r(FAKE_POSTS), 3000))
```

This works and everyone does it. The problem isn't that it's wrong, it's that
it's *temporary code in a permanent place*. It has to be removed before you
commit, it doesn't test the real fetch path, and the one time you forget, you
ship a three-second delay to production.

**Throttle the network in DevTools.**

Better — it's real network behaviour, no code change. But it's all-or-nothing
for the whole page, you can't make it fail, and you can't hand the setting to
a colleague or put it in a bug report.

**Run a local mock server.**

MSW, Mockoon, WireMock, `json-server` with middleware. These are genuinely the
right answer for a test suite, and if you're writing automated tests you should
use one. But for the thing you do twenty times a day — *"let me just see what
this looks like when it's slow"* — installing and configuring a server is a lot
of ceremony for a ten-second question.

## The thing that's missing

What you actually want is to make **one request** behave badly, from the URL,
without changing anything else.

That's what I ended up building. [flaky](https://flakyapi.dev) is a fake REST
API — the same shape as JSONPlaceholder, same resources, same field names — with
three query parameters that change how it responds.

```js
// a slow endpoint
fetch('https://flakyapi.dev/v1/posts?_delay=3000')

// a hard failure
fetch('https://flakyapi.dev/v1/posts?_status=503')

// an intermittent one — a third of requests fail
fetch('https://flakyapi.dev/v1/posts?_fail_rate=0.3')
```

Nothing to install, nothing to remove afterwards, and it works from a browser
console, a CodePen, or a colleague's machine that has nothing set up.

## Testing the three states, concretely

Here's a component with all three states, and how to actually see each one.

```jsx
function Posts() {
  const [posts, setPosts] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetch(URL)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(setPosts)
      .catch(setError)
  }, [])

  if (error) return <ErrorState message={error.message} />
  if (!posts) return <Spinner />
  return <PostList posts={posts} />
}
```

**Does the spinner actually render?** With a fast API you get one frame of it,
which is not enough to see a layout shift or a spinner that's positioned wrong.

```js
const URL = 'https://flakyapi.dev/v1/posts?_delay=3000'
```

Three full seconds. Long enough to notice that your spinner is off-centre, that
the page jumps when content arrives, or that you render `posts.length` before
`posts` exists.

**Does the error state render?**

```js
const URL = 'https://flakyapi.dev/v1/posts?_status=503'
```

This is the one that finds bugs. Common ones: the spinner never stops because
`setPosts` was never called and `posts` is still `null`; the error message shows
a raw stack trace; or the component renders both the error *and* the empty list.

**Does your retry logic work?**

This is where a fixed failure is not enough. Retry logic has to be tested
against *intermittent* failure, because that's the only case where retrying
helps:

```js
const URL = 'https://flakyapi.dev/v1/posts?_fail_rate=0.3'
```

Roughly one request in three fails, independently. Reload a few times. Things
this catches that a hard 503 doesn't: retrying without backoff, retrying
forever, retrying on a 4xx that will never succeed, and two components both
retrying the same request.

**And the combination, which is what production actually is:**

```js
const URL = 'https://flakyapi.dev/v1/posts?_delay=1500&_fail_rate=0.2'
```

Slow *and* unreliable. If your retry has a timeout shorter than your delay, you
will find out here rather than from a user.

## A pattern worth stealing

Rather than editing the URL each time, put the chaos behind an environment
variable so you can toggle it without touching component code:

```js
// api.js
const BASE = 'https://flakyapi.dev/v1'

const chaos = import.meta.env.VITE_CHAOS ?? ''

export const url = (path) => `${BASE}${path}${chaos ? '?' + chaos : ''}`
```

```bash
npm run dev                                    # normal
VITE_CHAOS='_delay=3000' npm run dev           # everything is slow
VITE_CHAOS='_fail_rate=0.3' npm run dev        # everything is flaky
```

Now "show me the app on a bad connection" is a shell command, and there is no
temporary code anywhere to forget about.

## Where this doesn't belong

To be clear about the limits, because a tool recommended without them isn't a
recommendation:

**Not in your CI test suite.** A test that depends on a network call to someone
else's server is a test that fails when their DNS hiccups. For automated tests,
use [MSW](https://mswjs.io/) — it intercepts at the network layer, runs offline,
and is deterministic. That's the right tool and this isn't competing with it.

**Not for your own API's edge cases.** If you need a specific malformed payload
from your own backend, mock your own backend.

This is for the loop between "I changed something" and "does it look right when
things go wrong" — the twenty-times-a-day question that's currently answered by
commenting out code.

## The wider point

Loading and error states are the parts of a UI most likely to be broken, because
they're the parts you look at least. Anything that lowers the cost of *seeing*
them — from a minute of editing code to a query parameter — means you'll look at
them more, and that's the whole benefit.

Whether you use flaky, `httpstat.us`, a local MSW handler, or DevTools
throttling matters much less than having *some* way to see the sad path without
it being a chore.

---

*flaky is free, has no signup for reads, and is
[open source](https://github.com/errohitrana2013/flaky). I built it, so treat
this as biased — but the three-parameter idea works just as well in your own
mock server, and you should steal it either way.*
