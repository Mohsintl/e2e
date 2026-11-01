---
"e2e": patch
---

`resolveExpression` takes `label` and `displayValue` options, so an engine whose nodes carry labels beside their name answers a label query by any of them, and one whose nodes carry values they do not display (a checkbox's) keeps them out of a display-value query.
