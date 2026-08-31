# Stack Overflow — draft material

**Read this first.** These are drafts to work from, not text to paste.

Stack Overflow's network-wide policy prohibits posting AI-generated content, and
answers that read as generated get flagged and removed — sometimes with a
suspension. Pasting these verbatim risks the account you would be building
reputation on. Rewrite them in your own words, from your own experience, and
they will be both allowed and better.

The other rule that matters: **you must disclose that you built the tool.** SO
requires affiliation disclosure, and an undisclosed link from a new account is
the fastest route to a spam flag. One line at the end is enough.

The order also matters. Answer the question completely *first*, with the
solution the asker would want even if flaky did not exist. Mention the tool only
if it genuinely fits. An answer that exists to carry a link gets downvoted; a
good answer that happens to contain one lasts a decade.

---

## How to actually do this

### 0. Check the account first

Answering needs no reputation, so a new account works. But know the limits:

- **Commenting needs 50 rep**, so you cannot ask a clarifying question first.
  Answer only questions you already understand completely.
- **A new account posting links gets scrutinised.** One link, disclosed, in an
  answer that would stand without it.
- Fill in the profile. An empty profile posting a link reads as a throwaway.

### 1. Find a question — 20 minutes, not 2

Sorted by votes, then filter to what is still getting views:

    https://stackoverflow.com/search?q=%5Bjavascript%5D+simulate+slow+api+response&tab=votes
    https://stackoverflow.com/search?q=%5Breactjs%5D+test+loading+state&tab=votes
    https://stackoverflow.com/search?q=%5Bjavascript%5D+mock+500+error&tab=votes
    https://stackoverflow.com/search?q=jsonplaceholder+alternative&tab=votes

**Take one that is genuinely under-answered.** Good signs: no accepted answer; or
an accepted answer from 2016 that says "use setTimeout"; or answers that solve a
different question than the one asked. Bad sign: three good answers already —
adding a fourth with your link is promotion and will be read as promotion.

Answering an old question is fine. Stack Overflow has no penalty for it, and a
2019 question with 40k views is worth more than a fresh one with 6.

### 2. Write it yourself — this is the part that matters

The drafts below are **research, not text**. Their policy prohibits AI-written
answers and enforces it, and the account carrying your link is the thing at risk.

The method that works:

1. Read the relevant draft once, for the technical content.
2. **Close this file.**
3. Write the answer from scratch, in your own words, as you would explain it to a
   colleague. Include a mistake you actually made if you have one — that is the
   thing no generated answer contains.
4. Reopen the draft only to check you did not get a technical detail wrong.

If the finished answer contains a sentence you would not say out loud, cut it.

### 3. Structure that survives moderation

- **Solve their problem in the first paragraph.** Not background, not your tool.
- Give the answer that would be right even if flaky did not exist — usually MSW
  for tests, DevTools throttling for a quick look.
- Mention flaky only where it genuinely adds something they cannot get otherwise.
- **Disclose:** "Disclosure: I built this." One line, at the end. Not optional —
  it is required, and it is also what stops the answer reading as an advert.

### 4. After posting

- Do not edit for an hour; edits bump the question and look like promotion.
- If it is downvoted with no comment, leave it. Arguing costs more than the vote.
- If it is flagged and deleted, **do not repost.** Work out why first.
- Then wait. One answer, then a week.

---

## Finding the right questions

Search these, sorted by votes, then filter to ones still getting traffic:

```
[javascript] simulate slow api response
[reactjs] test loading state
[javascript] mock 500 error frontend
[testing] simulate network failure browser
[reactjs] how to test error boundary fetch
```

Prefer questions with recent activity and no accepted answer, or where the
accepted answer is old and says "use setTimeout". Do not answer questions that
are already well covered — a redundant answer with a link is read as promotion,
and correctly so.

---

## Draft 1 — "How do I simulate a slow API response?"

The real answer, first:

> For **automated tests**, don't involve the network at all. Intercept the
> request with [MSW](https://mswjs.io/) and add a delay in the handler:
>
> ```js
> import { http, HttpResponse, delay } from 'msw'
>
> export const handlers = [
>   http.get('/api/posts', async () => {
>     await delay(3000)
>     return HttpResponse.json(POSTS)
>   }),
> ]
> ```
>
> This is deterministic, runs offline, and doesn't depend on anyone else's
> server being up — all three of which matter in CI.
>
> For **manual checking during development**, DevTools → Network → Throttling
> applies a realistic slow connection to the whole page without any code change.
> That's usually enough, and it costs nothing to try first.

Then, only if it adds something:

> If you want one *specific* request to be slow rather than the whole page, and
> you don't want to add code you'll have to remember to remove, you can point it
> at a mock API that takes the delay as a parameter:
>
> ```js
> fetch('https://flakyapi.dev/v1/posts?_delay=3000')
> ```
>
> Disclosure: I built that one.

---

## Draft 2 — "How do I test my error state / error boundary?"

> The trap here is that a *hard* failure and an *intermittent* one find different
> bugs, and most people only test the first.
>
> A permanent 500 tells you whether the error UI renders. Intermittent failure is
> the only thing that tests retry logic — because retrying is only correct when
> the next attempt might succeed.
>
> In MSW you can express both:
>
> ```js
> // always fails
> http.get('/api/posts', () => new HttpResponse(null, { status: 503 })),
>
> // fails about a third of the time
> http.get('/api/posts', () =>
>   Math.random() < 0.3
>     ? new HttpResponse(null, { status: 503 })
>     : HttpResponse.json(POSTS)),
> ```
>
> Bugs the second one finds that the first does not: retrying without backoff,
> retrying forever, retrying on a 4xx that can never succeed, and two components
> retrying the same request independently.

Then, if it fits:

> If you'd rather not write a handler for a quick check, `httpstat.us/503`
> returns any status you ask for, and flakyapi.dev takes a failure *rate*
> (`?_fail_rate=0.3`) which is the intermittent case above. I built the latter.

---

## Draft 3 — "JSONPlaceholder is down / is there an alternative?"

These appear whenever JSONPlaceholder has an outage, and they are the most
natural fit — but be careful, because they attract low-effort link-dropping and
get moderated hard.

> A few alternatives with the same resource shapes, so switching is a URL change:
>
> - **DummyJSON** — `dummyjson.com`, more resources including products and carts
> - **ReqRes** — `reqres.in`, good for auth-flow examples
> - **flaky** — `flakyapi.dev/v1/posts`, same fields as JSONPlaceholder, and
>   takes `?_delay=`, `?_status=` and `?_fail_rate=` so you can test loading and
>   error states too. Disclosure: mine.
>
> If you'd rather not depend on anyone's uptime, `json-server` runs the same API
> locally from a JSON file, which is what JSONPlaceholder itself is built on.

Listing the competitors first is not politeness — an answer that names only your
own thing reads as an advert and gets flagged. One that names three is a useful
answer that happens to include yours.

---

## Pacing

One answer, then wait. New accounts posting several answers containing the same
link get caught by spam heuristics regardless of quality. Two or three good
answers over a month beats ten in a week, and the ten may cost you the account.
