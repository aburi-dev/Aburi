---
"@aburi/cli": patch
---

`FORCE_COLOR` set to turn colour on beside `NO_COLOR` or `NODE_DISABLE_COLORS` no longer opens stderr with Node's own warning that the second is ignored. The bin drops both variables, which `FORCE_COLOR` outranks anyway, before the rest of the CLI loads, so neither the worker threads nor the processes it starts see them.
