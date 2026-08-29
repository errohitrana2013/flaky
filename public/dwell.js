// Reports how long this page was actually looked at.
//
// Two details that decide whether the number means anything:
//
// Hidden time is subtracted. A tab left open in the background for an hour is
// not an hour of reading, so the clock stops on visibilitychange and resumes
// when the page comes back.
//
// The send happens on pagehide, not unload — unload does not fire reliably on
// mobile Safari, which is exactly where people close tabs without navigating.
// sendBeacon survives the page going away; fetch does not.
(function () {
  let visibleSince = document.visibilityState === "visible" ? Date.now() : 0;
  let accumulated = 0;
  let sent = false;

  function stop() {
    if (visibleSince) { accumulated += Date.now() - visibleSince; visibleSince = 0; }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") visibleSince = Date.now();
    else stop();
  });

  function send() {
    if (sent) return;
    stop();
    const seconds = Math.round(accumulated / 1000);
    if (seconds <= 0) return;
    sent = true;
    try {
      navigator.sendBeacon(
        "/v1/beacon",
        new Blob([JSON.stringify({ path: location.pathname, seconds })], { type: "application/json" })
      );
    } catch { /* a failed beacon is not worth breaking a page over */ }
  }

  addEventListener("pagehide", send);
  // Safari sometimes skips pagehide when a tab is closed outright.
  addEventListener("beforeunload", send);
})();
