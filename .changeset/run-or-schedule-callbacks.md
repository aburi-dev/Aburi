---
"@aburi/lang-typescript": minor
---

Stop reading a function handed to a call that runs it at once or schedules it as the body of the const, `<default>` or class field that holds the call. A call named `then`, `catch`, `finally`, `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask`, `subscribe`, `on`, `once`, `addListener`, `effect`, `reaction`, `autorun`, `watch`, `map`, `filter`, `forEach`, `reduce` or `$transaction` is passed over: its callback is walked with the call, so on a field it stays on the class whose construction runs or schedules it, and a field such as `timer = setInterval(() => { … })` or `off = emitter.on("x", () => { … })` is no longer a member Symbol, so callers of `new C()` keep the callback's effects and a call of the disposer no longer takes them. A class of such fields is still not a data model. Other calls, wrappers such as `withAuth(() => { … })` among them, are read as before.
