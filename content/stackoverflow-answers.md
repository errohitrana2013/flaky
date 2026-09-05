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

- **Commenting now needs 1 rep**, not the 50 it used to — the privileges API
  reports the lowered threshold. So you *can* ask a clarifying question first.
  Do that rather than guessing at what a vague question means.
- **A comment is never the place for the link.** Promotion in comments is spam
  regardless of rep, and comments are deleted without much thought. If the tool
  is worth mentioning, it is worth an answer that stands on its own.
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

## Draft 4 — ASP.NET Core, "simulate a 404/500 from a dependent Web API"

Target: https://stackoverflow.com/questions/76618175 — open, no accepted answer,
one answer at score 0, 388 views since July 2023.

**This C# has not been compiled.** There is no .NET SDK on this machine, so
every snippet below is written from the API surface, not from a passing build.
This repo's own rule is that generated code gets verified by running it — do
that here too. Stand up the two projects, make the `HttpRequestException` test
go red and the 404/500 tests go green, and only then post. Shipping code that
does not compile to a question tagged `.net-core` earns downvotes faster than
anything else in this file.

**Read this before writing.** flaky is a *footnote* here, and a weak one. The
asker wants an **integration test**, and an automated test must not depend on
somebody else's server being reachable — that is a flaky test in the bad sense.
The correct answer is almost entirely about dependency injection and a stub
`HttpMessageHandler`. If the link does not fit naturally when you write it in
your own words, **post the answer without it.** A good .NET answer under this
account is worth more than a link in a bad one.

### The actual blocker, first paragraph

Nothing can be simulated until two things change, and both are in the asker's
code rather than in any mocking tool:

- `new HttpClient()` is constructed inside the action, so there is no seam to
  intercept. (It also leaks sockets under load — the existing answer's link to
  the HttpClient guidelines is right about that.)
- `SENSOR_URL` is a hardcoded `const` pointing at `localhost:7272`, so the test
  cannot redirect it either.

Fix both by making it a typed client:

```csharp
public class TrafficSensorClient
{
    private readonly HttpClient _http;
    public TrafficSensorClient(HttpClient http) => _http = http;

    public Task<HttpResponseMessage> GetAsync() => _http.GetAsync("/TrafficSensor");
}
```

```csharp
// Program.cs
builder.Services.AddHttpClient<TrafficSensorClient>(c =>
    c.BaseAddress = new Uri(builder.Configuration["SensorUrl"]!));
```

The controller then takes `TrafficSensorClient` in its constructor.

### The test

Stub the handler, not the client:

```csharp
sealed class StubHandler : HttpMessageHandler
{
    private readonly HttpStatusCode _status;
    public StubHandler(HttpStatusCode status) => _status = status;

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
        => Task.FromResult(new HttpResponseMessage(_status)
        {
            Content = new StringContent(string.Empty)
        });
}
```

```csharp
[Theory]
[InlineData(HttpStatusCode.NotFound)]
[InlineData(HttpStatusCode.InternalServerError)]
public async Task Reports_error_when_sensor_fails(HttpStatusCode status)
{
    await using var factory = new WebApplicationFactory<Program>()
        .WithWebHostBuilder(b => b.ConfigureTestServices(services =>
            services.AddHttpClient<TrafficSensorClient>()
                    .ConfigurePrimaryHttpMessageHandler(() => new StubHandler(status))));

    var client = factory.CreateClient();

    Assert.Equal("ERROR!", await client.GetStringAsync("/TrafficReport"));
}
```

Two details that cost people an afternoon and are worth stating:

- Re-calling `AddHttpClient<TrafficSensorClient>()` in `ConfigureTestServices`
  does not create a second client. It resolves to the same named registration,
  so `ConfigurePrimaryHttpMessageHandler` replaces the real handler while the
  `BaseAddress` set in `Program.cs` still applies. The stub ignores the URL.
- With minimal hosting, `WebApplicationFactory<Program>` will not compile until
  `Program` is visible. Add `public partial class Program { }` at the bottom of
  `Program.cs`, and reference `Microsoft.AspNetCore.Mvc.Testing`.

### The point worth making that nobody else has

The asker said "simulate an unavailable sensor API" and then asked for 404/500.
Those are different failures, and the code only survives one of them.

A 404 or a 500 is a *response*, so `IsSuccessStatusCode` is false and the
`"ERROR!"` branch runs as intended. But an API that is genuinely unavailable —
process down, connection refused, DNS gone, or just slow enough to hit the
default 100-second `HttpClient` timeout — does not return a status at all. It
throws `HttpRequestException` (or `TaskCanceledException` on timeout), the
action has no `try`/`catch`, and the Report API returns a 500 to *its own*
caller instead of the error string it was written to return.

So the test suite needs a third case, which the same stub gives for free:

```csharp
protected override Task<HttpResponseMessage> SendAsync(
    HttpRequestMessage request, CancellationToken cancellationToken)
    => throw new HttpRequestException("Connection refused");
```

That test fails against the code as posted, which is the useful outcome.

### Only then, if it fits — and it may not

> For the automated test above, keep it in-process; a test that reaches the
> internet is a test that fails when the wifi does.
>
> Where an external endpoint does earn its place is the manual pass *before*
> you write the test — pointing `SensorUrl` at something that returns the status
> you ask for, so you can watch the real `HttpClient`, the real socket and the
> real timeout behave, which a stub handler deliberately does not exercise:
>
> ```
> "SensorUrl": "https://flakyapi.dev/v1/posts/1?_status=500"
> "SensorUrl": "https://flakyapi.dev/v1/posts/1?_delay=30000"   // for the timeout path
> ```
>
> Disclosure: I built that.

The `_delay` half is the honest part of this. A stub handler that throws
`TaskCanceledException` asserts the catch block, but it never proves the client
actually times out where you think it does — the timeout is real only over a
real socket.

---

## Pacing

One answer, then wait. New accounts posting several answers containing the same
link get caught by spam heuristics regardless of quality. Two or three good
answers over a month beats ten in a week, and the ten may cost you the account.
