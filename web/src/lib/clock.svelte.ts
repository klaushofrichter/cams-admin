// One ticking "now" for every age on the page.
export const clock = $state({ now: Date.now() });
setInterval(() => (clock.now = Date.now()), 1000);
